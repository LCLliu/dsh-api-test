import { useEffect, useRef, useState } from 'react';
import type { chatMessage, commandDescriptor } from '../../../shared/dsh-type.ts';
import {
  cancelTurn,
  createSession,
  executeCommand,
  fetchReply,
  loadCommands,
  sendPrompt,
} from '../api';
import { clearStoredChat, readStoredChat, writeStoredChat } from '../storage';

const REPLY_POLL_MS = 1500;
const REPLY_TIMEOUT_MS = 20 * 60_000;

/**
 * 会话与消息流的全部状态：会话 id、消息、输入草稿、当前轮次、命令目录。
 */
export const useChatSession = () => {
  const [sessionId, setSessionId] = useState('');
  const [messages, setMessages] = useState<chatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState<boolean>();
  const [canceling, setCanceling] = useState(false);
  const [pendingRequestId, setPendingRequestId] = useState<string>();
  const [commands, setCommands] = useState<commandDescriptor[]>([]);
  const [commandsStatus, setCommandsStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [commandsError, setCommandsError] = useState('');

  const pollToken = useRef(0);
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

  /** 只查一次、不等待；靠轮询把长于 HTTP 请求的一轮接回来。 */
  const waitForReply = async (targetSessionId: string, requestId: string) => {
    const token = ++pollToken.current;
    const startedAt = Date.now();

    while (true) {
      if (pollToken.current !== token) return;

      await new Promise((resolve) => setTimeout(resolve, REPLY_POLL_MS));

      const reply = await fetchReply(targetSessionId, requestId);

      if (reply?.done === true) {
        const text = reply.text?.trim() ?? '';
        pushMessage(
          'assistant',
          text !== '' ? text : `本轮没有文本回复，结束原因：${reply.reason ?? 'unknown'}`,
        );
        return;
      }

      if (Date.now() - startedAt > REPLY_TIMEOUT_MS) {
        throw new Error('等待回复超时（20 分钟），dsh 可能仍在执行');
      }
    }
  };

  /** 提交输入：命中已知斜杠命令走 commands/execute，否则作为普通消息发送并轮询回复。 */
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
      await waitForReply(sessionId, requestId);
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
   * 切到另一个对话,状态一次set完，不取消dsh的轮次，只停本地的轮询，切回来的时候历史自己会带结果回来
   */
  const loadSession = (id: string, history: chatMessage[]) => {
    pollToken.current += 1;
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

  const startSession = async (): Promise<void> => {
    setSessionId(await createSession());
  };

  const reset = () => {
    pollToken.current += 1;
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

  // 刷新后接回上一次会话；pendingRequestId 还在说明那一轮可能仍在跑，继续轮询
  useEffect(() => {
    const saved = readStoredChat();
    if (saved === undefined) return;

    setSessionId(saved.sessionId);
    setMessages(saved.messages);

    if (saved.pendingRequestId === undefined) return;

    setPendingRequestId(saved.pendingRequestId);
    setSending(true);
    void waitForReply(saved.sessionId, saved.pendingRequestId)
      .catch(pushError)
      .finally(() => {
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
  };
};

export type chatSession = ReturnType<typeof useChatSession>;
