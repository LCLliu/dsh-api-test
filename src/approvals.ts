import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type {
    approvalDecision,
    approvalRequest,
    pendingQuestion,
    questionAnswerItem,
    questionItem,
    questionOption,
} from '../shared/dsh-type.js';

interface approvalsOptions {
  dshUrl: string;
  getCookie: () => Promise<string>;
  resetCookie: () => void;
}

interface readyFrame {
  type: 'ready';
  clientId?: unknown;
}

interface waterfallFrame {
  type: 'waterfall';
  event?: unknown;
  eventId?: unknown;
  agentId?: unknown;
  request?: Record<string, unknown>;
}

interface cancelFrame {
  type: 'cancel';
  eventId?: unknown;
}

type downlinkFrame = readyFrame | waterfallFrame | cancelFrame;

export interface approvalsService {
  start(): void;
  stop(): void;
  list(sessionId: string): approvalRequest[];
  decide(eventId: string, decision: approvalDecision): Promise<void>;
  listQuestions(sessionId: string): pendingQuestion[];
  answer(eventId: string, answers: questionAnswerItem[]): Promise<void>;
}

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

export const createApprovals = (options: approvalsOptions): approvalsService => {
  const pending = new Map<string, approvalRequest>();
  const questions = new Map<string, pendingQuestion>();
  let socket: WebSocket | undefined;
  let streamId = '';
  let clientId = '';
  let stopped = false;
  let retries = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  const log = (message: string) => console.warn(`[approvals] ${message}`);

  const scheduleReconnect = () => {
    if (stopped) return;
    retries += 1;
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(retries, 5));
    retryTimer = setTimeout(() => { void connect(); }, delay);
  };

  const parseOptions = (raw: unknown): questionOption[] => {
    if (!Array.isArray(raw)) return [];
    const list: questionOption[] = [];
    for (const entry of raw) {
      if (typeof entry !== 'object' || entry === null) continue;
      const item = entry as Record<string, unknown>;
      const label = asString(item.label);
      if (label === undefined) continue;
      const option: questionOption = { label };
      const description = asString(item.description);
      if (description !== undefined) option.description = description;
      list.push(option);
    }
    return list;
  };

  const parseQuestions = (raw: unknown): questionItem[] => {
    if (!Array.isArray(raw)) return [];
    const list: questionItem[] = [];
    raw.forEach((entry, index) => {
      if (typeof entry !== 'object' || entry === null) return;
      const item = entry as Record<string, unknown>;
      const text = asString(item.question);
      if (text === undefined) return;
      const question: questionItem = { id: asString(item.id) ?? `q${index + 1}`, question: text };
      const header = asString(item.header);
      if (header !== undefined) question.header = header;
      const detail = asString(item.detail);
      if (detail !== undefined) question.detail = detail;
      if (item.multiSelect === true) question.multiSelect = true;
      const options = parseOptions(item.options);
      if (options.length > 0) question.options = options;
      list.push(question);
    });
    return list;
  };

  const connect = async (): Promise<void> => {
    if (stopped) return;

    let ws: WebSocket;
    try {
      const cookie = await options.getCookie();
      const url = options.dshUrl.replace(/^http/, 'ws') + '/api/remote.mux';
      ws = new WebSocket(url, { headers: { cookie } });
    } catch (error) {
      log(`connect failed: ${error instanceof Error ? error.message : String(error)}`);
      scheduleReconnect();
      return;
    }

    socket = ws;
    streamId = randomUUID();

    ws.on('open', () => {
      retries = 0;
      ws.send(JSON.stringify({ type: 'open', streamId, endpoint: '$events', payload: { args: {} } }));
    });

    ws.on('message', (raw) => {
      let frame: { type?: unknown; streamId?: unknown; value?: unknown };
      try {
        frame = JSON.parse(String(raw)) as typeof frame;
      } catch {
        return;
      }
      if (frame.type !== 'item' || frame.streamId !== streamId) return;
      if (typeof frame.value !== 'object' || frame.value === null) return;

      const value = frame.value as downlinkFrame;

      if (value.type === 'ready') {
        clientId = asString(value.clientId) ?? '';
        log('events stream ready');
        return;
      }

      if (value.type === 'waterfall' && typeof value.eventId === 'string') {
        const request = value.request ?? {};
        const sessionId = asString(value.agentId) ?? '';

        if (value.event === 'approval/request') {
          const item: approvalRequest = {
            eventId: value.eventId,
            sessionId,
            toolName: asString(request.toolName) ?? 'unknown',
            receivedAt: Date.now(),
          };
          const callId = asString(request.callId);
          if (callId !== undefined) item.callId = callId;
          const reason = asString(request.reason);
          if (reason !== undefined) item.reason = reason;
          pending.set(item.eventId, item);
          log(`approval requested: ${item.toolName} (${item.sessionId})`);
          return;
        }

        if (value.event === 'user-questions/request') {
          const list = parseQuestions(request.questions);
          if (list.length === 0) {
            // 解析不出可用问题时把请求让给其它客户端，否则 Host 的 waterfall 会一直挂着
            void sendOutcome(value.eventId, { kind: 'next' }).catch(() => {});
            log('question request ignored: no parsable question');
            return;
          }
          questions.set(value.eventId, { eventId: value.eventId, sessionId, questions: list, receivedAt: Date.now() });
          log(`questions requested: ${list.length} (${sessionId})`);
        }
        return;
      }

      if (value.type === 'cancel' && typeof value.eventId === 'string') {
        pending.delete(value.eventId);
        questions.delete(value.eventId);
      }
    });

    ws.on('error', (error) => {
      if (/Unexpected server response: 401/.test(error.message)) options.resetCookie();
      log(`socket error: ${error.message}`);
    });

    ws.on('close', () => {
      if (socket !== ws) return;
      socket = undefined;
      clientId = '';
      pending.clear();
      questions.clear();
      scheduleReconnect();
    });
  };

  const sendOutcome = async (eventId: string, outcome: Record<string, unknown>): Promise<void> => {
    if (socket === undefined || clientId === '') throw new Error('事件通道未连接');

    const res = await fetch(new URL('api/$events/result', options.dshUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: await options.getCookie() },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: randomUUID(),
        method: '$events/result',
        payload: { args: { clientId, eventId, outcome } },
      }),
    });

    const text = await res.text();
    let body: { result?: { ok?: boolean; error?: { message?: string } } } = {};
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      throw new Error(`回传结果失败（HTTP ${res.status}）`);
    }
    if (!res.ok || body.result?.ok !== true) {
      throw new Error(body.result?.error?.message ?? `回传结果失败（HTTP ${res.status}）`);
    }
  };

  const decide = async (eventId: string, decision: approvalDecision): Promise<void> => {
    if (!pending.has(eventId)) throw new Error('审批已失效或已被处理');
    await sendOutcome(eventId, { kind: 'result', value: decision });
    pending.delete(eventId);
  };

  const answer = async (eventId: string, answers: questionAnswerItem[]): Promise<void> => {
    if (!questions.has(eventId)) throw new Error('问题已失效或已被回答');
    await sendOutcome(eventId, {
      kind: 'result',
      value: {
        answers: answers.map((item) => ({
          id: item.id,
          selected: item.selected,
          ...(item.custom === '' ? {} : { custom: item.custom }),
        })),
      },
    });
    questions.delete(eventId);
  };

  return {
    start() {
      stopped = false;
      void connect();
    },
    stop() {
      stopped = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      pending.clear();
      questions.clear();
      socket?.close();
      socket = undefined;
    },
    list(sessionId) {
      return [...pending.values()].filter((item) => item.sessionId === sessionId);
    },
    listQuestions(sessionId) {
      return [...questions.values()].filter((item) => item.sessionId === sessionId);
    },
    decide,
    answer,
  };
};
