import { randomUUID } from 'node:crypto';
import { dsh } from '../dsh/client.js';
import { findReply } from '../dsh/reply.js';
import {
  buildRequirementsPromptBatch,
  loadRequirementsForPrompt,
  persistClassification,
  type classificationUpdate,
  type promptRequirement,
} from '../requirements-classifier.js';
import { ensureClassificationSession } from './session.js';

type classificationBatchStatus = 'pending' | 'running' | 'done' | 'error';

export interface classificationBatchProgress {
  index: number;
  offset: number;
  count: number;
  itemIds: string[];
  status: classificationBatchStatus;
  requestId?: string;
  text?: string;
  reason?: string;
  error?: string;
  startedAt?: number;
  endedAt?: number;
}

export interface classificationJob {
  id: string;
  sessionId: string;
  mode: 'continuous' | 'single';
  batchSize: number;
  compactEvery: number;
  totalItems: number;
  pendingItems: number;
  completedBefore: number;
  totalBatches: number;
  status: 'running' | 'done' | 'error' | 'cancelled';
  error?: string;
  cancelled: boolean;
  batches: classificationBatchProgress[];
  startedAt: number;
  endedAt?: number;
}

export interface classificationStartRequest {
  batchSize?: unknown;
  mode?: unknown;
  compactEvery?: unknown;
}

export interface classificationStartResult {
  jobId: string;
  sessionId: string;
  mode: 'continuous' | 'single';
  batchSize: number;
  compactEvery: number;
  totalItems: number;
  pendingItems: number;
  completedBefore: number;
  totalBatches: number;
}

export class classificationJobError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'classificationJobError';
  }
}

const jobs = new Map<string, classificationJob>();
let activeJobId: string | undefined;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 有分类任务正在跑时，禁止再启动或重置会话。 */
export const isClassificationJobActive = (): boolean => {
  if (activeJobId === undefined) return false;
  const job = jobs.get(activeJobId);
  return job !== undefined && job.status === 'running';
};

const waitForClassificationTurn = async (
  job: classificationJob,
  requestId: string,
): Promise<{ done: true; text: string; reason: string } | undefined> => {
  const startedAt = Date.now();
  while (true) {
    await sleep(1500);
    if (job.cancelled) return undefined;

    const reply = await findReply(job.sessionId, requestId);
    if (reply.done) return reply;
    if (Date.now() - startedAt > 10 * 60_000) return undefined;
  }
};

const runClassificationJob = async (
  job: classificationJob,
  items: promptRequirement[],
  source: string,
): Promise<void> => {
  try {
    for (const batch of job.batches) {
      if (job.cancelled) break;

      const startedAt = Date.now();
      const requestId = randomUUID();
      batch.status = 'running';
      batch.startedAt = startedAt;
      batch.requestId = requestId;

      const runningUpdates: classificationUpdate[] = batch.itemIds.map((id) => ({
        workItemID: id,
        classification: {
          status: 'running',
          batch: batch.index,
          requestId,
          sessionId: job.sessionId,
          classifiedAt: startedAt,
        },
      }));

      try {
        await persistClassification(source, runningUpdates, {
          batch: batch.index,
          requestId,
          sessionId: job.sessionId,
          status: 'running',
          itemIds: batch.itemIds,
          startedAt,
        });
      } catch (err) {
        batch.status = 'error';
        batch.error = (err as Error).message;
        batch.endedAt = Date.now();
        job.status = 'error';
        job.error = `第 ${batch.index} 批进度写入失败：${batch.error}`;
        break;
      }

      const built = buildRequirementsPromptBatch(
        items,
        batch.offset,
        batch.count,
        batch.index,
        job.totalBatches,
      );

      try {
        await dsh.prompt({
          requestId,
          sessionId: job.sessionId,
          mode: 'queue',
          content: [{ type: 'text', text: built.prompt }],
        });

        const reply = await waitForClassificationTurn(job, requestId);
        if (reply === undefined) {
          const endedAt = Date.now();
          const error = job.cancelled ? '已取消' : '等待回复超时';
          batch.status = 'error';
          batch.error = error;
          batch.endedAt = endedAt;

          const updates: classificationUpdate[] = batch.itemIds.map((id) => ({
            workItemID: id,
            classification: {
              status: 'error',
              batch: batch.index,
              requestId,
              sessionId: job.sessionId,
              error,
              classifiedAt: endedAt,
            },
          }));
          await persistClassification(source, updates, {
            batch: batch.index,
            requestId,
            sessionId: job.sessionId,
            status: 'error',
            error,
            itemIds: batch.itemIds,
            startedAt,
            endedAt,
          });

          if (!job.cancelled) {
            job.status = 'error';
            job.error = `第 ${batch.index} 批等待回复超时`;
            break;
          }
        } else {
          const endedAt = Date.now();
          const failed = reply.reason === 'aborted' || reply.reason === 'error';
          const status: 'done' | 'error' = failed ? 'error' : 'done';
          const error = failed ? `结束原因：${reply.reason}` : undefined;

          batch.status = status;
          batch.text = reply.text;
          batch.reason = reply.reason;
          batch.error = error;
          batch.endedAt = endedAt;

          const updates: classificationUpdate[] = batch.itemIds.map((id) => ({
            workItemID: id,
            classification: {
              status,
              batch: batch.index,
              requestId,
              sessionId: job.sessionId,
              reason: reply.reason,
              ...(error === undefined ? {} : { error }),
              classifiedAt: endedAt,
            },
          }));
          await persistClassification(source, updates, {
            batch: batch.index,
            requestId,
            sessionId: job.sessionId,
            status,
            text: reply.text,
            reason: reply.reason,
            ...(error === undefined ? {} : { error }),
            itemIds: batch.itemIds,
            startedAt,
            endedAt,
          });
        }
      } catch (err) {
        const endedAt = Date.now();
        const error = (err as Error).message;
        batch.status = 'error';
        batch.error = error;
        batch.endedAt = endedAt;

        const updates: classificationUpdate[] = batch.itemIds.map((id) => ({
          workItemID: id,
          classification: {
            status: 'error',
            batch: batch.index,
            requestId,
            sessionId: job.sessionId,
            error,
            classifiedAt: endedAt,
          },
        }));
        await persistClassification(source, updates, {
          batch: batch.index,
          requestId,
          sessionId: job.sessionId,
          status: 'error',
          error,
          itemIds: batch.itemIds,
          startedAt,
          endedAt,
        }).catch(() => {});
      }

      if (job.compactEvery > 0 && batch.index % job.compactEvery === 0 && !job.cancelled) {
        try {
          await dsh.executeCommand(job.sessionId, '/compact');
        } catch {
          // compact 失败不影响后续批次
        }
      }

      if (job.cancelled) break;
      if (batch.status === 'error' && job.batches.filter((item) => item.status === 'error').length >= 3) {
        job.status = 'error';
        job.error = '连续批次失败，任务已停止';
        break;
      }
    }

    if (job.status === 'running') {
      const failed = job.batches.filter((batch) => batch.status === 'error').length;
      job.status = job.cancelled ? 'cancelled' : failed > 0 ? 'error' : 'done';
      if (!job.cancelled && failed > 0 && job.error === undefined) job.error = `${failed} 个批次失败`;
    }
  } catch (err) {
    job.status = 'error';
    job.error = (err as Error).message;
  } finally {
    job.endedAt = Date.now();
    if (activeJobId === job.id) activeJobId = undefined;
  }
};

/** 启动固定会话的分批分类任务；校验参数并只发送未完成的需求。 */
export const startClassificationJob = async (
  source: string,
  request: classificationStartRequest,
): Promise<classificationStartResult> => {
  if (isClassificationJobActive()) {
    throw new classificationJobError('已有分类任务在运行，请等待或先停止', 409);
  }

  const requestedBatchSize = typeof request.batchSize === 'number'
    ? request.batchSize
    : Number(request.batchSize);
  const batchSize = Number.isInteger(requestedBatchSize) && requestedBatchSize > 0 && requestedBatchSize <= 50
    ? requestedBatchSize
    : 5;
  const mode: 'continuous' | 'single' = request.mode === 'single' ? 'single' : 'continuous';
  const requestedCompactEvery = typeof request.compactEvery === 'number'
    ? request.compactEvery
    : Number(request.compactEvery);
  const compactEvery = Number.isInteger(requestedCompactEvery) && requestedCompactEvery >= 0 && requestedCompactEvery <= 100
    ? requestedCompactEvery
    : 10;

  const loaded = await loadRequirementsForPrompt(source);
  const pending = loaded.items.filter((item) => item.classification?.status !== 'done');
  if (pending.length === 0) {
    throw new classificationJobError('所有需求都已分类', 400);
  }

  const selected = mode === 'single' ? pending.slice(0, batchSize) : pending;
  const sessionId = await ensureClassificationSession();
  const totalBatches = Math.ceil(selected.length / batchSize);
  const job: classificationJob = {
    id: randomUUID(),
    sessionId,
    mode,
    batchSize,
    compactEvery,
    totalItems: loaded.items.length,
    pendingItems: pending.length,
    completedBefore: loaded.items.length - pending.length,
    totalBatches,
    status: 'running',
    cancelled: false,
    batches: Array.from({ length: totalBatches }, (_, index) => {
      const offset = index * batchSize;
      const count = Math.min(batchSize, selected.length - offset);
      return {
        index: index + 1,
        offset,
        count,
        itemIds: selected.slice(offset, offset + count).map((item) => item.workItemID ?? item.key),
        status: 'pending',
      };
    }),
    startedAt: Date.now(),
  };

  jobs.set(job.id, job);
  activeJobId = job.id;
  void runClassificationJob(job, selected, source);

  return {
    jobId: job.id,
    sessionId,
    mode,
    batchSize,
    compactEvery,
    totalItems: job.totalItems,
    pendingItems: job.pendingItems,
    completedBefore: job.completedBefore,
    totalBatches,
  };
};

export const getClassificationJob = (jobId: string): classificationJob | undefined =>
  jobs.get(jobId);

export const cancelClassificationJob = async (
  jobId: string,
): Promise<{ accepted: true; status?: classificationJob['status'] } | undefined> => {
  const job = jobs.get(jobId);
  if (job === undefined) return undefined;
  if (job.status !== 'running') return { accepted: true, status: job.status };

  job.cancelled = true;
  try {
    await dsh.cancl(job.sessionId);
  } catch {
    // 当前没有正在跑的 turn 时不影响任务退出
  }
  return { accepted: true };
};
