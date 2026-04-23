"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowSquareOut,
  Graph,
  SpinnerGap,
} from "@phosphor-icons/react";
import type {
  ApplyManifest,
  ApplyManifestOperation,
  ApplyOperation,
  ApplyPlan,
  GapSuggestion,
  GapSuggestionState,
  PaperLibraryClustersResponse,
  PaperLibraryGapsResponse,
  PaperLibraryGraphResponse,
  PaperLibraryScan,
  PaperReviewItem,
  PaperReviewItemState,
} from "@/lib/paper-library/contracts";
import { buildWorkspaceHrefForSlug } from "@/lib/project-navigation";

type PaperLibraryStep = "scan" | "review" | "apply" | "graph" | "history";
type ReviewFilter = Extract<PaperReviewItemState, "needs_review" | "accepted" | "ignored" | "unresolved">;
const DEFAULT_REVIEW_FILTER: ReviewFilter = "needs_review";
type GapFilter = GapSuggestionState | "all";

interface PaperLibrarySession {
  step: PaperLibraryStep;
  rootPath: string;
  templateFormat: string;
  scanId?: string;
  applyPlanId?: string;
  manifestId?: string;
}

interface ReviewPage {
  items: PaperReviewItem[];
  nextCursor?: string;
  totalCount: number;
  filteredCount: number;
}

interface ApplyPlanPage {
  plan: ApplyPlan;
  operations: ApplyOperation[];
  nextCursor?: string;
  totalCount: number;
  filteredCount: number;
}

interface ManifestPage {
  manifest: ApplyManifest;
  operations: ApplyManifestOperation[];
  nextCursor?: string;
  totalCount: number;
  filteredCount: number;
}

interface GapPage {
  suggestions: GapSuggestion[];
  stateCounts: PaperLibraryGapsResponse["stateCounts"];
  nextCursor?: string;
  totalCount: number;
  filteredCount: number;
  warnings: string[];
}

interface PaperLibrarySessionDraft {
  title: string;
  year: string;
  authors: string;
  venue: string;
}

class PaperLibraryApiError extends Error {
  status: number;
  code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "PaperLibraryApiError";
    this.status = status;
    this.code = code;
  }
}

const DEFAULT_TEMPLATE = "{year} - {title}.pdf";

function defaultSession(): PaperLibrarySession {
  return {
    step: "scan",
    rootPath: "",
    templateFormat: DEFAULT_TEMPLATE,
  };
}

function sessionStorageKey(projectSlug: string): string {
  return `scienceswarm.paperLibrary.session.${projectSlug}`;
}

function readStoredSession(projectSlug: string): PaperLibrarySession {
  if (typeof window === "undefined") return defaultSession();
  try {
    const raw = window.localStorage.getItem(sessionStorageKey(projectSlug));
    if (!raw) return defaultSession();
    const candidate = JSON.parse(raw) as Partial<PaperLibrarySession>;
    return {
      step:
        candidate.step === "review" ||
        candidate.step === "apply" ||
        candidate.step === "graph" ||
        candidate.step === "history"
          ? candidate.step
          : "scan",
      rootPath: typeof candidate.rootPath === "string" ? candidate.rootPath : "",
      templateFormat:
        typeof candidate.templateFormat === "string" && candidate.templateFormat.trim().length > 0
          ? candidate.templateFormat
          : DEFAULT_TEMPLATE,
      scanId: typeof candidate.scanId === "string" ? candidate.scanId : undefined,
      applyPlanId: typeof candidate.applyPlanId === "string" ? candidate.applyPlanId : undefined,
      manifestId: typeof candidate.manifestId === "string" ? candidate.manifestId : undefined,
    };
  } catch {
    return defaultSession();
  }
}

function persistStoredSession(projectSlug: string, session: PaperLibrarySession): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(sessionStorageKey(projectSlug), JSON.stringify(session));
  } catch {
    // best effort
  }
}

async function paperLibraryFetchJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = payload && typeof payload === "object" && "error" in payload
      ? (payload as { error?: { message?: string; code?: string } }).error
      : undefined;
    throw new PaperLibraryApiError(
      response.status,
      error?.message ?? `Paper Library request failed (${response.status})`,
      error?.code,
    );
  }

  return payload as T;
}

function isScanInFlight(scan: PaperLibraryScan | null): boolean {
  return Boolean(
    scan && (
      scan.status === "queued" ||
      scan.status === "scanning" ||
      scan.status === "identifying" ||
      scan.status === "enriching"
    ),
  );
}

function summarizePrimaryCandidate(item: PaperReviewItem): string {
  const selected = item.candidates.find((candidate) => candidate.id === item.selectedCandidateId) ?? item.candidates[0];
  if (!selected) return item.paperId;
  const title = selected.title?.trim() || item.paperId;
  if (selected.year) {
    return `${title} (${selected.year})`;
  }
  return title;
}

function reviewDraftForItem(item: PaperReviewItem, draft?: PaperLibrarySessionDraft): PaperLibrarySessionDraft {
  if (draft) return draft;
  const selected = item.candidates.find((candidate) => candidate.id === item.selectedCandidateId) ?? item.candidates[0];
  return {
    title: selected?.title ?? "",
    year: selected?.year ? String(selected.year) : "",
    authors: selected?.authors?.join(", ") ?? "",
    venue: selected?.venue ?? "",
  };
}

function formatStatus(status: string): string {
  return status.replaceAll("_", " ");
}

function makeIdempotencyKey(prefix: string): string {
  const webCrypto = globalThis.crypto;
  if (webCrypto && typeof webCrypto.randomUUID === "function") {
    return `${prefix}-${webCrypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}`;
}

function StepButton({
  active,
  count,
  disabled,
  label,
  onClick,
}: {
  active: boolean;
  count?: number;
  disabled?: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex h-9 items-center gap-2 rounded-lg border px-3 text-xs font-semibold transition-colors ${
        active
          ? "border-accent bg-white text-foreground shadow-sm"
          : "border-border bg-surface text-muted hover:text-foreground"
      } disabled:cursor-not-allowed disabled:opacity-50`}
    >
      <span>{label}</span>
      {typeof count === "number" && <span className="text-[11px] text-muted">{count}</span>}
    </button>
  );
}

function StatusBadge({
  tone,
  value,
}: {
  tone: "neutral" | "success" | "warning" | "danger";
  value: string;
}) {
  const className = tone === "success"
    ? "border-emerald-200 bg-emerald-50 text-emerald-700"
    : tone === "warning"
      ? "border-amber-200 bg-amber-50 text-amber-700"
      : tone === "danger"
        ? "border-red-200 bg-red-50 text-red-700"
        : "border-border bg-surface text-muted";
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-1 text-[11px] font-semibold ${className}`}>
      {formatStatus(value)}
    </span>
  );
}

function EmptyState({
  title,
  body,
}: {
  title: string;
  body: string;
}) {
  return (
    <div className="flex min-h-[260px] items-center justify-center px-6 py-10 text-center">
      <div className="max-w-lg">
        <h3 className="text-base font-semibold text-foreground">{title}</h3>
        <p className="mt-2 text-sm text-muted">{body}</p>
      </div>
    </div>
  );
}

export function PaperLibraryCommandCenter({
  projectSlug,
}: {
  projectSlug: string;
}) {
  const [session, setSession] = useState<PaperLibrarySession>(() => readStoredSession(projectSlug));
  const [scan, setScan] = useState<PaperLibraryScan | null>(null);
  const [scanLoading, setScanLoading] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [commandError, setCommandError] = useState<string | null>(null);

  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>(DEFAULT_REVIEW_FILTER);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewLoadingMore, setReviewLoadingMore] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [reviewPage, setReviewPage] = useState<ReviewPage | null>(null);
  const [reviewActionItemId, setReviewActionItemId] = useState<string | null>(null);

  const [applyPlanLoading, setApplyPlanLoading] = useState(false);
  const [applyPlanLoadingMore, setApplyPlanLoadingMore] = useState(false);
  const [applyPlanError, setApplyPlanError] = useState<string | null>(null);
  const [applyPlanPage, setApplyPlanPage] = useState<ApplyPlanPage | null>(null);
  const [approvalToken, setApprovalToken] = useState<{ token: string; expiresAt: string } | null>(null);

  const [manifestLoading, setManifestLoading] = useState(false);
  const [manifestLoadingMore, setManifestLoadingMore] = useState(false);
  const [manifestError, setManifestError] = useState<string | null>(null);
  const [manifestPage, setManifestPage] = useState<ManifestPage | null>(null);
  const [repairingManifest, setRepairingManifest] = useState(false);
  const [undoing, setUndoing] = useState(false);

  const [graphLoading, setGraphLoading] = useState(false);
  const [graphError, setGraphError] = useState<string | null>(null);
  const [graphPage, setGraphPage] = useState<PaperLibraryGraphResponse | null>(null);
  const [graphLoadingMore, setGraphLoadingMore] = useState(false);

  const [clustersLoading, setClustersLoading] = useState(false);
  const [clustersError, setClustersError] = useState<string | null>(null);
  const [clustersPage, setClustersPage] = useState<PaperLibraryClustersResponse | null>(null);
  const [clustersLoadingMore, setClustersLoadingMore] = useState(false);
  const [gapFilter, setGapFilter] = useState<GapFilter>("all");
  const [gapsLoading, setGapsLoading] = useState(false);
  const [gapsError, setGapsError] = useState<string | null>(null);
  const [gapPage, setGapPage] = useState<GapPage | null>(null);
  const [gapsLoadingMore, setGapsLoadingMore] = useState(false);
  const [gapActionSuggestionId, setGapActionSuggestionId] = useState<string | null>(null);

  const [draftsByItemId, setDraftsByItemId] = useState<Record<string, PaperLibrarySessionDraft>>({});
  const [selectedCandidatesByItemId, setSelectedCandidatesByItemId] = useState<Record<string, string>>({});

  const patchSession = useCallback((patch: Partial<PaperLibrarySession>) => {
    setSession((current) => ({ ...current, ...patch }));
  }, []);

  const resetDownstreamState = useCallback(() => {
    setReviewPage(null);
    setReviewError(null);
    setApplyPlanPage(null);
    setApplyPlanError(null);
    setManifestPage(null);
    setManifestError(null);
    setGraphPage(null);
    setGraphError(null);
    setClustersPage(null);
    setClustersError(null);
    setGapPage(null);
    setGapsError(null);
    setGapFilter("all");
    setApprovalToken(null);
    setReviewFilter(DEFAULT_REVIEW_FILTER);
    setDraftsByItemId({});
    setSelectedCandidatesByItemId({});
  }, []);

  useEffect(() => {
    setSession(readStoredSession(projectSlug));
    setScan(null);
    setScanError(null);
    resetDownstreamState();
    setCommandError(null);
  }, [projectSlug, resetDownstreamState]);

  useEffect(() => {
    persistStoredSession(projectSlug, session);
  }, [projectSlug, session]);

  const loadScan = useCallback(async (scanId: string) => {
    setScanLoading(true);
    setScanError(null);
    try {
      const payload = await paperLibraryFetchJson<{ ok: true; scan: PaperLibraryScan }>(
        `/api/brain/paper-library/scan?project=${encodeURIComponent(projectSlug)}&id=${encodeURIComponent(scanId)}`,
      );
      setScan(payload.scan);
      if (payload.scan.rootPath && !session.rootPath) {
        patchSession({ rootPath: payload.scan.rootPath });
      }
      if (payload.scan.applyPlanId && payload.scan.applyPlanId !== session.applyPlanId) {
        patchSession({ applyPlanId: payload.scan.applyPlanId });
      }
    } catch (error) {
      setScanError(error instanceof Error ? error.message : "Could not load paper-library scan.");
    } finally {
      setScanLoading(false);
    }
  }, [patchSession, projectSlug, session.applyPlanId, session.rootPath]);

  const loadReview = useCallback(async ({ cursor, append = false }: { cursor?: string; append?: boolean } = {}) => {
    if (!session.scanId) return;
    if (append) setReviewLoadingMore(true);
    else setReviewLoading(true);
    setReviewError(null);
    try {
      const params = new URLSearchParams({
        project: projectSlug,
        scanId: session.scanId,
        limit: "25",
        filter: reviewFilter,
      });
      if (cursor) params.set("cursor", cursor);
      const payload = await paperLibraryFetchJson<
        { ok: true } & ReviewPage
      >(`/api/brain/paper-library/review?${params.toString()}`);
      setReviewPage((current) => ({
        items: append && current ? [...current.items, ...payload.items] : payload.items,
        nextCursor: payload.nextCursor,
        totalCount: payload.totalCount,
        filteredCount: payload.filteredCount,
      }));
    } catch (error) {
      setReviewError(error instanceof Error ? error.message : "Could not load the review queue.");
    } finally {
      setReviewLoading(false);
      setReviewLoadingMore(false);
    }
  }, [projectSlug, reviewFilter, session.scanId]);

  const loadApplyPlan = useCallback(async ({
    applyPlanId,
    cursor,
    append = false,
  }: {
    applyPlanId: string;
    cursor?: string;
    append?: boolean;
  }) => {
    if (append) setApplyPlanLoadingMore(true);
    else setApplyPlanLoading(true);
    setApplyPlanError(null);
    try {
      const params = new URLSearchParams({
        project: projectSlug,
        id: applyPlanId,
        limit: "25",
      });
      if (cursor) params.set("cursor", cursor);
      const payload = await paperLibraryFetchJson<
        { ok: true; plan: ApplyPlan; operations: ApplyOperation[]; nextCursor?: string; totalCount: number; filteredCount: number }
      >(`/api/brain/paper-library/apply-plan?${params.toString()}`);
      setApplyPlanPage((current) => ({
        plan: payload.plan,
        operations: append && current ? [...current.operations, ...payload.operations] : payload.operations,
        nextCursor: payload.nextCursor,
        totalCount: payload.totalCount,
        filteredCount: payload.filteredCount,
      }));
      if (payload.plan.manifestId && payload.plan.manifestId !== session.manifestId) {
        patchSession({ manifestId: payload.plan.manifestId });
      }
    } catch (error) {
      setApplyPlanError(error instanceof Error ? error.message : "Could not load the apply plan.");
    } finally {
      setApplyPlanLoading(false);
      setApplyPlanLoadingMore(false);
    }
  }, [patchSession, projectSlug, session.manifestId]);

  const loadManifest = useCallback(async ({
    manifestId,
    cursor,
    append = false,
  }: {
    manifestId: string;
    cursor?: string;
    append?: boolean;
  }) => {
    if (append) setManifestLoadingMore(true);
    else setManifestLoading(true);
    setManifestError(null);
    try {
      const params = new URLSearchParams({
        project: projectSlug,
        id: manifestId,
        limit: "25",
      });
      if (cursor) params.set("cursor", cursor);
      const payload = await paperLibraryFetchJson<
        { ok: true; manifest: ApplyManifest; operations: ApplyManifestOperation[]; nextCursor?: string; totalCount: number; filteredCount: number }
      >(`/api/brain/paper-library/manifest?${params.toString()}`);
      setManifestPage((current) => ({
        manifest: payload.manifest,
        operations: append && current ? [...current.operations, ...payload.operations] : payload.operations,
        nextCursor: payload.nextCursor,
        totalCount: payload.totalCount,
        filteredCount: payload.filteredCount,
      }));
    } catch (error) {
      setManifestError(error instanceof Error ? error.message : "Could not load the apply manifest.");
    } finally {
      setManifestLoading(false);
      setManifestLoadingMore(false);
    }
  }, [projectSlug]);

  const loadGraph = useCallback(async ({ cursor, append = false, refresh = false }: {
    cursor?: string;
    append?: boolean;
    refresh?: boolean;
  } = {}) => {
    if (!session.scanId) return;
    if (append) setGraphLoadingMore(true);
    else setGraphLoading(true);
    setGraphError(null);
    try {
      const params = new URLSearchParams({
        project: projectSlug,
        scanId: session.scanId,
        limit: "30",
      });
      if (cursor) params.set("cursor", cursor);
      if (refresh) params.set("refresh", "1");
      const payload = await paperLibraryFetchJson<
        { ok: true } & PaperLibraryGraphResponse
      >(`/api/brain/paper-library/graph?${params.toString()}`);
      setGraphPage((current) => ({
        nodes: append && current ? [...current.nodes, ...payload.nodes] : payload.nodes,
        edges: append && current ? [...current.edges, ...payload.edges] : payload.edges,
        sourceRuns: payload.sourceRuns,
        warnings: payload.warnings,
        nextCursor: payload.nextCursor,
        totalCount: payload.totalCount,
        filteredCount: payload.filteredCount,
      }));
    } catch (error) {
      setGraphError(error instanceof Error ? error.message : "Could not load the citation graph.");
    } finally {
      setGraphLoading(false);
      setGraphLoadingMore(false);
    }
  }, [projectSlug, session.scanId]);

  const loadClusters = useCallback(async ({ cursor, append = false, refresh = false }: {
    cursor?: string;
    append?: boolean;
    refresh?: boolean;
  } = {}) => {
    if (!session.scanId) return;
    if (append) setClustersLoadingMore(true);
    else setClustersLoading(true);
    setClustersError(null);
    try {
      const params = new URLSearchParams({
        project: projectSlug,
        scanId: session.scanId,
        limit: "12",
      });
      if (cursor) params.set("cursor", cursor);
      if (refresh) params.set("refresh", "1");
      const payload = await paperLibraryFetchJson<
        { ok: true } & PaperLibraryClustersResponse
      >(`/api/brain/paper-library/clusters?${params.toString()}`);
      setClustersPage((current) => ({
        clusters: append && current ? [...current.clusters, ...payload.clusters] : payload.clusters,
        unclusteredCount: payload.unclusteredCount,
        model: payload.model,
        warnings: payload.warnings,
        nextCursor: payload.nextCursor,
        totalCount: payload.totalCount,
        filteredCount: payload.filteredCount,
      }));
    } catch (error) {
      setClustersError(error instanceof Error ? error.message : "Could not load semantic clusters.");
    } finally {
      setClustersLoading(false);
      setClustersLoadingMore(false);
    }
  }, [projectSlug, session.scanId]);

  const loadGaps = useCallback(async ({ cursor, append = false, refresh = false }: {
    cursor?: string;
    append?: boolean;
    refresh?: boolean;
  } = {}) => {
    if (!session.scanId) return;
    if (append) setGapsLoadingMore(true);
    else setGapsLoading(true);
    setGapsError(null);
    try {
      const params = new URLSearchParams({
        project: projectSlug,
        scanId: session.scanId,
        limit: "12",
      });
      if (gapFilter !== "all") params.set("state", gapFilter);
      if (cursor) params.set("cursor", cursor);
      if (refresh) params.set("refresh", "1");
      const payload = await paperLibraryFetchJson<
        { ok: true } & PaperLibraryGapsResponse
      >(`/api/brain/paper-library/gaps?${params.toString()}`);
      setGapPage((current) => ({
        suggestions: append && current ? [...current.suggestions, ...payload.suggestions] : payload.suggestions,
        stateCounts: payload.stateCounts,
        warnings: payload.warnings,
        nextCursor: payload.nextCursor,
        totalCount: payload.totalCount,
        filteredCount: payload.filteredCount,
      }));
    } catch (error) {
      setGapsError(error instanceof Error ? error.message : "Could not load gap suggestions.");
    } finally {
      setGapsLoading(false);
      setGapsLoadingMore(false);
    }
  }, [gapFilter, projectSlug, session.scanId]);

  useEffect(() => {
    if (!session.scanId) {
      setScan(null);
      return;
    }
    void loadScan(session.scanId);
  }, [loadScan, session.scanId]);

  useEffect(() => {
    if (!scan || !isScanInFlight(scan)) return;
    const interval = window.setInterval(() => {
      void loadScan(scan.id);
    }, 2_000);
    return () => window.clearInterval(interval);
  }, [loadScan, scan]);

  useEffect(() => {
    if (!session.applyPlanId) {
      setApplyPlanPage(null);
      return;
    }
    void loadApplyPlan({ applyPlanId: session.applyPlanId });
  }, [loadApplyPlan, session.applyPlanId]);

  useEffect(() => {
    if (!session.manifestId) {
      setManifestPage(null);
      return;
    }
    void loadManifest({ manifestId: session.manifestId });
  }, [loadManifest, session.manifestId]);

  useEffect(() => {
    if (!scan || session.step !== "review") return;
    if (scan.status !== "ready_for_review" && scan.status !== "ready_for_apply") return;
    void loadReview();
  }, [loadReview, scan, session.step, reviewFilter]);

  useEffect(() => {
    if (session.step !== "graph" || !session.scanId) return;
    void loadGraph();
    void loadClusters();
  }, [loadClusters, loadGraph, session.scanId, session.step]);

  useEffect(() => {
    if (session.step !== "graph" || !session.scanId) return;
    void loadGaps();
  }, [loadGaps, session.scanId, session.step]);

  useEffect(() => {
    if (scan?.applyPlanId && scan.applyPlanId !== session.applyPlanId) {
      patchSession({ applyPlanId: scan.applyPlanId });
    }
  }, [patchSession, scan?.applyPlanId, session.applyPlanId]);

  useEffect(() => {
    if (applyPlanPage?.plan.manifestId && applyPlanPage.plan.manifestId !== session.manifestId) {
      patchSession({ manifestId: applyPlanPage.plan.manifestId });
    }
  }, [applyPlanPage?.plan.manifestId, patchSession, session.manifestId]);

  const handleStartScan = useCallback(async () => {
    setCommandError(null);
    setScanError(null);
    resetDownstreamState();
    setScan(null);
    setSession((current) => ({
      ...current,
      scanId: undefined,
      applyPlanId: undefined,
      manifestId: undefined,
    }));

    try {
      const payload = await paperLibraryFetchJson<{ ok: true; scanId: string }>(
        "/api/brain/paper-library/scan",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "start",
            project: projectSlug,
            rootPath: session.rootPath,
            mode: "dry-run",
            idempotencyKey: makeIdempotencyKey("paper-library-scan"),
          }),
        },
      );
      patchSession({
        scanId: payload.scanId,
        applyPlanId: undefined,
        manifestId: undefined,
        step: "scan",
      });
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : "Could not start the paper-library scan.");
    }
  }, [patchSession, projectSlug, resetDownstreamState, session.rootPath]);

  const handleCancelScan = useCallback(async () => {
    if (!session.scanId) return;
    setCommandError(null);
    try {
      await paperLibraryFetchJson<{ ok: true; scan: PaperLibraryScan }>(
        "/api/brain/paper-library/scan",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "cancel",
            project: projectSlug,
            scanId: session.scanId,
          }),
        },
      );
      await loadScan(session.scanId);
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : "Could not cancel the scan.");
    }
  }, [loadScan, projectSlug, session.scanId]);

  const handleReviewAction = useCallback(async (
    item: PaperReviewItem,
    action: "accept" | "correct" | "ignore" | "unresolve",
  ) => {
    if (!session.scanId) return;
    setCommandError(null);
    setReviewActionItemId(item.id);
    try {
      const draft = reviewDraftForItem(item, draftsByItemId[item.id]);
      await paperLibraryFetchJson<{ ok: true; remainingCount: number }>(
        "/api/brain/paper-library/review",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            project: projectSlug,
            scanId: session.scanId,
            itemId: item.id,
            action,
            selectedCandidateId: selectedCandidatesByItemId[item.id]
              ?? item.selectedCandidateId
              ?? item.candidates[0]?.id,
            correction:
              action === "correct"
                ? {
                    title: draft.title.trim(),
                    year: draft.year.trim(),
                    authors: draft.authors.trim(),
                    venue: draft.venue.trim(),
                  }
                : undefined,
          }),
        },
      );
      patchSession({ applyPlanId: undefined, manifestId: undefined });
      setApplyPlanPage(null);
      setManifestPage(null);
      setApprovalToken(null);
      await loadScan(session.scanId);
      await loadReview();
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : "Could not update the review item.");
    } finally {
      setReviewActionItemId(null);
    }
  }, [
    draftsByItemId,
    loadReview,
    loadScan,
    patchSession,
    projectSlug,
    selectedCandidatesByItemId,
    session.scanId,
  ]);

  const handleCreateApplyPlan = useCallback(async () => {
    if (!session.scanId) return;
    setCommandError(null);
    setApplyPlanError(null);
    try {
      const payload = await paperLibraryFetchJson<{ ok: true; applyPlanId: string }>(
        "/api/brain/paper-library/apply-plan",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            project: projectSlug,
            scanId: session.scanId,
            rootPath: session.rootPath || undefined,
            templateFormat: session.templateFormat,
          }),
        },
      );
      patchSession({
        applyPlanId: payload.applyPlanId,
        manifestId: undefined,
        step: "apply",
      });
      setApprovalToken(null);
      setManifestPage(null);
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : "Could not create the apply plan.");
    }
  }, [patchSession, projectSlug, session.rootPath, session.scanId, session.templateFormat]);

  const handleApprovePlan = useCallback(async () => {
    if (!session.applyPlanId) return;
    setCommandError(null);
    try {
      const payload = await paperLibraryFetchJson<{ ok: true; approvalToken: string; expiresAt: string }>(
        "/api/brain/paper-library/apply-plan/approve",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            project: projectSlug,
            applyPlanId: session.applyPlanId,
            userConfirmation: true,
          }),
        },
      );
      setApprovalToken({ token: payload.approvalToken, expiresAt: payload.expiresAt });
      await loadApplyPlan({ applyPlanId: session.applyPlanId });
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : "Could not approve the apply plan.");
    }
  }, [loadApplyPlan, projectSlug, session.applyPlanId]);

  const handleApplyPlan = useCallback(async () => {
    if (!session.applyPlanId || !approvalToken) return;
    setCommandError(null);
    try {
      const payload = await paperLibraryFetchJson<{ ok: true; manifestId: string }>(
        "/api/brain/paper-library/apply",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            project: projectSlug,
            applyPlanId: session.applyPlanId,
            approvalToken: approvalToken.token,
            idempotencyKey: makeIdempotencyKey("paper-library-apply"),
          }),
        },
      );
      setApprovalToken(null);
      patchSession({
        manifestId: payload.manifestId,
        step: "history",
      });
      await loadApplyPlan({ applyPlanId: session.applyPlanId });
      await loadManifest({ manifestId: payload.manifestId });
      if (session.scanId) {
        await loadScan(session.scanId);
      }
    } catch (error) {
      if (error instanceof PaperLibraryApiError && error.code === "approval_token_expired") {
        setApprovalToken(null);
      }
      setCommandError(error instanceof Error ? error.message : "Could not apply the approved plan.");
    }
  }, [approvalToken, loadApplyPlan, loadManifest, loadScan, patchSession, projectSlug, session.applyPlanId, session.scanId]);

  const handleUndo = useCallback(async () => {
    if (!session.manifestId) return;
    setUndoing(true);
    setCommandError(null);
    try {
      await paperLibraryFetchJson<{ ok: true }>(
        "/api/brain/paper-library/undo",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            project: projectSlug,
            manifestId: session.manifestId,
          }),
        },
      );
      await loadManifest({ manifestId: session.manifestId });
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : "Could not undo the last apply manifest.");
    } finally {
      setUndoing(false);
    }
  }, [loadManifest, projectSlug, session.manifestId]);

  const handleRepairManifest = useCallback(async () => {
    if (!session.manifestId) return;
    setRepairingManifest(true);
    setCommandError(null);
    try {
      const payload = await paperLibraryFetchJson<{
        ok: true;
        repaired: boolean;
        manifest: ApplyManifest;
      }>(
        "/api/brain/paper-library/repair",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            project: projectSlug,
            manifestId: session.manifestId,
          }),
        },
      );
      await loadManifest({ manifestId: session.manifestId });
      if (session.applyPlanId) {
        await loadApplyPlan({ applyPlanId: session.applyPlanId });
      }
      if (!payload.repaired && payload.manifest.warnings.length > 0) {
        setCommandError(payload.manifest.warnings[payload.manifest.warnings.length - 1] ?? "Could not repair the manifest.");
      }
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : "Could not repair the apply manifest.");
    } finally {
      setRepairingManifest(false);
    }
  }, [loadApplyPlan, loadManifest, projectSlug, session.applyPlanId, session.manifestId]);

  const handleGapAction = useCallback(async (
    suggestionId: string,
    action: "watch" | "ignore" | "save" | "import" | "reopen",
  ) => {
    if (!session.scanId) return;
    setGapActionSuggestionId(suggestionId);
    setGapsError(null);
    try {
      await paperLibraryFetchJson<{ ok: true; suggestion: GapSuggestion }>(
        "/api/brain/paper-library/gaps",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            project: projectSlug,
            scanId: session.scanId,
            suggestionId,
            action,
          }),
        },
      );
      await loadGaps();
    } catch (error) {
      setGapsError(error instanceof Error ? error.message : "Could not update the gap suggestion.");
    } finally {
      setGapActionSuggestionId(null);
    }
  }, [loadGaps, projectSlug, session.scanId]);

  const activePlan = applyPlanPage?.plan ?? null;
  const activeManifest = manifestPage?.manifest ?? null;

  const reviewNeededCount = scan?.counters.needsReview ?? 0;
  const applyReadyCount = activePlan?.operationCount ?? scan?.counters.readyForApply ?? 0;
  const graphCount = graphPage?.filteredCount ?? graphPage?.totalCount ?? 0;
  const historyCount = activeManifest?.appliedCount ?? 0;
  const approvalTokenExpired = approvalToken
    ? Date.parse(approvalToken.expiresAt) <= Date.now()
    : false;

  const stepContent = useMemo(() => {
    if (session.step === "review") {
      if (!scan) {
        return <EmptyState title="No scan selected" body="Start a dry-run scan first so ScienceSwarm can build a review queue." />;
      }

      if (scan.status !== "ready_for_review" && scan.status !== "ready_for_apply") {
        return (
          <EmptyState
            title="Review queue is not ready yet"
            body="Wait for the scan to finish identifying and enriching papers, then the ambiguous cases will appear here."
          />
        );
      }

      return (
        <div className="px-4 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">Review</p>
              <h3 className="mt-1 text-lg font-semibold text-foreground">Resolve low-confidence papers</h3>
              <p className="mt-1 max-w-2xl text-sm text-muted">
                Accept a detected identity, correct the filename-derived metadata, or ignore items you do not want in the plan.
              </p>
            </div>
            <div className="inline-flex items-center gap-2">
              {(["needs_review", "accepted", "ignored", "unresolved"] as const).map((filter) => (
                <button
                  key={filter}
                  type="button"
                  onClick={() => setReviewFilter(filter)}
                  className={`rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors ${
                    reviewFilter === filter
                      ? "border-accent bg-white text-foreground"
                      : "border-border bg-surface text-muted hover:text-foreground"
                  }`}
                >
                  {formatStatus(filter)}
                </button>
              ))}
            </div>
          </div>

          {reviewError && (
            <div role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {reviewError}
            </div>
          )}

          {(reviewLoading && !reviewPage) ? (
            <div className="flex items-center gap-2 px-1 py-6 text-sm text-muted">
              <SpinnerGap className="animate-spin" size={16} />
              Loading review items...
            </div>
          ) : reviewPage?.items.length ? (
            <div className="divide-y divide-border">
              {reviewPage.items.map((item) => {
                const draft = reviewDraftForItem(item, draftsByItemId[item.id]);
                const selectedCandidateId = selectedCandidatesByItemId[item.id]
                  ?? item.selectedCandidateId
                  ?? item.candidates[0]?.id;
                return (
                  <article key={item.id} className="py-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <h4 className="text-sm font-semibold text-foreground">{summarizePrimaryCandidate(item)}</h4>
                        <p className="mt-1 text-xs text-muted">{item.source?.relativePath ?? item.paperId}</p>
                        {item.reasonCodes.length > 0 && (
                          <div className="mt-2 flex flex-wrap gap-2">
                            {item.reasonCodes.map((reason) => (
                              <span key={reason} className="rounded-full border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] font-semibold text-amber-700">
                                {reason.replaceAll("_", " ")}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                      <StatusBadge
                        tone={item.state === "accepted" || item.state === "corrected" ? "success" : item.state === "ignored" ? "neutral" : "warning"}
                        value={item.state}
                      />
                    </div>

                    <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
                      <div>
                        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted">Candidates</p>
                        <div className="mt-2 space-y-2">
                          {item.candidates.map((candidate) => (
                            <label key={candidate.id} className="flex cursor-pointer items-start gap-3 rounded-lg border border-border px-3 py-2 text-sm">
                              <input
                                type="radio"
                                name={`candidate-${item.id}`}
                                checked={selectedCandidateId === candidate.id}
                                onChange={() => {
                                  setSelectedCandidatesByItemId((current) => ({
                                    ...current,
                                    [item.id]: candidate.id,
                                  }));
                                }}
                              />
                              <span>
                                <span className="block font-semibold text-foreground">
                                  {candidate.title ?? candidate.id}
                                </span>
                                <span className="mt-1 block text-xs text-muted">
                                  confidence {Math.round(candidate.confidence * 100)}%
                                  {candidate.year ? ` • ${candidate.year}` : ""}
                                  {candidate.venue ? ` • ${candidate.venue}` : ""}
                                </span>
                              </span>
                            </label>
                          ))}
                        </div>
                      </div>

                      <div>
                        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted">Correction</p>
                        <div className="mt-2 grid gap-2 sm:grid-cols-2">
                          <input
                            value={draft.title}
                            onChange={(event) => {
                              const value = event.target.value;
                              setDraftsByItemId((current) => ({
                                ...current,
                                [item.id]: { ...draft, title: value },
                              }));
                            }}
                            className="rounded-lg border border-border px-3 py-2 text-sm"
                            placeholder="Corrected title"
                          />
                          <input
                            value={draft.year}
                            onChange={(event) => {
                              const value = event.target.value;
                              setDraftsByItemId((current) => ({
                                ...current,
                                [item.id]: { ...draft, year: value },
                              }));
                            }}
                            className="rounded-lg border border-border px-3 py-2 text-sm"
                            placeholder="Year"
                          />
                          <input
                            value={draft.authors}
                            onChange={(event) => {
                              const value = event.target.value;
                              setDraftsByItemId((current) => ({
                                ...current,
                                [item.id]: { ...draft, authors: value },
                              }));
                            }}
                            className="rounded-lg border border-border px-3 py-2 text-sm sm:col-span-2"
                            placeholder="Authors"
                          />
                          <input
                            value={draft.venue}
                            onChange={(event) => {
                              const value = event.target.value;
                              setDraftsByItemId((current) => ({
                                ...current,
                                [item.id]: { ...draft, venue: value },
                              }));
                            }}
                            className="rounded-lg border border-border px-3 py-2 text-sm sm:col-span-2"
                            placeholder="Venue"
                          />
                        </div>
                      </div>
                    </div>

                    <div className="mt-4 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => void handleReviewAction(item, "accept")}
                        disabled={reviewActionItemId === item.id}
                        className="rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
                      >
                        Accept selected
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleReviewAction(item, "correct")}
                        disabled={reviewActionItemId === item.id}
                        className="rounded-lg border border-border bg-white px-3 py-2 text-xs font-semibold text-foreground transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
                      >
                        Save correction
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleReviewAction(item, "ignore")}
                        disabled={reviewActionItemId === item.id}
                        className="rounded-lg border border-border bg-white px-3 py-2 text-xs font-semibold text-foreground transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
                      >
                        Ignore
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleReviewAction(item, "unresolve")}
                        disabled={reviewActionItemId === item.id}
                        className="rounded-lg border border-border bg-white px-3 py-2 text-xs font-semibold text-foreground transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
                      >
                        Leave unresolved
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            <EmptyState
              title="Nothing in this review slice"
              body="Switch the filter or finish the scan. Once items need attention, they will appear here in bounded windows."
            />
          )}

          {reviewPage?.nextCursor && (
            <div className="border-t border-border pt-4">
              <button
                type="button"
                onClick={() => void loadReview({ cursor: reviewPage.nextCursor, append: true })}
                disabled={reviewLoadingMore}
                className="rounded-lg border border-border bg-white px-3 py-2 text-xs font-semibold text-foreground transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
              >
                {reviewLoadingMore ? "Loading..." : "Load more review items"}
              </button>
            </div>
          )}
        </div>
      );
    }

    if (session.step === "apply") {
      if (!scan) {
        return <EmptyState title="No scan selected" body="Run a dry-run scan first, then turn the reviewed papers into a reversible apply plan." />;
      }

      return (
        <div className="px-4 py-4">
          <div className="border-b border-border pb-4">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">Apply</p>
            <h3 className="mt-1 text-lg font-semibold text-foreground">Preview and approve filesystem changes</h3>
            <p className="mt-1 max-w-2xl text-sm text-muted">
              Generate a dry-run rename and folder plan, review conflicts, then approve the immutable plan before anything touches disk.
            </p>
            <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
              <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs font-semibold text-muted">
                Template
                <input
                  value={session.templateFormat}
                  onChange={(event) => patchSession({ templateFormat: event.target.value })}
                  className="rounded-lg border border-border px-3 py-2 text-sm text-foreground"
                  placeholder="{year} - {title}.pdf"
                />
              </label>
              <button
                type="button"
                onClick={() => void handleCreateApplyPlan()}
                disabled={scan.status !== "ready_for_apply" && scan.status !== "ready_for_review"}
                className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
              >
                {session.applyPlanId ? "Regenerate preview" : "Preview apply plan"}
              </button>
            </div>
          </div>

          {applyPlanError && (
            <div role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {applyPlanError}
            </div>
          )}

          {(applyPlanLoading && !applyPlanPage) ? (
            <div className="flex items-center gap-2 px-1 py-6 text-sm text-muted">
              <SpinnerGap className="animate-spin" size={16} />
              Loading apply plan...
            </div>
          ) : activePlan ? (
            <div className="space-y-4 pt-4">
              <div className="flex flex-wrap items-center gap-3">
                <StatusBadge
                  tone={
                    activePlan.status === "blocked"
                      ? "danger"
                      : activePlan.status === "approved" || activePlan.status === "applied"
                        ? "success"
                        : "neutral"
                  }
                  value={activePlan.status}
                />
                <span className="text-sm text-muted">
                  {activePlan.operationCount} operations
                </span>
                <span className="text-sm text-muted">
                  {activePlan.conflictCount} conflicts
                </span>
              </div>

              {activePlan.conflictCount > 0 && (
                <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700">
                  Resolve review items or path conflicts before approving this plan.
                </div>
              )}

              <div className="divide-y divide-border rounded-xl border border-border bg-white">
                {applyPlanPage?.operations.map((operation) => (
                  <div key={operation.id} className="px-4 py-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-foreground">
                          {operation.source?.relativePath ?? "Missing source"}{" -> "}{operation.destinationRelativePath}
                        </p>
                        <p className="mt-1 text-xs text-muted">
                          {operation.reason} • confidence {Math.round(operation.confidence * 100)}%
                        </p>
                      </div>
                      <StatusBadge
                        tone={operation.conflictCodes.length > 0 ? "warning" : "success"}
                        value={operation.conflictCodes.length > 0 ? "needs_attention" : operation.kind}
                      />
                    </div>
                    {operation.conflictCodes.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-2">
                        {operation.conflictCodes.map((code) => (
                          <span key={code} className="rounded-full border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] font-semibold text-amber-700">
                            {code.replaceAll("_", " ")}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void handleApprovePlan()}
                  disabled={activePlan.status !== "validated" || activePlan.conflictCount > 0}
                  className="rounded-lg border border-border bg-white px-3 py-2 text-xs font-semibold text-foreground transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
                >
                  Approve plan
                </button>
                <button
                  type="button"
                  onClick={() => void handleApplyPlan()}
                  disabled={!approvalToken || approvalTokenExpired}
                  className="rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
                >
                  Apply approved plan
                </button>
                {activePlan.manifestId && (
                  <button
                    type="button"
                    onClick={() => patchSession({ step: "history" })}
                    className="rounded-lg border border-border bg-white px-3 py-2 text-xs font-semibold text-foreground transition-colors hover:border-accent hover:text-accent"
                  >
                    Open history
                  </button>
                )}
              </div>

              {approvalToken && (
                <div
                  className={`rounded-lg border px-3 py-2 text-sm ${
                    approvalTokenExpired
                      ? "border-amber-200 bg-amber-50 text-amber-700"
                      : "border-emerald-200 bg-emerald-50 text-emerald-700"
                  }`}
                >
                  {approvalTokenExpired
                    ? `Approval expired at ${new Date(approvalToken.expiresAt).toLocaleString()}. Approve the plan again to apply it.`
                    : `Plan approved until ${new Date(approvalToken.expiresAt).toLocaleString()}.`}
                </div>
              )}

              {applyPlanPage?.nextCursor && (
                <button
                  type="button"
                  onClick={() => void loadApplyPlan({
                    applyPlanId: activePlan.id,
                    cursor: applyPlanPage.nextCursor,
                    append: true,
                  })}
                  disabled={applyPlanLoadingMore}
                  className="rounded-lg border border-border bg-white px-3 py-2 text-xs font-semibold text-foreground transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
                >
                  {applyPlanLoadingMore ? "Loading..." : "Load more operations"}
                </button>
              )}
            </div>
          ) : (
            <EmptyState
              title="No apply plan yet"
              body="Once the review queue is in a usable state, generate a dry-run plan here and inspect the proposed file moves before approval."
            />
          )}
        </div>
      );
    }

    if (session.step === "graph") {
      if (!session.scanId) {
        return <EmptyState title="No scan selected" body="Run a scan first so ScienceSwarm can build a local citation and topic view." />;
      }

      return (
        <div className="px-4 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">Graph</p>
              <h3 className="mt-1 text-lg font-semibold text-foreground">Citation graph and semantic organization</h3>
              <p className="mt-1 max-w-2xl text-sm text-muted">
                Browse the connected paper graph, inspect source-run status, and regenerate local topic clusters without rewriting durable paper identity.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void loadGraph({ refresh: true })}
                className="rounded-lg border border-border bg-white px-3 py-2 text-xs font-semibold text-foreground transition-colors hover:border-accent hover:text-accent"
              >
                Refresh graph
              </button>
              <button
                type="button"
                onClick={() => void loadClusters({ refresh: true })}
                className="rounded-lg border border-border bg-white px-3 py-2 text-xs font-semibold text-foreground transition-colors hover:border-accent hover:text-accent"
              >
                Refresh clusters
              </button>
              <button
                type="button"
                onClick={() => void loadGaps({ refresh: true })}
                className="rounded-lg border border-border bg-white px-3 py-2 text-xs font-semibold text-foreground transition-colors hover:border-accent hover:text-accent"
              >
                Refresh gaps
              </button>
            </div>
          </div>

          {graphError && (
            <div role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {graphError}
            </div>
          )}

          {clustersError && (
            <div role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {clustersError}
            </div>
          )}

          {gapsError && (
            <div role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {gapsError}
            </div>
          )}

          {(graphLoading && !graphPage) ? (
            <div className="flex items-center gap-2 px-1 py-6 text-sm text-muted">
              <SpinnerGap className="animate-spin" size={16} />
              Loading graph...
            </div>
          ) : (
            <div className="grid gap-6 py-4 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
              <section className="space-y-4">
                <div className="rounded-xl border border-border bg-white p-4">
                  <div className="flex flex-wrap items-center gap-3">
                    <StatusBadge tone="neutral" value={`${graphPage?.nodes.length ?? 0}_nodes`} />
                    <StatusBadge tone="neutral" value={`${graphPage?.edges.length ?? 0}_edges`} />
                    <span className="text-sm text-muted">{graphPage?.sourceRuns.length ?? 0} source runs</span>
                  </div>
                  {graphPage?.warnings.length ? (
                    <div className="mt-3 space-y-2">
                      {graphPage.warnings.map((warning) => (
                        <div key={warning} className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700">
                          {warning}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>

                <div className="rounded-xl border border-border bg-white">
                  <div className="border-b border-border px-4 py-3">
                    <p className="text-sm font-semibold text-foreground">Graph nodes</p>
                  </div>
                  <div className="divide-y divide-border">
                    {graphPage?.nodes.map((node) => (
                      <div key={node.id} className="px-4 py-3">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <div>
                            <p className="text-sm font-semibold text-foreground">{node.title ?? node.id}</p>
                            <p className="mt-1 text-xs text-muted">
                              {formatStatus(node.kind)} • {node.local ? "local" : "external"}
                              {node.suggestion ? " • suggestion" : ""}
                            </p>
                          </div>
                          <div className="text-xs text-muted">
                            {node.referenceCount ?? 0} refs • {node.citationCount ?? 0} cites
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                  {graphPage?.nextCursor && (
                    <div className="border-t border-border px-4 py-3">
                      <button
                        type="button"
                        onClick={() => void loadGraph({ cursor: graphPage.nextCursor, append: true })}
                        disabled={graphLoadingMore}
                        className="rounded-lg border border-border bg-white px-3 py-2 text-xs font-semibold text-foreground transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
                      >
                        {graphLoadingMore ? "Loading..." : "Load more nodes"}
                      </button>
                    </div>
                  )}
                </div>
              </section>

              <section className="space-y-4">
                <div className="rounded-xl border border-border bg-white p-4">
                  <p className="text-sm font-semibold text-foreground">Semantic clusters</p>
                  {clustersLoading && !clustersPage ? (
                    <div className="mt-3 flex items-center gap-2 text-sm text-muted">
                      <SpinnerGap className="animate-spin" size={16} />
                      Loading clusters...
                    </div>
                  ) : clustersPage ? (
                    <>
                      <div className="mt-3 flex flex-wrap items-center gap-3">
                        <StatusBadge
                          tone={
                            clustersPage.model.status === "ready"
                              ? "success"
                              : clustersPage.model.status === "model_unavailable"
                                ? "danger"
                                : "warning"
                          }
                          value={clustersPage.model.status}
                        />
                        <span className="text-sm text-muted">
                          {clustersPage.clusters.length} clusters • {clustersPage.unclusteredCount} unclustered papers
                        </span>
                      </div>
                      {clustersPage.warnings.length ? (
                        <div className="mt-3 space-y-2">
                          {clustersPage.warnings.map((warning) => (
                            <div key={warning} className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700">
                              {warning}
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </>
                  ) : (
                    <p className="mt-3 text-sm text-muted">
                      Semantic organization appears here after a completed scan.
                    </p>
                  )}
                </div>

                {clustersPage?.clusters.map((cluster) => (
                  <div key={cluster.id} className="rounded-xl border border-border bg-white p-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-foreground">{cluster.label}</p>
                        <p className="mt-1 text-xs text-muted">
                          folder token {cluster.folderName} • confidence {Math.round(cluster.confidence * 100)}%
                        </p>
                      </div>
                      <span className="text-xs text-muted">{cluster.memberCount} papers</span>
                    </div>
                    {cluster.keywords.length > 0 && (
                      <div className="mt-3 flex flex-wrap gap-2">
                        {cluster.keywords.map((keyword) => (
                          <span key={keyword} className="rounded-full border border-border bg-surface px-2 py-1 text-[11px] font-semibold text-muted">
                            {keyword}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}

                {clustersPage?.nextCursor && (
                  <button
                    type="button"
                    onClick={() => void loadClusters({ cursor: clustersPage.nextCursor, append: true })}
                    disabled={clustersLoadingMore}
                    className="rounded-lg border border-border bg-white px-3 py-2 text-xs font-semibold text-foreground transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
                  >
                    {clustersLoadingMore ? "Loading..." : "Load more clusters"}
                  </button>
                )}

                <div className="rounded-xl border border-border bg-white p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-foreground">Gap suggestions</p>
                      <p className="mt-1 text-xs text-muted">
                        Missing seminal papers ranked from your local citation graph, cluster coverage, and recency cues.
                      </p>
                    </div>
                    {gapPage && (
                      <span className="text-xs text-muted">
                        {gapPage.filteredCount} shown • {gapPage.totalCount} total
                      </span>
                    )}
                  </div>

                  <div className="mt-3 flex flex-wrap gap-2">
                    {([
                      ["all", gapPage?.totalCount ?? 0],
                      ["open", gapPage?.stateCounts.open ?? 0],
                      ["watching", gapPage?.stateCounts.watching ?? 0],
                      ["saved", gapPage?.stateCounts.saved ?? 0],
                      ["imported", gapPage?.stateCounts.imported ?? 0],
                      ["ignored", gapPage?.stateCounts.ignored ?? 0],
                    ] as const).map(([value, count]) => (
                      <button
                        key={value}
                        type="button"
                        onClick={() => setGapFilter(value)}
                        className={`rounded-full border px-3 py-1 text-[11px] font-semibold transition-colors ${
                          gapFilter === value
                            ? "border-accent bg-white text-foreground"
                            : "border-border bg-surface text-muted hover:text-foreground"
                        }`}
                      >
                        {value.replaceAll("_", " ")} {count}
                      </button>
                    ))}
                  </div>

                  {gapsLoading && !gapPage ? (
                    <div className="mt-4 flex items-center gap-2 text-sm text-muted">
                      <SpinnerGap className="animate-spin" size={16} />
                      Loading gap suggestions...
                    </div>
                  ) : gapPage ? (
                    <>
                      {gapPage.warnings.length > 0 && (
                        <div className="mt-4 space-y-2">
                          {gapPage.warnings.map((warning) => (
                            <div key={warning} className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700">
                              {warning}
                            </div>
                          ))}
                        </div>
                      )}

                      {gapPage.suggestions.length > 0 ? (
                        <div className="mt-4 space-y-3">
                          {gapPage.suggestions.map((suggestion) => (
                            <div key={suggestion.id} className="rounded-xl border border-border bg-surface p-4">
                              <div className="flex flex-wrap items-start justify-between gap-3">
                                <div>
                                  <p className="text-sm font-semibold text-foreground">
                                    {suggestion.title}
                                    {suggestion.year ? ` (${suggestion.year})` : ""}
                                  </p>
                                  <p className="mt-1 text-xs text-muted">
                                    score {Math.round(suggestion.score.overall * 100)}% • {suggestion.localConnectionCount} local links
                                  </p>
                                </div>
                                <StatusBadge
                                  tone={
                                    suggestion.state === "ignored"
                                      ? "warning"
                                      : suggestion.state === "saved" || suggestion.state === "imported"
                                        ? "success"
                                        : "neutral"
                                  }
                                  value={suggestion.state}
                                />
                              </div>

                              <div className="mt-3 flex flex-wrap gap-2">
                                {suggestion.reasonCodes.map((reason) => (
                                  <span key={reason} className="rounded-full border border-border bg-white px-2 py-1 text-[11px] font-semibold text-muted">
                                    {reason.replaceAll("_", " ")}
                                  </span>
                                ))}
                              </div>

                              <p className="mt-3 text-xs text-muted">
                                Evidence papers: {suggestion.evidencePaperIds.join(", ") || "none"}
                              </p>

                              <div className="mt-3 flex flex-wrap gap-2">
                                {suggestion.state !== "watching" && (
                                  <button
                                    type="button"
                                    onClick={() => void handleGapAction(suggestion.id, "watch")}
                                    disabled={gapActionSuggestionId === suggestion.id}
                                    className="rounded-lg border border-border bg-white px-3 py-2 text-xs font-semibold text-foreground transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
                                  >
                                    Watch
                                  </button>
                                )}
                                {suggestion.state !== "ignored" && (
                                  <button
                                    type="button"
                                    onClick={() => void handleGapAction(suggestion.id, "ignore")}
                                    disabled={gapActionSuggestionId === suggestion.id}
                                    className="rounded-lg border border-border bg-white px-3 py-2 text-xs font-semibold text-foreground transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
                                  >
                                    Ignore
                                  </button>
                                )}
                                {suggestion.state !== "saved" && (
                                  <button
                                    type="button"
                                    onClick={() => void handleGapAction(suggestion.id, "save")}
                                    disabled={gapActionSuggestionId === suggestion.id}
                                    className="rounded-lg border border-border bg-white px-3 py-2 text-xs font-semibold text-foreground transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
                                  >
                                    Save
                                  </button>
                                )}
                                {suggestion.state !== "imported" && (
                                  <button
                                    type="button"
                                    onClick={() => void handleGapAction(suggestion.id, "import")}
                                    disabled={gapActionSuggestionId === suggestion.id}
                                    className="rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
                                  >
                                    Mark imported
                                  </button>
                                )}
                                {suggestion.state !== "open" && (
                                  <button
                                    type="button"
                                    onClick={() => void handleGapAction(suggestion.id, "reopen")}
                                    disabled={gapActionSuggestionId === suggestion.id}
                                    className="rounded-lg border border-border bg-white px-3 py-2 text-xs font-semibold text-foreground transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
                                  >
                                    Reopen
                                  </button>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="mt-4 text-sm text-muted">
                          No gap suggestions match this filter yet.
                        </p>
                      )}

                      {gapPage.nextCursor && (
                        <button
                          type="button"
                          onClick={() => void loadGaps({ cursor: gapPage.nextCursor, append: true })}
                          disabled={gapsLoadingMore}
                          className="mt-4 rounded-lg border border-border bg-white px-3 py-2 text-xs font-semibold text-foreground transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
                        >
                          {gapsLoadingMore ? "Loading..." : "Load more suggestions"}
                        </button>
                      )}
                    </>
                  ) : (
                    <p className="mt-4 text-sm text-muted">
                      Gap suggestions appear here after graph enrichment and clustering finish.
                    </p>
                  )}
                </div>
              </section>
            </div>
          )}
        </div>
      );
    }

    if (session.step === "history") {
      if (manifestLoading && !activeManifest) {
        return (
          <div className="flex items-center gap-2 px-5 py-6 text-sm text-muted">
            <SpinnerGap className="animate-spin" size={16} />
            Loading manifest history...
          </div>
        );
      }

      if (!activeManifest) {
        return <EmptyState title="No apply history yet" body="Apply a plan first, then this step will show the manifest, operation outcomes, and undo controls." />;
      }

      return (
        <div className="px-4 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">History</p>
              <h3 className="mt-1 text-lg font-semibold text-foreground">Manifest and undo</h3>
              <p className="mt-1 max-w-2xl text-sm text-muted">
                Inspect the manifest written before apply, verify outcomes, and undo ScienceSwarm-managed moves when you need to roll back.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {activeManifest.status === "applied_with_repair_required" && (
                <button
                  type="button"
                  onClick={() => void handleRepairManifest()}
                  disabled={repairingManifest}
                  className="rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
                >
                  {repairingManifest ? "Repairing..." : "Retry gbrain repair"}
                </button>
              )}
              <button
                type="button"
                onClick={() => void handleUndo()}
                disabled={undoing || repairingManifest || activeManifest.undoneCount === activeManifest.operationCount}
                className="rounded-lg border border-border bg-white px-3 py-2 text-xs font-semibold text-foreground transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
              >
                {undoing ? "Undoing..." : "Undo changes"}
              </button>
            </div>
          </div>

          {manifestError && (
            <div role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {manifestError}
            </div>
          )}

          <div className="grid gap-4 py-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
            <section className="rounded-xl border border-border bg-white p-4">
              <div className="flex flex-wrap items-center gap-3">
                <StatusBadge
                  tone={
                    activeManifest.status === "applied" || activeManifest.status === "undone"
                      ? "success"
                      : activeManifest.status === "failed" || activeManifest.status === "applied_with_repair_required"
                        ? "warning"
                        : "neutral"
                  }
                  value={activeManifest.status}
                />
                <span className="text-sm text-muted">{activeManifest.appliedCount} applied</span>
                <span className="text-sm text-muted">{activeManifest.failedCount} failed</span>
                <span className="text-sm text-muted">{activeManifest.undoneCount} undone</span>
              </div>
              {activeManifest.status === "applied_with_repair_required" && (
                <p className="mt-3 text-sm text-muted">
                  Local filesystem changes are already applied. Retry the gbrain repair to finish writing the paper pages and timeline updates.
                </p>
              )}
              {activeManifest.warnings.length > 0 && (
                <div className="mt-3 space-y-2">
                  {activeManifest.warnings.map((warning) => (
                    <div key={warning} className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700">
                      {warning}
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="rounded-xl border border-border bg-white">
              <div className="border-b border-border px-4 py-3">
                <p className="text-sm font-semibold text-foreground">Manifest operations</p>
              </div>
              <div className="divide-y divide-border">
                {manifestPage?.operations.map((operation) => (
                  <div key={operation.operationId} className="px-4 py-3">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-foreground">
                          {operation.sourceRelativePath}{" -> "}{operation.destinationRelativePath}
                        </p>
                        {operation.error && (
                          <p className="mt-1 text-xs text-red-700">{operation.error}</p>
                        )}
                      </div>
                      <StatusBadge
                        tone={
                          operation.status === "verified" || operation.status === "undone"
                            ? "success"
                            : operation.status === "failed"
                              ? "danger"
                              : "neutral"
                        }
                        value={operation.status}
                      />
                    </div>
                  </div>
                ))}
              </div>
              {manifestPage?.nextCursor && (
                <div className="border-t border-border px-4 py-3">
                  <button
                    type="button"
                    onClick={() => void loadManifest({ manifestId: activeManifest.id, cursor: manifestPage.nextCursor, append: true })}
                    disabled={manifestLoadingMore}
                    className="rounded-lg border border-border bg-white px-3 py-2 text-xs font-semibold text-foreground transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
                  >
                    {manifestLoadingMore ? "Loading..." : "Load more manifest rows"}
                  </button>
                </div>
              )}
            </section>
          </div>
        </div>
      );
    }

    return (
      <div className="px-4 py-4">
        <div className="border-b border-border pb-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">Scan</p>
          <h3 className="mt-1 text-lg font-semibold text-foreground">Scan a local paper library without mutating disk</h3>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            Point ScienceSwarm at a local PDF directory, keep the run dry, and watch progress persist until the archive is ready for review or apply planning.
          </p>
          <div className="mt-4 grid gap-3 md:grid-cols-[minmax(0,1fr)_auto_auto]">
            <label className="flex min-w-0 flex-col gap-1 text-xs font-semibold text-muted">
              Library root
              <input
                value={session.rootPath}
                onChange={(event) => patchSession({ rootPath: event.target.value })}
                placeholder="/Users/you/Research Papers"
                className="rounded-lg border border-border px-3 py-2 text-sm text-foreground"
              />
            </label>
            <button
              type="button"
              onClick={() => void handleStartScan()}
              disabled={!session.rootPath.trim() || scanLoading}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
            >
              Start dry-run scan
            </button>
            <button
              type="button"
              onClick={() => void handleCancelScan()}
              disabled={!isScanInFlight(scan)}
              className="rounded-lg border border-border bg-white px-4 py-2 text-sm font-semibold text-foreground transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
            >
              Cancel scan
            </button>
          </div>
        </div>

        {scanError && (
          <div role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {scanError}
          </div>
        )}

        {scanLoading && !scan ? (
          <div className="flex items-center gap-2 px-1 py-6 text-sm text-muted">
            <SpinnerGap className="animate-spin" size={16} />
            Loading scan...
          </div>
        ) : scan ? (
          <div className="grid gap-4 py-4 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
            <section className="rounded-xl border border-border bg-white p-4">
              <div className="flex flex-wrap items-center gap-3">
                <StatusBadge
                  tone={
                    scan.status === "failed"
                      ? "danger"
                      : scan.status === "ready_for_review" || scan.status === "ready_for_apply"
                        ? "success"
                        : scan.status === "canceled"
                          ? "warning"
                          : "neutral"
                  }
                  value={scan.status}
                />
                {isScanInFlight(scan) && (
                  <span className="inline-flex items-center gap-2 text-sm text-muted">
                    <SpinnerGap className="animate-spin" size={16} />
                    Processing...
                  </span>
                )}
              </div>
              <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
                <div>
                  <dt className="text-muted">Detected files</dt>
                  <dd className="font-semibold text-foreground">{scan.counters.detectedFiles}</dd>
                </div>
                <div>
                  <dt className="text-muted">Identified</dt>
                  <dd className="font-semibold text-foreground">{scan.counters.identified}</dd>
                </div>
                <div>
                  <dt className="text-muted">Needs review</dt>
                  <dd className="font-semibold text-foreground">{scan.counters.needsReview}</dd>
                </div>
                <div>
                  <dt className="text-muted">Ready for apply</dt>
                  <dd className="font-semibold text-foreground">{scan.counters.readyForApply}</dd>
                </div>
              </dl>
              {scan.currentPath && (
                <p className="mt-4 text-xs text-muted">Current path: {scan.currentPath}</p>
              )}
              {scan.warnings.length > 0 && (
                <div className="mt-4 space-y-2">
                  {scan.warnings.map((warning) => (
                    <div key={warning} className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700">
                      {warning}
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="rounded-xl border border-border bg-white p-4">
              <p className="text-sm font-semibold text-foreground">Next moves</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => patchSession({ step: "review" })}
                  disabled={scan.counters.needsReview === 0}
                  className="rounded-lg border border-border bg-white px-3 py-2 text-xs font-semibold text-foreground transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
                >
                  Open review queue
                </button>
                <button
                  type="button"
                  onClick={() => patchSession({ step: "apply" })}
                  disabled={scan.status !== "ready_for_review" && scan.status !== "ready_for_apply"}
                  className="rounded-lg border border-border bg-white px-3 py-2 text-xs font-semibold text-foreground transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
                >
                  Build apply plan
                </button>
                <button
                  type="button"
                  onClick={() => patchSession({ step: "graph" })}
                  disabled={!session.scanId}
                  className="rounded-lg border border-border bg-white px-3 py-2 text-xs font-semibold text-foreground transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
                >
                  Open graph
                </button>
              </div>
              <div className="mt-4 rounded-lg border border-border bg-surface px-3 py-3 text-sm text-muted">
                No files are renamed or moved during scan. ScienceSwarm only proposes operations after review and explicit approval.
              </div>
            </section>
          </div>
        ) : (
          <EmptyState
            title="No paper-library scan yet"
            body="Enter a local root path, start a dry-run scan, and ScienceSwarm will build a review queue, apply preview, graph, and undo-ready history from there."
          />
        )}
      </div>
    );
  }, [
    activeManifest,
    activePlan,
    approvalToken,
    approvalTokenExpired,
    applyPlanError,
    applyPlanLoading,
    applyPlanLoadingMore,
    applyPlanPage,
    clustersError,
    clustersLoading,
    clustersLoadingMore,
    clustersPage,
    draftsByItemId,
    gapActionSuggestionId,
    gapFilter,
    gapPage,
    gapsError,
    gapsLoading,
    gapsLoadingMore,
    graphError,
    graphLoading,
    graphLoadingMore,
    graphPage,
    handleApplyPlan,
    handleApprovePlan,
    handleCancelScan,
    handleCreateApplyPlan,
    handleGapAction,
    handleRepairManifest,
    handleReviewAction,
    handleStartScan,
    handleUndo,
    loadApplyPlan,
    loadClusters,
    loadGaps,
    loadGraph,
    loadManifest,
    loadReview,
    manifestError,
    manifestLoading,
    manifestLoadingMore,
    manifestPage,
    patchSession,
    repairingManifest,
    reviewActionItemId,
    reviewError,
    reviewFilter,
    reviewLoading,
    reviewLoadingMore,
    reviewPage,
    scan,
    scanError,
    scanLoading,
    selectedCandidatesByItemId,
    session,
    undoing,
  ]);

  return (
    <div
      data-testid="paper-library-command-center"
      className="flex min-h-0 flex-1 flex-col"
    >
      <section className="border-b border-border bg-white px-4 py-4">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.2em] text-muted">
              <Graph size={15} />
              Paper Library
            </div>
            <h2 className="mt-1 text-xl font-semibold text-foreground">Local research library operator</h2>
            <p className="mt-1 max-w-3xl text-sm text-muted">
              Scan a messy PDF archive, resolve ambiguous identities, preview reversible renames, inspect local graph context, and keep every filesystem change explicit and undoable.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href={buildWorkspaceHrefForSlug(projectSlug)}
              className="inline-flex h-9 items-center gap-2 rounded-lg border border-border bg-white px-3 text-xs font-semibold text-foreground transition-colors hover:border-accent hover:text-accent"
            >
              <ArrowSquareOut size={14} />
              Open workspace
            </Link>
          </div>
        </div>
      </section>

      <section className="border-b border-border bg-surface px-4 py-3">
        <div className="flex flex-wrap gap-2">
          <StepButton
            active={session.step === "scan"}
            count={scan?.counters.detectedFiles}
            label="Scan"
            onClick={() => patchSession({ step: "scan" })}
          />
          <StepButton
            active={session.step === "review"}
            count={reviewNeededCount}
            label="Review"
            onClick={() => patchSession({ step: "review" })}
          />
          <StepButton
            active={session.step === "apply"}
            count={applyReadyCount}
            label="Apply"
            onClick={() => patchSession({ step: "apply" })}
          />
          <StepButton
            active={session.step === "graph"}
            count={graphCount}
            label="Graph"
            onClick={() => patchSession({ step: "graph" })}
          />
          <StepButton
            active={session.step === "history"}
            count={historyCount}
            label="History"
            onClick={() => patchSession({ step: "history" })}
          />
        </div>
      </section>

      {commandError && (
        <div className="border-b border-border bg-white px-4 py-4">
          <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {commandError}
          </div>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto bg-white">
        {stepContent}
      </div>
    </div>
  );
}
