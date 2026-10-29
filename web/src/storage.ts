import type { chatMessage } from '../../shared/dsh-type.ts';

const STORAGE_KEY = 'apitest:chat';

// 将打开的信息储存在浏览器的localStorage，这样子打开的时候就能读取浏览器内的信息打开上一次的对话信息
export interface storedChat {
  sessionId: string;
  messages: chatMessage[];
  pendingRequestId?: string;
}

export const readStoredChat = (): storedChat | undefined => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return undefined;
    const value = JSON.parse(raw) as storedChat;
    if (typeof value.sessionId !== 'string' || value.sessionId === '' || !Array.isArray(value.messages)) {
      return undefined;
    }
    return value;
  } catch {
    return undefined;
  }
};

export const writeStoredChat = (value: storedChat): void => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // 超出 localStorage 配额时放弃持久化
  }
};

export const clearStoredChat = (): void => {
  localStorage.removeItem(STORAGE_KEY);
};
