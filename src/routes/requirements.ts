import { Router, type Response } from 'express';
import { requirementsSource } from '../config.js';
import { buildRequirementsPrompt, loadRequirements } from '../requirements-classifier.js';
import {
  cancelClassificationJob,
  classificationJobError,
  getClassificationJob,
  isClassificationJobActive,
  startClassificationJob,
  type classificationStartRequest,
} from '../requirements/jobs.js';
import { resetClassificationSession } from '../requirements/session.js';

const sourceOrError = (res: Response): string | undefined => {
  const source = requirementsSource();
  if (source === '') {
    res.status(400).json({ error: '未配置 REQUIREMENTS_JSON_PATH' });
    return undefined;
  }
  return source;
};

/** 需求清单、提示词预览、分批分类任务和固定会话。 */
export const createRequirementsRouter = (): Router => {
  const router = Router();

  router.get('/requirements', async (_req, res) => {
    const source = sourceOrError(res);
    if (source === undefined) return;

    try {
      res.json({ items: await loadRequirements(source) });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  router.get('/requirements/prompt', async (_req, res) => {
    const source = sourceOrError(res);
    if (source === undefined) return;

    try {
      res.json(await buildRequirementsPrompt(source));
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  router.post('/requirements/send', async (req, res) => {
    const source = sourceOrError(res);
    if (source === undefined) return;

    try {
      res.json(await startClassificationJob(source, (req.body ?? {}) as classificationStartRequest));
    } catch (err) {
      if (err instanceof classificationJobError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      res.status(502).json({ error: (err as Error).message });
    }
  });

  router.get('/requirements/send/:jobId', (req, res) => {
    const job = getClassificationJob(req.params.jobId);
    if (job === undefined) {
      res.status(404).json({ error: '任务不存在' });
      return;
    }
    res.json(job);
  });

  router.post('/requirements/send/:jobId/cancel', async (req, res) => {
    try {
      const result = await cancelClassificationJob(req.params.jobId);
      if (result === undefined) {
        res.status(404).json({ error: '任务不存在' });
        return;
      }
      res.json(result);
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  router.post('/requirements/session/reset', async (_req, res) => {
    if (isClassificationJobActive()) {
      res.status(409).json({ error: '已有分类任务在运行，不能重置会话' });
      return;
    }

    try {
      res.json({ sessionId: await resetClassificationSession() });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  return router;
};
