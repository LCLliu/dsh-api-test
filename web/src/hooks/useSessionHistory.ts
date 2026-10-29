import { useCallback, useEffect, useState } from 'react';
import type { chatMessage, sessionListItem } from '../../../shared/dsh-type.ts';
import { fetchHistory, fetchSessions } from '../api';

const HISTORY_LIMIT = 30;

interface historyOptions {
    open: boolean;
    currentSessionId: string;
    /** 切换成功后由会话 hook 落状态 */
    onLoad: (sessionId: string, messages: chatMessage[]) => void;
    onPrepend: (older: chatMessage[]) => void;
    pushError: (error: unknown) => void;
}

/** 侧边栏的历史会话列表 + 点进去续聊的编排。 */
export const useSessionHistory = ({
    open,
    currentSessionId,
    onLoad,
    onPrepend,
    pushError,
}: historyOptions) => {
    const [items, setItems] = useState<sessionListItem[]>([]);
    const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
    const [error, setError] = useState('');
    const [switching, setSwitching] = useState<string>();
    const [hasMore, setHasMore] = useState(false);
    const [oldestSeq, setOldestSeq] = useState<number>();
    const [loadingOlder, setLoadingOlder] = useState(false);

    const refresh = useCallback(async () => {
        setStatus('loading');
        try {
            setItems(await fetchSessions());
            setStatus('ready');
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
            setStatus('error');
        }
    }, []);

    // 只在展开时拉一次，历史不会自己变，不做轮询
    useEffect(() => {
        if (open) void refresh();
    }, [open, refresh]);

    const switchTo = async (item: sessionListItem): Promise<void> => {
        setSwitching(item.sessionId);
        try {
            const page = await fetchHistory(item.sessionId, HISTORY_LIMIT);
            onLoad(item.sessionId, page.messages);
            setHasMore(page.hasMore);
            setOldestSeq(page.oldestSeq);
        } catch (err) {
            // 历史读取失败时不要切走当前会话
            pushError(err);
        } finally {
            setSwitching(undefined);
        }
    };

    const loadOlder = async (): Promise<void> => {
        if (currentSessionId === '' || oldestSeq === undefined) return;

        setLoadingOlder(true);
        try {
            const page = await fetchHistory(currentSessionId, HISTORY_LIMIT, oldestSeq);
            onPrepend(page.messages);
            setHasMore(page.hasMore);
            setOldestSeq(page.oldestSeq);
        } catch (err) {
            pushError(err);
        } finally {
            setLoadingOlder(false);
        }
    };

    return { items, status, error, switching, hasMore, loadingOlder, refresh, switchTo, loadOlder };
};

export type sessionHistory = ReturnType<typeof useSessionHistory>;