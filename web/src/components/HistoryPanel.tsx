import { useMemo, useState } from 'react';
import type { sessionListItem } from '../../../shared/dsh-type.ts';
import type { sessionHistory } from '../hooks/useSessionHistory';

const relativeTime = (millis: number) => {
    const diff = Date.now() - millis;
    if (diff < 60_000) return '刚刚';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
    return new Date(millis).toLocaleDateString('zh-CN');
};

/** dsh 在容器里，cwd 是 POSIX 路径，取最后一段当目录名。 */
const folderLabel = (cwd: string) => {
    const name = cwd.replace(/\/+$/, '').split('/').pop();
    return name === undefined || name === '' ? '未知目录' : name;
};

interface cwdGroup {
    cwd: string;
    label: string;
    updatedAt: number;
    items: sessionListItem[];
}

interface historyPanelProps {
    open: boolean;
    currentSessionId: string;
    history: sessionHistory;
    onClose: () => void;
}

/** 左侧抽屉：按 cwd 分组的历史会话列表，点一条就认领并接着聊。 */
export function HistoryPanel({ open, currentSessionId, history, onClose }: historyPanelProps) {
    const [pinned, setPinned] = useState<Record<string, boolean>>({});

    const groups = useMemo<cwdGroup[]>(() => {
        const map = new Map<string, cwdGroup>();
        for (const item of history.items) {
            const cwd = item.cwd ?? '';
            const group = map.get(cwd) ?? { cwd, label: folderLabel(cwd), updatedAt: 0, items: [] };
            group.items.push(item);
            group.updatedAt = Math.max(group.updatedAt, item.updatedAt);
            map.set(cwd, group);
        }
        return [...map.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    }, [history.items]);

    // 默认只展开当前会话所在的那组；新会话还没说过话会被后端过滤掉，所以兜底展开最新一组
    const autoOpen = groups.find((group) => group.items.some((item) => item.sessionId === currentSessionId))?.cwd
        ?? groups[0]?.cwd;

    const toggle = (cwd: string) =>
        setPinned((all) => ({ ...all, [cwd]: !(all[cwd] ?? cwd === autoOpen) }));

    return (
        <>
            {/* {open && <div className='history-scrim' />} */}
            <aside className='history-panel' data-open={open ? 'true' : 'false'}>
                <div className='history-head'>
                    <span>历史对话</span>
                    <button className='ghost' onClick={onClose}>收起</button>
                </div>

                {history.status === 'loading' && <p className='history-note'>加载中…</p>}
                {history.status === 'error' && (
                    <p className='history-note'>
                        {history.error}
                        <button className='ghost' onClick={() => void history.refresh()}>重试</button>
                    </p>
                )}
                {history.status === 'ready' && history.items.length === 0 && (
                    <p className='history-note'>还没有历史会话</p>
                )}

                <div className='history-list'>
                    {groups.map((group) => {
                        const expanded = pinned[group.cwd] ?? group.cwd === autoOpen;
                        return (
                            <div key={group.cwd || 'unknown'} className='history-group'>
                                <button
                                    type='button'
                                    className='history-dir'
                                    title={group.cwd}
                                    aria-expanded={expanded}
                                    onClick={() => toggle(group.cwd)}
                                >
                                    <span className='history-caret'>{expanded ? '▾' : '▸'}</span>
                                    <span className='history-dir-name'>{group.label}</span>
                                    <span className='history-dir-count'>{group.items.length}</span>
                                </button>

                                {expanded && group.items.map((item) => (
                                    <button
                                        key={item.sessionId}
                                        type='button'
                                        className={`history-item${item.sessionId === currentSessionId ? ' history-item-active' : ''}`}
                                        disabled={history.switching !== undefined}
                                        onClick={() => void history.switchTo(item)}
                                    >
                                        <span className='history-title'>{item.title}</span>
                                        <span className='history-meta'>
                                            {item.running && <span className='history-running'>执行中</span>}
                                            {relativeTime(item.updatedAt)}
                                            {history.switching === item.sessionId && ' 打开中…'}
                                        </span>
                                    </button>
                                ))}
                            </div>
                        );
                    })}
                </div>
            </aside>
        </>
    );
}