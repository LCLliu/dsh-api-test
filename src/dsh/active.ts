import type { PageRecord } from '../../shared/dsh-type.js';
import { dsh } from './client.js';

type sessionEvent = PageRecord['event'];

const PAGE_SIZE = 200;
const MAX_PAGES = 10;

export interface activeTurn {
  running: boolean;
  requestId?: string;
}

/**
 * 从日志尾部判断会话当前是否有一轮在跑：
 * 最后一条 turn/start 晚于最后一条 turn/end 就是运行中。
 * 本轮 requestId 取上一条 turn/end 之后最早一条带 rpcId 的 user/message，
 * 这样并发排队多条消息时也能锚定到正在执行的那一轮。
 */
export const findActiveTurn = async (sessionId: string): Promise<activeTurn> => {
  const projections = await dsh.projections(sessionId);
  if (projections === null) throw new Error(`会话不存在：${sessionId}`);

  let beforeSeq: number | undefined;
  let latestStart = 0;
  let latestEnd = 0;
  const candidates: Array<{ seq: number; requestId: string }> = [];

  for (let index = 0; index < MAX_PAGES; index += 1) {
    const page = await dsh.page(sessionId, projections.asOfSeq, PAGE_SIZE, beforeSeq);
    const events: sessionEvent[] = page.records.map((record) => record.event);

    for (const event of events) {
      if (event.type === 'turn/start') {
        latestStart = Math.max(latestStart, event.seq);
      } else if (event.type === 'turn/end') {
        latestEnd = Math.max(latestEnd, event.seq);
      } else if (event.type === 'user/message' && event.data?.source?.rpcId !== undefined) {
        candidates.push({ seq: event.seq, requestId: event.data.source.rpcId });
      }
    }

    // 尾部看到的最后一条轮次事件是 turn/end，说明最新一轮已经结束
    if (latestEnd > latestStart) return { running: false };

    // 找到上一条 turn/end 就够了：运行中这轮的用户消息一定排在它后面
    if (latestEnd > 0) break;
    if (!page.hasMore || events.length === 0) break;
    beforeSeq = Math.min(...events.map((event) => event.seq));
  }

  if (latestStart <= latestEnd) return { running: false };

  const anchor = candidates
    .filter((candidate) => candidate.seq > latestEnd)
    .sort((a, b) => a.seq - b.seq)[0];

  return anchor === undefined
    ? { running: true }
    : { running: true, requestId: anchor.requestId };
};
