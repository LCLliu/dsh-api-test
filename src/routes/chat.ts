import { Router, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { dsh } from '../dsh/client.js';
import { followTurn } from '../dsh/stream.js';

/** SSE 一帧：事件名 + JSON 负载。 */
const writeEvent = (res: Response, name: string, data: unknown): void => {
  res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
};

/** 会话创建、发消息、流式读回复、取消当前轮。 */
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

  /** 用 SSE 推一轮回复：delta 逐段、done 定稿、error 失败；客户端断开即取消订阅。 */
  router.get('/reply/stream', (req: Request, res: Response) => {
    const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : '';
    const requestId = typeof req.query.requestId === 'string' ? req.query.requestId : '';
    if (sessionId === '' || requestId === '') {
      res.status(400).json({ error: 'sessionId 和 requestId 必填' });
      return;
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });

    const controller = new AbortController();
    req.on('close', () => controller.abort());

    // 订阅别人已经起好的轮次（分批分类任务）时，前端会带超时，避免这一轮已结束时一直挂着
    const requestedTimeout = Number(req.query.timeoutMs);
    const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0 ? requestedTimeout : undefined;

    void followTurn(sessionId, requestId, {
      signal: controller.signal,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      onDelta: (text) => writeEvent(res, 'delta', { text }),
    }).then(
      (result) => writeEvent(res, 'done', result),
      (error: unknown) => writeEvent(res, 'error', {
        error: error instanceof Error ? error.message : String(error),
      }),
    ).finally(() => {
      res.end();
    });
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
