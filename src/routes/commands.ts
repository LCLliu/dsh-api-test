import { Router } from 'express';
import { dsh } from '../dsh/client.js';

/** 斜杠命令目录和执行。 */
export const createCommandsRouter = (): Router => {
  const router = Router();

  router.get('/commands', async (req, res) => {
    const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : '';
    if (sessionId === '') {
      res.status(400).json({ error: 'sessionId 必填' });
      return;
    }

    try {
      res.json(await dsh.listCommands(sessionId));
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  router.post('/command', async (req, res) => {
    const { sessionId, line } = req.body as { sessionId?: string; line?: string };
    if (!sessionId || !line?.trim()) {
      res.status(400).json({ error: 'sessionId 和 line 必填' });
      return;
    }

    try {
      const execution = await dsh.executeCommand(sessionId, line.trim());
      if (execution === undefined) {
        res.status(400).json({ error: '命令不存在或语法不对' });
        return;
      }
      res.json(execution.result);
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  return router;
};
