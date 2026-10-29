import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { dsh } from '../dsh/client.js';
import { findReply } from '../dsh/reply.js';

/** 会话创建、发消息、查回复、取消当前轮。 */
export const createChatRouter = (): Router => {
  const router = Router();

  router.post('/createSession', async (_req, res) => {
    try {
      res.json(await dsh.createSession());
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  router.post('/sendmessage', async (req, res) => {
    const { sessionId, text } = req.body as { sessionId?: string; text?: string };

    if (!sessionId || !text?.trim()) {
      res.status(400).json({ error: 'sessionId 和 text 必填' });
      return;
    }

    try {
      const requestId = randomUUID();
      await dsh.prompt({
        requestId,
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
      });
      res.json({ accepted: true, requestId });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  router.get('/reply', async (req, res) => {
    const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : '';
    const requestId = typeof req.query.requestId === 'string' ? req.query.requestId : '';
    if (sessionId === '' || requestId === '') {
      res.status(400).json({ error: 'sessionId 和 requestId 必填' });
      return;
    }

    try {
      res.json(await findReply(sessionId, requestId));
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  router.post('/cancel', async (req, res) => {
    const { sessionId } = req.body as { sessionId?: string };
    if (!sessionId) {
      res.status(400).json({ error: 'sessionId 必填' });
      return;
    }

    try {
      res.json(await dsh.cancl(sessionId));
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  return router;
};
