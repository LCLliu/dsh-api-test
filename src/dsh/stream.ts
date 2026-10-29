import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type { PageRecord, turnResult } from '../../shared/dsh-type.js';
import { DSH_URL } from '../config.js';
import { dsh, getCookie, resetCookie } from './client.js';

type sessionEvent = PageRecord['event'];

/** session/follow 下行帧：开头快照、持久事件、进程内 assistant 增量。 */
type followFrame =
  | { type: 'snapshot'; records?: { event?: sessionEvent }[] }
  | { type: 'event'; event?: sessionEvent }
  | { type: 'assistant-stream'; frame?: unknown };

interface turnScan {
  /**
   * 本轮事件的水位线：本轮 assistant/message 和 turn/end 都取 seq 大于它的。
   * 默认是开始扫描时的日志水位；找到本轮 user/message 后收紧成它的 seq。
   */
  anchorSeq: number;
  /** 是否已经按 rpcId 精确锚定到本轮的用户消息 */
  anchored: boolean;
  /** 已提交的 assistant 文本，按事件 seq 去重 */
  messages: Map<number, string>;
  /** turn/end 的结束原因；有值说明这一轮已经跑完 */
  reason: string | undefined;
}

export interface turnWatch {
  /** 每来一段增量文本回调一次 */
  onDelta?: (delta: string) => void;
  /** 最长等待时间，默认 20 分钟 */
  timeoutMs?: number;
  /** 外部取消：浏览器断开 SSE 或任务被停止 */
  signal?: AbortSignal;
}

const PAGE_SIZE = 200;
const MAX_PAGES = 10;
const DEFAULT_TIMEOUT_MS = 20 * 60_000;

const eventText = (event: sessionEvent): string => (event.data?.message?.content ?? [])
  .filter((block) => block.type === 'text')
  .map((block) => block.text ?? '')
  .join('');

const isTurnStart = (event: sessionEvent, requestId: string): boolean =>
  event.type === 'user/message' && event.data?.source?.rpcId === requestId;

/**
 * 按 seq 升序把事件并进扫描结果。
 * 本轮的 user/message 是在 turn/start 之后才落盘的，所以它可能已经翻过去了：
 * 找不到就继续用开始扫描时的水位当锚点，只靠 turn/start 之后的事件判定本轮。
 * 快照、翻页和实时帧共用这条规则，重复事件靠 Map 按 seq 去掉。
 */
const absorb = (scan: turnScan, event: sessionEvent, requestId: string): void => {
  if (!scan.anchored && isTurnStart(event, requestId)) {
    scan.anchored = true;
    scan.anchorSeq = event.seq;
    return;
  }
  if (event.seq <= scan.anchorSeq) return;

  if (event.type === 'assistant/message') {
    const text = eventText(event);
    if (text !== '') scan.messages.set(event.seq, text);
  } else if (event.type === 'turn/end') {
    scan.reason = event.data?.reason?.kind ?? 'unknown';
  }
};

const joinMessages = (scan: turnScan): string => [...scan.messages.entries()]
  .sort((a, b) => a[0] - b[0])
  .map(([, text]) => text)
  .join('');

/** 从日志尾部往前翻，找齐这一轮已经落盘的部分。 */
const scanTurn = async (sessionId: string, requestId: string): Promise<turnScan> => {
  const projections = await dsh.projections(sessionId);
  if (projections === null) throw new Error(`会话不存在：${sessionId}`);

  // 找不到本轮 user/message 时，就用当前水位当锚点：本轮的事件一定都排在它后面
  const scan: turnScan = { anchorSeq: projections.asOfSeq, anchored: false, messages: new Map(), reason: undefined };
  let beforeSeq: number | undefined;

  for (let index = 0; index < MAX_PAGES; index += 1) {
    const page = await dsh.page(sessionId, projections.asOfSeq, PAGE_SIZE, beforeSeq);
    const events = page.records.map((record) => record.event).filter((event) => event !== undefined);
    for (const event of events) absorb(scan, event, requestId);

    if (page.hasMore && events.length > 0 && !scan.anchored) {
      beforeSeq = Math.min(...events.map((event) => event.seq));
      continue;
    }
    break;
  }

  return scan;
};

const asFollowFrame = (value: unknown): followFrame | undefined => {
  if (typeof value !== 'object' || value === null) return undefined;
  const frame = value as followFrame;
  return frame.type === 'snapshot' || frame.type === 'event' || frame.type === 'assistant-stream'
    ? frame
    : undefined;
};

/** assistant-stream 的内层帧：start 带 attempt 起点，chunk 带 StreamChunk 负载。 */
interface assistantFramePart {
  type?: string;
  attemptId?: string;
  startedAfterSeq?: number;
  chunk?: unknown;
}

const asAssistantFrame = (value: unknown): assistantFramePart | undefined => {
  if (typeof value !== 'object' || value === null) return undefined;
  return value as assistantFramePart;
};

const asTextDelta = (value: unknown): string | undefined => {
  if (typeof value !== 'object' || value === null) return undefined;
  const chunk = value as { type?: string; text?: string };
  return chunk.type === 'text-delta' && typeof chunk.text === 'string' ? chunk.text : undefined;
};

/**
 * 流式读取一轮回复：先读已落盘的部分，再通过 remote.mux 订阅 session/follow，
 * 把 text-delta 逐段回调出去，直到 turn/end 到达。
 * 定稿文本用持久化的 assistant/message，不用累加的增量，避免断流后少字。
 */
export const followTurn = async (
  sessionId: string,
  requestId: string,
  watch: turnWatch = {},
): Promise<turnResult> => {
  const scan = await scanTurn(sessionId, requestId);
  if (scan.reason !== undefined) return { text: joinMessages(scan), reason: scan.reason };

  const streamed: { text: string } = { text: '' };
  const attempts = new Set<string>();

  await new Promise<void>((resolve, reject) => {
    const streamId = randomUUID();
    let socket: WebSocket | undefined;
    let settled = false;
    let failure: unknown;

    const timer = setTimeout(() => {
      finish(new Error('等待回复超时'));
    }, watch.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    const onAbort = () => finish(new Error('已取消'));

    function finish(error?: unknown): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      watch.signal?.removeEventListener('abort', onAbort);

      if (socket !== undefined) {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'cancel', streamId }));
        }
        socket.close();
      }

      if (error === undefined) resolve();
      else reject(error);
    }

    const handleEvent = (event: sessionEvent): void => {
      absorb(scan, event, requestId);
      if (scan.reason !== undefined) finish();
    };

    const handleFrame = (value: unknown): void => {
      const frame = asFollowFrame(value);
      if (frame === undefined) return;

      if (frame.type === 'snapshot') {
        for (const record of frame.records ?? []) {
          if (record.event !== undefined) handleEvent(record.event);
        }
        return;
      }

      if (frame.type === 'event') {
        if (frame.event !== undefined) handleEvent(frame.event);
        return;
      }

      const part = asAssistantFrame(frame.frame);
      if (part?.attemptId === undefined) return;

      if (part.type === 'start') {
        if (part.startedAfterSeq === undefined || part.startedAfterSeq >= scan.anchorSeq) {
          attempts.add(part.attemptId);
        }
        return;
      }

      if (part.type !== 'chunk' || part.attemptId === undefined) return;

      /**
       * 迟到的订阅拿不到本轮 attempt 的 start 帧（follow 只补发最近一条消息的快照），
       * chunk 会带着没登记过的 attemptId。本轮已经锚定就说明它属于本轮，直接登记；
       * 还没锚定时维持原样，避免把排队中上一轮的输出当成本轮。
       */
      if (!attempts.has(part.attemptId)) {
        if (!scan.anchored) return;
        attempts.add(part.attemptId);
      }

      const delta = asTextDelta(part.chunk);
      if (delta !== undefined && delta !== '') {
        streamed.text += delta;
        watch.onDelta?.(delta);
      }
    };

    const open = async (): Promise<void> => {
      const cookie = await getCookie();
      const ws = new WebSocket(`${DSH_URL.replace(/^http/, 'ws')}/api/remote.mux`, { headers: { cookie } });
      socket = ws;

      ws.on('open', () => {
        ws.send(JSON.stringify({
          type: 'open',
          streamId,
          endpoint: 'session/follow',
          payload: {
            args: {
              request: {
                address: { kind: 'session', sessionId },
                assistantStream: true,
                maxMessages: 1,
              },
            },
          },
        }));
      });

      ws.on('message', (raw) => {
        let frame: { type?: unknown; streamId?: unknown; value?: unknown; error?: { message?: string } };
        try {
          frame = JSON.parse(String(raw)) as typeof frame;
        } catch {
          return;
        }
        if (frame.streamId !== streamId) return;

        if (frame.type === 'item') handleFrame(frame.value);
        else if (frame.type === 'end') finish();
        else if (frame.type === 'error') finish(new Error(frame.error?.message ?? '事件流错误'));
      });

      ws.on('error', (error) => {
        if (/401/.test(error.message)) resetCookie();
        finish(error);
      });

      ws.on('close', () => {
        if (!settled) finish(new Error('事件流已断开'));
      });
    };

    if (watch.signal?.aborted === true) {
      finish(new Error('已取消'));
      return;
    }
    watch.signal?.addEventListener('abort', onAbort);
    open().catch((error: unknown) => finish(error));
  });

  const text = joinMessages(scan);
  return { text: text !== '' ? text : streamed.text, reason: scan.reason ?? 'unknown' };
};
