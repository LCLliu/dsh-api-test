import { randomUUID } from 'node:crypto';
import { dsh } from '../dsh/client.js';
import { followTurn } from '../dsh/stream.js';
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
  /** 跑满多少批就停；0 表示不限，把待处理需求发完 */
  stopAfterBatches: number;
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
  stopAfterBatches?: unknown;
}

export interface classificationStartResult {
  jobId: string;
  sessionId: string;
  mode: 'continuous' | 'single';
  batchSize: number;
  compactEvery: number;
  /** 跑满多少批就停；0 表示不限，把待处理需求发完 */
  stopAfterBatches: number;
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

/** 每个在跑的任务留一个取消入口，停止任务时直接断掉正在等的流。 */
const jobAborts = new Map<string, AbortController>();

const TURN_TIMEOUT_MS = 10 * 60_000;

/** 有分类任务正在跑时，禁止再启动或重置会话。 */
export const isClassificationJobActive = (): boolean => {
  if (activeJobId === undefined) return false;
  const job = jobs.get(activeJobId);
  return job !== undefined && job.status === 'running';
};

type turnOutcome = { ok: true; text: string; reason: string } | { ok: false; error: string };

/**
 * 流式等一轮回复：增量边到边写进 batch.text，
 * 面板按 1.5 秒轮询任务进度时就能看到回复逐步变长。
 */
const waitForClassificationTurn = async (
  job: classificationJob,
  batch: classificationBatchProgress,
  requestId: string,
): Promise<turnOutcome> => {
  const controller = new AbortController();
  jobAborts.set(job.id, controller);

  try {
    const reply = await followTurn(job.sessionId, requestId, {
      timeoutMs: TURN_TIMEOUT_MS,
      signal: controller.signal,
      onDelta: (delta) => {
        batch.text = (batch.text ?? '') + delta;
      },
    });
    return { ok: true, text: reply.text, reason: reply.reason };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    jobAborts.delete(job.id);
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

        const reply = await waitForClassificationTurn(job, batch, requestId);
        if (reply.ok === false) {
          const endedAt = Date.now();
          const error = reply.error;
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
            job.error = `第 ${batch.index} 批${error}`;
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
  const requestedStopAfter = typeof request.stopAfterBatches === 'number'
    ? request.stopAfterBatches
    : Number(request.stopAfterBatches);
  const stopAfterBatches = Number.isInteger(requestedStopAfter) && requestedStopAfter > 0 && requestedStopAfter <= 200
    ? requestedStopAfter
    : 0;

  const loaded = await loadRequirementsForPrompt(source);
  const pending = loaded.items.filter((item) => item.classification?.status !== 'done');
  if (pending.length === 0) {
    throw new classificationJobError('所有需求都已分类', 400);
  }

  const chosen = mode === 'single' ? pending.slice(0, batchSize) : pending;
  const selected = stopAfterBatches > 0 ? chosen.slice(0, stopAfterBatches * batchSize) : chosen;
  const sessionId = await ensureClassificationSession();
  const totalBatches = Math.ceil(selected.length / batchSize);
  const job: classificationJob = {
    id: randomUUID(),
    sessionId,
    mode,
    batchSize,
    compactEvery,
    stopAfterBatches,
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
    stopAfterBatches,
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
  jobAborts.get(jobId)?.abort();
  try {
    await dsh.cancl(job.sessionId);
  } catch {
    // 当前没有正在跑的 turn 时不影响任务退出
  }
  return { accepted: true };
};
