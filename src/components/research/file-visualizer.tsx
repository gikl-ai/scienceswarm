"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ArrowClockwise,
  ChatCircleText,
  Code,
  Eye,
  FloppyDisk,
  PencilSimple,
  X,
} from "@phosphor-icons/react";
import { Spinner } from "@/components/spinner";
import {
  RenderedFileContent,
  SourceRenderer,
} from "@/components/research/file-renderers";
import { CompiledPageView } from "@/components/research/compiled-page-view";
import {
  canRenderKind,
  getFileDisplayName,
  getShikiLanguageForPath,
  type FilePreviewState,
} from "@/lib/file-visualization";

type VisualizerMode = "rendered" | "source" | "edit";

function defaultModeForPreview(preview: FilePreviewState): VisualizerMode {
  if (preview.status !== "ready") return "rendered";
  if (canRenderKind(preview.kind)) return "rendered";
  return "source";
}

function isReadyPreview(preview: FilePreviewState): preview is Extract<FilePreviewState, { status: "ready" }> {
  return preview.status === "ready";
}

function ModeButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex h-8 items-center gap-1.5 rounded border px-2.5 text-[11px] font-semibold transition-colors ${
        active
          ? "border-accent bg-accent text-white"
          : "border-border bg-white text-foreground hover:border-accent hover:text-accent"
      }`}
    >
      {children}
    </button>
  );
}

export function FileVisualizer({
  preview,
  inChatContext = false,
  onUseInChat,
  onClose,
  onRetry,
  onSaveContent,
  onNavigateBrainPage,
  extraActions,
}: {
  preview: FilePreviewState;
  inChatContext?: boolean;
  onUseInChat?: () => void;
  onClose?: () => void;
  onRetry?: () => void;
  onSaveContent?: (content: string) => Promise<void>;
  onNavigateBrainPage?: (slug: string) => void;
  extraActions?: React.ReactNode;
}) {
  const [mode, setMode] = useState<VisualizerMode>(() => defaultModeForPreview(preview));
  const [draft, setDraft] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setMode(defaultModeForPreview(preview));
    setDraft(isReadyPreview(preview) ? preview.content ?? "" : "");
    setSaveError(null);
  }, [preview]);

  const ready = isReadyPreview(preview) ? preview : null;
  const hasSource = ready ? typeof ready.content === "string" : false;
  const hasRendered = ready ? canRenderKind(ready.kind) : false;
  const canEdit = Boolean(ready?.editable && hasSource && onSaveContent);
  const fileName = ready
    ? getFileDisplayName(ready.path)
    : preview.status === "loading" || preview.status === "error"
      ? getFileDisplayName(preview.path)
      : "No file selected";

  const kindLabel = useMemo(() => {
    if (!ready) return "";
    return ready.kind.replace("-", " ");
  }, [ready]);

  const saveDraft = async () => {
    if (!onSaveContent) return;
    setSaving(true);
    setSaveError(null);
    try {
      await onSaveContent(draft);
      setMode(canRenderKind(ready?.kind ?? "unknown") ? "rendered" : "source");
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const renderBody = () => {
    if (preview.status === "idle") {
      return (
        <div className="flex h-full items-center justify-center bg-white px-4 text-sm text-muted">
          Select a file to preview.
        </div>
      );
    }

    if (preview.status === "loading") {
      return (
        <div className="flex h-full items-center justify-center gap-2 bg-white px-4 text-sm text-muted">
          <Spinner size="h-4 w-4" />
          <span>Loading {fileName}...</span>
        </div>
      );
    }

    if (preview.status === "error") {
      return (
        <div className="flex h-full items-center justify-center bg-white px-4">
          <div className="max-w-md rounded border border-border bg-surface px-4 py-3 text-sm">
            <div className="font-semibold text-foreground">{preview.message}</div>
            {preview.retryable && onRetry && (
              <button
                type="button"
                onClick={onRetry}
                className="mt-3 inline-flex items-center gap-1.5 rounded border border-border bg-white px-3 py-1.5 text-xs font-semibold text-foreground transition-colors hover:border-accent hover:text-accent"
              >
                <ArrowClockwise size={14} />
                Retry
              </button>
            )}
          </div>
        </div>
      );
    }

    if (mode === "edit" && canEdit) {
      return (
        <div className="flex h-full flex-col bg-white">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            spellCheck={false}
            className="min-h-0 flex-1 resize-none border-0 bg-white px-4 py-3 font-mono text-xs leading-5 text-foreground outline-none focus:ring-2 focus:ring-accent/20"
            aria-label={`Edit ${fileName}`}
          />
          <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border bg-white px-3 py-2">
            <div className="text-xs text-danger">{saveError}</div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setDraft(ready?.content ?? "");
                  setMode(hasRendered ? "rendered" : "source");
                }}
                className="rounded border border-border bg-white px-3 py-1.5 text-xs font-semibold text-foreground transition-colors hover:border-accent hover:text-accent"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={saveDraft}
                disabled={saving}
                className="inline-flex items-center gap-1.5 rounded bg-accent px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
              >
                <FloppyDisk size={14} />
                {saving ? "Saving" : "Save"}
              </button>
            </div>
          </div>
        </div>
      );
    }

    if (mode === "source" && hasSource) {
      return (
        <SourceRenderer
          content={preview.content ?? ""}
          language={getShikiLanguageForPath(preview.path, preview.mime)}
          fileName={fileName}
          sizeBytes={preview.sizeBytes}
        />
      );
    }

    if (ready?.compiledPage && mode === "rendered") {
      return (
        <CompiledPageView
          page={ready.compiledPage}
          onNavigate={onNavigateBrainPage}
        />
      );
    }

    if (hasRendered) {
      return <RenderedFileContent preview={preview} />;
    }

    if (hasSource) {
      return (
        <SourceRenderer
          content={preview.content ?? ""}
          language={getShikiLanguageForPath(preview.path, preview.mime)}
          fileName={fileName}
          sizeBytes={preview.sizeBytes}
        />
      );
    }

    return (
      <div className="flex h-full items-center justify-center bg-white px-4 text-sm text-muted">
        Preview unavailable.
      </div>
    );
  };

  return (
    <section
      aria-label="File visualizer"
      className="flex h-full min-h-0 flex-col overflow-hidden border-b border-border bg-white"
    >
      <div className="flex min-h-12 shrink-0 items-center justify-between gap-3 border-b border-border bg-white px-3 py-2">
        <div className="min-w-0">
          <div className="truncate font-mono text-xs font-semibold text-foreground" title={ready?.path ?? fileName}>
            {ready?.path ?? fileName}
          </div>
          {ready && (
            <div className="mt-0.5 text-[10px] uppercase tracking-wide text-muted">
              {kindLabel}
              {typeof ready.sizeBytes === "number" ? ` · ${ready.sizeBytes.toLocaleString()} bytes` : ""}
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {ready && (
            <div className="flex items-center gap-1" aria-label="Preview mode">
              {hasRendered && (
                <ModeButton active={mode === "rendered"} onClick={() => setMode("rendered")}>
                  <Eye size={14} />
                  Rendered
                </ModeButton>
              )}
              {hasSource && (
                <ModeButton active={mode === "source"} onClick={() => setMode("source")}>
                  <Code size={14} />
                  Source
                </ModeButton>
              )}
              {canEdit && (
                <ModeButton active={mode === "edit"} onClick={() => setMode("edit")}>
                  <PencilSimple size={14} />
                  Edit
                </ModeButton>
              )}
            </div>
          )}
          {ready && onUseInChat && (
            <button
              type="button"
              onClick={onUseInChat}
              disabled={inChatContext}
              className="inline-flex h-8 items-center gap-1.5 rounded border border-border bg-white px-2.5 text-[11px] font-semibold text-foreground transition-colors hover:border-accent hover:text-accent disabled:cursor-default disabled:text-muted"
              aria-label={inChatContext ? "In chat context" : "Use in chat"}
              title={inChatContext ? "In chat context" : "Use in chat"}
            >
              <ChatCircleText size={14} />
              {inChatContext ? "In chat context" : "Use in chat"}
            </button>
          )}
          {extraActions}
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-8 w-8 items-center justify-center rounded border border-border bg-white text-muted transition-colors hover:border-accent hover:text-foreground"
              title="Close visualizer"
              aria-label="Close visualizer"
            >
              <X size={14} />
            </button>
          )}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">{renderBody()}</div>
    </section>
  );
}
