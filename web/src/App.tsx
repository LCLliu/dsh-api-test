import { useRef, type KeyboardEvent, useState } from 'react';
import { SessionType } from './components/SessionType';
import { useChatSession } from './hooks/useChatSession';
import { useInteractions } from './hooks/useInteractions';
import { useSlashMenu } from './hooks/useSlashCommands';
import { useSessionHistory } from './hooks/useSessionHistory';
import { HistoryPanel } from './components/HistoryPanel';

export function App() {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const chat = useChatSession();
  const slash = useSlashMenu({
    sessionId: chat.sessionId,
    input: chat.input,
    commands: chat.commands,
    textareaRef,
    onPick: (command) => chat.setInput(`/${command.name} `),
  });
  const popups = useInteractions({ sessionId: chat.sessionId, pushError: chat.pushError });

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
      <main className='page' data-history={historyOpen ? 'open' : 'closed'}>
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
