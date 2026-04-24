"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import type { ImportPreview } from "@/brain/types";
import type { ProcessedFolderTreeNode } from "@/lib/folder-processor";

// ── Types ────────────────────────────────────────────────────

interface ImportedFolder {
  name: string;
  basePath?: string;
  totalFiles: number;
  detectedFiles?: number;
  detectedItems?: number;
  detectedBytes?: number;
  files: {
    path: string;
    name: string;
    type: string;
    size: number;
    hash?: string;
    content?: string;
    metadata?: Record<string, unknown>;
  }[];
  tree?: ProcessedFolderTreeNode[];
  analysis?: string;
  backend?: string;
  preview?: ImportPreview;
  projects?: ImportPreview["projects"];
  duplicateGroups?: ImportPreview["duplicateGroups"];
  warnings?: ImportPreview["warnings"];
}

export interface CompletedImportResult {
  projectSlug: string;
  name: string;
  totalFiles: number;
  detectedItems?: number;
  detectedBytes?: number;
  duplicateGroups?: number;
  source?: string;
  warnings?: ImportPreview["warnings"];
}

interface ImportDialogProps {
  open: boolean;
  onClose: () => void;
  projectSlug?: string | null;
  onImport: (result: CompletedImportResult) => void | Promise<void>;
  initialPath?: string | null;
}

type ImportState = "idle" | "scanning" | "previewing" | "importing" | "error";

interface ImportJobStatus {
  id: string;
  project: string;
  folderName: string;
  folderPath: string;
  status: "queued" | "running" | "completed" | "failed";
  progress: {
    phase: "queued" | "scanning" | "importing" | "finalizing";
    detectedFiles: number;
    detectedItems: number;
    detectedBytes: number;
    importedFiles: number;
    skippedDuplicates: number;
    duplicateGroups: number;
    currentPath: string | null;
  };
  result: {
    project: string;
    title: string;
    importedFiles: number;
    detectedItems: number;
    detectedBytes: number;
    duplicateGroups: number;
    projectPagePath: string;
    sourcePageCount: number;
    generatedAt: string;
    warnings?: ImportPreview["warnings"];
  } | null;
  error: string | null;
}

const LEGACY_DEMO_DATA_PREFIX = "~/.scienceswarm/demo-data/";
const RECENT_IMPORT_PATHS_KEY = "scienceswarm.importDialog.recentPaths";
const ACTIVE_IMPORT_JOB_KEY = "scienceswarm.importDialog.activeJob";
const MAX_RECENT_IMPORT_PATHS = 1;
const IMPORT_PROGRESS_SEGMENTS = 10;

function isHiddenRecentImportPath(value: string): boolean {
  return value.startsWith(LEGACY_DEMO_DATA_PREFIX);
}

interface PersistedImportJobRecord {
  id: string;
  project: string;
  projectTitle: string | null;
  folderName: string;
  folderPath: string;
  preparedFiles: number | null;
  detectedItems: number | null;
  detectedBytes: number | null;
  handledCompletion: boolean;
  savedAt: string;
}

type ImportProgressSummary = {
  label: string;
  detail: string;
  percent: number | null;
  percentLabel: string | null;
};

function isPersistedImportJobRecord(value: unknown): value is PersistedImportJobRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<PersistedImportJobRecord>;
  return (
    typeof record.id === "string"
    && typeof record.project === "string"
    && (record.projectTitle === undefined || record.projectTitle === null || typeof record.projectTitle === "string")
    && typeof record.folderName === "string"
    && typeof record.folderPath === "string"
    && (record.preparedFiles === undefined || record.preparedFiles === null || typeof record.preparedFiles === "number")
    && (record.detectedItems === undefined || record.detectedItems === null || typeof record.detectedItems === "number")
    && (record.detectedBytes === undefined || record.detectedBytes === null || typeof record.detectedBytes === "number")
    && typeof record.handledCompletion === "boolean"
    && typeof record.savedAt === "string"
  );
}

function readPersistedImportJob(): PersistedImportJobRecord | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(ACTIVE_IMPORT_JOB_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!isPersistedImportJobRecord(parsed)) return null;
    return {
      ...parsed,
      projectTitle: parsed.projectTitle ?? null,
      preparedFiles: parsed.preparedFiles ?? null,
      detectedItems: parsed.detectedItems ?? null,
      detectedBytes: parsed.detectedBytes ?? null,
    };
  } catch {
    return null;
  }
}

function persistImportJob(
  job: ImportJobStatus,
  handledCompletion: boolean,
  context?: {
    projectTitle?: string | null;
    preparedFiles?: number | null;
    detectedItems?: number | null;
    detectedBytes?: number | null;
  },
): PersistedImportJobRecord | null {
  if (typeof window === "undefined") return null;
  const previous = readPersistedImportJob();
  const record: PersistedImportJobRecord = {
    id: job.id,
    project: job.project,
    projectTitle: context?.projectTitle ?? previous?.projectTitle ?? null,
    folderName: job.folderName,
    folderPath: job.folderPath,
    preparedFiles: context?.preparedFiles ?? previous?.preparedFiles ?? null,
    detectedItems: context?.detectedItems ?? previous?.detectedItems ?? null,
    detectedBytes: context?.detectedBytes ?? previous?.detectedBytes ?? null,
    handledCompletion,
    savedAt: new Date().toISOString(),
  };
  try {
    window.localStorage.setItem(ACTIVE_IMPORT_JOB_KEY, JSON.stringify(record));
  } catch {
    // Keep the import flow usable when storage is unavailable.
  }
  return record;
}

function clearPersistedImportJob(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(ACTIVE_IMPORT_JOB_KEY);
  } catch {
    // Ignore storage cleanup failures.
  }
}

function createPlaceholderImportJob(record: PersistedImportJobRecord): ImportJobStatus {
  return {
    id: record.id,
    project: record.project,
    folderName: record.folderName,
    folderPath: record.folderPath,
    status: "queued",
    progress: {
      phase: "queued",
      detectedFiles: 0,
      detectedItems: 0,
      detectedBytes: 0,
      importedFiles: 0,
      skippedDuplicates: 0,
      duplicateGroups: 0,
      currentPath: null,
    },
    result: null,
    error: null,
  };
}

// ── Component ────────────────────────────────────────────────

export function ImportDialog({
  open,
  onClose,
  onImport,
  initialPath = null,
  projectSlug = null,
}: ImportDialogProps) {
  const [path, setPath] = useState("");
  const [state, setState] = useState<ImportState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportedFolder | null>(null);
  const [scanningPath, setScanningPath] = useState("");
  const [selectedProjectSlug, setSelectedProjectSlug] = useState<string | null>(null);
  const [recentPaths, setRecentPaths] = useState<string[]>([]);
  const [importJob, setImportJob] = useState<ImportJobStatus | null>(null);
  const [persistedImportJobRecord, setPersistedImportJobRecord] = useState<PersistedImportJobRecord | null>(null);
  const [importNotice, setImportNotice] = useState<string | null>(null);
  const onImportRef = useRef(onImport);
  const onCloseRef = useRef(onClose);
  const openRef = useRef(open);
  const persistedImportJobRecordRef = useRef<PersistedImportJobRecord | null>(null);
  const completionStateRef = useRef(new Map<string, "delivering" | "handled">());
  const lockedProjectSlug = projectSlug?.trim() || null;
  const effectiveTargetProjectSlug = lockedProjectSlug ?? selectedProjectSlug;

  useEffect(() => {
    onImportRef.current = onImport;
    onCloseRef.current = onClose;
    openRef.current = open;
    persistedImportJobRecordRef.current = persistedImportJobRecord;
  }, [onClose, onImport, open, persistedImportJobRecord]);

  useEffect(() => {
    if (!open) return;

    try {
      const raw = window.localStorage.getItem(RECENT_IMPORT_PATHS_KEY);
      if (!raw) {
        setRecentPaths([]);
        return;
      }

      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        setRecentPaths([]);
        return;
      }

      setRecentPaths(
        parsed
          .filter((value): value is string =>
            typeof value === "string" &&
            value.trim().length > 0 &&
            !isHiddenRecentImportPath(value))
          .slice(0, MAX_RECENT_IMPORT_PATHS),
      );
    } catch {
      setRecentPaths([]);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setPath(initialPath?.trim() ?? "");
  }, [initialPath, open]);

  useEffect(() => {
    if (!open || importJob?.id || state === "scanning" || state === "previewing") return;

    const persistedJob = readPersistedImportJob();
    if (!persistedJob || persistedJob.handledCompletion) {
      if (persistedJob?.handledCompletion) {
        clearPersistedImportJob();
      }
      setPersistedImportJobRecord(null);
      return;
    }

    setPersistedImportJobRecord(persistedJob);
    setPath(persistedJob.folderPath);
    setSelectedProjectSlug(persistedJob.project);
    setImportJob(createPlaceholderImportJob(persistedJob));
    setImportNotice(`Resumed background import tracking for ${persistedJob.folderName}.`);
    setError(null);
    setState("importing");
  }, [importJob?.id, open, state]);

  const rememberRecentPath = useCallback((nextPath: string) => {
    const normalizedPath = nextPath.trim();
    if (!normalizedPath) return;

    setRecentPaths((current) => {
      const updated = [
        normalizedPath,
        ...current.filter((value) =>
          value !== normalizedPath && !isHiddenRecentImportPath(value),
        ),
      ].slice(0, MAX_RECENT_IMPORT_PATHS);
      try {
        window.localStorage.setItem(RECENT_IMPORT_PATHS_KEY, JSON.stringify(updated));
      } catch {
        // Keep the current session usable even when storage is unavailable.
      }
      return updated;
    });
  }, []);

  const showPreview = useCallback((importedFolder: ImportedFolder) => {
    setPreview(importedFolder);
    setSelectedProjectSlug(
      lockedProjectSlug ?? importedFolder.preview?.projects[0]?.slug ?? null,
    );
    setState("previewing");
  }, [lockedProjectSlug]);

  const scanPath = useCallback(async (rawPath: string) => {
    const normalizedPath = rawPath.trim();
    if (!normalizedPath) return;

    setState("scanning");
    setError(null);
    setImportNotice(null);
    setPreview(null);
    setImportJob(null);
    setPersistedImportJobRecord(null);
    clearPersistedImportJob();
    setSelectedProjectSlug(null);
    setScanningPath(normalizedPath);

    try {
      const res = await fetch("/api/import-project", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: normalizedPath }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || `Import failed: ${res.status}`);
      }

      const importedFolder = data as ImportedFolder;
      showPreview(importedFolder);
      rememberRecentPath(normalizedPath);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Scan failed");
      setState("error");
    }
  }, [rememberRecentPath, showPreview]);

  const handleScan = useCallback(async () => {
    await scanPath(path);
  }, [path, scanPath]);

  const handleChooseFolder = useCallback(async () => {
    setError(null);
    setImportNotice(null);

    try {
      const res = await fetch("/api/local-folder-picker", {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || `Folder picker failed: ${res.status}`);
      }

      if (data.cancelled) {
        return;
      }

      if (typeof data.path !== "string" || data.path.trim().length === 0) {
        throw new Error("Folder picker returned no path");
      }

      setPath(data.path);
      await scanPath(data.path);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not choose a local folder");
      setState("error");
    }
  }, [scanPath]);

  const handleImport = useCallback(async () => {
    const structuredPreview = preview?.preview;
    if (!structuredPreview || !preview.basePath) return;
    setState("importing");
    setError(null);
    setImportNotice("The server is importing the full local folder in the background. You can close this dialog and reopen it later to resume progress.");

    try {
      const res = await fetch("/api/brain/import-project-job", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "start",
          path: preview.basePath,
          projectSlug: effectiveTargetProjectSlug ?? structuredPreview.projects[0]?.slug,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || `Import commit failed: ${res.status}`);
      }
      if (!data.job || typeof data.job !== "object") {
        throw new Error("Background import did not return a job");
      }
      const nextJob = data.job as ImportJobStatus;
      const targetProject = structuredPreview.projects.find(
        (candidate) => candidate.slug === (effectiveTargetProjectSlug ?? structuredPreview.projects[0]?.slug),
      );
      setPersistedImportJobRecord(persistImportJob(nextJob, false, {
        projectTitle: targetProject?.title ?? null,
        preparedFiles: preview.totalFiles ?? structuredPreview.totalFiles ?? preview.files.length,
        detectedItems: preview.detectedItems ?? preview.detectedFiles ?? null,
        detectedBytes: preview.detectedBytes ?? null,
      }));
      setImportJob(nextJob);
    } catch (err) {
      setImportJob(null);
      setPersistedImportJobRecord(null);
      clearPersistedImportJob();
      setImportNotice(null);
      setError(err instanceof Error ? err.message : "Import commit failed");
      setState("previewing");
    }
  }, [effectiveTargetProjectSlug, preview]);

  const handleClose = useCallback(() => {
    if (state === "importing") {
      setImportNotice((current) => (
        current ?? "Background import continues while this dialog is closed. Reopen it to check progress."
      ));
      onClose();
      return;
    }

    setState("idle");
    setPreview(null);
    setError(null);
    setImportNotice(null);
    setPath("");
    setScanningPath("");
    setSelectedProjectSlug(null);
    setImportJob(null);
    setPersistedImportJobRecord(null);
    clearPersistedImportJob();
    onClose();
  }, [onClose, state]);

  useEffect(() => {
    if (state !== "importing" || !importJob?.id) return;

    let cancelled = false;
    let inFlight = false;
    let consecutiveFailures = 0;

    const pollJob = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      let fatalFailure = false;

      try {
        const res = await fetch(`/api/brain/import-project-job?id=${encodeURIComponent(importJob.id)}`);
        const data = await res.json();
        if (!res.ok) {
          fatalFailure = res.status >= 400 && res.status < 500;
          if (res.status === 404) {
            throw new Error("Background import session is no longer available. Re-scan the local folder to start again.");
          }
          throw new Error(data.error || `Import status failed: ${res.status}`);
        }

        consecutiveFailures = 0;
        const nextJob = data as ImportJobStatus;
        setPersistedImportJobRecord(persistImportJob(nextJob, false, {
          projectTitle: persistedImportJobRecordRef.current?.projectTitle ?? null,
          preparedFiles: persistedImportJobRecordRef.current?.preparedFiles ?? null,
          detectedItems: persistedImportJobRecordRef.current?.detectedItems ?? null,
          detectedBytes: persistedImportJobRecordRef.current?.detectedBytes ?? null,
        }));
        setImportJob(nextJob);
        setImportNotice((current) => (
          current?.startsWith("Lost contact") ? null : current
        ));

        if (nextJob.status === "completed" && nextJob.result) {
          const completionState = completionStateRef.current.get(nextJob.id);
          if (completionState === "delivering" || completionState === "handled") {
            clearPersistedImportJob();
            window.clearInterval(interval);
            return;
          }

          completionStateRef.current.set(nextJob.id, "delivering");
          window.clearInterval(interval);
          try {
            setPersistedImportJobRecord(persistImportJob(nextJob, true, {
              projectTitle: persistedImportJobRecordRef.current?.projectTitle ?? null,
              preparedFiles: persistedImportJobRecordRef.current?.preparedFiles ?? null,
              detectedItems: persistedImportJobRecordRef.current?.detectedItems ?? null,
              detectedBytes: persistedImportJobRecordRef.current?.detectedBytes ?? null,
            }));
            await onImportRef.current({
              projectSlug: nextJob.result.project ?? nextJob.project,
              name: nextJob.result.title,
              totalFiles: nextJob.result.importedFiles,
              detectedItems: nextJob.result.detectedItems,
              detectedBytes: nextJob.result.detectedBytes,
              duplicateGroups: nextJob.result.duplicateGroups,
              source: "background-local-import",
              ...(nextJob.result.warnings ? { warnings: nextJob.result.warnings } : {}),
            });
            completionStateRef.current.set(nextJob.id, "handled");
            clearPersistedImportJob();
            if (cancelled) return;
            setState("idle");
            setPreview(null);
            setPath("");
            setSelectedProjectSlug(null);
            setImportNotice(null);
            setImportJob(null);
            setPersistedImportJobRecord(null);
            if (openRef.current) {
              onCloseRef.current();
            }
          } catch (completionError) {
            completionStateRef.current.delete(nextJob.id);
            setPersistedImportJobRecord(persistImportJob(nextJob, false, {
              projectTitle: persistedImportJobRecordRef.current?.projectTitle ?? null,
              preparedFiles: persistedImportJobRecordRef.current?.preparedFiles ?? null,
              detectedItems: persistedImportJobRecordRef.current?.detectedItems ?? null,
              detectedBytes: persistedImportJobRecordRef.current?.detectedBytes ?? null,
            }));
            if (cancelled) return;
            setImportNotice(null);
            setError(completionError instanceof Error ? completionError.message : "Background import completed but the UI could not refresh.");
            setState(preview ? "previewing" : "error");
          }
          return;
        }

        if (nextJob.status === "failed") {
          if (cancelled) return;
          clearPersistedImportJob();
          window.clearInterval(interval);
          setImportNotice(null);
          setImportJob(nextJob);
          setPath(nextJob.folderPath);
          setError(nextJob.error || "Background import failed");
          setState(preview ? "previewing" : "error");
          return;
        }
      } catch (err) {
        consecutiveFailures += 1;
        const message = err instanceof Error ? err.message : "Background import failed";
        const shouldStopPolling = fatalFailure || consecutiveFailures >= 3;

        if (!shouldStopPolling) {
          setImportNotice("Lost contact with the local import worker. Retrying status checks...");
          return;
        }

        if (cancelled) return;
        clearPersistedImportJob();
        window.clearInterval(interval);
        setImportNotice(null);
        setError(message);
        setState(preview ? "previewing" : "error");
      } finally {
        inFlight = false;
      }
    };

    const interval = window.setInterval(() => {
      void pollJob();
    }, 1500);
    void pollJob();

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [importJob?.id, preview, state]);

  if (!open) return null;

  const structuredPreview = preview?.preview;
  const preparedFileCount = preview?.totalFiles ?? structuredPreview?.totalFiles ?? 0;
  const detectedItemCount = preview?.detectedItems ?? preview?.detectedFiles ?? null;
  const previewProjects = structuredPreview?.projects.slice(0, 3) ?? [];
  const progressSummary = importJob
    ? describeImportProgress(importJob, preview, persistedImportJobRecord)
    : null;
  const progressActiveSegments = progressSummary?.percent != null
    ? Math.max(
        0,
        Math.min(
          IMPORT_PROGRESS_SEGMENTS,
          Math.round((progressSummary.percent / 100) * IMPORT_PROGRESS_SEGMENTS),
        ),
      )
    : 0;
  const statusCardTone = importJob?.status === "failed"
    ? {
      border: "border-danger/30",
      bg: "bg-danger/10",
      heading: "text-danger",
      body: "text-danger",
      detail: "text-danger",
    }
    : {
      border: "border-rule",
      bg: "bg-sunk",
      heading: "text-body",
      body: "text-strong",
      detail: "text-body",
    };
  const pathSuggestions = recentPaths
    .filter((recentPath) => !isHiddenRecentImportPath(recentPath))
    .slice(0, 1)
    .map((recentPath) => ({
      label: `Recent: ${recentPath}`,
      value: recentPath,
    }));

  // Count files by type for preview
  const typeCounts: Record<string, number> = {};
  if (structuredPreview) {
    for (const file of structuredPreview.files) {
      const cat = categorizePreviewFile(file.classification, file.type);
      typeCounts[cat] = (typeCounts[cat] || 0) + 1;
    }
  } else if (preview) {
    for (const file of preview.files) {
      const cat = categorize(file.type);
      typeCounts[cat] = (typeCounts[cat] || 0) + 1;
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl border-2 border-border shadow-xl w-full max-w-2xl max-h-[calc(100vh-2rem)] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b-2 border-border flex-shrink-0">
          <h2 className="text-sm font-bold text-foreground">Import Local Folder</h2>
          <button
            onClick={handleClose}
            className="text-muted hover:text-foreground transition-colors text-lg leading-none"
          >
            x
          </button>
        </div>

        {/* Body */}
        <div className="p-6 space-y-4 overflow-y-auto">
          {/* Path input */}
          <div>
            <label className="text-xs font-medium text-muted block mb-1.5">
              Local folder path
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleScan();
                }}
                placeholder="/Users/your-username/code/your-project"
                className="flex-1 text-sm bg-surface border-2 border-border rounded-xl px-4 py-2.5 focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 transition-all font-mono"
                disabled={state === "scanning" || state === "importing"}
              />
              <button
                type="button"
                onClick={() => {
                  void handleChooseFolder();
                }}
                disabled={state === "scanning" || state === "importing"}
                className="border-2 border-border bg-white px-5 py-2.5 rounded-xl text-sm font-semibold text-foreground hover:border-accent hover:text-accent transition-colors disabled:opacity-40 flex-shrink-0"
              >
                Pick Local Folder
              </button>
              <button
                type="button"
                onClick={handleScan}
                disabled={!path.trim() || state === "scanning" || state === "importing"}
                className="bg-accent text-white px-5 py-2.5 rounded-xl text-sm font-semibold hover:bg-accent-hover transition-colors disabled:opacity-40 flex-shrink-0"
              >
                {state === "scanning" ? "Preparing..." : "Import"}
              </button>
            </div>
            {pathSuggestions.length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-2">
                {pathSuggestions.map((suggestion) => (
                  <button
                    key={suggestion.value}
                    type="button"
                    onClick={() => setPath(suggestion.value)}
                    disabled={state === "scanning" || state === "importing"}
                    className="rounded-full border border-border bg-surface/40 px-3 py-1 text-xs text-foreground transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
                  >
                    {suggestion.label}
                  </button>
                ))}
              </div>
            ) : null}
            <p className="text-xs text-muted">
              Pick a local folder, reuse the recent import path, or import the path directly.
            </p>
          </div>

          {/* Scanning indicator */}
          {state === "scanning" && (
            <div className="flex items-center gap-3 bg-surface/50 rounded-xl px-4 py-3">
              <div className="flex items-center gap-2 text-xs text-accent font-medium">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-accent" />
                </span>
                Scanning local folder {scanningPath}...
              </div>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="bg-danger/10 border border-danger/30 rounded-xl px-4 py-3 text-sm text-danger">
              {error}
            </div>
          )}

          {(state === "importing" || importJob?.status === "failed") && importJob && progressSummary ? (
            <div className={`rounded-xl border px-4 py-3 ${statusCardTone.border} ${statusCardTone.bg}`}>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className={`text-[10px] font-bold uppercase tracking-wider ${statusCardTone.heading}`}>
                    {importJob.status === "failed" ? "Import failed" : "Background import"}
                  </p>
                  <p className={`mt-1 text-sm font-semibold ${statusCardTone.body}`}>{importJob.folderName}</p>
                </div>
                <div className={`text-right text-xs ${statusCardTone.detail}`}>
                  <p>Phase: <span className="font-semibold">{humanizePhase(importJob.progress.phase)}</span></p>
                  {persistedImportJobRecord?.projectTitle ? (
                    <p>{persistedImportJobRecord.projectTitle}</p>
                  ) : null}
                </div>
              </div>
              {progressSummary.percent !== null ? (
                <div className="mt-3 space-y-1.5">
                  <div className="grid h-2 grid-cols-10 gap-0.5 overflow-hidden rounded-full" aria-hidden="true">
                    {Array.from({ length: IMPORT_PROGRESS_SEGMENTS }, (_, index) => (
                      <span
                        key={index}
                        className={`rounded-full transition-colors ${getImportProgressSegmentClass({
                          index,
                          activeSegments: progressActiveSegments,
                          failed: importJob.status === "failed",
                        })}`}
                      />
                    ))}
                  </div>
                  <p className={`text-xs font-medium ${statusCardTone.body}`}>{progressSummary.percentLabel}</p>
                </div>
              ) : null}
              <div className={`mt-3 space-y-1 text-xs ${statusCardTone.body}`}>
                <p>{progressSummary.label}</p>
                <p className={statusCardTone.detail}>{progressSummary.detail}</p>
                <p>
                  Imported {formatCount(importJob.progress.importedFiles)} unique files so far. Skipped {formatCount(importJob.progress.skippedDuplicates)} duplicate files across {formatCount(importJob.progress.duplicateGroups)} duplicate groups.
                </p>
                {importJob.progress.detectedBytes > 0 ? (
                  <p>{formatBytes(importJob.progress.detectedBytes)} read on disk so far.</p>
                ) : null}
                {importJob.progress.currentPath ? (
                  <p className={`font-mono text-[11px] ${statusCardTone.detail}`}>
                    Current: {importJob.progress.currentPath}
                  </p>
                ) : null}
                {importNotice ? (
                  <p className={statusCardTone.detail}>{importNotice}</p>
                ) : (
                  <p className={statusCardTone.detail}>
                    {importJob.status === "failed"
                      ? "The local worker stopped before completion. Re-scan the folder to retry."
                      : "The local worker keeps importing in the background. You can close this dialog and reopen it later to resume progress."}
                  </p>
                )}
              </div>
            </div>
          ) : null}

          {/* Preview */}
          {(state === "previewing" || state === "importing") && preview && (
            <div className="space-y-3">
              <div className="bg-surface/50 rounded-xl px-4 py-3">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-sm font-bold text-foreground">
                    {preview.name}
                  </span>
                  <span className="text-[10px] text-muted bg-white border border-border rounded px-2 py-0.5">
                    {detectedItemCount && detectedItemCount > preparedFileCount
                      ? `${formatCount(preparedFileCount)} files prepared for preview`
                      : `${formatCount(preparedFileCount)} files prepared locally`}
                  </span>
                  {detectedItemCount && detectedItemCount > preparedFileCount ? (
                    <span className="text-[10px] text-muted bg-white border border-border rounded px-2 py-0.5">
                      {formatCount(detectedItemCount)} items detected in local scan
                    </span>
                  ) : null}
                </div>
                {preview.detectedBytes && detectedItemCount && detectedItemCount > preparedFileCount ? (
                  <p className="mb-2 text-xs text-muted">
                    Local scan detected {formatCount(detectedItemCount)} items and {formatBytes(preview.detectedBytes)} on disk.
                    This preview prepared the first {formatCount(preparedFileCount)} files as a sample while the background import can continue from the full local folder.
                  </p>
                ) : null}

                {!lockedProjectSlug && previewProjects.length > 0 && (
                  <div className="mb-3 grid gap-2">
                    {previewProjects.map((previewProject) => (
                      <button
                        key={previewProject.slug}
                        type="button"
                        onClick={() => setSelectedProjectSlug(previewProject.slug)}
                        className={`rounded-xl border px-3 py-2 text-left transition-colors ${
                          selectedProjectSlug === previewProject.slug
                            ? "border-accent bg-accent/5"
                            : "border-border bg-white hover:border-accent/40"
                        }`}
                      >
                        <div className="flex items-center gap-2 text-xs text-foreground">
                          <span className="font-semibold">{previewProject.title}</span>
                          <span className={`rounded px-2 py-0.5 text-[10px] ${confidenceTone(previewProject.confidence)}`}>
                            {previewProject.confidence}
                          </span>
                          <span className="text-muted font-mono">{previewProject.slug}</span>
                          {selectedProjectSlug === previewProject.slug && (
                            <span className="ml-auto text-[10px] font-semibold text-accent">Selected</span>
                          )}
                        </div>
                        <p className="mt-1 text-xs text-muted">{previewProject.reason}</p>
                      </button>
                    ))}
                  </div>
                )}

                {/* Type breakdown */}
                <div className="grid grid-cols-2 gap-2">
                  {Object.entries(typeCounts)
                    .sort(([, a], [, b]) => b - a)
                    .map(([cat, count]) => (
                      <div
                        key={cat}
                        className="flex items-center gap-2 text-xs text-foreground"
                      >
                        <span>{categoryIcon(cat)}</span>
                        <span className="font-medium">{cat}</span>
                        <span className="text-muted ml-auto">{count}</span>
                      </div>
                    ))}
                </div>
              </div>

              {structuredPreview && (
                <div className="grid gap-3 md:grid-cols-3">
                  <div className="rounded-xl border border-border bg-surface/30 px-4 py-3">
                    <p className="text-[10px] font-bold uppercase tracking-wider text-muted">Scan backend</p>
                    <p className="mt-1 text-sm font-semibold text-foreground">{preview.backend || structuredPreview.backend}</p>
                  </div>
                  <div className="rounded-xl border border-border bg-surface/30 px-4 py-3">
                    <p className="text-[10px] font-bold uppercase tracking-wider text-muted">Duplicates</p>
                    <p className="mt-1 text-sm font-semibold text-foreground">{structuredPreview.duplicateGroups.length}</p>
                  </div>
                  <div className="rounded-xl border border-border bg-surface/30 px-4 py-3">
                    <p className="text-[10px] font-bold uppercase tracking-wider text-muted">Warnings</p>
                    <p className="mt-1 text-sm font-semibold text-foreground">{structuredPreview.warnings.length}</p>
                  </div>
                </div>
              )}

              {structuredPreview?.warnings.length ? (
                <div className="rounded-xl border border-warn/30 bg-warn/10 px-4 py-3">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-warn">Scan warnings</p>
                  <div className="mt-2 space-y-1">
                    {structuredPreview.warnings.slice(0, 4).map((warning) => (
                      <div key={`${warning.code}-${warning.path || warning.message}`} className="space-y-0.5">
                        <p className="text-xs text-warn">
                          {warning.code}: {warning.message}
                        </p>
                        {describeWarningAction(warning.code, {
                          preparedFileCount,
                          previewFileCount: structuredPreview.files.length,
                        }) ? (
                          <p className="text-[11px] text-warn">
                            {describeWarningAction(warning.code, {
                              preparedFileCount,
                              previewFileCount: structuredPreview.files.length,
                            })}
                          </p>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              {structuredPreview?.analysis ? (
                <div className="rounded-xl border border-border bg-surface/20 px-4 py-3">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-muted">Local scan summary</p>
                  <pre className="mt-2 max-h-36 overflow-auto whitespace-pre-wrap text-xs text-foreground">
                    {structuredPreview.analysis}
                  </pre>
                </div>
              ) : null}

              {/* Sample files */}
              <div className="max-h-40 overflow-y-auto bg-surface/30 rounded-xl px-4 py-2">
                <p className="text-[10px] font-bold text-muted uppercase tracking-wider mb-1">
                  Previewed files
                </p>
                {(structuredPreview?.files ?? []).slice(0, 15).map((f) => (
                  <div key={f.path} className="flex items-center gap-2 py-0.5 text-xs text-foreground">
                    <span>{categoryIcon(categorizePreviewFile(f.classification, f.type))}</span>
                    <span className="font-mono truncate">{f.path}</span>
                    <span className="ml-auto text-[10px] text-muted">{f.classification}</span>
                  </div>
                ))}
                {!structuredPreview &&
                  preview.files.slice(0, 15).map((f) => (
                    <div
                      key={f.path}
                      className="text-xs text-foreground py-0.5 font-mono truncate"
                    >
                      {f.path}
                    </div>
                  ))}
                {(structuredPreview?.files.length ?? preview.files.length) > 15 && (
                  <div className="text-xs text-muted py-0.5">
                    ... and {(structuredPreview?.files.length ?? preview.files.length) - 15} more files
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t-2 border-border bg-surface/30 flex-shrink-0">
          <button
            onClick={handleClose}
            className="text-sm text-muted hover:text-foreground transition-colors px-4 py-2"
          >
            {state === "importing" ? "Close" : "Cancel"}
          </button>
          {state === "previewing" && preview?.preview && (
            <button
              onClick={handleImport}
              className="bg-accent text-white px-6 py-2.5 rounded-xl text-sm font-semibold hover:bg-accent-hover transition-colors"
            >
              {`Import full archive in background${
                effectiveTargetProjectSlug ? ` to ${effectiveTargetProjectSlug}` : ""
              }`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function describeWarningAction(
  code: string,
  counts: { preparedFileCount: number; previewFileCount: number },
): string | null {
  if (code === "scan-limit") {
    return `This preview is capped at ${formatCount(counts.preparedFileCount)} files, but the server-side import can continue from the full local folder in the background.`;
  }
  if (code === "file-limit") {
    return `The preview list below is only a sample of the local scan. It shows the first ${formatCount(counts.previewFileCount)} files from the capped preview set.`;
  }
  if (code === "duplicates") {
    return "ScienceSwarm keeps the first file in each duplicate group and skips the rest during import.";
  }
  return null;
}

// ── Helpers ──────────────────────────────────────────────────

function describeImportProgress(
  job: ImportJobStatus,
  preview: ImportedFolder | null,
  persistedRecord: PersistedImportJobRecord | null,
): ImportProgressSummary {
  const knownDetectedItems = preview?.detectedItems
    ?? preview?.detectedFiles
    ?? persistedRecord?.detectedItems
    ?? null;
  const knownDetectedBytes = preview?.detectedBytes
    ?? persistedRecord?.detectedBytes
    ?? null;
  const scannedItems = knownDetectedItems
    ? Math.min(job.progress.detectedItems, knownDetectedItems)
    : job.progress.detectedItems;

  if (job.status === "failed") {
    return {
      label: knownDetectedItems
        ? `Last progress: ${formatCount(scannedItems)} of ${formatCount(knownDetectedItems)} items scanned.`
        : `Last progress: ${formatCount(job.progress.detectedItems)} items scanned.`,
      detail: knownDetectedBytes && knownDetectedBytes > 0
        ? `${formatBytes(Math.min(job.progress.detectedBytes, knownDetectedBytes))} of ${formatBytes(knownDetectedBytes)} read before the worker stopped.`
        : "The local worker stopped before completion.",
      percent: knownDetectedItems ? clampPercent(scannedItems, knownDetectedItems) : null,
      percentLabel: knownDetectedItems ? `${clampPercent(scannedItems, knownDetectedItems)}% of the initial local scan` : null,
    };
  }

  if (job.status === "completed") {
    return {
      label: `Imported ${formatCount(job.progress.importedFiles)} unique files from ${formatCount(job.progress.detectedItems)} scanned items.`,
      detail: "Finalizing the local project summary and refreshing the workspace.",
      percent: 100,
      percentLabel: "100% of the initial local scan",
    };
  }

  if (job.progress.phase === "queued") {
    return {
      label: "Queued locally. Waiting for the import worker to start.",
      detail: "You can close this dialog and reopen it later to resume tracking.",
      percent: 0,
      percentLabel: "Waiting for the local import worker",
    };
  }

  if (knownDetectedItems && knownDetectedItems > 0) {
    const percent = clampPercent(scannedItems, knownDetectedItems);
    return {
      label: `${formatCount(scannedItems)} of ${formatCount(knownDetectedItems)} items scanned.`,
      detail: knownDetectedBytes && knownDetectedBytes > 0
        ? `${formatBytes(Math.min(job.progress.detectedBytes, knownDetectedBytes))} of ${formatBytes(knownDetectedBytes)} read from the initial local scan.`
        : "Percentages are based on the initial local scan and may shift if files change during import.",
      percent,
      percentLabel: `${percent}% of the initial local scan`,
    };
  }

  if (job.progress.detectedBytes > 0) {
    return {
      label: `${formatCount(job.progress.detectedItems)} items scanned so far.`,
      detail: `${formatBytes(job.progress.detectedBytes)} read so far while the local worker continues scanning.`,
      percent: null,
      percentLabel: null,
    };
  }

  return {
    label: `Scanning the local folder. ${formatCount(job.progress.detectedItems)} items detected so far.`,
    detail: "ScienceSwarm updates this status as the local worker scans and imports the folder.",
    percent: null,
    percentLabel: null,
  };
}

function humanizePhase(phase: ImportJobStatus["progress"]["phase"]): string {
  switch (phase) {
    case "queued":
      return "Queued";
    case "scanning":
      return "Scanning";
    case "importing":
      return "Importing";
    case "finalizing":
      return "Finalizing";
    default:
      return phase;
  }
}

function getImportProgressSegmentClass(input: {
  index: number;
  activeSegments: number;
  failed: boolean;
}): string {
  if (input.index < input.activeSegments) {
    return input.failed ? "bg-danger" : "bg-accent";
  }
  return "bg-white/70";
}

function clampPercent(value: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((value / total) * 100)));
}

function categorize(ext: string): string {
  if (ext === "pdf") return "Papers";
  if (["py", "js", "ts", "tsx", "jsx", "r", "jl", "m", "sh", "sql", "do", "sps"].includes(ext)) return "Code";
  if (["csv", "json", "tsv", "xlsx", "xlsm", "xls"].includes(ext)) return "Data";
  if (["ipynb"].includes(ext)) return "Notebooks";
  if (["tex", "bib"].includes(ext)) return "LaTeX";
  if (["md", "txt", "rst"].includes(ext)) return "Docs";
  if (["png", "jpg", "jpeg", "gif", "svg"].includes(ext)) return "Figures";
  if (["yaml", "yml", "toml", "ini", "cfg"].includes(ext)) return "Config";
  return "Other";
}

function categorizePreviewFile(classification: string, type: string): string {
  if (classification === "paper") return "Papers";
  if (classification === "data") return "Data";
  if (classification === "spreadsheet") return "Data";
  if (classification === "notebook") return "Notebooks";
  if (classification === "code" || classification === "stats") return "Code";
  if (classification === "draft") return "Writing";
  if (classification === "protocol") return "Protocols";
  if (classification === "meeting_note" || classification === "class_note" || classification === "note") return "Notes";
  if (classification === "binary") return "Other";
  return categorize(type);
}

function categoryIcon(cat: string): string {
  const icons: Record<string, string> = {
    Papers: "📄",
    Code: "🐍",
    Data: "📊",
    Notebooks: "📓",
    LaTeX: "📝",
    Docs: "📑",
    Writing: "✍️",
    Protocols: "🧪",
    Notes: "🗒️",
    Figures: "🖼️",
    Config: "⚙️",
    Other: "📁",
  };
  return icons[cat] || "📁";
}

function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function confidenceTone(confidence: string): string {
  if (confidence === "high") return "bg-ok/10 text-ok";
  if (confidence === "medium") return "bg-warn/10 text-warn";
  return "bg-sunk text-body";
}
