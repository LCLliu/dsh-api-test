import { useEffect, useState } from 'react';
import type {
  approvalDecision,
  approvalRequest,
  pendingQuestion,
  questionAnswerItem,
  questionItem,
} from '../../../shared/dsh-type.ts';
import { answerQuestion, decideApproval, fetchInteractions } from '../api';

const INTERACTION_POLL_MS = 1_000;

type questionDraft = Record<string, Record<string, { selected: string[]; custom: string }>>;

interface interactionsOptions {
  sessionId: string;
  /** 审批和答题失败要落到消息流里，由会话 hook 提供 */
  pushError: (error: unknown) => void;
}

/** 审批卡片与模型提问卡片：同一条 $events 瀑布，共用一次轮询。 */
export const useInteractions = ({ sessionId, pushError }: interactionsOptions) => {
  const [approvals, setApprovals] = useState<approvalRequest[]>([]);
  const [questionCards, setQuestionCards] = useState<pendingQuestion[]>([]);
  const [drafts, setDrafts] = useState<questionDraft>({});
  const [deciding, setDeciding] = useState<string>();
  const [answering, setAnswering] = useState<string>();

  const draftFor = (card: pendingQuestion, questionId: string) =>
    drafts[card.eventId]?.[questionId] ?? { selected: [], custom: '' };

  const updateDraft = (
    eventId: string,
    questionId: string,
    patch: Partial<{ selected: string[]; custom: string }>,
  ) => {
    setDrafts((all) => ({
      ...all,
      [eventId]: {
        ...all[eventId],
        [questionId]: { ...(all[eventId]?.[questionId] ?? { selected: [], custom: '' }), ...patch },
      },
    }));
  };

  /** 单选换成当前项，多选做增删。 */
  const toggleOption = (card: pendingQuestion, question: questionItem, label: string) => {
    const draft = draftFor(card, question.id);
    const selected = question.multiSelect === true
      ? (draft.selected.includes(label)
          ? draft.selected.filter((item) => item !== label)
          : [...draft.selected, label])
      : [label];
    updateDraft(card.eventId, question.id, { selected });
  };

  const decide = async (eventId: string, decision: approvalDecision): Promise<void> => {
    setDeciding(eventId);
    try {
      await decideApproval(eventId, decision);
      setApprovals((list) => list.filter((item) => item.eventId !== eventId));
    } catch (error) {
      // 已经失效的事件直接撤掉卡片，重试没有意义
      setApprovals((list) => list.filter((item) => item.eventId !== eventId));
      pushError(error);
    } finally {
      setDeciding(undefined);
    }
  };

  const submitAnswers = async (card: pendingQuestion): Promise<void> => {
    setAnswering(card.eventId);
    try {
      const answers: questionAnswerItem[] = card.questions.map((question) => {
        const draft = draftFor(card, question.id);
        const custom = draft.custom.trim();
        if (draft.selected.length === 0 && custom === '') {
          throw new Error(`请先回答：${question.question}`);
        }
        return {
          id: question.id,
          selected: draft.selected,
          ...(custom === '' ? {} : { custom }),
        };
      });

      await answerQuestion(card.eventId, answers);
      setQuestionCards((list) => list.filter((item) => item.eventId !== card.eventId));
      setDrafts((all) => {
        const next = { ...all };
        delete next[card.eventId];
        return next;
      });
    } catch (error) {
      // 失败时保留卡片，方便重试
      pushError(error);
    } finally {
      setAnswering(undefined);
    }
  };

  const clearApprovals = () => setApprovals([]);

  useEffect(() => {
    if (sessionId === '') {
      setApprovals([]);
      setQuestionCards([]);
      return;
    }

    let cancelled = false;

    const load = async () => {
      const result = await fetchInteractions(sessionId);
      if (cancelled) return;
      if (result.approvals !== undefined) setApprovals(result.approvals);
      if (result.questions !== undefined) setQuestionCards(result.questions);
    };

    void load();
    const timer = setInterval(() => { void load(); }, INTERACTION_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [sessionId]);

  return {
    approvals,
    questionCards,
    deciding,
    answering,
    draftFor,
    updateDraft,
    toggleOption,
    decide,
    submitAnswers,
    clearApprovals,
  };
};

export type interactions = ReturnType<typeof useInteractions>;
