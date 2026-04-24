"use client";

/**
 * BrainProgress — reusable SSE-driven progress panel.
 *
 * Phase C Lane 4 of the ScienceSwarm → gbrain pivot. Built for two
 * callers that both need a "watch the brain do long work" surface:
 *
 *   1. Warm-start messy-corpus import (Issue 8B). A scientist with a
 *      1000-file corpus will wait 10–50 seconds for the sequential
 *      import. The progress UI is what makes that wait feel
 *      productive — total, current file, elapsed, ETA, errors.
 *
 *   2. PGLite first-boot content-hash rebuild (Issue 9). On gbrain
 *      upgrade, PGLite re-runs a content-hash rebuild once per user.
 *      The `/setup` flow should surface that work rather than hanging.
 *      (Wired once the installer exposes rebuild progress events.)
 *
 * Streaming protocol
 * ------------------
 * The component POSTs a JSON body to `streamUrl` and reads SSE blocks
 * out of the response stream. We use a hand-rolled ReadableStream
 * reader, not `EventSource`, because POST + EventSource is not a
 * standard combination and both consumers need to pass a JSON body on
 * the same request. This matches the fixed pattern in
 * `src/components/setup/create-brain-section.tsx` (PR #242).
 *
 * Event shape — see `src/app/api/brain/coldstart-stream/route.ts`:
 *
 *   event: start      data: { total: number }
 *   event: progress   data: { phase, current, total, currentFile, message }
 *   event: file-done  data: { path, type, wikiPath }
 *   event: error      data: { path, error }
 *   event: complete   data: { imported, skipped, errors, ... }
 *
 * Any unknown event shape is silently ignored — forward compatibility
 * with future event types that land before a consumer is taught about
 * them.
 *
 * Lifecycle
 * ---------
 * An `AbortController` is threaded through the fetch + reader loop so
 * unmounting (user navigates away) cancels the in-flight request and
 * prevents `setState` on an unmounted component. Greptile flagged this
 * exact leak in PR #242's CreateBrainSection; we replicate the fixed
 * shape here.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// ── Public event/prop types ─────────────────────────────────────

/**
 * The union of SSE event types this component understands. New types
 * can be added without breaking existing streams — the parser discards
 * anything it can't decode.
 */
export type BrainProgressEvent =
  | { type: "start"; total: number }
  | {
      type: "progress";
      phase?: string;
      current: number;
      total: number;
      currentFile?: string;
      message?: string;
    }
  | { type: "file-done"; path: string; wikiPath?: string }
  | { type: "error"; path?: string; error: string }
  | {
      type: "complete";
      imported?: number;
      skipped?: number;
      errors?: Array<{ path: string; error: string }>;
      pagesCreated?: number;
      durationMs?: number;
    };

export interface BrainProgressResult {
  /** Total files processed (excluding pre-skipped duplicates). */
  processed: number;
  /** Files that the server imported successfully. */
  imported: number;
  /** Files the server deliberately skipped. */
  skipped: number;
  /** Non-fatal per-file errors. */
  errors: Array<{ path: string; error: string }>;
  /** Total elapsed wall time in ms. */
  elapsedMs: number;
}

export interface BrainProgressProps {
  /**
   * The SSE endpoint to POST to. Must return
   * `Content-Type: text/event-stream`.
   */
  streamUrl: string;
  /**
   * Optional JSON body to send with the POST. Defaults to an empty
   * object — some consumers just want to kick off work.
   */
  requestBody?: Record<string, unknown>;
  /** Header text shown above the progress bar. */
  title: string;
  /** Optional sub-header / description. */
  description?: string;
  /**
   * Auto-start on mount. Defaults to `true`. Set `false` to require
   * an explicit click on the "Start" button (useful for dashboards
   * where the user should confirm before kicking off a 30-second
   * import).
   */
  autoStart?: boolean;
  /**
   * Called once the stream emits a `complete` event. Receives the
   * final counts (imported, skipped, errors) plus elapsed wall time.
   */
  onComplete?: (result: BrainProgressResult) => void;
  /**
   * Called when the fetch or parse fails hard (network error, aborted
   * response, malformed stream). Unmount-triggered aborts are NOT
   * surfaced — they land as a silent cleanup.
   */
  onError?: (error: Error) => void;
  /**
   * Optional label overrides for the "start" and "running" button
   * states. The default copy is tuned for the warm-start case
   * ("Start import" / "Importing…").
   */
  startLabel?: string;
  runningLabel?: string;
  /** Test hook — stable DOM anchor. */
  testId?: string;
}

// ── Internal types ──────────────────────────────────────────────

type RunState = "idle" | "running" | "succeeded" | "failed";

interface ErrorEntry {
  path: string;
  message: string;
}

// ── Component ───────────────────────────────────────────────────

const ROLLING_WINDOW = 10;
const ELAPSED_TICK_MS = 1000;

export function BrainProgress({
  streamUrl,
  requestBody,
  title,
  description,
  autoStart = true,
  onComplete,
  onError,
  startLabel = "Start import",
  runningLabel = "Importing…",
  testId = "brain-progress",
}: BrainProgressProps) {
  const [state, setState] = useState<RunState>("idle");
  const [total, setTotal] = useState<number>(0);
  const [processed, setProcessed] = useState<number>(0);
  const [currentFile, setCurrentFile] = useState<string>("");
  const [statusMessage, setStatusMessage] = useState<string>("");
  const [errors, setErrors] = useState<ErrorEntry[]>([]);
  const [errorsExpanded, setErrorsExpanded] = useState<boolean>(false);
  const [elapsedMs, setElapsedMs] = useState<number>(0);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [completionCount, setCompletionCount] = useState<number | null>(null);

  // Stable refs for long-lived state the run-loop closure needs to
  // read without re-triggering effects.
  const startedAtRef = useRef<number | null>(null);
  const fileDurationsRef = useRef<number[]>([]);
  const lastFileStartRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const autoStartedRef = useRef(false);
  // Snapshot onComplete/onError into refs so handleRun doesn't need to
  // re-bind when a consumer re-renders with a new inline closure.
  const onCompleteRef = useRef(onComplete);
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onCompleteRef.current = onComplete;
  }, [onComplete]);
  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  // Cleanup: abort any in-flight fetch on unmount. Without this we'd
  // leak a live reader calling setState after the component is gone
  // (same bug Greptile caught in PR #242's CreateBrainSection).
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
      autoStartedRef.current = false;
    };
  }, []);

  // Elapsed-time ticker. Only runs while state === "running".
  useEffect(() => {
    if (state !== "running") return;
    const interval = window.setInterval(() => {
      if (startedAtRef.current != null) {
        setElapsedMs(Date.now() - startedAtRef.current);
      }
    }, ELAPSED_TICK_MS);
    return () => window.clearInterval(interval);
  }, [state]);

  const resetState = useCallback(() => {
    setState("idle");
    setTotal(0);
    setProcessed(0);
    setCurrentFile("");
    setStatusMessage("");
    setErrors([]);
    setErrorsExpanded(false);
    setElapsedMs(0);
    setFatalError(null);
    setCompletionCount(null);
    startedAtRef.current = null;
    fileDurationsRef.current = [];
    lastFileStartRef.current = null;
  }, []);

  const applyEvent = useCallback((event: BrainProgressEvent) => {
    switch (event.type) {
      case "start": {
        setTotal(event.total);
        setStatusMessage(
          event.total > 0
            ? `Preparing to import ${event.total} files…`
            : "Starting…",
        );
        // First file will kick off its own timing below.
        lastFileStartRef.current = Date.now();
        return;
      }
      case "progress": {
        // `current` is 1-indexed from the server (files completed).
        // Track timing to derive the rolling average for ETA: each
        // time `current` advances, record how long the previous file
        // took.
        if (event.total > 0) setTotal(event.total);
        setProcessed(event.current);
        if (event.currentFile) setCurrentFile(event.currentFile);
        if (event.message) setStatusMessage(event.message);

        const now = Date.now();
        if (lastFileStartRef.current != null) {
          const delta = now - lastFileStartRef.current;
          // Clamp obviously-garbage negative deltas to zero.
          if (delta >= 0) {
            const buf = fileDurationsRef.current;
            buf.push(delta);
            if (buf.length > ROLLING_WINDOW) {
              buf.shift();
            }
          }
        }
        lastFileStartRef.current = now;
        return;
      }
      case "file-done": {
        // file-done is informational: the authoritative progress
        // counter is the next `progress` event. We just use it to
        // surface the current path if no message has landed yet.
        // Use a functional setState to read the freshest currentFile
        // instead of closing over it — otherwise applyEvent's
        // useCallback dep would force handleRun to recreate on every
        // progress tick (Greptile P2 on PR #248).
        if (event.path) {
          setCurrentFile((prev) => (prev ? prev : event.path));
        }
        return;
      }
      case "error": {
        const entry: ErrorEntry = {
          path: event.path ?? "",
          message: event.error,
        };
        setErrors((prev) => [...prev, entry]);
        return;
      }
      case "complete": {
        const imported = event.imported ?? 0;
        const skipped = event.skipped ?? 0;
        const errorList = event.errors ?? [];
        const elapsed =
          startedAtRef.current != null
            ? Date.now() - startedAtRef.current
            : 0;
        // Finalize UI state before calling back, so the consumer
        // can safely unmount us from inside onComplete.
        setState("succeeded");
        setElapsedMs(elapsed);
        setCompletionCount(imported + skipped);
        setStatusMessage(
          imported === 0 && skipped === 0
            ? "Nothing to import."
            : `Imported ${imported}${skipped > 0 ? ` (${skipped} skipped)` : ""}.`,
        );
        onCompleteRef.current?.({
          processed: imported + skipped,
          imported,
          skipped,
          errors: errorList,
          elapsedMs: elapsed,
        });
        return;
      }
      default: {
        // Unknown event — ignore for forward compatibility.
        return;
      }
    }
  }, []);

  const handleRun = useCallback(async () => {
    // Cancel any prior run before starting a new one.
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    resetState();
    setState("running");
    startedAtRef.current = Date.now();

    try {
      const response = await fetch(streamUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody ?? {}),
        signal: ac.signal,
      });
      if (!response.ok || !response.body) {
        const fallback =
          (await response.json().catch(() => ({}))) as { error?: string };
        const message =
          fallback.error ?? `Request failed with HTTP ${response.status}`;
        setState("failed");
        setFatalError(message);
        onErrorRef.current?.(new Error(message));
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      // Track the SSE event name per block so we can route it to the
      // right handler. Each block is a set of `field: value` lines.
      while (true) {
        if (ac.signal.aborted) {
          await reader.cancel().catch(() => {});
          break;
        }
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE blocks are separated by a blank line.
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() ?? "";
        for (const block of blocks) {
          let eventName = "message";
          let dataLine: string | null = null;
          for (const line of block.split("\n")) {
            if (line.startsWith("event:")) {
              eventName = line.slice("event:".length).trim();
            } else if (line.startsWith("data:")) {
              const json = line.slice("data:".length).trim();
              if (json.length > 0) dataLine = json;
            }
          }
          if (dataLine == null) continue;
          try {
            const payload = JSON.parse(dataLine);
            // The coldstart-stream route puts the type on the event:
            // line, not inside the JSON. Rehydrate the discriminant
            // before applying so the switch works on a flat type.
            applyEvent({ type: eventName, ...payload } as BrainProgressEvent);
          } catch {
            // Malformed block — skip, the next one may be fine.
          }
        }
      }
    } catch (err) {
      // Aborted fetches arrive here as AbortError. Those are the
      // expected outcome of unmount; never surface them as user-
      // visible failures.
      if ((err as { name?: string } | null)?.name === "AbortError") {
        return;
      }
      const message =
        err instanceof Error ? err.message : "Network error during import.";
      setState("failed");
      setFatalError(message);
      onErrorRef.current?.(err instanceof Error ? err : new Error(message));
    } finally {
      if (abortRef.current === ac) {
        abortRef.current = null;
      }
    }
  }, [streamUrl, requestBody, resetState, applyEvent]);

  // Auto-start on mount when requested. Runs exactly once regardless
  // of re-renders because handleRun is memoized on stable props.
  useEffect(() => {
    if (!autoStart) return;
    if (autoStartedRef.current) return;
    autoStartedRef.current = true;
    void handleRun();
  }, [autoStart, handleRun]);

  // ── Derived values for the UI ────────────────────────────────

  const percent = useMemo(() => {
    if (total <= 0) return state === "succeeded" ? 100 : 0;
    return Math.min(100, Math.round((processed / total) * 100));
  }, [total, processed, state]);

  const etaMs = useMemo(() => {
    // Rolling average over the last N per-file deltas. If we don't
    // yet have a data point, or we already finished, return null so
    // the UI can show a placeholder instead of a meaningless "0s".
    const buf = fileDurationsRef.current;
    if (state !== "running" || buf.length === 0 || total <= 0) return null;
    const remaining = Math.max(0, total - processed);
    if (remaining === 0) return 0;
    const avg = buf.reduce((acc, v) => acc + v, 0) / buf.length;
    return Math.round(avg * remaining);
    // `elapsedMs` is intentionally in the dep list so the ETA
    // re-renders on each elapsed tick even though the actual ETA
    // math reads from a ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [elapsedMs, state, total, processed]);

  const buttonLabel =
    state === "running"
      ? runningLabel
      : state === "failed"
        ? "Retry import"
        : state === "succeeded"
          ? "Re-run import"
          : startLabel;

  return (
    <section
      className="rounded-[28px] border-2 border-border bg-white p-5 shadow-sm"
      data-testid={testId}
      data-state={state}
    >
      <header>
        <h2 className="text-xl font-semibold text-foreground">{title}</h2>
        {description && (
          <p className="mt-1 text-sm leading-6 text-muted">{description}</p>
        )}
      </header>

      {!autoStart && (
        <div className="mt-4">
          <button
            type="button"
            onClick={handleRun}
            disabled={state === "running"}
            data-testid={`${testId}-run-button`}
            className="rounded-xl bg-accent px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
          >
            {buttonLabel}
          </button>
        </div>
      )}

      <div
        className="mt-5"
        data-testid={`${testId}-bar`}
        aria-live="polite"
      >
        <div className="flex items-baseline justify-between text-sm">
          <span className="font-medium text-foreground">
            {state === "idle"
              ? "Waiting to start"
              : state === "running"
                ? `${processed} of ${total || "?"}`
                : state === "succeeded"
                  ? `${completionCount ?? processed} of ${total || processed} — done`
                  : "Import failed"}
          </span>
          <span className="tabular-nums text-xs text-muted">
            {percent}%
          </span>
        </div>
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          className="mt-1 h-2 w-full overflow-hidden rounded-full bg-surface"
        >
          <div
            className={`h-full transition-[width] duration-300 ${state === "failed" ? "bg-danger" : "bg-accent"}`}
            style={{ width: `${percent}%` }}
          />
        </div>
      </div>

      {(currentFile || statusMessage) && (
        <p
          className="mt-3 truncate text-xs text-muted"
          data-testid={`${testId}-current`}
          title={currentFile || statusMessage}
        >
          {currentFile ? currentFile : statusMessage}
        </p>
      )}

      <dl
        className="mt-3 grid grid-cols-2 gap-3 text-xs"
        data-testid={`${testId}-stats`}
      >
        <div>
          <dt className="font-medium uppercase tracking-[0.16em] text-muted">
            Elapsed
          </dt>
          <dd className="mt-0.5 font-mono text-sm text-foreground">
            {formatDuration(elapsedMs)}
          </dd>
        </div>
        <div>
          <dt className="font-medium uppercase tracking-[0.16em] text-muted">
            ETA
          </dt>
          <dd className="mt-0.5 font-mono text-sm text-foreground">
            {etaMs == null ? "—" : formatDuration(etaMs)}
          </dd>
        </div>
      </dl>

      {errors.length > 0 && (
        <div
          className="mt-4 rounded-xl border border-warn/30 bg-warn/10 px-4 py-3 text-sm text-warn"
          data-testid={`${testId}-error-list`}
        >
          <button
            type="button"
            onClick={() => setErrorsExpanded((prev) => !prev)}
            className="flex w-full items-center justify-between text-left font-medium"
            aria-expanded={errorsExpanded}
            data-testid={`${testId}-error-toggle`}
          >
            <span>
              {errors.length} file{errors.length === 1 ? "" : "s"} had errors
            </span>
            <span aria-hidden="true" className="text-xs">
              {errorsExpanded ? "▾" : "▸"}
            </span>
          </button>
          {errorsExpanded && (
            <ul className="mt-2 space-y-1 text-xs">
              {errors.map((entry, i) => (
                <li key={`${entry.path}-${i}`} className="truncate">
                  <span className="font-mono">{entry.path || "(no path)"}</span>
                  {": "}
                  <span>{entry.message}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {state === "succeeded" && (
        <div
          role="status"
          className="mt-4 rounded-xl border border-ok/30 bg-ok/10 px-4 py-3 text-sm text-ok"
          data-testid={`${testId}-success-banner`}
        >
          Imported {completionCount ?? processed} file
          {(completionCount ?? processed) === 1 ? "" : "s"} in{" "}
          {formatDuration(elapsedMs)}.
        </div>
      )}

      {state === "failed" && fatalError && (
        <div
          role="alert"
          className="mt-4 rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger"
          data-testid={`${testId}-error-banner`}
        >
          <p className="font-medium">{fatalError}</p>
          <p className="mt-1 text-xs">
            Check the server logs for details, then retry.
          </p>
        </div>
      )}
    </section>
  );
}

// ── Helpers ─────────────────────────────────────────────────────

/**
 * Format a millisecond duration as `Xs` / `Xm Ys` / `Xh Ym` depending
 * on magnitude. We don't use Intl.RelativeTimeFormat here because it
 * rounds to a single unit (30 seconds → "half a minute") which is
 * worse than "30s" for a live-updating progress UI.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  return remMin === 0 ? `${hours}h` : `${hours}h ${remMin}m`;
}
