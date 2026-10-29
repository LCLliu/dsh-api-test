import {
  type historyResponse,
  type approvalDecision,
  type approvalRequest,
  type chatMessage,
  type commandDescriptor,
  type commandResponse,
  type createResponse,
  type pendingQuestion,
  type questionAnswerItem,
  type requirementItem,
  type requirementsResponse,
  type sendResponse,
  type sessionListItem,
  type sessionsResponse,
  type turnResult,
} from '../../shared/dsh-type.ts';

/** 统一处理JSON 响应：非 2xx 一律抛 Error，优先用后端返回的中文错误。 */
const requestJson = async <T>(path: string, fallback: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(path, init);
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };

  if (!res.ok) {
    throw new Error(body.error ?? `${fallback}（HTTP ${res.status}）`);
  }
  return body as T;
};

const post = (payload: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload),
});

/** 创建会话，返回 sessionId */
export const createSession = async (): Promise<string> => {
  const res = await fetch('/api/createSession', { method: 'POST' });
  const text = await res.text();

  let body: createResponse;
  try {
    body = JSON.parse(text) as createResponse;
  } catch {
    throw new Error(`返回的不是JSON（HTTP ${res.status}）`);
  }

  const sessionId = body.sessionId ?? body.result?.value?.sessionId;

  if (!res.ok || body.error !== undefined || body.result?.ok === false || sessionId === undefined) {
    throw new Error(body.error ?? '创建失败');
  }
  return sessionId;
};

/** 获取会话可用的斜杠命令目录。 */
export const loadCommands = async (sessionId: string): Promise<commandDescriptor[]> => {
  const body = await requestJson<commandDescriptor[]>(
    `/api/commands?sessionId=${encodeURIComponent(sessionId)}`,
    '加载命令失败',
  );

  if (!Array.isArray(body)) {
    throw new Error('加载命令失败：返回的不是列表');
  }
  return body;
};

/** 发送一条消息，只返回 requestId，正文靠 streamReply 接流获取 */
export const sendPrompt = async (sessionId: string, text: string): Promise<string> => {
  const body = await requestJson<sendResponse>('/api/sendmessage', '发送失败', post({ sessionId, text }));

  if (body.requestId === undefined) {
    throw new Error('后端没有返回 requestId');
  }
  return body.requestId;
};

/**
 * 订阅一轮回复的流式输出（SSE）。
 * 返回关闭连接的函数；done/error 之后流自己会关。
 */
export const streamReply = (
  sessionId: string,
  requestId: string,
  handlers: {
    onDelta: (text: string) => void;
    onDone: (result: turnResult) => void;
    onError: (error: string) => void;
  },
  options: { timeoutMs?: number } = {},
): (() => void) => {
  const query = new URLSearchParams({ sessionId, requestId });
  if (options.timeoutMs !== undefined) query.set('timeoutMs', String(options.timeoutMs));
  const source = new EventSource(`/api/reply/stream?${query}`);

  const read = <T>(raw: unknown): T | undefined => {
    if (typeof raw !== 'string') return undefined;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return undefined;
    }
  };

  source.addEventListener('delta', (event) => {
    const data = read<{ text?: string }>((event as MessageEvent).data);
    if (data?.text !== undefined) handlers.onDelta(data.text);
  });

  source.addEventListener('done', (event) => {
    source.close();
    const data = read<turnResult>((event as MessageEvent).data);
    if (data !== undefined) handlers.onDone(data);
    else handlers.onError('本轮已结束，但回复结果解析失败');
  });

  source.addEventListener('error', (event) => {
    source.close();
    const data = read<{ error?: string }>((event as MessageEvent).data);
    handlers.onError(data?.error ?? '与后端的事件流已断开');
  });

  return () => source.close();
};

/** 执行一条斜杠命令，line 必须带前导斜杠。 */
export const executeCommand = (sessionId: string, line: string): Promise<commandResponse> =>
  requestJson<commandResponse>('/api/command', '命令执行失败', post({ sessionId, line }));

/** 取消当前正在执行的一轮。 */
export const cancelTurn = (sessionId: string): Promise<{ accepted?: true }> =>
  requestJson<{ accepted?: true }>('/api/cancel', '取消失败', post({ sessionId }));

/** 拉取待处理的审批与提问；任一接口失败不影响另一个。 */
export const fetchInteractions = async (
  sessionId: string,
): Promise<{ approvals?: approvalRequest[]; questions?: pendingQuestion[] }> => {
  const query = `sessionId=${encodeURIComponent(sessionId)}`;

  const read = async <T>(path: string): Promise<T[] | undefined> => {
    try {
      const res = await fetch(path);
      if (!res.ok) return undefined;
      const list = await res.json() as T[];
      return Array.isArray(list) ? list : undefined;
    } catch {
      return undefined;
    }
  };

  const [approvals, questions] = await Promise.all([
    read<approvalRequest>(`/api/approvals?${query}`),
    read<pendingQuestion>(`/api/questions?${query}`),
  ]);

  return { approvals, questions };
};

/** 回答一个审批请求。 */
export const decideApproval = (eventId: string, decision: approvalDecision): Promise<unknown> =>
  requestJson(`/api/approvals/${encodeURIComponent(eventId)}`, '审批失败', post({ decision }));

/** 提交一组问题回答。 */
export const answerQuestion = (eventId: string, answers: questionAnswerItem[]): Promise<unknown> =>
  requestJson(`/api/questions/${encodeURIComponent(eventId)}`, '提交失败', post({ answers }));

/** 获取历史会话列表 */
export const fetchSessions = async (): Promise<sessionListItem[]> => {
  const body = await requestJson<sessionsResponse>('/api/session', '加载历史失败');
  return body.items ?? [];
}

/** 获取某个会话的一页消息 */
export const fetchHistory = async (
  sessionId: string,
  limit = 30,
  beforeSeq?: number,
): Promise<{ messages: chatMessage[]; hasMore: boolean; oldestSeq?: number }> => {
  const query = new URLSearchParams({ sessionId, limit: String(limit) });
  if (beforeSeq !== undefined) query.set('beforeSeq', String(beforeSeq));

  const body = await requestJson<historyResponse>(`/api/history?${query}`, '加载历史失败');
  return { messages: body.messages ?? [], hasMore: body.hasMore === true, oldestSeq: body.oldestSeq };
}

/** 读取 env 指向的需求 JSON（后端归一化后的列表）。 */
export const fetchRequirements = async (): Promise<requirementItem[]> => {
  const body = await requestJson<requirementsResponse>('/api/requirements', '加载需求失败');
  return body.items ?? [];
}

/** POST /api/requirements/send 的响应：分批任务已启动。 */
export type requirementSendMode = 'continuous' | 'single';

export interface startRequirementsSendResponse {
  jobId?: string;
  sessionId?: string;
  mode?: requirementSendMode;
  totalItems?: number;
  pendingItems?: number;
  completedBefore?: number;
  totalBatches?: number;
  batchSize?: number;
  compactEvery?: number;
  stopAfterBatches?: number;
  error?: string;
}

export interface classificationBatchProgress {
  index: number;
  offset: number;
  count: number;
  status: 'pending' | 'running' | 'done' | 'error';
  requestId?: string;
  text?: string;
  reason?: string;
  error?: string;
}

export interface classificationJob {
  id: string;
  sessionId: string;
  mode: requirementSendMode;
  batchSize: number;
  compactEvery: number;
  /** 跑满多少批就停；0 表示不限 */
  stopAfterBatches: number;
  totalItems: number;
  pendingItems: number;
  completedBefore: number;
  totalBatches: number;
  status: 'running' | 'done' | 'error' | 'cancelled';
  error?: string;
  batches: classificationBatchProgress[];
}

export interface startRequirementsSendOptions {
  batchSize: number;
  mode: requirementSendMode;
  compactEvery: number;
  /** 跑满多少批就停；0 表示不限，一直发到没有待处理需求 */
  stopAfterBatches: number;
}

/** 启动分批发送：固定会话、每批 batchSize 条。 */
export const startRequirementsSend = async (
  options: startRequirementsSendOptions,
): Promise<startRequirementsSendResponse> => {
  const body = await requestJson<startRequirementsSendResponse>(
    '/api/requirements/send',
    '启动分批发送失败',
    post(options),
  );
  if (body.jobId === undefined || body.sessionId === undefined) {
    throw new Error('后端没有返回 jobId/sessionId');
  }
  return body;
};

/** 查询分批任务进度。 */
export const fetchClassificationJob = async (jobId: string): Promise<classificationJob> =>
  requestJson<classificationJob>(
    `/api/requirements/send/${encodeURIComponent(jobId)}`,
    '查询发送进度失败',
  );

/** 停止分批任务。 */
export const cancelClassificationJob = async (
  jobId: string,
): Promise<{ accepted?: true; status?: string; error?: string }> =>
  requestJson(
    `/api/requirements/send/${encodeURIComponent(jobId)}/cancel`,
    '取消发送失败',
    post({}),
  );