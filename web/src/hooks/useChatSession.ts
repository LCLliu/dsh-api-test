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
import { localMessageId, mergeIncoming } from '../messageMerge';
import { clearStoredChat, readStoredChat, writeStoredChat } from '../storage';

/** 分批分类单轮上限 10 分钟（后端 jobs.ts），这里留一点余量，避免订阅永久挂着。 */
const BATCH_FOLLOW_TIMEOUT_MS = 11 * 60_000;

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
  /** 镜像当前消息，供流式写气泡时在更新函数外面决定落点。 */
  const messagesRef = useRef<chatMessage[]>([]);
  /** 事件流是否占着聊天区：刷新和接别的轮次都要让路，避免半截文本被再补一条。 */
  const streamingRef = useRef(false);
  /** 从按下发送到第一轮增量到达之间的空档，同样视为忙。 */
  const busyRef = useRef(false);
  const commandsPromise = useRef<{ sessionId: string; promise: Promise<commandDescriptor[]> } | null>(null);

  const pushMessage = (role: chatMessage['role'], text: string) => {
    const id = localMessageId();
    setMessages((list) => [...list, { id, role, text }]);
  };

  const pushError = (error: unknown) => {
    pushMessage('error', error instanceof Error ? error.message : String(error));
  };

  /** 整体替换消息时同步镜像，流式落点才不会读到上一份状态。 */
  const replaceMessages = (next: chatMessage[]) => {
    messagesRef.current = next;
    setMessages(next);
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
   * 接一轮流式回复：增量写进气泡，done 时用定稿文本覆盖。
   * 切会话或新建对话时由 streamAbort 关掉事件流。
   * adoptTrailingAssistant 只给刷新后接回同一轮用——那时最后一条就是自己写了一半的气泡。
   */
  const streamTurn = (
    targetSessionId: string,
    requestId: string,
    options: { adoptTrailingAssistant?: boolean; timeoutMs?: number } = {},
  ): Promise<void> => new Promise((resolve) => {
    let bubbleId = '';
    let buffer = '';
    let closeStream: (() => void) | undefined;

    /**
     * 落点必须在更新函数外面定：StrictMode 会把更新函数调两次，
     * 在里面给外层 bubbleId 赋值会让可见气泡和跟踪的那条分家，打字机就卡住不动了。
     */
    const write = (text: string) => {
      if (bubbleId === '') {
        const last = messagesRef.current[messagesRef.current.length - 1];
        bubbleId = options.adoptTrailingAssistant === true && last !== undefined && last.role === 'assistant'
          ? last.id
          : localMessageId();
      }
      const id = bubbleId;
      setMessages((list) => list.some((item) => item.id === id)
        ? list.map((item) => (item.id === id ? { ...item, text } : item))
        : [...list, { id, role: 'assistant', text }]);
    };

    const stop = () => {
      streamAbort.current = undefined;
      streamingRef.current = false;
      setStreaming(false);
      resolve();
    };

    streamingRef.current = true;
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
    }, options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs });
  });

  /** 提交输入：命中已知斜杠命令走 commands/execute，否则作为普通消息发送并接流式回复。 */
  const submit = async (): Promise<void> => {
    const text = input.trim();
    if (sessionId === '' || text === '' || sending) return;

    pushMessage('user', text);
    setInput('');
    setSending(true);
    busyRef.current = true;
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
      busyRef.current = false;
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
    replaceMessages(history);
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

  /** 拉一页最新历史并合并进当前列表；流式写入占着聊天区时让路。 */
  const pullHistory = useCallback(async (targetSessionId: string): Promise<void> => {
    if (targetSessionId === '' || streamingRef.current) return;
    try {
      const page = await fetchHistory(targetSessionId, 30);
      setMessages((current) => mergeIncoming(current, page.messages));
    } catch {
      // 自动刷新失败不打断当前界面
    }
  }, []);

  /** 只补新增消息，并认领本地乐观气泡，避免刷新一次多出一条重复。 */
  const refreshHistory = useCallback(async (): Promise<void> => {
    await pullHistory(sessionId);
  }, [pullHistory, sessionId]);

  /**
   * 分批分类任务在同一会话新起一轮：先开流，历史并行补进来。
   * 顺序不能反——等历史拉完再订阅，开头那段增量就错过了。
   * 聊天区自己正忙时直接让路。
   */
  const followBatch = useCallback(async (
    targetSessionId: string,
    requestId: string,
  ): Promise<void> => {
    if (targetSessionId === '' || streamingRef.current || busyRef.current) return;

    const history = fetchHistory(targetSessionId, 30).catch(() => undefined);
    const turn = streamTurn(targetSessionId, requestId, { timeoutMs: BATCH_FOLLOW_TIMEOUT_MS });

    const page = await history;
    if (page !== undefined) setMessages((current) => mergeIncoming(current, page.messages));
    await turn;
  }, []);

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
    replaceMessages([]);
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
    replaceMessages(saved.messages);
    // 存的是上次的快照，先把它补齐到最新，否则一打开看到的是很早的内容
    void pullHistory(saved.sessionId);

    if (saved.pendingRequestId === undefined) return;

    setPendingRequestId(saved.pendingRequestId);
    setSending(true);
    void streamTurn(saved.sessionId, saved.pendingRequestId, { adoptTrailingAssistant: true }).finally(() => {
      setPendingRequestId(undefined);
      setSending(false);
    });
  }, []);

  // 追加/合并后同步镜像，供流式写入决定落点
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

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
    followBatch,
    openSession,
  };
};

export type chatSession = ReturnType<typeof useChatSession>;
