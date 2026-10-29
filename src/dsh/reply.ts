import type { sessionPageValue } from '../../shared/dsh-type.js';
import { dsh } from './client.js';

type pageEvent = sessionPageValue['records'][number]['event'];

// requestId -> 用户消息的 seq，缓存后轮询时不必每次从最新一页翻回开头
const userSeqByRequest = new Map<string, number>();

/**
 * 单次查询某一轮是否结束。只在请求内读一次事件，不等待、不循环。
 * 前端每 1.5 秒调用一次，后端重启或页面刷新都不影响 dsh 继续跑。
 */
export const findReply = async (
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
