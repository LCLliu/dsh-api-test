import 'dotenv/config';
import express, { response } from 'express';
import fs from 'node:fs';
import { IncomingMessage, request, ServerResponse } from 'node:http';
import path, { resolve } from 'node:path';
import type {
  chatMessage,
  commandDescriptor,
  commandExecution,
  questionAnswerItem,
  RpcBody,
  sessionCreateValue,
  sessionListItem,
  sessionListValue,
  sessionPageValue,
  sessionProjectionsValue,
  sessionPromptRequest,
  sessionPromptValue,
  sessionSummary,
} from '../shared/dsh-type.js';
import { randomUUID } from 'node:crypto';
import { createApprovals } from './approvals.js';
import { approvalDecision } from '../shared/dsh-type.js';

const DSH_URL = process.env.DSH_URL ?? 'http://127.0.0.1:3080';
const DSH_TOKEN = process.env.DSH_TOKEN ?? '';
let cookie: Promise<string> | undefined;

const app = express();
app.use(express.json());
const port = Number(process.env.PORT ?? 3000);
// ==========================================================

/**
 * 获取登录的Cookie
 */
const login = async () => {
  const url = new URL('/', DSH_URL);
  url.searchParams.set('token', DSH_TOKEN);
  url.searchParams.set('interactions', 'none');

  const response = await fetch(url, { redirect: 'manual' });
  const setCookie = response.headers.getSetCookie()[0];
  await response.arrayBuffer();

  if (setCookie === undefined) {
    console.info(`[createSession] -> 返回 ${response.status}, 未下发 cookie（token可能失效了）`)
    throw new Error(`返回 ${response.status}, 未下发 cookie（token可能失效了）`);
  }
  return setCookie.split(';', 1)[0]
};

// cookie 绑定 authority，换一次就能一直用；失败时清掉缓存，下次调用重新换
const getCookie = () => {
  if (cookie === undefined) {
    cookie = login().catch((error: unknown) => {
      cookie = undefined;
      throw error;
    });
  }
  return cookie;
};

const resetCookie = () => { cookie = undefined };

const approvals = createApprovals({
  dshUrl: DSH_URL,
  getCookie,
  resetCookie,
})

const sendMeil = async <T>(method: string, args: unknown): Promise<T> => {
  const res = await fetch(new URL(`api/${method}`, DSH_URL), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: await getCookie(),
    },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: randomUUID(),
      method,
      payload: { args },
    }),
  });

  if (res.status === 401) {
    cookie = undefined;
  }

  const text = await res.text();
  let body: RpcBody<T>;

  try {
    body = JSON.parse(text) as RpcBody<T>;
  } catch {
    throw new Error(`dsh 返回了非 JSON 响应（HTTP ${res.status}）`);
  }

  if (!res.ok || body.result?.ok !== true) {
    throw new Error(
      body.result?.error?.message ?? `dsh ${method} 失败 HTTP ${res.status}: ${text.slice(0, 300)}`
    );
  }
  return body.result!.value as T;
};

const dsh = {
  /** 创建会话 */
  createSession: (request: { workspaceId?: string; cwd?: string; sessionId?: string; agentPreset?: string } = {}) =>
    sendMeil<sessionCreateValue>('session/create', { request }),

  /** 认领已经存在的会话（通过session/create 携带 sessionId 走 adopt 的 分支） */

  resumeSession: (sessionId: string, cwd?: string) =>
    sendMeil<sessionCreateValue>('session/create', {
      request: { sessionId, ...(cwd === undefined ? {} : { cwd }) },
    }),

  /** 发送用户信息，只返回 accept 回执，AI 的正文在事件流里面 */
  prompt: (request: sessionPromptRequest) => sendMeil<sessionPromptValue>('session/prompt', { request }),

  /** 列出会话摘要 */
  listSessions: () => sendMeil<sessionListValue>('session/list', { _request: {} }),

  /** 读取指定会话的投影，比如说权限，标题和 turnOutline 等 */
  projections: (sessionId: string) =>
    sendMeil<sessionProjectionsValue>('session/projections', { request: { sessionId } }),

  /** 读取一页的历史事件： throughSeq 用投影里面的asOfSeq */
  page: (sessionId: string, throughSeq: number, maxMessages = 200, beforeSeq?: number) =>
    sendMeil<sessionPageValue>('session/page', {
      request: {
        address: { kind: 'session', sessionId },
        throughSeq,
        maxMessages,
        ...(beforeSeq === undefined ? {} : { beforeSeq }),
      },
    }),

  /** 切换当前会话权限 */
  setPermission: (SessionId: string, preset: string) =>
    sendMeil<commandExecution | undefined>('commands/execute', {
      agentId: SessionId,
      line: `/permission ${preset}`,
      submittedAttachments: [],
    }),
  /** 取消当前正在执行的任务，保留已排队的消息 */
  cancl: (sessionId: string) => sendMeil<{ accepted: true }>('session/cancel', { request: { sessionId } }),

  /** 重命名对话 */

  rename: (sessionId: string, title: string) =>
    sendMeil<{ title: string; seq: number }>('session/rename', { request: { sessionId, title } }),

  /** 列出会话可用的斜杠命令 */
  listCommands: (agentId: string) => sendMeil<commandDescriptor[]>('commands/list', { agentId }),

  /** 执行一条斜杠命令： line 必须带前导航杠 */
  executeCommand: (agentId: string, line: string) =>
    sendMeil<commandExecution | undefined>('commands/execute', {
      agentId,
      line,
      submittedAttachments: [],
    })
}


type pageEvent = sessionPageValue['records'][number]['event'];

// requestId -> 用户消息的 seq，缓存后轮询时不必每次从最新一页翻回开头
const userSeqByRequest = new Map<string, number>();

/**
 * 单次查询某一轮是否结束。只在请求内读一次事件，不等待、不循环。
 * 前端每 1.5 秒调用一次，后端重启或页面刷新都不影响 dsh 继续跑。
 */
const findReply = async (
  sessionId: string,
  requestId: string,
): Promise<{ done: false } | { done: true; text: string; reason: string }> => {
  const list = await dsh.listSessions();
  const row = list.items.find((item) => item.sessionId === sessionId);
  const cursor = row?.projections?.asOfSeq;
  if (typeof cursor !== 'number') return { done: false };

  let userSeq = userSeqByRequest.get(requestId);
  const events: pageEvent[] = [];
  let beforeSeq: number | undefined;

  for (let index = 0; index < 10; index += 1) {
    const page = await dsh.page(sessionId, cursor, 200, beforeSeq);
    const pageEvents = page.records.map((record) => record.event);
    events.push(...pageEvents);

    if (userSeq === undefined) {
      const user = pageEvents.find(
        (event) => event.type === 'user/message' && event.data?.source?.rpcId === requestId,
      );
      if (user !== undefined) {
        userSeq = user.seq;
        userSeqByRequest.set(requestId, user.seq);
      }
    }

    if (!page.hasMore || pageEvents.length === 0) break;
    const first = Math.min(...pageEvents.map((event) => event.seq));
    if (userSeq !== undefined && first <= userSeq) break;
    if (beforeSeq !== undefined && first >= beforeSeq) break;
    beforeSeq = first;
  }

  if (userSeq === undefined) return { done: false };

  const end = events.find((event) => event.type === 'turn/end' && event.seq > userSeq);
  if (end === undefined) return { done: false };

  const text = events
    .filter((event) => event.type === 'assistant/message' && event.seq > userSeq && event.seq < end.seq)
    .flatMap((event) => event.data?.message?.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('');

  userSeqByRequest.delete(requestId);
  return { done: true, text, reason: end.data?.reason?.kind ?? 'unknown' };
};
// ========================================================== 历史会话

/** 先查看有没有返回标题，没有则用第一个会话的提示词的前面的字作为标题，如果没有对话，则设置标题为会话ID兜底 */
const sessionTitle = (row: sessionSummary): string => {
  const values = row.projections?.values ?? {};
  if (typeof values.title === 'string' && values.title !== '') return values.title;

  const firstPromt = values.turnOutline?.[0].prompt;
  if (typeof firstPromt === 'string' && firstPromt !== '') return firstPromt.slice(0, 24);

  return `会话 ... ${row.sessionId.slice(-8)}`;
}

const toListItem = (row: sessionSummary): sessionListItem => ({
  sessionId: row.sessionId,
  title: sessionTitle(row),
  updatedAt: row.updatedAt,
  ...(row.cwd === undefined ? {} : { cwd: row.cwd }),
  running: row.running,
})

type historyEntry = chatMessage & { seq: number };

/** 把一页原始的事件渲染为消息气泡， 工具调用和 step 事件的第一版不渲染 */
const toHistoryEntries = (events: pageEvent[]): historyEntry[] => {
  const entries: historyEntry[] = [];

  for (const event of events) {
    // 会话如果压缩过的话就会出现 replace 这类的 surfaceOp，或者位未知，就跳过
    if (event.surfaceOp !== undefined && event.surfaceOp !== 'append') continue;

    if (event.type === 'user/message') {
      // 除去除了用户信息外的内容，包括答题回注这类
      if (event.data?.source?.kind !== 'user') continue;

      const text = (event.data?.content ?? [])
        .filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join('');
      if (text !== '') entries.push({ seq: event.seq, id: `dsh-${event.seq}`, role: 'user', text });
      continue;
    }

    if (event.type === 'command/done') {
      const text = event.data?.text ?? '';
      entries.push({
        seq: event.seq,
        id: `dis${event.seq}`,
        role: event.data?.kind === 'error' ? 'error' : 'command',
        text: text !== '' ? text : `/${event.data?.name ?? '命令'} 已执行`,
      });
    }

    if (event.type === 'assistant/message') {
      const text = (event.data?.message?.content ?? [])
        .filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join('');
      if (text !== '') entries.push({ seq: event.seq, id: `dsh-${event.seq}`, role: 'assistant', text });
      continue;
    }
  }
  return entries;
};

/** 从日志尾部往上面翻，显示 limit 条信息 throughSeq 固定投影的游标，通过 beforeSeq 往前翻页 与findReply差不多的方法 */
const collectHistory = async (sessionId: string, limit: number, beforSeq?: number) => {
  const projections = await dsh.projections(sessionId);
  if (projections === null) throw new Error('会话不存在');
  if (projections === null) throw new Error('会话是不存在');

  const entries: historyEntry[] = [];
  let cursor = beforSeq;
  let exhausted = false;

  for (let index = 0; index < 20; index++) {
    const page = await dsh.page(sessionId, projections.asOfSeq, 200, cursor);
    const events = page.records.map((record) => record.event);

    entries.unshift(...toHistoryEntries(events));

    if (!page.hasMore || events.length === 0) {
      exhausted = true;
      break;
    }
    cursor = Math.min(...events.map((event) => event.seq));
    if (entries.length >= limit) break;
  }

  const visible = entries.slice(-limit);
  return {
    visible,
    hasMore: entries.length > visible.length || !exhausted,
    oldestSeq: visible.length === 0 ? beforSeq : visible[0].seq,
  };

};


// ==========================================================

const sendJson = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

const readJson = async (req: IncomingMessage) => {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.lenght;
    if (size > 1_000_000)
      throw new Error('请求体过大');
    chunks.push(chunk as Buffer);
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
}

// ========================================================================================

app.post('/api/createSession', async (req, res) => {
  try {
    const value = await dsh.createSession();
    res.json(value);
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

app.post('/api/sendmessage', async (req, res) => {
  const { sessionId, text } = req.body as { sessionId?: string; text?: string };

  if (!sessionId || !text?.trim()) {
    res.status(400).json({ error: 'sessionId 和 text 必填' });
    return;
  }

  try {
    const requestId = randomUUID();
    await dsh.prompt({
      requestId,
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text }]
    });
    res.json({ accepted: true, requestId });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

app.get('/api/reply', async (req, res) => {
  const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : '';
  const requestId = typeof req.query.requestId === 'string' ? req.query.requestId : '';
  if (sessionId === '' || requestId === '') {
    res.status(400).json({ error: 'sessionId 和 requestId 必填' });
    return;
  }

  try {
    res.json(await findReply(sessionId, requestId));
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

app.get('/api/approvals', (req, res) => {
  const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : '';
  if (sessionId === '') {
    res.status(400).json({ error: 'sessionId 必填' });
    return;
  }
  res.json(approvals.list(sessionId));
});

app.post('/api/approvals/:eventId', async (req, res) => {
  const { decision } = req.body as { decision?: approvalDecision };
  if (decision !== 'allowed-once' && decision !== 'rejected') {
    res.status(400).json({ error: 'decision 只能是 allowed-once 或 rejected' });
    return;
  }

  try {
    await approvals.decide(req.params.eventId, decision);
    res.json({ accepted: true });
  } catch (err) {
    const message = (err as Error).message;
    res.status(message.includes('失效') ? 404 : 502).json({ error: message });
  }
});

app.get('/api/questions', (req, res) => {
  const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : '';
  if (sessionId === '') {
    res.status(400).json({ error: 'sessionId 必填' });
    return;
  }
  res.json(approvals.listQuestions(sessionId));
});

app.post('/api/questions/:eventId', async (req, res) => {
  const { answers } = req.body as { answers?: questionAnswerItem[] };
  if (!Array.isArray(answers) || answers.length === 0) {
    res.status(400).json({ error: 'answers 不能为空' });
    return;
  }
  try {
    await approvals.answer(req.params.eventId, answers);
    res.json({ accepted: true });
  } catch (err) {
    const message = (err as Error).message;
    res.status(message.includes('失效') ? 404 : 502).json({ error: message });
  }
});

app.get('/api/commands', async (req, res) => {
  const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : '';
  if (sessionId === '') {
    res.status(400).json({ error: 'sessionId 必填' });
    return;
  }

  try {
    res.json(await dsh.listCommands(sessionId));
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

app.post('/api/command', async (req, res) => {
  const { sessionId, line } = req.body as { sessionId?: string; line?: string };
  if (!sessionId || !line?.trim()) {
    res.status(400).json({ error: 'sessionId 和 line 必填' });
    return;
  }

  try {
    const execution = await dsh.executeCommand(sessionId, line.trim());
    if (execution === undefined) {
      res.status(400).json({ error: '命令不存在或语法不对' });
      return;
    }
    res.json(execution.result);   // { kind: 'success' | 'error', text?, sourceEventSeq? }
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

app.post('/api/cancel', async (req, res) => {
  const { sessionId } = req.body as { sessionId?: string };
  if (!sessionId) {
    res.status(400).json({ error: 'sessionId 必填' });
    return;
  }
  try {
    res.json(await dsh.cancl(sessionId));
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

// 获取会话列表
app.get('/api/session', async (req, res) => {
  try {
    const sessionList = await dsh.listSessions();
    const items = sessionList.items
      .filter((row) => row.origin !== 'subagent' && row.blank !== true)
      .map(toListItem)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    res.json({ items });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
})

// 认领历史会话，使得能够被继续对话
app.post('/api/resume', async (req, res) => {
  const { sessionId, cwd } = req.body as { sessionId?: string; cwd?: string };
  if (!sessionId) {
    res.status(400).json({ error: 'sessionId 必填' });
    return;
  }
  try {
    res.json(await dsh.resumeSession(sessionId, cwd));
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
})

// 读取某个会话的历史消息，beforeSeq 用来加载更早的消息
app.get('/api/history', async (req, res) => {
  const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : '';
  const beforeSeq = typeof req.query.beforeSeq === 'string' ? Number(req.query.beforeSeq) : undefined;
  const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : 30;

  if (!sessionId) {
    res.status(400).json({ error: 'sessionId 必填' });
    return;
  }

  try {
    const page = await collectHistory(sessionId, Math.min(Math.max(limit, 1), 100), beforeSeq);
    res.json({
      sessionId,
      messages: page.visible.map(({ seq, ...message }) => message), // 丢掉seq 只留下chatMessage
      hasMore: page.hasMore,
      oldestSeq: page.oldestSeq,
    });
  } catch (err) {
    const message = (err as Error).message;
    res.status(message.includes('不存在') ? 404 : 502).json({ error: message });
  }
})

// npm scripts 都从项目根运行；开发模式下该目录通常不存在，直接跳过静态托管
const webDir = path.resolve(process.cwd(), 'dist', 'web');
if (fs.existsSync(webDir)) {
  app.use(express.static(webDir));
}

approvals.start();

const server = app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});

process.on('SIGINT', () => {
  approvals.stop();
  server.close(() => process.exit(0));
})
