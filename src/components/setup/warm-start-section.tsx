"use client";

/**
 * WarmStartSection — dashboard card that turns an initialized, empty
 * research store into a useful brain by importing the user's corpus.
 *
 * Phase C Lane 4 of the ScienceSwarm → gbrain pivot. Mounted below
 * the study dashboard when the local store exists but the study
 * has no imported data. This is where a scientist actually watches a
 * real warm-start import happen, so it doubles as the demo site for
 * the reusable `BrainProgress` component.
 *
 * The flow is deliberately two-step:
 *
 *   1. User types a directory path, clicks "Scan corpus". We POST
 *      `{ action: "scan", paths: [path] }` to `/api/brain/coldstart`
 *      and show a summary (`N files, M duplicate groups`).
 *   2. User clicks "Import approved files" → we mount `BrainProgress`
 *      pointed at `/api/brain/coldstart-stream` with the preview as
 *      the POST body. The component owns the streaming UX
 *      (progress bar, current file, elapsed, ETA, error list).
 *
 * The section is *optional* — `/setup` stays usable without it. The
 * user can skip straight to the dashboard and trigger warm-start
 * later (feature not wired in the dashboard yet; future PR).
 *
 * This file deliberately does not import `src/brain/*` types: it
 * treats the preview as an opaque `unknown` object to stay on the
 * right side of the frontend/backend boundary.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  BrainProgress,
  type BrainProgressResult,
} from "@/components/progress/brain-progress";
import { Spinner } from "@/components/spinner";

interface ScanSummary {
  fileCount: number;
  duplicateGroupCount: number;
  projectCount: number;
  preview: Record<string, unknown>;
}

type ViewState =
  | { kind: "idle" }
  | { kind: "scanning" }
  | { kind: "scanned"; summary: ScanSummary }
  | { kind: "importing"; summary: ScanSummary }
  | { kind: "done"; summary: ScanSummary; result: BrainProgressResult }
  | { kind: "error"; message: string };

export interface WarmStartSectionProps {
  /**
   * Disables the whole section — e.g. while `/api/setup/status` is
   * still loading and we don't yet know whether a brain exists.
   */
  disabled?: boolean;
  /** When present, import directly into the active study slug. */
  projectSlug?: string | null;
}

export function WarmStartSection({
  disabled = false,
  projectSlug = null,
}: WarmStartSectionProps) {
  const [path, setPath] = useState<string>("");
  const [state, setState] = useState<ViewState>({ kind: "idle" });
  const statusRef = useRef<HTMLDivElement | null>(null);
  const lockedProjectSlug = projectSlug?.trim() || null;

  useEffect(() => {
    if (
      state.kind === "scanned" ||
      state.kind === "importing" ||
      state.kind === "done"
    ) {
      statusRef.current?.scrollIntoView?.({ block: "center" });
    }
  }, [state.kind]);

  const handleScan = useCallback(async () => {
    const trimmed = path.trim();
    if (trimmed.length === 0) {
      setState({ kind: "error", message: "Enter a directory path first." });
      return;
    }
    setState({ kind: "scanning" });
    try {
      const res = await fetch("/api/brain/coldstart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "scan", paths: [trimmed] }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(body.error ?? `Scan failed with HTTP ${res.status}`);
      }
      const scan = (await res.json()) as {
        files?: unknown[];
        duplicateGroups?: unknown[];
        projects?: unknown[];
      };
      const summary: ScanSummary = {
        fileCount: Array.isArray(scan.files) ? scan.files.length : 0,
        duplicateGroupCount: Array.isArray(scan.duplicateGroups)
          ? scan.duplicateGroups.length
          : 0,
        projectCount: Array.isArray(scan.projects) ? scan.projects.length : 0,
        preview: scan as Record<string, unknown>,
      };
      setState({ kind: "scanned", summary });
    } catch (err) {
      setState({
        kind: "error",
        message: err instanceof Error ? err.message : "Scan failed",
      });
    }
  }, [path]);

  const handleStartImport = useCallback(() => {
    if (state.kind !== "scanned") return;
    setState({ kind: "importing", summary: state.summary });
  }, [state]);

  const handleComplete = useCallback(
    (result: BrainProgressResult) => {
      // Freeze the summary into the "done" view so re-renders don't
      // re-trigger the import by re-mounting BrainProgress.
      setState((prev) =>
        prev.kind === "importing"
          ? { kind: "done", summary: prev.summary, result }
          : prev,
      );
    },
    [],
  );

  // Memoize the request body so we pass a stable reference down to
  // BrainProgress. Without this, every render of WarmStartSection
  // creates a new object literal, which (because requestBody is in
  // BrainProgress's handleRun deps) forces handleRun to recreate and
  // re-triggers the autoStart effect on each render — autoStartedRef
  // guards the actual second run, but the churn is still wasted work
  // (Greptile P2 on PR #248).
  const previewForImport =
    state.kind === "importing" || state.kind === "done"
      ? state.summary.preview
      : null;
  const importRequestBody = useMemo(
    () =>
      previewForImport
        ? {
            preview: previewForImport,
            options: {
              skipDuplicates: true,
              ...(lockedProjectSlug
                ? { projectSlug: lockedProjectSlug }
                : {}),
            },
          }
        : undefined,
    [lockedProjectSlug, previewForImport],
  );

  return (
    <section
      className="rounded-[28px] border-2 border-border bg-white p-5 shadow-sm"
      data-testid="warm-start-section"
    >
      <p className="text-[10px] font-bold uppercase tracking-[0.24em] text-muted">
        BUILD YOUR RESEARCH BRAIN
      </p>
      <h2 className="mt-2 text-xl font-semibold text-foreground">
        Import your first corpus
      </h2>
      <p className="mt-2 text-sm leading-6 text-muted">
        Point ScienceSwarm at a folder of research you already have on
        disk (PDFs, notes, code, datasets). We scan the folder, classify
        every file into a MECE bucket, and write structured pages into
        the local research store. Until this import runs, your brain is
        still mostly empty. Expect 10-50 seconds for a typical lab
        folder; the progress panel shows every file as it lands.
      </p>
      {lockedProjectSlug ? (
        <p className="mt-2 text-xs text-muted">
          Import target:{" "}
          <span className="font-mono text-foreground">{lockedProjectSlug}</span>
        </p>
      ) : null}

      <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center">
        <label htmlFor="warm-start-path" className="sr-only">
          Folder path to scan
        </label>
        <input
          id="warm-start-path"
          type="text"
          value={path}
          onChange={(ev) => setPath(ev.target.value)}
          placeholder="/Users/you/Documents/research"
          disabled={
            disabled ||
            state.kind === "scanning" ||
            state.kind === "importing"
          }
          data-testid="warm-start-path-input"
          className="flex-1 rounded-xl border-2 border-border bg-surface/30 px-3 py-2 font-mono text-xs text-foreground placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent"
        />
        <button
          type="button"
          onClick={handleScan}
          disabled={
            disabled ||
            state.kind === "scanning" ||
            state.kind === "importing"
          }
          data-testid="warm-start-scan-button"
          className="rounded-xl bg-accent px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
        >
          {state.kind === "scanning" ? (
            <span className="inline-flex items-center gap-2">
              <Spinner size="h-3.5 w-3.5" className="text-white" testId="warm-start-scan-spinner" />
              Scanning…
            </span>
          ) : (
            "Scan corpus"
          )}
        </button>
      </div>

      {state.kind === "scanned" && (
        <div
          ref={statusRef}
          className="mt-4 rounded-xl border border-border bg-surface/30 px-4 py-3 text-sm text-foreground"
          data-testid="warm-start-summary"
        >
          <p className="font-medium">
            Found {state.summary.fileCount} file
            {state.summary.fileCount === 1 ? "" : "s"}
          </p>
          <p className="mt-1 text-xs text-muted">
            {state.summary.projectCount} detected project
            {state.summary.projectCount === 1 ? "" : "s"}
            {", "}
            {state.summary.duplicateGroupCount} duplicate group
            {state.summary.duplicateGroupCount === 1 ? "" : "s"}
          </p>
          <button
            type="button"
            onClick={handleStartImport}
            disabled={disabled || state.summary.fileCount === 0}
            data-testid="warm-start-import-button"
            className="mt-3 rounded-xl bg-accent px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
          >
            Import approved files
          </button>
        </div>
      )}

      {(state.kind === "importing" || state.kind === "done") && (
        <div
          ref={statusRef}
          className="mt-4"
          data-testid="warm-start-progress-container"
        >
          <BrainProgress
            streamUrl="/api/brain/coldstart-stream"
            requestBody={importRequestBody}
            title="Importing your corpus"
            description={`Writing ${state.summary.fileCount} files into your research brain.`}
            onComplete={handleComplete}
            testId="warm-start-brain-progress"
          />
        </div>
      )}

      {state.kind === "error" && (
        <div
          role="alert"
          className="mt-4 rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger"
          data-testid="warm-start-error"
        >
          <p className="font-medium">{state.message}</p>
          <button
            type="button"
            onClick={() => setState({ kind: "idle" })}
            className="mt-2 text-xs underline"
          >
            Reset
          </button>
        </div>
      )}
    </section>
  );
}
