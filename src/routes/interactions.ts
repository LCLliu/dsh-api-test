import { Router } from 'express';
import type { approvalsService } from '../approvals.js';
import type { approvalDecision, questionAnswerItem } from '../../shared/dsh-type.js';

/** 审批和用户提问的查询/回传。 */
export const createInteractionsRouter = (approvals: approvalsService): Router => {
  const router = Router();

  router.get('/approvals', (req, res) => {
    const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : '';
    if (sessionId === '') {
      res.status(400).json({ error: 'sessionId 必填' });
      return;
    }
    res.json(approvals.list(sessionId));
  });

  router.post('/approvals/:eventId', async (req, res) => {
    const { decision } = req.body as { decision?: approvalDecision };
    if (decision !== 'allowed-once' && decision !== 'rejected') {
      res.status(400).json({ error: 'decision 只能是 allowed-once 或 rejected' });
      return;
    }

    try {
      await approvals.decide(req.params.eventId, decision);
      res.json({ accepted: true });
    } catch (err) {
      const message = (err as Error).message;
      res.status(message.includes('失效') ? 404 : 502).json({ error: message });
    }
  });

  router.get('/questions', (req, res) => {
    const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : '';
    if (sessionId === '') {
      res.status(400).json({ error: 'sessionId 必填' });
      return;
    }
    res.json(approvals.listQuestions(sessionId));
  });

  router.post('/questions/:eventId', async (req, res) => {
    const { answers } = req.body as { answers?: questionAnswerItem[] };
    if (!Array.isArray(answers) || answers.length === 0) {
      res.status(400).json({ error: 'answers 不能为空' });
      return;
    }

    try {
      await approvals.answer(req.params.eventId, answers);
      res.json({ accepted: true });
    } catch (err) {
      const message = (err as Error).message;
      res.status(message.includes('失效') ? 404 : 502).json({ error: message });
    }
  });

  return router;
};
