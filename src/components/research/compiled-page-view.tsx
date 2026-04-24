"use client";

import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { LinkSimple, WarningDiamond } from "@phosphor-icons/react";

export interface CompiledPageLink {
  slug: string;
  kind: string;
  title: string;
  context?: string | null;
  fromSlug?: string;
  toSlug?: string;
}

export interface CompiledPageTimelineEntry {
  date: string;
  source?: string | null;
  summary: string;
  detail?: string | null;
}

export interface CompiledPageRead {
  path: string;
  title?: string;
  type?: string;
  content?: string;
  compiled_truth?: string;
  frontmatter?: Record<string, unknown>;
  timeline?: CompiledPageTimelineEntry[];
  backlinks?: CompiledPageLink[];
  links?: CompiledPageLink[];
}

const METADATA_PANEL_DEFAULT_WIDTH = 280;
const METADATA_PANEL_MIN_WIDTH = 180;
const METADATA_PANEL_MAX_WIDTH = 420;
const METADATA_PANEL_COLLAPSE_THRESHOLD = 96;
const METADATA_PANEL_STORAGE_KEY = "scienceswarm:compiled-page-metadata-width";
const METADATA_PANEL_RESIZING_CLASS = "scienceswarm-resizing";

function clampMetadataPanelWidth(width: number): number {
  if (width <= 0) return 0;
  return Math.min(
    METADATA_PANEL_MAX_WIDTH,
    Math.max(METADATA_PANEL_MIN_WIDTH, Math.round(width)),
  );
}

function readStoredMetadataPanelWidth(): number {
  if (typeof window === "undefined") return METADATA_PANEL_DEFAULT_WIDTH;

  try {
    const raw = window.localStorage.getItem(METADATA_PANEL_STORAGE_KEY);
    if (raw === null) return METADATA_PANEL_DEFAULT_WIDTH;
    const storedWidth = Number(raw);
    if (!Number.isFinite(storedWidth)) return METADATA_PANEL_DEFAULT_WIDTH;
    return clampMetadataPanelWidth(storedWidth);
  } catch {
    return METADATA_PANEL_DEFAULT_WIDTH;
  }
}

function storeMetadataPanelWidth(width: number): void {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(METADATA_PANEL_STORAGE_KEY, String(width));
  } catch {
    // Non-critical preference persistence.
  }
}

export function CompiledPageView({
  page,
  onNavigate,
}: {
  page: CompiledPageRead;
  onNavigate?: (slug: string) => void;
}) {
  const [metadataPanelWidth, setMetadataPanelWidth] = useState(readStoredMetadataPanelWidth);
  const metadataPanelWidthRef = useRef(metadataPanelWidth);
  const compiledTruth = (page.compiled_truth ?? page.content ?? "").trim();
  const timeline = page.timeline ?? [];
  const backlinks = page.backlinks ?? [];
  const links = page.links ?? [];
  const metadataCount = links.length + backlinks.length;
  const metadataCollapsed = metadataPanelWidth === 0;
  const contradictionCount = [...backlinks, ...links].filter(
    (link) => link.kind === "contradicts",
  ).length;

  const setMetadataPanelPreference = useCallback((width: number, persist = false) => {
    const nextWidth = clampMetadataPanelWidth(width);
    metadataPanelWidthRef.current = nextWidth;
    setMetadataPanelWidth(nextWidth);
    if (persist) storeMetadataPanelWidth(nextWidth);
  }, []);

  const revealMetadataPanel = useCallback(() => {
    setMetadataPanelPreference(METADATA_PANEL_DEFAULT_WIDTH, true);
  }, [setMetadataPanelPreference]);

  const handleMetadataResizePointerDown = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();

    const containerRight = event.currentTarget.parentElement?.getBoundingClientRect().right ?? window.innerWidth;
    document.body.classList.add(METADATA_PANEL_RESIZING_CLASS);

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const nextWidth = containerRight - moveEvent.clientX;
      setMetadataPanelPreference(
        nextWidth <= METADATA_PANEL_COLLAPSE_THRESHOLD ? 0 : nextWidth,
      );
    };

    const handlePointerUp = () => {
      document.removeEventListener("pointermove", handlePointerMove);
      document.removeEventListener("pointerup", handlePointerUp);
      document.body.classList.remove(METADATA_PANEL_RESIZING_CLASS);
      storeMetadataPanelWidth(metadataPanelWidthRef.current);
    };

    document.addEventListener("pointermove", handlePointerMove);
    document.addEventListener("pointerup", handlePointerUp, { once: true });
  }, [setMetadataPanelPreference]);

  const handleMetadataResizeKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      if (
        event.key !== "ArrowLeft" &&
        event.key !== "ArrowRight" &&
        event.key !== "Home" &&
        event.key !== "End"
      ) {
        return;
      }

      event.preventDefault();

      if (event.key === "Home") {
        setMetadataPanelPreference(METADATA_PANEL_DEFAULT_WIDTH, true);
        return;
      }

      if (event.key === "End") {
        setMetadataPanelPreference(0, true);
        return;
      }

      const nextWidth = event.key === "ArrowRight"
        ? metadataPanelWidth + 24
        : metadataPanelWidth - 24;
      setMetadataPanelPreference(nextWidth < METADATA_PANEL_MIN_WIDTH ? 0 : nextWidth, true);
    },
    [metadataPanelWidth, setMetadataPanelPreference],
  );

  const gridTemplateColumns = useMemo(
    () => metadataCollapsed
      ? "minmax(0, 1fr)"
      : `minmax(0, 1fr) 8px ${metadataPanelWidth}px`,
    [metadataCollapsed, metadataPanelWidth],
  );

  return (
    <div
      className="relative flex h-full min-h-0 flex-col overflow-y-auto bg-white md:grid md:overflow-hidden"
      style={{ gridTemplateColumns }}
    >
      <main className="shrink-0 px-4 py-4 md:min-h-0 md:overflow-y-auto md:px-6 md:py-5">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3 border-b border-border pb-4">
          <div className="min-w-0">
            <div className="mb-1 text-[10px] font-semibold uppercase text-muted">
              {page.type ?? "page"} · compiled truth
            </div>
            <h2 className="truncate text-xl font-semibold text-foreground">
              {page.title ?? page.path}
            </h2>
            <div className="mt-1 text-xs text-muted">{page.path}</div>
          </div>
          {contradictionCount > 0 && (
            <div className="inline-flex items-center gap-1.5 rounded border border-warn/40 bg-warn/10 px-2.5 py-1 text-xs font-semibold text-warn">
              <WarningDiamond size={14} weight="bold" />
              {contradictionCount} contradiction{contradictionCount === 1 ? "" : "s"}
            </div>
          )}
        </div>

        <section className="prose prose-sm max-w-none prose-headings:font-semibold prose-p:leading-6 prose-li:leading-6">
          {compiledTruth ? (
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{compiledTruth}</ReactMarkdown>
          ) : (
            <p className="text-sm text-muted">Not yet synthesized. Timeline below.</p>
          )}
        </section>

        <section className="mt-7 border-t border-border pt-5">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold text-foreground">Timeline</h3>
            <span className="text-[10px] uppercase text-muted">
              {timeline.length === 0 ? "Not yet observed" : `${timeline.length} entries`}
            </span>
          </div>
          {timeline.length === 0 ? (
            <p className="text-sm text-muted">Not yet observed</p>
          ) : (
            <ol className="space-y-3">
              {timeline.map((entry, index) => (
                <li key={`${entry.date}-${entry.summary}-${index}`} className="border-l-2 border-accent/50 pl-3">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                    <time>{entry.date}</time>
                    {entry.source && <span>{entry.source}</span>}
                  </div>
                  <div className="mt-0.5 text-sm font-medium text-foreground">
                    {entry.summary}
                  </div>
                  {entry.detail && (
                    <p className="mt-1 text-xs leading-5 text-muted">{entry.detail}</p>
                  )}
                </li>
              ))}
            </ol>
          )}
        </section>
      </main>

      {metadataCollapsed ? (
        <button
          type="button"
          onClick={revealMetadataPanel}
          className="absolute right-0 top-4 z-20 inline-flex h-9 items-center gap-1.5 rounded-l border border-r-0 border-border bg-white px-2 text-xs font-semibold text-muted shadow-sm transition-colors hover:border-accent hover:text-foreground focus:outline-none focus:ring-2 focus:ring-accent/30"
          aria-label="Show links and backlinks metadata"
          title="Show links and backlinks metadata"
        >
          <LinkSimple size={14} />
          <span>{metadataCount}</span>
        </button>
      ) : (
        <>
          <button
            type="button"
            className="group relative hidden h-full w-2 cursor-col-resize bg-white transition-colors hover:bg-accent/10 focus:outline-none focus:ring-2 focus:ring-accent/30 md:block"
            onPointerDown={handleMetadataResizePointerDown}
            onKeyDown={handleMetadataResizeKeyDown}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize links and backlinks metadata"
            aria-valuemin={0}
            aria-valuemax={METADATA_PANEL_MAX_WIDTH}
            aria-valuenow={metadataPanelWidth}
            title="Drag right to hide metadata. Use ArrowRight to expand and ArrowLeft to collapse."
          >
            <span className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-border transition-colors group-hover:bg-accent/50" />
            <span className="absolute left-1/2 top-1/2 h-14 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-border transition-colors group-hover:bg-accent/60" />
          </button>

          <aside className="shrink-0 border-t border-border bg-surface/40 px-4 py-4 md:min-h-0 md:overflow-y-auto md:border-t-0 md:px-3">
            <LinkSection title="Links" links={links} onNavigate={onNavigate} />
            <div className="mt-5">
              <LinkSection title="Backlinks" links={backlinks} onNavigate={onNavigate} />
            </div>
          </aside>
        </>
      )}
    </div>
  );
}

function LinkSection({
  title,
  links,
  onNavigate,
}: {
  title: string;
  links: CompiledPageLink[];
  onNavigate?: (slug: string) => void;
}) {
  return (
    <section>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold text-foreground">{title}</h3>
        <span className="text-[10px] text-muted">{links.length}</span>
      </div>
      {links.length === 0 ? (
        <p className="text-xs text-muted">No typed links yet.</p>
      ) : (
        <ul className="space-y-2">
          {links.map((link, index) => (
            <li key={`${link.kind}-${link.slug}-${index}`}>
              <button
                type="button"
                onClick={() => onNavigate?.(link.slug)}
                disabled={!onNavigate}
                className="w-full rounded border border-border bg-white px-2.5 py-2 text-left transition-colors enabled:hover:border-accent enabled:hover:text-accent disabled:cursor-default"
                title={link.context ?? undefined}
              >
                <div className="mb-1 inline-flex rounded border border-border bg-surface px-1.5 py-0.5 text-[10px] font-semibold uppercase text-muted">
                  {link.kind}
                </div>
                <div className="truncate text-xs font-medium text-foreground">
                  {link.title || link.slug}
                </div>
                <div className="mt-0.5 truncate font-mono text-[10px] text-muted">
                  {link.slug}
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
