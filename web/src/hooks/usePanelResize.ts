import { useCallback, useEffect, useRef, type PointerEvent, type RefObject } from 'react';

interface panelResizeOptions {
    /** 面板贴靠的屏幕侧：左侧面板往右变宽，右侧面板往左变宽 */
    side: 'left' | 'right';
    /** 宽度写入的 CSS 变量名，面板和页面留白都读它 */
    cssVar: string;
    /** 记住宽度的 localStorage 键 */
    storageKey: string;
    /** 最小宽度 px */
    min: number;
}

interface panelResize {
    /** 挂到面板根节点上，用来取当前渲染宽度作为拖拽基准 */
    panelRef: RefObject<HTMLElement | null>;
    handleProps: {
        onPointerDown: (event: PointerEvent<HTMLElement>) => void;
        onPointerMove: (event: PointerEvent<HTMLElement>) => void;
        onPointerUp: (event: PointerEvent<HTMLElement>) => void;
        onPointerCancel: (event: PointerEvent<HTMLElement>) => void;
    };
}

/** 拖宽的上限：视口 75%，留出主内容区。 */
const MAX_RATIO = 0.75;

const clampWidth = (value: number, min: number) =>
    Math.round(Math.min(Math.max(value, min), Math.max(min, window.innerWidth * MAX_RATIO)));

/**
 * 让固定定位的侧边栏可以用拖拽条改宽度：拖拽期间把像素写进 CSS 变量，
 * 松手再存 localStorage，下次启动直接接回上次的宽度。
 */
export const usePanelResize = ({ side, cssVar, storageKey, min }: panelResizeOptions): panelResize => {
    const panelRef = useRef<HTMLElement>(null);
    const drag = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);

    const apply = useCallback((px: number) => {
        document.documentElement.style.setProperty(cssVar, `${px}px`);
    }, [cssVar]);

    // 启动时接回上次宽度；窗口尺寸变化后按新的视口重新夹取
    useEffect(() => {
        const restore = () => {
            const saved = Number(window.localStorage.getItem(storageKey));
            if (Number.isFinite(saved) && saved >= min) apply(clampWidth(saved, min));
        };
        restore();
        window.addEventListener('resize', restore);
        return () => window.removeEventListener('resize', restore);
    }, [apply, storageKey, min]);

    const onPointerDown = (event: PointerEvent<HTMLElement>) => {
        const panel = panelRef.current;
        if (panel === null) return;

        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startWidth: panel.getBoundingClientRect().width,
        };
        document.documentElement.dataset.resizing = 'true';
    };

    const onPointerMove = (event: PointerEvent<HTMLElement>) => {
        const started = drag.current;
        if (started === null || started.pointerId !== event.pointerId) return;

        const delta = event.clientX - started.startX;
        apply(clampWidth(started.startWidth + (side === 'left' ? delta : -delta), min));
    };

    const endDrag = (event: PointerEvent<HTMLElement>) => {
        if (drag.current?.pointerId !== event.pointerId) return;

        drag.current = null;
        delete document.documentElement.dataset.resizing;
        const panel = panelRef.current;
        if (panel !== null) {
            window.localStorage.setItem(storageKey, String(Math.round(panel.getBoundingClientRect().width)));
        }
    };

    return { panelRef, handleProps: { onPointerDown, onPointerMove, onPointerUp: endDrag, onPointerCancel: endDrag } };
};
