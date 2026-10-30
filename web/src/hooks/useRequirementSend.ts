import { useCallback, useRef, useState } from 'react';
import {
  cancelClassificationJob,
  fetchClassificationJob,
  startRequirementsSend,
  type classificationJob,
  type startRequirementsSendOptions,
} from '../api';

export type requirementSendStatus = 'idle' | 'starting' | 'running' | 'done' | 'error' | 'cancelled';

// 阶段二可能只跑一两秒，轮询太慢会错过 moduleRequestId 的接流窗口
const POLL_MS = 500;

/** 启动固定会话的分批发送任务，并轮询批次进度。 */
export const useRequirementSend = () => {
  const [status, setStatus] = useState<requirementSendStatus>('idle');
  const [job, setJob] = useState<classificationJob | null>(null);
  const [jobId, setJobId] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [error, setError] = useState('');
  const pollToken = useRef(0);

  const send = useCallback(async (options: startRequirementsSendOptions) => {
    const token = ++pollToken.current;
    setStatus('starting');
    setJob(null);
    setJobId('');
    setSessionId('');
    setError('');

    try {
      const started = await startRequirementsSend(options);
      const startedJobId = started.jobId;
      const startedSessionId = started.sessionId;
      if (startedJobId === undefined || startedSessionId === undefined) {
        throw new Error('后端没有返回 jobId/sessionId');
      }

      setJobId(startedJobId);
      setSessionId(startedSessionId);
      setStatus('running');

      while (true) {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        if (token !== pollToken.current) return;

        const current = await fetchClassificationJob(startedJobId);
        if (token !== pollToken.current) return;
        setJob(current);

        if (current.status === 'done') {
          setStatus('done');
          return;
        }
        if (current.status === 'cancelled') {
          setStatus('cancelled');
          return;
        }
        if (current.status === 'error') {
          setError(current.error ?? '分批发送失败');
          setStatus('error');
          return;
        }
      }
    } catch (err) {
      if (token !== pollToken.current) return;
      setError(err instanceof Error ? err.message : String(err));
      setStatus('error');
    }
  }, []);

  const cancel = useCallback(async () => {
    if (jobId === '') return;
    try {
      await cancelClassificationJob(jobId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [jobId]);

  return { status, job, jobId, sessionId, error, send, cancel };
};

export type requirementSend = ReturnType<typeof useRequirementSend>;
