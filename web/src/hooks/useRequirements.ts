import { useCallback, useEffect, useState } from 'react';
import type { requirementItem } from '../../../shared/dsh-type.ts';
import { fetchRequirements } from '../api';

export type requirementsStatus = 'idle' | 'loading' | 'ready' | 'error';

/** 需求面板的数据源：每次打开时重新扫描，也可以手动刷新。 */
export const useRequirements = (open: boolean) => {
  const [items, setItems] = useState<requirementItem[]>([]);
  const [status, setStatus] = useState<requirementsStatus>('idle');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setStatus('loading');
    setError('');
    try {
      setItems(await fetchRequirements());
      setStatus('ready');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  return { items, status, error, refresh: load };
};
