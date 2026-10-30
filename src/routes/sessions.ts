import { Router } from 'express';
import { findActiveTurn } from '../dsh/active.js';
import { dsh } from '../dsh/client.js';
import { collectHistory, toListItem } from '../sessions/history.js';

/** 会话列表、认领历史会话、读取历史消息。 */
export const createSessionsRouter = (): Router => {
  const router = Router();

  router.get('/session', async (_req, res) => {
    try {
      const sessionList = await dsh.listSessions();
      const items = sessionList.items
        .filter((row) => row.origin !== 'subagent' && row.blank !== true)
        .map(toListItem)
        .sort((a, b) => b.updatedAt - a.updatedAt);
      res.json({ items });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  /** 打开会话时查一下有没有正在跑的一轮，前端拿到 requestId 就能接上流。 */
  router.get('/session/active', async (req, res) => {
    const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : '';
    if (!sessionId) {
      res.status(400).json({ error: 'sessionId 必填' });
      return;
    }

    try {
      res.json(await findActiveTurn(sessionId));
    } catch (err) {
      const message = (err as Error).message;
      res.status(message.includes('不存在') ? 404 : 502).json({ error: message });
    }
  });

  router.get('/history', async (req, res) => {
    const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : '';
    const beforeSeq = typeof req.query.beforeSeq === 'string' ? Number(req.query.beforeSeq) : undefined;
    const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : 30;

    if (!sessionId) {
      res.status(400).json({ error: 'sessionId 必填' });
      return;
    }

    try {
      const page = await collectHistory(sessionId, Math.min(Math.max(limit, 1), 100), beforeSeq);
      res.json({
        sessionId,
        messages: page.visible.map(({ seq, ...message }) => message),
        hasMore: page.hasMore,
        oldestSeq: page.oldestSeq,
      });
    } catch (err) {
      const message = (err as Error).message;
      res.status(message.includes('不存在') ? 404 : 502).json({ error: message });
    }
  });

  return router;
};
