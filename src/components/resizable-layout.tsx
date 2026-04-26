"use client";

import { useCallback, useEffect, useRef, useState, type RefObject, type ReactNode } from "react";

const SIDEBAR_MIN = 56;
const SIDEBAR_MAX = 200;
const SIDEBAR_DEFAULT = 56;
const SIDEBAR_LABEL_THRESHOLD = 100;

const STORAGE_KEY_SIDEBAR = "scienceswarm:sidebar-width";

/** CSS class applied to <body> during drag to set cursor + disable selection. */
const DRAGGING_CLASS = "scienceswarm-resizing";
const DRAGGING_Y_CLASS = "scienceswarm-resizing-y";

function readStoredWidth(
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(key);
    if (raw !== null) {
      const v = Number(raw);
      if (Number.isFinite(v)) return Math.min(max, Math.max(min, v));
    }
  } catch {
    // localStorage can throw in some contexts
  }
  return fallback;
}

function storeWidth(key: string, value: number): void {
  try {
    localStorage.setItem(key, String(Math.round(value)));
  } catch {
    // ignore
  }
}

/**
 * Wraps the dashboard's sidebar + main content with a draggable
 * resize handle between them.
 *
 * The sidebar width is persisted in localStorage so it survives
 * page reloads.
 */
export function ResizableLayout({
  sidebar,
  children,
}: {
  sidebar: ReactNode;
  children: ReactNode;
}) {
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    readStoredWidth(STORAGE_KEY_SIDEBAR, SIDEBAR_DEFAULT, SIDEBAR_MIN, SIDEBAR_MAX),
  );
  const isDragging = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isDragging.current = true;
      startX.current = e.clientX;
      startWidth.current = sidebarWidth;
      document.body.classList.add(DRAGGING_CLASS);
    },
    [sidebarWidth],
  );

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!isDragging.current) return;
      const delta = e.clientX - startX.current;
      const next = Math.min(
        SIDEBAR_MAX,
        Math.max(SIDEBAR_MIN, startWidth.current + delta),
      );
      setSidebarWidth(next);
    };

    const onMouseUp = () => {
      if (!isDragging.current) return;
      isDragging.current = false;
      document.body.classList.remove(DRAGGING_CLASS);
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  // Persist width changes (debounced by requestAnimationFrame on drag end)
  const prevWidth = useRef(sidebarWidth);
  useEffect(() => {
    if (prevWidth.current !== sidebarWidth && !isDragging.current) {
      storeWidth(STORAGE_KEY_SIDEBAR, sidebarWidth);
    }
    prevWidth.current = sidebarWidth;
  }, [sidebarWidth]);

  // Also persist when drag ends
  useEffect(() => {
    const persist = () => {
      if (!isDragging.current) {
        storeWidth(STORAGE_KEY_SIDEBAR, sidebarWidth);
      }
    };
    window.addEventListener("mouseup", persist);
    return () => window.removeEventListener("mouseup", persist);
  }, [sidebarWidth]);

  const showLabels = sidebarWidth >= SIDEBAR_LABEL_THRESHOLD;

  return (
    <div className="fixed inset-0 flex overflow-hidden">
      <div
        className="flex-shrink-0 overflow-hidden"
        style={{ width: sidebarWidth }}
        data-sidebar-show-labels={showLabels ? "true" : "false"}
        suppressHydrationWarning
      >
        {sidebar}
      </div>

      {/* Drag handle: sidebar <-> main */}
      <div
        className="w-1 flex-shrink-0 cursor-col-resize bg-border hover:bg-accent/40 transition-colors"
        onMouseDown={onMouseDown}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        tabIndex={0}
      />

      <main className="min-w-0 flex-1 overflow-y-auto">{children}</main>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Project-list / chat resize hook                                     */
/* ------------------------------------------------------------------ */

const PROJECT_LIST_MIN = 160;
const PROJECT_LIST_MAX = 400;
const PROJECT_LIST_DEFAULT = 224; // w-56 = 14rem = 224px
const STORAGE_KEY_PROJECT_LIST = "scienceswarm:project-list-width";

/**
 * Hook for the project-list <-> chat panel resize handle inside the
 * project page. Returns the current width and a mouseDown handler to
 * attach to the drag handle div.
 */
export function useProjectListResize() {
  const [width, setWidth] = useState(() =>
    readStoredWidth(STORAGE_KEY_PROJECT_LIST, PROJECT_LIST_DEFAULT, PROJECT_LIST_MIN, PROJECT_LIST_MAX),
  );
  const isDragging = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isDragging.current = true;
      startX.current = e.clientX;
      startWidth.current = width;
      document.body.classList.add(DRAGGING_CLASS);
    },
    [width],
  );

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!isDragging.current) return;
      const delta = e.clientX - startX.current;
      const next = Math.min(
        PROJECT_LIST_MAX,
        Math.max(PROJECT_LIST_MIN, startWidth.current + delta),
      );
      setWidth(next);
    };

    const onMouseUp = () => {
      if (!isDragging.current) return;
      isDragging.current = false;
      document.body.classList.remove(DRAGGING_CLASS);
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  // Persist width
  const prevWidth = useRef(width);
  useEffect(() => {
    if (prevWidth.current !== width && !isDragging.current) {
      storeWidth(STORAGE_KEY_PROJECT_LIST, width);
    }
    prevWidth.current = width;
  }, [width]);

  useEffect(() => {
    const persist = () => {
      if (!isDragging.current) {
        storeWidth(STORAGE_KEY_PROJECT_LIST, width);
      }
    };
    window.addEventListener("mouseup", persist);
    return () => window.removeEventListener("mouseup", persist);
  }, [width]);

  return { projectListWidth: width, onProjectListResizeMouseDown: onMouseDown };
}

/* ------------------------------------------------------------------ */
/* File visualizer / chat vertical split hook                          */
/* ------------------------------------------------------------------ */

const VISUALIZER_MIN = 220;
const VISUALIZER_MAX_RATIO = 0.75;
const VISUALIZER_DEFAULT_RATIO = 0.5;
const STORAGE_KEY_VISUALIZER_CHAT_SPLIT = "scienceswarm:visualizer-chat-split";

function readStoredNumber(key: string): number | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function clampVisualizerHeight(value: number, totalHeight: number): number {
  const max = Math.max(VISUALIZER_MIN, totalHeight * VISUALIZER_MAX_RATIO);
  const min = Math.min(VISUALIZER_MIN, max);
  return Math.min(max, Math.max(min, value));
}

export function useVisualizerChatSplitResize(
  containerRef: RefObject<HTMLElement | null>,
) {
  const [visualizerHeight, setVisualizerHeight] = useState<number | null>(() =>
    readStoredNumber(STORAGE_KEY_VISUALIZER_CHAT_SPLIT),
  );
  const isDragging = useRef(false);
  const startY = useRef(0);
  const startHeight = useRef(0);

  const getContainerHeight = useCallback(() => {
    return containerRef.current?.getBoundingClientRect().height ?? window.innerHeight;
  }, [containerRef]);

  const clampHeight = useCallback(
    (value: number) => clampVisualizerHeight(value, getContainerHeight()),
    [getContainerHeight],
  );

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const total = getContainerHeight();
      setVisualizerHeight((current) => {
        if (current !== null) return clampVisualizerHeight(current, total);
        return clampVisualizerHeight(total * VISUALIZER_DEFAULT_RATIO, total);
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [getContainerHeight]);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const total = getContainerHeight();
      isDragging.current = true;
      startY.current = e.clientY;
      startHeight.current = visualizerHeight ?? total * VISUALIZER_DEFAULT_RATIO;
      document.body.classList.add(DRAGGING_Y_CLASS);
    },
    [getContainerHeight, visualizerHeight],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      e.preventDefault();
      const delta = e.key === "ArrowUp" ? -24 : 24;
      const base = visualizerHeight ?? getContainerHeight() * VISUALIZER_DEFAULT_RATIO;
      const next = clampHeight(base + delta);
      setVisualizerHeight(next);
      storeWidth(STORAGE_KEY_VISUALIZER_CHAT_SPLIT, next);
    },
    [clampHeight, getContainerHeight, visualizerHeight],
  );

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!isDragging.current) return;
      const delta = e.clientY - startY.current;
      setVisualizerHeight(clampHeight(startHeight.current + delta));
    };

    const onMouseUp = () => {
      if (!isDragging.current) return;
      isDragging.current = false;
      document.body.classList.remove(DRAGGING_Y_CLASS);
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [clampHeight]);

  useEffect(() => {
    const persist = () => {
      if (!isDragging.current && visualizerHeight !== null) {
        storeWidth(STORAGE_KEY_VISUALIZER_CHAT_SPLIT, visualizerHeight);
      }
    };
    window.addEventListener("mouseup", persist);
    return () => window.removeEventListener("mouseup", persist);
  }, [visualizerHeight]);

  return {
    visualizerHeight,
    onVisualizerChatResizeMouseDown: onMouseDown,
    onVisualizerChatResizeKeyDown: onKeyDown,
  };
}
