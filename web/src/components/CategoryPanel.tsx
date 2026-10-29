import { useMemo } from 'react';
import type { requirementItem } from '../../../shared/dsh-type.ts';
import { useRequirements } from '../hooks/useRequirements';

interface categoryPanelProps {
    open: boolean;
    onClose: () => void;
}

const UNCATEGORIZED = '未分类';

/** 按“模块”分组；没有模块的排最后。 */
const groupRequirements = (items: requirementItem[]): Array<[string, requirementItem[]]> => {
    const map = new Map<string, requirementItem[]>();
    for (const item of items) {
        const key = item.module ?? UNCATEGORIZED;
        map.set(key, [...(map.get(key) ?? []), item]);
    }
    return [...map.entries()].sort(([a], [b]) => {
        if (a === UNCATEGORIZED) return 1;
        if (b === UNCATEGORIZED) return -1;
        return a.localeCompare(b, 'zh-CN');
    });
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
export function CategoryPanel({ open, onClose }: categoryPanelProps) {
    const { items, status, error, refresh } = useRequirements(open);
    const groups = useMemo(() => groupRequirements(items), [items]);

    return (
        <aside className='category-panel' data-open={open ? 'true' : 'false'}>
            <div className='category-head'>
                <span>需求清单</span>
                <span className='category-count'>{status === 'ready' ? `${items.length} 条` : ''}</span>
                <div className='category-actions'>
                    <button className='ghost' onClick={() => void refresh()} disabled={status === 'loading'}>
                        刷新
                    </button>
                    <button className='ghost' onClick={onClose}>收起</button>
                </div>
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
                {groups.map(([moduleName, list]) => (
                    <section key={moduleName} className='category-group'>
                        <h3 className='category-group-title'>
                            <span>{moduleName}</span>
                            <span className='category-group-count'>{list.length}</span>
                        </h3>
                        {list.map((item) => {
                            const primary = item.workItemID ?? item.key;
                            return (
                                <article key={primary} className='requirement-item'>
                                    <div className='requirement-top'>
                                        <span className='requirement-id'>{primary}</span>
                                        {item.key !== primary && (
                                            <span className='requirement-tag'>Key {item.key}</span>
                                        )}
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
            </div>
        </aside>
    );
}
