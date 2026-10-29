import { randomUUID } from 'node:crypto';
import type {
  commandDescriptor,
  commandExecution,
  RpcBody,
  sessionCreateValue,
  sessionListValue,
  sessionPageValue,
  sessionProjectionsValue,
  sessionPromptRequest,
  sessionPromptValue,
} from '../../shared/dsh-type.js';
import { DSH_TOKEN, DSH_URL } from '../config.js';

let cookie: Promise<string> | undefined;

/** 登录 dsh 并拿到绑定 authority 的 cookie。 */
const login = async (): Promise<string> => {
  const url = new URL('/', DSH_URL);
  url.searchParams.set('token', DSH_TOKEN);
  url.searchParams.set('interactions', 'none');

  const response = await fetch(url, { redirect: 'manual' });
  const setCookie = response.headers.getSetCookie()[0];
  await response.arrayBuffer();

  if (setCookie === undefined) {
    console.info(`[createSession] -> 返回 ${response.status}, 未下发 cookie（token可能失效了）`);
    throw new Error(`返回 ${response.status}, 未下发 cookie（token可能失效了）`);
  }
  return setCookie.split(';', 1)[0];
};

// cookie 绑定 authority，换一次就能一直用；失败时清掉缓存，下次调用重新换
export const getCookie = (): Promise<string> => {
  if (cookie === undefined) {
    cookie = login().catch((error: unknown) => {
      cookie = undefined;
      throw error;
    });
  }
  return cookie;
};

export const resetCookie = (): void => {
  cookie = undefined;
};

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
      body.result?.error?.message ?? `dsh ${method} 失败 HTTP ${res.status}: ${text.slice(0, 300)}`,
    );
  }
  return body.result!.value as T;
};

export const dsh = {
  /** 创建会话 */
  createSession: (request: { workspaceId?: string; cwd?: string; sessionId?: string; agentPreset?: string } = {}) =>
    sendMeil<sessionCreateValue>('session/create', { request }),

  /** 认领已经存在的会话（通过 session/create 携带 sessionId 走 adopt 分支） */
  resumeSession: (sessionId: string, cwd?: string) =>
    sendMeil<sessionCreateValue>('session/create', {
      request: { sessionId, ...(cwd === undefined ? {} : { cwd }) },
    }),

  /** 发送用户信息，只返回 accept 回执，AI 的正文在事件流里面 */
  prompt: (request: sessionPromptRequest) => sendMeil<sessionPromptValue>('session/prompt', { request }),

  /** 列出会话摘要 */
  listSessions: () => sendMeil<sessionListValue>('session/list', { _request: {} }),

  /** 读取指定会话的投影，比如权限、标题和 turnOutline 等 */
  projections: (sessionId: string) =>
    sendMeil<sessionProjectionsValue>('session/projections', { request: { sessionId } }),

  /** 读取一页的历史事件：throughSeq 用投影里的 asOfSeq */
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
  setPermission: (sessionId: string, preset: string) =>
    sendMeil<commandExecution | undefined>('commands/execute', {
      agentId: sessionId,
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

  /** 执行一条斜杠命令：line 必须带前导斜杠 */
  executeCommand: (agentId: string, line: string) =>
    sendMeil<commandExecution | undefined>('commands/execute', {
      agentId,
      line,
      submittedAttachments: [],
    }),
};
