import { useEffect, useMemo, useState } from 'react';
import type { requirementItem } from '../../../shared/dsh-type.ts';
import type { requirementSend } from '../hooks/useRequirementSend';
import { useRequirements } from '../hooks/useRequirements';
import { usePanelResize } from '../hooks/usePanelResize';

interface categoryPanelProps {
    open: boolean;
    onClose: () => void;
    send: requirementSend;
    onViewSession: (sessionId: string) => void;
}

const UNCATEGORIZED = '未分类';

interface modulePath {
    l1: string;
    l2: string;
    l3: string;
}

/** module 是模块参考表的 l1-l2-l3 路径；模块名自带连字符时并回三级。 */
const parseModule = (module: string | undefined): modulePath => {
    const parts = (module ?? '').split('-').map((part) => part.trim()).filter((part) => part !== '');
    if (parts.length === 0) return { l1: UNCATEGORIZED, l2: '', l3: '' };
    const [l1 = UNCATEGORIZED, l2 = '', ...rest] = parts;
    return { l1, l2, l3: rest.join('-') };
};

/** 一级 → 二级 → 需求；未分类和没有二级的排最后，后者直接挂在一级下面。 */
type subGroup = [string, requirementItem[]];
type moduleGroup = [string, subGroup[]];

const groupRequirements = (items: requirementItem[]): moduleGroup[] => {
    const tree = new Map<string, Map<string, requirementItem[]>>();
    for (const item of items) {
        const { l1, l2 } = parseModule(item.module);
        const sub = tree.get(l1) ?? new Map<string, requirementItem[]>();
        sub.set(l2, [...(sub.get(l2) ?? []), item]);
        tree.set(l1, sub);
    }

    const byName = (a: string, b: string): number => {
        if (a === UNCATEGORIZED) return 1;
        if (b === UNCATEGORIZED) return -1;
        if (a === '') return 1;
        if (b === '') return -1;
        return a.localeCompare(b, 'zh-CN');
    };

    return [...tree.entries()]
        .sort(([a], [b]) => byName(a, b))
        .map<moduleGroup>(([l1, sub]) => [
            l1,
            [...sub.entries()].sort(([a], [b]) => byName(a, b)),
        ]);
};

const classificationStatusOf = (item: requirementItem): { text: string; className: string } => {
    switch (item.classification?.status) {
        case 'done':
            return { text: '已分类', className: 'requirement-status-done' };
        case 'running':
            return { text: '进行中', className: 'requirement-status-running' };
        case 'error':
            return { text: '失败', className: 'requirement-status-error' };
        default:
            return { text: '未分类', className: 'requirement-status-pending' };
    }
};

/** prd 是 http(s) URL 时渲染成链接，否则按文本展示。 */
const PrdLine = ({ value }: { value: string }) => {
    if (/^https?:\/\//i.test(value)) {
        return (
            <a className='requirement-prd' href={value} target='_blank' rel='noreferrer' title={value}>
                {value}
            </a>
        );
    }
    return <p className='requirement-prd' title={value}>{value}</p>;
};

/** 右侧抽屉：遍历 env 指向的需求 JSON，按模块分组展示。 */
export function CategoryPanel({ open, onClose, send, onViewSession }: categoryPanelProps) {
    const { items, status, error, refresh } = useRequirements(open);
    const [batchSize, setBatchSize] = useState(5);
    const [mode, setMode] = useState<'continuous' | 'single'>('continuous');
    const [compactEvery, setCompactEvery] = useState(10);
    const [stopAfterBatches, setStopAfterBatches] = useState(0);
    const groups = useMemo(() => groupRequirements(items), [items]);
    const { panelRef, handleProps } = usePanelResize({
        side: 'right',
        cssVar: '--category-w',
        storageKey: 'apitest:category-w',
        min: 300,
    });
    const running = send.status === 'starting' || send.status === 'running';

    const doneCount = items.filter((item) => item.classification?.status === 'done').length;
    const pendingCount = items.length - doneCount;

    const job = send.job;
    const doneBatches = job?.batches.filter((batch) => batch.status === 'done').length ?? 0;
    const failedBatches = job?.batches.filter((batch) => batch.status === 'error').length ?? 0;
    const doneItems = (job?.completedBefore ?? 0) + (job?.batches
        .filter((batch) => batch.status === 'done')
        .reduce((sum, batch) => sum + batch.count, 0) ?? 0);
    const runningBatch = job?.batches.find((batch) => batch.status === 'running');
    // 阶段二一挂上 moduleRequestId 就切到模块分类的实时文本
    const liveStage = runningBatch?.moduleRequestId === undefined ? 'intent' : 'module';
    const liveText = runningBatch === undefined
        ? ''
        : liveStage === 'module'
            ? runningBatch.moduleText ?? ''
            : runningBatch.text ?? '';
    const latestReply = job === null || job === undefined
        ? undefined
        : [...job.batches].reverse().find((batch) => batch.status === 'done' && batch.text !== undefined);

    const allClassified = status === 'ready' && items.length > 0 && pendingCount === 0;

    // 任务开始、每批切换、结束时各补拉一次：后端在发提示词前就把这批写成 running 了，
    // 只在任务结束才刷新的话，进行中的条目会一直停在未分类。
    useEffect(() => {
        if (send.status === 'idle' || send.status === 'starting') return;
        void refresh();
    }, [send.status, runningBatch?.index, refresh]);

    return (
        <aside className='category-panel' data-open={open ? 'true' : 'false'} ref={panelRef}>
            <div className='category-head'>
                <span>需求清单</span>
                <span className='category-count'>
                    {status === 'ready' ? `已分类 ${doneCount}/${items.length}` : ''}
                </span>
                <div className='category-actions'>
                    <button className='ghost' onClick={() => void refresh()} disabled={status === 'loading' || running}>
                        刷新
                    </button>
                    <button className='ghost' onClick={onClose}>收起</button>
                </div>
            </div>

            <div className='category-controls'>
                <label>
                    每批
                    <select
                        value={batchSize}
                        onChange={(event) => setBatchSize(Number(event.target.value))}
                        disabled={running}
                    >
                        <option value={5}>5 条</option>
                        <option value={10}>10 条</option>
                        <option value={20}>20 条</option>
                    </select>
                </label>
                <label>
                    模式
                    <select
                        value={mode}
                        onChange={(event) => setMode(event.target.value === 'single' ? 'single' : 'continuous')}
                        disabled={running}
                    >
                        <option value='continuous'>连续</option>
                        <option value='single'>单批</option>
                    </select>
                </label>
                <label>
                    每
                    <select
                        value={compactEvery}
                        onChange={(event) => setCompactEvery(Number(event.target.value))}
                        disabled={running}
                    >
                        <option value={5}>5 批</option>
                        <option value={10}>10 批</option>
                    </select>
                    压缩一次
                </label>
                <label>
                    跑
                    <select
                        value={stopAfterBatches}
                        onChange={(event) => setStopAfterBatches(Number(event.target.value))}
                        disabled={running}
                    >
                        <option value={0}>不限</option>
                        <option value={1}>1 批</option>
                        <option value={2}>2 批</option>
                        <option value={3}>3 批</option>
                        <option value={5}>5 批</option>
                        <option value={10}>10 批</option>
                    </select>
                    后停止
                </label>
                {running ? (
                    <button className='ghost' onClick={() => void send.cancel()}>停止</button>
                ) : (
                    <button
                        className='ghost'
                        onClick={() => void send.send({ batchSize, mode, compactEvery, stopAfterBatches })}
                        disabled={allClassified}
                    >
                        {allClassified ? '全部已分类' : mode === 'single' ? '发送下一批' : '开始连续发送'}
                    </button>
                )}
                {send.sessionId !== '' && (
                    <button className='ghost' onClick={() => onViewSession(send.sessionId)}>
                        查看分类会话
                    </button>
                )}
            </div>

            {status === 'loading' && <p className='category-note'>加载中…</p>}
            {status === 'error' && (
                <p className='category-note'>
                    {error}
                    <button className='ghost' onClick={() => void refresh()}>重试</button>
                </p>
            )}
            {status === 'ready' && items.length === 0 && (
                <p className='category-note'>JSON 里没有需求</p>
            )}

            <div className='category-list'>
                {groups.map(([l1, subs]) => {
                    const l1Count = subs.reduce((sum, [, list]) => sum + list.length, 0);
                    return (
                        <section key={l1} className='category-group'>
                            <h3 className='category-group-title'>
                                <span>{l1}</span>
                                <span className='category-group-count'>{l1Count}</span>
                            </h3>
                            {subs.map(([l2, list]) => (
                                <section key={l2 || '—'} className='category-subgroup'>
                                    {l2 !== '' && (
                                        <h4 className='category-subgroup-title'>
                                            <span>{l2}</span>
                                            <span className='category-group-count'>{list.length}</span>
                                        </h4>
                                    )}
                                    {list.map((item) => {
                                        const primary = item.workItemID ?? item.key;
                                        const classification = classificationStatusOf(item);
                                        const path = parseModule(item.module);
                                        const ungrouped = path.l1 === UNCATEGORIZED;
                                        return (
                                            <article key={primary} className='requirement-item'>
                                                <div className='requirement-top'>
                                                    <span className='requirement-id'>{primary}</span>
                                                    {item.key !== primary && (
                                                        <span className='requirement-tag'>Key: {item.key}</span>
                                                    )}
                                                    {!ungrouped && path.l3 !== '' && (
                                                        <span className='requirement-tag' title={item.module}>
                                                            {path.l3}
                                                        </span>
                                                    )}
                                                    {ungrouped && item.sourceModule !== undefined && (
                                                        <span className='requirement-tag' title='源表模块列，分类后换成模块树路径'>
                                                            {item.sourceModule}
                                                        </span>
                                                    )}
                                                    <span className={`requirement-tag requirement-status ${classification.className}`}>
                                                        {classification.text}
                                                    </span>
                                                </div>
                                                <h4 className='requirement-title'>{item.summary}</h4>
                                                {item.prd !== undefined && <PrdLine value={item.prd} />}
                                                {item.requirement_content_path !== undefined && (
                                                    <p className='requirement-path' title={item.requirement_content_path}>
                                                        {item.requirement_content_path}
                                                    </p>
                                                )}
                                            </article>
                                        );
                                    })}
                                </section>
                            ))}
                        </section>
                    );
                })}
            </div>

            {send.status !== 'idle' && (
                <section className='category-send'>
                    <div className='category-send-head'>
                        <span>
                            {send.status === 'starting' && '正在创建任务…'}
                            {send.status === 'running' && '分批发送中'}
                            {send.status === 'done' && '发送完成'}
                            {send.status === 'cancelled' && '已取消'}
                            {send.status === 'error' && '发送失败'}
                        </span>
                        {job?.sessionId !== undefined && (
                            <span className='category-send-session' title={job.sessionId}>
                                {job.sessionId}
                            </span>
                        )}
                    </div>

                    {job !== null && job !== undefined && (
                        <>
                            <p className='category-note'>
                                总进度：{doneItems}/{job.totalItems} 条，已分类
                                {job.completedBefore > 0 ? `（进入本任务前 ${job.completedBefore} 条）` : ''}
                                {runningBatch !== undefined ? `；正在发送第 ${runningBatch.index} 批` : ''}
                                {send.status !== 'cancelled' && failedBatches > 0 ? `；失败 ${failedBatches} 批` : ''}
                            </p>
                            <p className='category-note'>
                                本次：{doneBatches}/{job.totalBatches} 批，剩余 {Math.max(0, job.pendingItems - (doneItems - job.completedBefore))} 条
                            </p>
                            <progress
                                className='category-progress'
                                max={job.totalItems}
                                value={doneItems}
                            />
                        </>
                    )}

                    {send.error !== '' && <p className='category-note'>发送失败：{send.error}</p>}
                    {job?.error !== undefined && <p className='category-note'>任务错误：{job.error}</p>}

                    {running && runningBatch !== undefined && (
                        <>
                            <div className='category-send-head'>
                                <span>
                                    第 {runningBatch.index} 批 · {liveStage === 'module' ? '模块分类' : '意图识别'}实时回复
                                </span>
                            </div>
                            <pre className='category-reply'>
                                {liveText !== '' ? liveText : '等待回复…'}
                            </pre>
                        </>
                    )}

                    {!running && latestReply?.text !== undefined && (
                        <>
                            <div className='category-send-head'>
                                <span>第 {latestReply.index} 批回复</span>
                            </div>
                            <pre className='category-reply'>
                                {latestReply.text !== ''
                                    ? latestReply.text
                                    : `（无文本，结束原因：${latestReply.reason ?? 'unknown'}）`}
                            </pre>
                        </>
                    )}
                </section>
            )}
            <div
                className='panel-resizer panel-resizer-left'
                role='separator'
                aria-orientation='vertical'
                aria-label='拖动调整需求清单宽度'
                {...handleProps}
            />
        </aside>
    );
}
