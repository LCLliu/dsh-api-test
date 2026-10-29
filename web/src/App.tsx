import { useEffect, useRef, type KeyboardEvent, useState } from 'react';
import { SessionType } from './components/SessionType';
import { useChatSession } from './hooks/useChatSession';
import { useInteractions } from './hooks/useInteractions';
import { useRequirementSend } from './hooks/useRequirementSend';
import { useSlashMenu } from './hooks/useSlashCommands';
import { useSessionHistory } from './hooks/useSessionHistory';
import { HistoryPanel } from './components/HistoryPanel';
import { CategoryPanel } from './components/CategoryPanel';

export function App() {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [categoryOpen, setCategoryOpen] = useState(false);
  const chat = useChatSession();
  const slash = useSlashMenu({
    sessionId: chat.sessionId,
    input: chat.input,
    commands: chat.commands,
    textareaRef,
    onPick: (command) => chat.setInput(`/${command.name} `),
  });
  const popups = useInteractions({ sessionId: chat.sessionId, pushError: chat.pushError });
  const requirementSend = useRequirementSend();

  const classificationSessionId = requirementSend.sessionId || requirementSend.job?.sessionId || '';
  const completedBatches = requirementSend.job?.batches.filter((batch) => batch.status === 'done').length ?? 0;
  const runningBatch = requirementSend.job?.batches.find((batch) => batch.status === 'running');
  const runningRequestId = runningBatch?.requestId;
  const followedRequestId = useRef('');

  // 分类会话就是当前聊天时：批次一开跑就把 prompt 补进会话并接上这轮的流，不等它结束
  useEffect(() => {
    if (classificationSessionId === '' || chat.sessionId !== classificationSessionId) return;
    if (requirementSend.status !== 'running' || runningRequestId === undefined) return;

    // 同一个批次只接一次；切进/切出这个会话会换 key，重新接上正在跑的那轮
    const followKey = `${chat.sessionId}:${runningRequestId}`;
    if (followedRequestId.current === followKey) return;

    followedRequestId.current = followKey;
    void chat.followBatch(classificationSessionId, runningRequestId);
  }, [
    classificationSessionId,
    chat.sessionId,
    chat.followBatch,
    requirementSend.status,
    runningRequestId,
  ]);

  // 每批完成/任务结束再补拉一次，把这轮定稿文本和命令消息带回来
  useEffect(() => {
    if (classificationSessionId === '' || chat.sessionId !== classificationSessionId) return;
    if (requirementSend.status === 'idle' || requirementSend.status === 'starting') return;
    void chat.refreshHistory();
  }, [
    classificationSessionId,
    completedBatches,
    requirementSend.status,
    chat.sessionId,
    chat.refreshHistory,
  ]);

  const openClassificationSession = async (sessionId: string) => {
    try {
      await chat.openSession(sessionId);
      setCategoryOpen(false);
    } catch (error) {
      chat.pushError(error);
    }
  };

  const history = useSessionHistory({
    open: historyOpen,
    currentSessionId: chat.sessionId,
    onLoad: chat.loadSession,
    onPrepend: chat.prependMessages,
    pushError: chat.pushError,
  })

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (slash.open && slash.items.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        slash.moveActive(1);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        slash.moveActive(-1);
        return;
      }
      if ((event.key === 'Enter' || event.key === 'Tab') && !event.nativeEvent.isComposing) {
        event.preventDefault();
        slash.accept();
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        slash.dismiss();
        return;
      }
    }

    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void chat.submit();
    }
  };

  const handleNewChat = () => {
    chat.reset();
    slash.reset();
  };

  const handleCancel = () => {
    void chat.cancel().then((canceled) => {
      if (canceled) popups.clearApprovals();
    });
  };

  return (
    <>
      <HistoryPanel
        open={historyOpen}
        currentSessionId={chat.sessionId}
        history={history}
        onClose={() => setHistoryOpen(false)}
      />
      <CategoryPanel
        open={categoryOpen}
        onClose={() => setCategoryOpen(false)}
        send={requirementSend}
        onViewSession={openClassificationSession}
      />
      <main
        className='page'
        data-history={historyOpen ? 'open' : 'closed'}
        data-category={categoryOpen ? 'open' : 'closed'}
      >
        <section className={`card${chat.sessionId === '' ? '' : ' card-chat'}`}>
          <div className='topbar'>
            {!historyOpen && <button
              className='ghost'
              onClick={() => setHistoryOpen((value) => !value)}
            >
              {/* {historyOpen ? '关闭历史' : '打开历史'} */}
              历史对话
            </button>}
            <h1 className='title'> dsh API Test</h1>
            <button
              className='Category'
              aria-expanded={categoryOpen}
              onClick={() => setCategoryOpen((value) => !value)}
            >
              分类需求
            </button>
          </div>
          {
            chat.sessionId === '' ? (
              <button className='action' onClick={() => void chat.startSession()}>
                创建会话
              </button>
            ) : (
              <SessionType
                chat={chat}
                slash={slash}
                popups={popups}
                textareaRef={textareaRef}
                onKeyDown={handleKeyDown}
                onSubmit={() => void chat.submit()}
                onCancel={handleCancel}
                onNewChat={handleNewChat}
              />
            )
          }
        </section>
      </main>
    </>
  );
}
