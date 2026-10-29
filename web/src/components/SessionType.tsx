import { useRef, useEffect, type KeyboardEvent, type RefObject } from 'react';
import type { chatSession } from '../hooks/useChatSession';
import type { interactions } from '../hooks/useInteractions';
import type { slashMenu } from '../hooks/useSlashCommands';
import { ApprovalCards, QuestionCards } from './PopupCard';
import { SlashMenu } from './SlashMenu';

interface sessionTypeProps {
  chat: chatSession;
  slash: slashMenu;
  popups: interactions;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onSubmit: () => void;
  onCancel: () => void;
  onNewChat: () => void;
}

/** 对话主体：会话头、消息流、审批与提问卡片、输入区。 */
export function SessionType({
  chat,
  slash,
  popups,
  textareaRef,
  onKeyDown,
  onSubmit,
  onCancel,
  onNewChat,
}: sessionTypeProps) {
  const listRef = useRef<HTMLDivElement>(null);

  // 当前的对话进行时，发送消息没有自动的追寻底部，现在加上自动贴附底部
  // 当前的对话为底部时，发送消息才会自动贴附底部，如果不是则不贴附。
  const stickToBottom = useRef(true);

  /** 
   * scrollHeight：内容总高度,包括被裁掉、看不见的那部分
   * clientHeight：可见窗口自身的高度（含 padding,不含 border 和横向滚动条）—— 在 CSS 里就是 min(42vh, 360px) 那个值,基本恒定 360
   * scrollTop：已经往上滚掉了多少"当前视口顶边距离内容顶边的距离,在最顶部时为 0
   */
  const handleScroll = () => {
    const el = listRef.current;
    if (el !== null) {
      // 距离底部的距离小于24时默认是底部
      stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    }
  };

  // 流式输出时正文在同一个气泡里变长，用最后一条的长度一起触发贴底
  const lastLength = chat.messages[chat.messages.length - 1]?.text.length ?? 0;

  // 换会话就是换内容，上一份滚动位置不该带进来：打开直接落在最新一条
  useEffect(() => {
    stickToBottom.current = true;
  }, [chat.sessionId]);

  useEffect(() => {
    const el = listRef.current;
    if (el !== null && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [lastLength, chat.sending, chat.sessionId]);

  return (
    <>
      <div className='session-row'>
        <span className='result-label'>sessionId</span>
        <code className='session-id'>{chat.sessionId}</code>
        <button className='ghost' onClick={onNewChat}> 新建对话 </button>
      </div>

      <div className='messages' ref={listRef} onScroll={handleScroll}>
        {chat.messages.length === 0 && !chat.sending && (
          <p className='empty'> 发送信息 </p>
        )}
        {chat.messages.map((item) => (
          <div key={item.id} className={`bubble bubble-${item.role}`}>
            {item.text}
          </div>
        ))}
        {chat.sending && !chat.streaming && <div className='bubble bubble-assistant typing'> 等待dsh 回复...</div>}
      </div>

      <ApprovalCards
        approvals={popups.approvals}
        deciding={popups.deciding}
        onDecide={(eventId, decision) => void popups.decide(eventId, decision)}
      />

      <QuestionCards
        cards={popups.questionCards}
        answering={popups.answering}
        draftFor={popups.draftFor}
        onToggleOption={popups.toggleOption}
        onCustomChange={(eventId, questionId, custom) => popups.updateDraft(eventId, questionId, { custom })}
        onSubmit={(card) => void popups.submitAnswers(card)}
      />

      <div className='composer'>
        <div className='composer-input'>
          {slash.open && (
            <SlashMenu
              status={chat.commandsStatus}
              error={chat.commandsError}
              items={slash.items}
              active={slash.active}
              onPick={slash.pick}
            />
          )}
          <textarea
            ref={textareaRef}
            value={chat.input}
            onChange={(event) => {
              chat.setInput(event.target.value);
              slash.onInputChanged();
            }}
            onKeyDown={onKeyDown}
            placeholder='输入消息，enter 发送，shift+enter 换行，/ 查看命令'
            rows={3}
            disabled={chat.sending}
          />
        </div>
        <button
          className='action'
          onClick={() => (chat.sending ? onCancel() : onSubmit())}
          disabled={chat.sending ? chat.canceling : chat.input.trim() === ''}
        >
          {chat.sending ? (chat.canceling ? '中断中' : '中断') : '发送'}
        </button>
      </div>
    </>
  );
}
