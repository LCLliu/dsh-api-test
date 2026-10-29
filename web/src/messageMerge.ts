import type { chatMessage } from '../../shared/dsh-type.ts';

/** 本地气泡的 id 前缀；服务端历史用 dsh-<seq>，靠这个前缀区分两边。 */
const LOCAL_PREFIX = 'local-';

export const localMessageId = (): string => `${LOCAL_PREFIX}${crypto.randomUUID()}`;

export const isLocalMessage = (message: chatMessage): boolean => message.id.startsWith(LOCAL_PREFIX);

/** 流式定稿文本和落库文本可能差个换行，比对时忽略空白差异。 */
export const normalizeText = (text: string): string => text.replace(/\s+/g, ' ').trim();

/**
 * 服务端历史按 id 认不出本地乐观气泡，所以同角色同内容视为同一条：
 * 把本地那条的 id 换成服务端 id（位置不动），认不出才追加。
 * 认领后它不再是本地气泡，下一条同内容的服务端消息不会被错认。
 */
export const mergeIncoming = (current: chatMessage[], incoming: chatMessage[]): chatMessage[] => {
  const merged = [...current];
  const known = new Set(merged.map((message) => message.id));

  for (const message of incoming) {
    if (known.has(message.id)) continue;
    known.add(message.id);

    const twin = merged.findIndex((item) =>
      isLocalMessage(item) && item.role === message.role
      && normalizeText(item.text) === normalizeText(message.text),
    );
    if (twin === -1) {
      merged.push(message);
      continue;
    }
    merged[twin] = { ...merged[twin], id: message.id };
  }

  return merged;
};
