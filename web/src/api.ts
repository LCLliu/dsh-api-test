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
  type replyResponse,
  type sendResponse,
  type sessionListItem,
  type sessionsResponse,
  type resumeResponse,
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

/** 发送一条消息，只返回 requestId，正文靠 fetchReply 轮询获取 */
export const sendPrompt = async (sessionId: string, text: string): Promise<string> => {
  const body = await requestJson<sendResponse>('/api/sendmessage', '发送失败', post({ sessionId, text }));

  if (body.requestId === undefined) {
    throw new Error('后端没有返回 requestId');
  }
  return body.requestId;
};

/**
 * 单次查询某一轮是否结束。
 * 网络失败返回 null（后端重启、断网都属正常，交给调用方继续轮询）；HTTP 报错才抛。
 */
export const fetchReply = async (sessionId: string, requestId: string): Promise<replyResponse | null> => {
  const res = await fetch(
    `/api/reply?sessionId=${encodeURIComponent(sessionId)}&requestId=${encodeURIComponent(requestId)}`,
  ).catch(() => null);

  if (res === null) return null;

  if (!res.ok) {
    const failed = await res.json().catch(() => ({})) as replyResponse;
    throw new Error(failed.error ?? `查询回复失败（HTTP ${res.status}）`);
  }
  return await res.json().catch(() => null);
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

/** 返回选择的会话历史的会话的Id */
export const resumeSession = async (sessionId: string, cwd?: string): Promise<string> => {
  const body = await requestJson<resumeResponse>('/api/resume', '打开对话失败', post({ sessionId, ...(cwd === undefined ? {} : { cwd }) }));
  if (body.sessionId === undefined) {
    throw new Error('后端没有返回sessionId');
  }
  return body.sessionId;
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