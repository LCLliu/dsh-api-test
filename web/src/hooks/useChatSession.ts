import { useCallback, useEffect, useRef, useState } from 'react';
import type { chatMessage, commandDescriptor } from '../../../shared/dsh-type.ts';
import {
  cancelTurn,
  createSession,
  executeCommand,
  fetchHistory,
  loadCommands,
  sendPrompt,
  streamReply,
} from '../api';
import { clearStoredChat, readStoredChat, writeStoredChat } from '../storage';

/**
 * 会话与消息流的全部状态：会话 id、消息、输入草稿、当前轮次、命令目录。
 */
export const useChatSession = () => {
  const [sessionId, setSessionId] = useState('');
  const [messages, setMessages] = useState<chatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState<boolean>();
  const [streaming, setStreaming] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [pendingRequestId, setPendingRequestId] = useState<string>();
  const [commands, setCommands] = useState<commandDescriptor[]>([]);
  const [commandsStatus, setCommandsStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [commandsError, setCommandsError] = useState('');

  const streamAbort = useRef<(() => void) | undefined>(undefined);
  const commandsPromise = useRef<{ sessionId: string; promise: Promise<commandDescriptor[]> } | null>(null);

  const pushMessage = (role: chatMessage['role'], text: string) => {
    setMessages((list) => [...list, { id: crypto.randomUUID(), role, text }]);
  };

  const pushError = (error: unknown) => {
    pushMessage('error', error instanceof Error ? error.message : String(error));
  };

  /** 同一会话只发一次命令目录请求，重复调用复用同一个 promise。 */
  const ensureCommands = (): Promise<commandDescriptor[]> => {
    if (commandsPromise.current?.sessionId !== sessionId) {
      const promise = loadCommands(sessionId);
      commandsPromise.current = { sessionId, promise };
      promise.catch(() => {
        if (commandsPromise.current?.promise === promise) commandsPromise.current = null;
      });
    }
    return commandsPromise.current.promise;
  };

  /**
   * 接一轮流式回复：增量写进同一个气泡，done 时用定稿文本覆盖。
   * 切会话或新建对话时由 streamAbort 关掉事件流。
   */
  const streamTurn = (targetSessionId: string, requestId: string): Promise<void> => new Promise((resolve) => {
    let bubbleId = '';
    let buffer = '';
    let closeStream: (() => void) | undefined;

    const write = (text: string) => {
      if (bubbleId !== '') {
        setMessages((list) => list.map((item) => (item.id === bubbleId ? { ...item, text } : item)));
        return;
      }

      // 刷新后接回同一轮时，最后一条就是刚才写了一半的 assistant 气泡，续着它写而不是再开一个
      setMessages((list) => {
        const last = list[list.length - 1];
        bubbleId = last !== undefined && last.role === 'assistant' ? last.id : crypto.randomUUID();
        return last !== undefined && last.role === 'assistant'
          ? list.map((item) => (item.id === bubbleId ? { ...item, text } : item))
          : [...list, { id: bubbleId, role: 'assistant', text }];
      });
    };

    const stop = () => {
      streamAbort.current = undefined;
      setStreaming(false);
      resolve();
    };

    setStreaming(true);
    streamAbort.current = () => {
      closeStream?.();
      stop();
    };

    closeStream = streamReply(targetSessionId, requestId, {
      onDelta: (delta) => {
        buffer += delta;
        write(buffer);
      },
      onDone: (result) => {
        const text = result.text.trim();
        write(text !== '' ? text : (buffer !== '' ? buffer : `本轮没有文本回复，结束原因：${result.reason}`));
        stop();
      },
      onError: (message) => {
        if (buffer !== '') write(`${buffer}\n（中断：${message}）`);
        else pushMessage('error', message);
        stop();
      },
    });
  });

  /** 提交输入：命中已知斜杠命令走 commands/execute，否则作为普通消息发送并接流式回复。 */
  const submit = async (): Promise<void> => {
    const text = input.trim();
    if (sessionId === '' || text === '' || sending) return;

    pushMessage('user', text);
    setInput('');
    setSending(true);
    try {
      const name = text.match(/^\/(\S+)/)?.[1];

      if (name !== undefined) {
        let known = commands;
        if (known.length === 0 && commandsStatus !== 'error') {
          known = await ensureCommands().catch(() => []);
        }

        if (known.some((command) => command.name === name)) {
          const body = await executeCommand(sessionId, text);
          pushMessage(body.kind === 'error' ? 'error' : 'command', body.text ?? `/${name} 已执行`);
          return;
        }
      }

      const requestId = await sendPrompt(sessionId, text);
      setPendingRequestId(requestId);
      await streamTurn(sessionId, requestId);
    } catch (error) {
      pushError(error);
    } finally {
      setPendingRequestId(undefined);
      setSending(false);
    }
  };

  /** 取消当前轮次；返回是否成功，成功后由调用方清掉审批卡片。 */
  const cancel = async (): Promise<boolean> => {
    if (sessionId === '' || canceling) return false;

    setCanceling(true);
    try {
      await cancelTurn(sessionId);
      return true;
    } catch (error) {
      pushError(error);
      return false;
    } finally {
      setCanceling(false);
    }
  };

  /**
   * 切到另一个对话,状态一次set完，不取消dsh的轮次，只断掉本地的事件流，切回来的时候历史自己会带结果回来
   */
  const loadSession = (id: string, history: chatMessage[]) => {
    streamAbort.current?.();
    commandsPromise.current = null;
    setSessionId(id);
    setMessages(history);
    setInput('');
    setPendingRequestId(undefined);
    setSending(false);
    setCommands([]);
    setCommandsStatus('idle');
  };

  /** 加载改造的页面信息 */
  const prependMessages = (older: chatMessage[]) => {
    setMessages((list) => [...older, ...list]);
  }

  /** 只补新增消息，避免覆盖已经加载的更早历史。 */
  const refreshHistory = useCallback(async (): Promise<void> => {
    if (sessionId === '') return;
    try {
      const page = await fetchHistory(sessionId, 30);
      setMessages((current) => {
        const seen = new Set(current.map((message) => message.id));
        const incoming = page.messages.filter((message) => !seen.has(message.id));
        return incoming.length === 0 ? current : [...current, ...incoming];
      });
    } catch {
      // 自动刷新失败不打断当前界面
    }
  }, [sessionId]);

  /** 打开一个已有会话（用于“查看分类会话”），加载后可以继续聊天。 */
  const openSession = async (id: string): Promise<void> => {
    const page = await fetchHistory(id, 30);
    loadSession(id, page.messages);
  };

  const startSession = async (): Promise<void> => {
    setSessionId(await createSession());
  };

  const reset = () => {
    streamAbort.current?.();
    clearStoredChat();
    commandsPromise.current = null;
    setSessionId('');
    setMessages([]);
    setInput('');
    setPendingRequestId(undefined);
    setSending(false);
    setCommands([]);
    setCommandsStatus('idle');
    setCommandsError('');
  };

  useEffect(() => {
    if (sessionId === '' || commandsStatus !== 'idle') return;

    setCommandsStatus('loading');
    void ensureCommands().then(
      (list) => {
        setCommands(list);
        setCommandsStatus('ready');
      },
      (error) => {
        setCommandsError(error instanceof Error ? error.message : String(error));
        setCommandsStatus('error');
      },
    );
  }, [sessionId, commandsStatus]);

  // 刷新后接回上一次会话；pendingRequestId 还在说明那一轮可能仍在跑，继续接它的流
  useEffect(() => {
    const saved = readStoredChat();
    if (saved === undefined) return;

    setSessionId(saved.sessionId);
    setMessages(saved.messages);

    if (saved.pendingRequestId === undefined) return;

    setPendingRequestId(saved.pendingRequestId);
    setSending(true);
    void streamTurn(saved.sessionId, saved.pendingRequestId).finally(() => {
      setPendingRequestId(undefined);
      setSending(false);
    });
  }, []);

  useEffect(() => {
    if (sessionId === '') return;

    writeStoredChat({
      sessionId,
      messages,
      ...(pendingRequestId === undefined ? {} : { pendingRequestId }),
    });
  }, [sessionId, messages, pendingRequestId]);

  return {
    sessionId,
    messages,
    input,
    setInput,
    sending,
    streaming,
    canceling,
    pendingRequestId,
    commands,
    commandsStatus,
    commandsError,
    pushMessage,
    pushError,
    submit,
    cancel,
    startSession,
    reset,
    loadSession,
    prependMessages,
    refreshHistory,
    openSession,
  };
};

export type chatSession = ReturnType<typeof useChatSession>;
