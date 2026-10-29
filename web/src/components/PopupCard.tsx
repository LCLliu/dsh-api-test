import type {
  approvalDecision,
  approvalRequest,
  pendingQuestion,
  questionItem,
} from '../../../shared/dsh-type.ts';

interface approvalCardsProps {
  approvals: approvalRequest[];
  deciding?: string;
  onDecide: (eventId: string, decision: approvalDecision) => void;
}

/** dsh 的 approval/request 瀑布：需要人点一次才能继续。 */
export function ApprovalCards({ approvals, deciding, onDecide }: approvalCardsProps) {
  if (approvals.length === 0) return null;

  return (
    <div className='approvals'>
      {approvals.map((item) => (
        <div key={item.eventId} className='approval-card'>
          <div className='approval-head'>需要审批：{item.toolName}</div>
          {item.reason !== undefined && <p className='approval-reason'>{item.reason}</p>}
          <div className='approval-actions'>
            <button
              className='action'
              disabled={deciding === item.eventId}
              onClick={() => onDecide(item.eventId, 'allowed-once')}
            >
              允许一次
            </button>
            <button
              className='ghost'
              disabled={deciding === item.eventId}
              onClick={() => onDecide(item.eventId, 'rejected')}
            >
              拒绝
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

interface questionCardsProps {
  cards: pendingQuestion[];
  answering?: string;
  draftFor: (card: pendingQuestion, questionId: string) => { selected: string[]; custom: string };
  onToggleOption: (card: pendingQuestion, question: questionItem, label: string) => void;
  onCustomChange: (eventId: string, questionId: string, custom: string) => void;
  onSubmit: (card: pendingQuestion) => void;
}

/** dsh 的 user-questions/request 瀑布：模型发起的澄清提问。 */
export function QuestionCards({
  cards,
  answering,
  draftFor,
  onToggleOption,
  onCustomChange,
  onSubmit,
}: questionCardsProps) {
  return (
    <>
      {cards.map((card) => (
        <div key={card.eventId} className='question-card'>
          {card.questions.map((question) => {
            const draft = draftFor(card, question.id);
            return (
              <div key={question.id} className='question-item'>
                {question.header !== undefined && <div className='question-header'>{question.header}</div>}
                <p className='question-text'>{question.question}</p>
                {question.detail !== undefined && <p className='question-detail'>{question.detail}</p>}

                {question.options?.map((option) => (
                  <label key={option.label} className='question-option'>
                    <input
                      type={question.multiSelect === true ? 'checkbox' : 'radio'}
                      name={`${card.eventId}:${question.id}`}
                      checked={draft.selected.includes(option.label)}
                      onChange={() => onToggleOption(card, question, option.label)}
                    />
                    <span>
                      {option.label}
                      {option.description !== undefined && (
                        <span className='question-option-desc'> — {option.description}</span>
                      )}
                    </span>
                  </label>
                ))}

                <input
                  className='question-custom'
                  placeholder='其他（可选）'
                  value={draft.custom}
                  onChange={(event) => onCustomChange(card.eventId, question.id, event.target.value)}
                />
              </div>
            );
          })}

          <button className='action' disabled={answering === card.eventId} onClick={() => onSubmit(card)}>
            {answering === card.eventId ? '提交中…' : '提交回答'}
          </button>
        </div>
      ))}
    </>
  );
}
