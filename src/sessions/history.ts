import type {
  chatMessage,
  sessionListItem,
  sessionPageValue,
  sessionSummary,
} from '../../shared/dsh-type.js';
import { dsh } from '../dsh/client.js';

type pageEvent = sessionPageValue['records'][number]['event'];

const sessionTitle = (row: sessionSummary): string => {
  const values = row.projections?.values ?? {};
  if (typeof values.title === 'string' && values.title !== '') return values.title;

  const firstPromt = values.turnOutline?.[0].prompt;
  if (typeof firstPromt === 'string' && firstPromt !== '') return firstPromt.slice(0, 24);

  return `会话 ... ${row.sessionId.slice(-8)}`;
};

/** session/list 的一行转成 UI 需要的摘要。 */
export const toListItem = (row: sessionSummary): sessionListItem => ({
  sessionId: row.sessionId,
  title: sessionTitle(row),
  updatedAt: row.updatedAt,
  ...(row.cwd === undefined ? {} : { cwd: row.cwd }),
  running: row.running,
});

export type historyEntry = chatMessage & { seq: number };

/** 把一页原始事件渲染为消息气泡；工具调用和 step 事件暂不渲染。 */
const toHistoryEntries = (events: pageEvent[]): historyEntry[] => {
  const entries: historyEntry[] = [];

  for (const event of events) {
    // 压缩/替换产生的事件先跳过
    if (event.surfaceOp !== undefined && event.surfaceOp !== 'append') continue;

    if (event.type === 'user/message') {
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

/** 从日志尾部往前翻，返回最近 limit 条消息。 */
export const collectHistory = async (sessionId: string, limit: number, beforeSeq?: number) => {
  const projections = await dsh.projections(sessionId);
  if (projections === null) throw new Error('会话不存在');

  const entries: historyEntry[] = [];
  let cursor = beforeSeq;
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
    oldestSeq: visible.length === 0 ? beforeSeq : visible[0].seq,
  };
};
