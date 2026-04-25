"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowSquareOut,
  FolderOpen,
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
const GRAPH_MAP_NODE_LIMIT = 24;

const RENAME_TEMPLATE_OPTIONS = [
  {
    id: "year-title",
    label: "Year - Title",
    format: "{year} - {title}.pdf",
    example: "2024 - Scaling Laws.pdf",
    detail: "A clean flat folder for small libraries.",
  },
  {
    id: "author-year-title",
    label: "Author Year - Title",
    format: "{first_author} {year} - {title}.pdf",
    example: "Kaplan 2024 - Scaling Laws.pdf",
    detail: "Best when you recognize papers by first author.",
  },
  {
    id: "year-folder",
    label: "Year folders",
    format: "papers/{year}/{first_author} - {title}.pdf",
    example: "papers/2024/Kaplan - Scaling Laws.pdf",
    detail: "Keeps large archives easier to scan.",
  },
] as const;

function templateOptionForFormat(format: string) {
  return RENAME_TEMPLATE_OPTIONS.find((option) => option.format === format);
}

function defaultSession(): PaperLibrarySession {
  return {
    step: "scan",
    rootPath: "",
    templateFormat: DEFAULT_TEMPLATE,
  };
}

function stepForRestoredScan(scan: PaperLibraryScan): PaperLibraryStep {
  if (scan.applyPlanId) return "apply";
  if (isScanInFlight(scan) || scan.status === "failed" || scan.status === "canceled") return "scan";
  if (scan.counters.needsReview > 0 || scan.status === "ready_for_review") return "review";
  if (scan.counters.readyForApply > 0 || scan.status === "ready_for_apply") return "apply";
  return "scan";
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

function reviewDraftForItem(item: PaperReviewItem, draft?: PaperLibrarySessionDraft): PaperLibrarySessionDraft {
  if (draft) return draft;
  const selected = item.candidates.find((candidate) => candidate.id === item.selectedCandidateId) ?? item.candidates[0];
  return {
    title: selected?.title ?? "",
    year: selected?.year ? String(selected.year) : "",
    authors: selected?.authors?.join(", ") ?? "",
  };
}

function selectedCandidateForItem(item: PaperReviewItem, selectedCandidateId?: string) {
  return item.candidates.find((candidate) => candidate.id === selectedCandidateId)
    ?? item.candidates.find((candidate) => candidate.id === item.selectedCandidateId)
    ?? item.candidates[0];
}

function splitAuthors(value: string): string[] {
  return value
    .split(",")
    .map((author) => author.trim())
    .filter(Boolean);
}

function normalizeAuthorsText(value: string): string {
  return value.trim().replace(/\s*,\s*/g, ", ").replace(/\s+/g, " ");
}

function candidateAuthorsForReview(candidate: ReturnType<typeof selectedCandidateForItem>): string[] {
  return (candidate?.authors ?? []).map((author) => author.trim()).filter(Boolean);
}

function metadataMatchesSuggestion(draft: PaperLibrarySessionDraft, candidate: ReturnType<typeof selectedCandidateForItem>): boolean {
  if (!candidate) return false;
  const candidateAuthors = candidateAuthorsForReview(candidate);
  return (
    draft.title.trim() === (candidate.title ?? "").trim()
    && draft.year.trim() === (candidate.year ? String(candidate.year) : "")
    && normalizeAuthorsText(draft.authors) === normalizeAuthorsText(candidateAuthors.join(", "))
  );
}

function authorsForCorrection(draft: PaperLibrarySessionDraft, candidate: ReturnType<typeof selectedCandidateForItem>): string[] {
  const candidateAuthors = candidateAuthorsForReview(candidate);
  if (normalizeAuthorsText(draft.authors) === normalizeAuthorsText(candidateAuthors.join(", "))) {
    return candidateAuthors;
  }
  return splitAuthors(draft.authors);
}

function mergeUniqueById<T extends { id: string }>(existing: T[], incoming: T[]): T[] {
  const byId = new Map(existing.map((item) => [item.id, item]));
  for (const item of incoming) byId.set(item.id, item);
  return Array.from(byId.values());
}

function formatStatus(status: string): string {
  return status.replaceAll("_", " ");
}

function truncateGraphLabel(value: string | undefined, fallback: string, maxLength = 34): string {
  const label = (value?.trim() || fallback).replace(/\s+/g, " ");
  return label.length > maxLength ? `${label.slice(0, maxLength - 1)}...` : label;
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
    ? "border-ok/30 bg-ok/10 text-ok"
    : tone === "warning"
      ? "border-warn/30 bg-warn/10 text-warn"
      : tone === "danger"
        ? "border-danger/30 bg-danger/10 text-danger"
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

function CitationGraphMap({
  graphPage,
}: {
  graphPage: PaperLibraryGraphResponse | null;
}) {
  const layout = useMemo(() => {
    const nodes = graphPage?.nodes ?? [];
    const edges = graphPage?.edges ?? [];
    const connectedIds = new Set(edges.flatMap((edge) => [edge.sourceNodeId, edge.targetNodeId]));
    const connected = nodes.filter((node) => connectedIds.has(node.id));
    const disconnected = nodes.filter((node) => !connectedIds.has(node.id));
    const visibleNodes = (connected.length > 0 ? [...connected, ...disconnected] : nodes)
      .slice(0, GRAPH_MAP_NODE_LIMIT);
    const visibleIds = new Set(visibleNodes.map((node) => node.id));
    const visibleEdges = edges.filter((edge) => visibleIds.has(edge.sourceNodeId) && visibleIds.has(edge.targetNodeId));
    const positions = new Map<string, { x: number; y: number }>();

    if (visibleEdges.length === 0) {
      const columns = Math.min(4, Math.max(1, Math.ceil(Math.sqrt(visibleNodes.length || 1))));
      const rows = Math.max(1, Math.ceil((visibleNodes.length || 1) / columns));
      visibleNodes.forEach((node, index) => {
        const column = index % columns;
        const row = Math.floor(index / columns);
        positions.set(node.id, {
          x: 90 + (column * (540 / Math.max(1, columns - 1 || 1))),
          y: 72 + (row * (210 / Math.max(1, rows - 1 || 1))),
        });
      });
    } else {
      let left = visibleNodes.filter((node) => node.local);
      let right = visibleNodes.filter((node) => !node.local);
      if (right.length === 0) {
        const midpoint = Math.ceil(visibleNodes.length / 2);
        left = visibleNodes.slice(0, midpoint);
        right = visibleNodes.slice(midpoint);
      }
      const placeColumn = (columnNodes: typeof visibleNodes, x: number) => {
        const span = 230;
        columnNodes.forEach((node, index) => {
          positions.set(node.id, {
            x,
            y: 58 + (index * (span / Math.max(1, columnNodes.length - 1))),
          });
        });
      };
      placeColumn(left, 170);
      placeColumn(right.length ? right : left, right.length ? 550 : 390);
    }

    return { nodes: visibleNodes, edges: visibleEdges, positions };
  }, [graphPage]);

  if (layout.nodes.length === 0) {
    return (
      <div className="flex h-72 items-center justify-center rounded-lg border border-dashed border-border bg-surface text-sm text-muted">
        The citation map appears after graph data is available.
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface">
      <svg
        aria-label="Citation graph map"
        className="h-72 w-full"
        role="img"
        viewBox="0 0 720 340"
      >
        <rect width="720" height="340" fill="var(--surface-sunk)" />
        {layout.edges.map((edge) => {
          const source = layout.positions.get(edge.sourceNodeId);
          const target = layout.positions.get(edge.targetNodeId);
          if (!source || !target) return null;
          return (
            <line
              key={edge.id}
              stroke={edge.kind === "same_identity" ? "var(--warn)" : "var(--accent)"}
              strokeDasharray={edge.kind === "bridge_suggestion" ? "4 5" : undefined}
              strokeOpacity={0.46}
              strokeWidth={1.8}
              x1={source.x}
              x2={target.x}
              y1={source.y}
              y2={target.y}
            />
          );
        })}
        {layout.nodes.map((node) => {
          const point = layout.positions.get(node.id) ?? { x: 360, y: 170 };
          const fill = node.local
            ? "var(--accent)"
            : node.suggestion
              ? "var(--warn)"
              : "var(--surface-raised)";
          const textAnchor = point.x > 420 ? "end" : "start";
          const textX = point.x > 420 ? point.x - 14 : point.x + 14;
          return (
            <g key={node.id}>
              <title>{node.title ?? node.id}</title>
              <circle
                cx={point.x}
                cy={point.y}
                fill={fill}
                opacity={node.local ? 0.95 : 0.82}
                r={node.local ? 7 : 6}
                stroke="var(--surface-raised)"
                strokeWidth={2}
              />
              <text
                dominantBaseline="middle"
                fill="var(--text-body)"
                fontSize="11"
                textAnchor={textAnchor}
                x={textX}
                y={point.y}
              >
                {truncateGraphLabel(node.title, node.id, 30)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export function PaperLibraryCommandCenter({
  projectSlug,
}: {
  projectSlug: string;
}) {
  const skipLatestRestoreRef = useRef(false);
  const templateSelectionDirtyRef = useRef(false);
  const [session, setSession] = useState<PaperLibrarySession>(() => defaultSession());
  const [restoredProjectSlug, setRestoredProjectSlug] = useState<string | null>(null);
  const sessionRestored = restoredProjectSlug === projectSlug;
  const sessionRef = useRef(session);
  const [scan, setScan] = useState<PaperLibraryScan | null>(null);
  const [scanLoading, setScanLoading] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [folderPickerLoading, setFolderPickerLoading] = useState(false);

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
  }, []);

  useEffect(() => {
    skipLatestRestoreRef.current = false;
    templateSelectionDirtyRef.current = false;
    setSession(readStoredSession(projectSlug));
    setScan(null);
    setScanError(null);
    resetDownstreamState();
    setCommandError(null);
    setRestoredProjectSlug(projectSlug);
  }, [projectSlug, resetDownstreamState]);

  useEffect(() => {
    if (!sessionRestored) return;
    persistStoredSession(projectSlug, session);
  }, [projectSlug, session, sessionRestored]);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

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
      if (error instanceof PaperLibraryApiError && error.status === 404) {
        setScan(null);
        setSession((current) => current.scanId === scanId
          ? {
              ...current,
              step: "scan",
              scanId: undefined,
              applyPlanId: undefined,
              manifestId: undefined,
            }
          : current);
        return;
      }
      setScanError(error instanceof Error ? error.message : "Could not load paper-library scan.");
    } finally {
      setScanLoading(false);
    }
  }, [patchSession, projectSlug, session.applyPlanId, session.rootPath]);

  const loadLatestScan = useCallback(async () => {
    setScanLoading(true);
    setScanError(null);
    try {
      const payload = await paperLibraryFetchJson<{ ok?: true; scan?: PaperLibraryScan }>(
        `/api/brain/paper-library/scan?project=${encodeURIComponent(projectSlug)}&latest=1`,
      );
      const restoredScan = payload?.scan;
      if (!restoredScan) {
        return;
      }
      const currentSession = sessionRef.current;
      if (currentSession.scanId || skipLatestRestoreRef.current) {
        return;
      }
      setSession((current) => current.scanId || skipLatestRestoreRef.current
        ? current
        : {
            ...current,
            step: stepForRestoredScan(restoredScan),
            rootPath: restoredScan.rootPath || current.rootPath || "",
            scanId: restoredScan.id,
            applyPlanId: restoredScan.applyPlanId,
            manifestId: undefined,
          });
      setScan(restoredScan);
    } catch (error) {
      if (error instanceof PaperLibraryApiError && error.status === 404) {
        return;
      }
      setScanError(error instanceof Error ? error.message : "Could not restore the latest paper-library scan.");
    } finally {
      setScanLoading(false);
    }
  }, [projectSlug]);

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
      if (
        (payload.plan.manifestId && payload.plan.manifestId !== session.manifestId)
        || (!templateSelectionDirtyRef.current && payload.plan.templateFormat !== session.templateFormat)
      ) {
        patchSession({
          manifestId: payload.plan.manifestId ?? session.manifestId,
          step: payload.plan.manifestId && session.step === "apply" ? "history" : session.step,
          ...(!templateSelectionDirtyRef.current ? { templateFormat: payload.plan.templateFormat } : {}),
        });
      }
    } catch (error) {
      setApplyPlanError(error instanceof Error ? error.message : "Could not load the apply plan.");
    } finally {
      setApplyPlanLoading(false);
      setApplyPlanLoadingMore(false);
    }
  }, [patchSession, projectSlug, session.manifestId, session.step, session.templateFormat]);

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
      setGraphPage((current) => {
        const incomingLoadedCount = payload.loadedNodeCount ?? payload.nodes.length;
        if (!append || !current) {
          return {
            ...payload,
            loadedNodeCount: Math.min(incomingLoadedCount, payload.filteredCount),
          };
        }

        return {
          ...payload,
          nodes: mergeUniqueById(current.nodes, payload.nodes),
          edges: mergeUniqueById(current.edges, payload.edges),
          sourceRuns: payload.sourceRuns.length ? payload.sourceRuns : current.sourceRuns,
          warnings: payload.warnings.length ? payload.warnings : current.warnings,
          loadedNodeCount: Math.min(
            payload.filteredCount,
            (current.loadedNodeCount ?? current.nodes.length) + incomingLoadedCount,
          ),
          totalEdgeCount: payload.totalEdgeCount ?? current.totalEdgeCount,
        };
      });
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
    if (!sessionRestored) return;
    if (!session.scanId) {
      setScan(null);
      return;
    }
    void loadScan(session.scanId);
  }, [loadScan, session.scanId, sessionRestored]);

  useEffect(() => {
    if (!sessionRestored) return;
    if (session.scanId) return;
    void loadLatestScan();
  }, [loadLatestScan, session.scanId, sessionRestored]);

  useEffect(() => {
    if (!sessionRestored) return;
    if (!scan || !isScanInFlight(scan)) return;
    const interval = window.setInterval(() => {
      void loadScan(scan.id);
    }, 2_000);
    return () => window.clearInterval(interval);
  }, [loadScan, scan, sessionRestored]);

  useEffect(() => {
    if (!sessionRestored) return;
    if (!session.applyPlanId) {
      setApplyPlanPage(null);
      return;
    }
    void loadApplyPlan({ applyPlanId: session.applyPlanId });
  }, [loadApplyPlan, session.applyPlanId, sessionRestored]);

  useEffect(() => {
    if (!sessionRestored) return;
    if (!session.manifestId) {
      setManifestPage(null);
      return;
    }
    void loadManifest({ manifestId: session.manifestId });
  }, [loadManifest, session.manifestId, sessionRestored]);

  useEffect(() => {
    if (!sessionRestored) return;
    if (!scan || session.step !== "review") return;
    if (scan.status !== "ready_for_review" && scan.status !== "ready_for_apply") return;
    void loadReview();
  }, [loadReview, scan, session.step, reviewFilter, sessionRestored]);

  useEffect(() => {
    if (!sessionRestored) return;
    if (session.step !== "graph" || !session.scanId) return;
    void loadGraph();
    void loadClusters();
  }, [loadClusters, loadGraph, session.scanId, session.step, sessionRestored]);

  useEffect(() => {
    if (!sessionRestored) return;
    if (session.step !== "graph" || !session.scanId) return;
    void loadGaps();
  }, [loadGaps, session.scanId, session.step, sessionRestored]);

  useEffect(() => {
    if (!sessionRestored) return;
    if (scan?.applyPlanId && scan.applyPlanId !== session.applyPlanId) {
      patchSession({ applyPlanId: scan.applyPlanId });
    }
  }, [patchSession, scan?.applyPlanId, session.applyPlanId, sessionRestored]);

  useEffect(() => {
    if (!sessionRestored) return;
    if (applyPlanPage?.plan.manifestId && applyPlanPage.plan.manifestId !== session.manifestId) {
      patchSession({ manifestId: applyPlanPage.plan.manifestId });
    }
  }, [applyPlanPage?.plan.manifestId, patchSession, session.manifestId, sessionRestored]);

  const startScanForRoot = useCallback(async (rootPath: string) => {
    setCommandError(null);
    setScanError(null);
    resetDownstreamState();
    setScan(null);
    setSession((current) => ({
      ...current,
      rootPath,
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
            rootPath,
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
  }, [patchSession, projectSlug, resetDownstreamState]);

  const handleImportPdfFolder = useCallback(async () => {
    setFolderPickerLoading(true);
    setCommandError(null);
    setScanError(null);
    try {
      const payload = await paperLibraryFetchJson<{ path?: string; cancelled?: boolean }>(
        "/api/local-folder-picker",
        { method: "POST" },
      );
      if (payload.cancelled) return;
      const rootPath = payload.path?.trim();
      if (!rootPath) throw new Error("Folder picker returned no path.");
      skipLatestRestoreRef.current = true;
      await startScanForRoot(rootPath);
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : "Could not choose a PDF folder.");
    } finally {
      setFolderPickerLoading(false);
    }
  }, [startScanForRoot]);

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
      const selectedCandidateId = item.selectedCandidateId ?? item.candidates[0]?.id;
      const selectedCandidate = selectedCandidateForItem(item, selectedCandidateId);
      const resolvedAction = action === "correct" && metadataMatchesSuggestion(draft, selectedCandidate)
        ? "accept"
        : action;
      await paperLibraryFetchJson<{ ok: true; remainingCount: number }>(
        "/api/brain/paper-library/review",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            project: projectSlug,
            scanId: session.scanId,
            itemId: item.id,
            action: resolvedAction,
            selectedCandidateId,
            correction:
              resolvedAction === "correct"
                ? {
                    title: draft.title.trim(),
                    year: draft.year.trim(),
                    authors: authorsForCorrection(draft, selectedCandidate),
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
      templateSelectionDirtyRef.current = false;
      setApprovalToken(null);
      setManifestPage(null);
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : "Could not create the apply plan.");
    }
  }, [patchSession, projectSlug, session.rootPath, session.scanId, session.templateFormat]);

  const handleSelectTemplateFormat = useCallback((templateFormat: string) => {
    if (templateFormat === session.templateFormat) return;
    templateSelectionDirtyRef.current = true;
    setApprovalToken(null);
    setCommandError(null);
    setApplyPlanError(null);
    patchSession({ templateFormat });
  }, [patchSession, session.templateFormat]);

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
    const planMatchesSelectedTemplate = applyPlanPage?.plan.templateFormat === session.templateFormat;
    if (!session.applyPlanId || !approvalToken || !planMatchesSelectedTemplate) return;
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
  }, [
    applyPlanPage?.plan.templateFormat,
    approvalToken,
    loadApplyPlan,
    loadManifest,
    loadScan,
    patchSession,
    projectSlug,
    session.applyPlanId,
    session.scanId,
    session.templateFormat,
  ]);

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
  const activePlanMatchesTemplate = Boolean(
    activePlan && activePlan.templateFormat === session.templateFormat,
  );
  const applyPlanTemplateStale = Boolean(activePlan && !activePlanMatchesTemplate);

  const reviewNeededCount = scan?.counters.needsReview ?? 0;
  const applyReadyCount = activePlan?.operationCount ?? scan?.counters.readyForApply ?? 0;
  const graphCount = graphPage?.filteredCount ?? graphPage?.totalCount ?? 0;
  const historyCount = activeManifest?.appliedCount ?? 0;
  const totalGraphEdgeCount = graphPage?.totalEdgeCount ?? graphPage?.edges.length ?? 0;
  const graphSourceRunCount = graphPage?.sourceRuns.length ?? 0;
  const graphSuccessfulRuns = graphPage?.sourceRuns.filter((run) => run.status === "success").length ?? 0;
  const graphNoIdentifierRuns = graphPage?.sourceRuns.filter((run) => (
    run.status === "negative" && run.message?.toLowerCase().includes("no supported identifier")
  )).length ?? 0;
  const approvalTokenExpired = approvalToken
    ? Date.parse(approvalToken.expiresAt) <= Date.now()
    : false;
  const persistedApprovalExpiresAt = activePlan?.approvalExpiresAt ?? null;
  const persistedApprovalExpired = persistedApprovalExpiresAt
    ? Date.parse(persistedApprovalExpiresAt) <= Date.now()
    : false;
  const approvalNeedsRefresh = Boolean(
    activePlan
    && activePlanMatchesTemplate
    && activePlan.status === "approved"
    && !activePlan.manifestId
    && (!approvalToken || approvalTokenExpired),
  );
  const canApprovePlan = Boolean(
    activePlan
    && activePlanMatchesTemplate
    && activePlan.conflictCount === 0
    && !activePlan.manifestId
    && (activePlan.status === "validated" || approvalNeedsRefresh),
  );
  const approveButtonLabel = approvalNeedsRefresh ? "Refresh approval" : "Approve plan";
  const approvalStatusMessage = approvalToken
    ? (
        approvalTokenExpired
          ? `Approval expired at ${new Date(approvalToken.expiresAt).toLocaleString()}. Refresh approval to continue.`
          : `Plan approved until ${new Date(approvalToken.expiresAt).toLocaleString()}.`
      )
    : activePlan?.status === "approved"
      ? (
          persistedApprovalExpiresAt
            ? persistedApprovalExpired
              ? `Approval expired at ${new Date(persistedApprovalExpiresAt).toLocaleString()}. Refresh approval to continue.`
              : `Plan approved until ${new Date(persistedApprovalExpiresAt).toLocaleString()}, but this browser session no longer has the apply token. Refresh approval to continue.`
            : "Plan is already approved, but this browser session needs a fresh apply token. Refresh approval to continue."
        )
      : null;
  const approvalStatusTone = (approvalToken && !approvalTokenExpired)
    ? "border-ok/30 bg-ok/10 text-ok"
    : "border-warn/30 bg-warn/10 text-warn";

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
              <h3 className="mt-1 text-lg font-semibold text-foreground">Check extracted PDF metadata</h3>
              <p className="mt-1 max-w-2xl text-sm text-muted">
                Review the title, year, and authors ScienceSwarm found for each PDF. Save the suggestion as-is or correct the fields first.
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
            <div role="alert" className="mt-4 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
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
                return (
                  <article key={item.id} className="py-4">
                    <div className="rounded-xl border border-border bg-surface p-4">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted">PDF</p>
                          <h4 className="mt-1 break-words text-base font-semibold text-foreground">
                            {item.source?.relativePath ?? item.paperId}
                          </h4>
                          <p className="mt-1 text-xs text-muted">
                            Check the extracted title, year, and authors. These fields will be used to rename and organize the PDF.
                          </p>
                        </div>
                        <StatusBadge
                          tone={item.state === "accepted" || item.state === "corrected" ? "success" : item.state === "ignored" ? "neutral" : "warning"}
                          value={item.state}
                        />
                      </div>

                      <div className="mt-4">
                        <div className="flex flex-wrap items-end justify-between gap-2">
                          <div>
                            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted">Suggested metadata</p>
                            <p className="mt-1 text-xs text-muted">Save it as-is, or edit any field before saving.</p>
                          </div>
                        </div>
                        <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_8rem]">
                          <label className="min-w-0 text-[11px] font-semibold text-muted">
                            Title
                            <input
                              value={draft.title}
                              onChange={(event) => {
                                const value = event.target.value;
                                setDraftsByItemId((current) => ({
                                  ...current,
                                  [item.id]: { ...draft, title: value },
                                }));
                              }}
                              className="mt-1 w-full rounded-lg border border-border px-3 py-2 text-sm text-foreground"
                              placeholder="Title"
                            />
                          </label>
                          <label className="min-w-0 text-[11px] font-semibold text-muted">
                            Year
                            <input
                              value={draft.year}
                              onChange={(event) => {
                                const value = event.target.value;
                                setDraftsByItemId((current) => ({
                                  ...current,
                                  [item.id]: { ...draft, year: value },
                                }));
                              }}
                              className="mt-1 w-full rounded-lg border border-border px-3 py-2 text-sm text-foreground"
                              placeholder="Year"
                            />
                          </label>
                          <label className="min-w-0 text-[11px] font-semibold text-muted sm:col-span-2">
                            Authors
                            <input
                              value={draft.authors}
                              onChange={(event) => {
                                const value = event.target.value;
                                setDraftsByItemId((current) => ({
                                  ...current,
                                  [item.id]: { ...draft, authors: value },
                                }));
                              }}
                              className="mt-1 w-full rounded-lg border border-border px-3 py-2 text-sm text-foreground"
                              placeholder="Authors, separated by commas"
                            />
                          </label>
                        </div>
                      </div>

                      <div className="mt-4 flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() => void handleReviewAction(item, "correct")}
                          disabled={reviewActionItemId === item.id}
                          className="rounded-lg border border-accent bg-accent px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          Save metadata
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleReviewAction(item, "ignore")}
                          disabled={reviewActionItemId === item.id}
                          className="rounded-lg border border-border bg-white px-4 py-2 text-sm font-semibold text-foreground transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          Skip file
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleReviewAction(item, "unresolve")}
                          disabled={reviewActionItemId === item.id}
                          className="rounded-lg border border-border bg-white px-4 py-2 text-sm font-semibold text-foreground transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          Review later
                        </button>
                      </div>
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
            <h3 className="mt-1 text-lg font-semibold text-foreground">Choose how to rename all your PDFs</h3>
            <p className="mt-1 max-w-2xl text-sm text-muted">
              Pick a title format, preview every proposed move, then approve the exact reversible plan before anything touches disk.
            </p>
            <div className="mt-4 grid gap-2 md:grid-cols-3">
              {RENAME_TEMPLATE_OPTIONS.map((option) => {
                const active = session.templateFormat === option.format;
                return (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => handleSelectTemplateFormat(option.format)}
                    className={`rounded-lg border px-3 py-3 text-left transition-colors ${
                      active
                        ? "border-accent bg-accent-faint text-foreground"
                        : "border-border bg-white text-foreground hover:border-accent"
                    }`}
                  >
                    <span className="block text-xs font-semibold">{option.label}</span>
                    <span className="mt-1 block truncate font-mono text-[11px] text-muted">{option.example}</span>
                    <span className="mt-2 block text-[11px] leading-snug text-muted">{option.detail}</span>
                  </button>
                );
              })}
            </div>
            {!templateOptionForFormat(session.templateFormat) && (
              <div className="mt-3 rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-sm text-warn">
                This scan restored a custom format: {session.templateFormat}
              </div>
            )}
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <span className="rounded-full border border-border bg-surface px-3 py-1 font-mono text-[11px] text-muted">
                {session.templateFormat}
              </span>
              <button
                type="button"
                onClick={() => void handleCreateApplyPlan()}
                disabled={scan.status !== "ready_for_apply" && scan.status !== "ready_for_review"}
                className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
              >
                {session.applyPlanId ? "Regenerate rename preview" : "Preview renames"}
              </button>
            </div>
          </div>

          {applyPlanError && (
            <div role="alert" className="mt-4 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
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
                <div role="alert" className="rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-sm text-warn">
                  Resolve review items or path conflicts before approving this plan.
                </div>
              )}

              {applyPlanTemplateStale && (
                <div role="status" className="rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-sm text-warn">
                  This preview uses {activePlan.templateFormat}. Regenerate rename preview to inspect {session.templateFormat}.
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
                          <span key={code} className="rounded-full border border-warn/30 bg-warn/10 px-2 py-1 text-[11px] font-semibold text-warn">
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
                  disabled={!canApprovePlan}
                  className="rounded-lg border border-border bg-white px-3 py-2 text-xs font-semibold text-foreground transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
                >
                  {approveButtonLabel}
                </button>
                <button
                  type="button"
                  onClick={() => void handleApplyPlan()}
                  disabled={!approvalToken || approvalTokenExpired || !activePlanMatchesTemplate}
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

              {approvalStatusMessage && (
                <div
                  className={`rounded-lg border px-3 py-2 text-sm ${approvalStatusTone}`}
                >
                  {approvalStatusMessage}
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
            <div role="alert" className="mt-4 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
              {graphError}
            </div>
          )}

          {clustersError && (
            <div role="alert" className="mt-4 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
              {clustersError}
            </div>
          )}

          {gapsError && (
            <div role="alert" className="mt-4 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
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
                    <StatusBadge tone="neutral" value={`${graphPage?.nodes.length ?? 0}_visible_nodes`} />
                    <StatusBadge tone={totalGraphEdgeCount > 0 ? "success" : "warning"} value={`${totalGraphEdgeCount}_citation_edges`} />
                    <span className="text-sm text-muted">
                      {graphSourceRunCount} source checks
                      {graphSuccessfulRuns > 0 ? ` • ${graphSuccessfulRuns} with relations` : ""}
                    </span>
                  </div>
                  {graphPage && totalGraphEdgeCount === 0 && (
                    <div className="mt-3 rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-sm text-warn">
                      No citation edges yet. {graphNoIdentifierRuns > 0
                        ? `${graphNoIdentifierRuns} papers need DOI, arXiv, PMID, or OpenAlex identifiers before external citation lookup can connect them.`
                        : "Refresh graph after identifier enrichment, or review missing metadata so external citation lookup has stable IDs."}
                    </div>
                  )}
                  {graphPage?.warnings.length ? (
                    <div className="mt-3 space-y-2">
                      {graphPage.warnings.map((warning) => (
                        <div key={warning} className="rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-sm text-warn">
                          {warning}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>

                <div className="rounded-xl border border-border bg-white">
                  <div className="border-b border-border px-4 py-3">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-foreground">Citation map</p>
                        <p className="mt-1 text-xs text-muted">
                          Showing connected neighbors with each loaded node so citation edges are visible in context.
                        </p>
                      </div>
                      {graphPage && (
                        <span className="text-xs text-muted">
                          {graphPage.loadedNodeCount ?? graphPage.nodes.length} of {graphPage.filteredCount} papers loaded
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="p-4">
                    <CitationGraphMap graphPage={graphPage} />
                  </div>
                </div>

                <div className="rounded-xl border border-border bg-white">
                  <div className="border-b border-border px-4 py-3">
                    <p className="text-sm font-semibold text-foreground">Papers in this graph window</p>
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
                            <div key={warning} className="rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-sm text-warn">
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
                            <div key={warning} className="rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-sm text-warn">
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
            <div role="alert" className="mt-4 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
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
                    <div key={warning} className="rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-sm text-warn">
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
                          <p className="mt-1 text-xs text-danger">{operation.error}</p>
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
          <h3 className="mt-1 text-lg font-semibold text-foreground">Import a local PDF folder without mutating disk</h3>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            Choose a folder of PDFs. ScienceSwarm will run a dry scan, build a review queue, and wait for approval before any file move.
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => void handleImportPdfFolder()}
              disabled={folderPickerLoading || scanLoading || isScanInFlight(scan)}
              className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
            >
              {folderPickerLoading ? <SpinnerGap className="animate-spin" size={16} /> : <FolderOpen size={16} />}
              Import PDF Folder
            </button>
            <button
              type="button"
              onClick={() => void handleCancelScan()}
              disabled={!isScanInFlight(scan)}
              className="rounded-lg border border-border bg-white px-4 py-2 text-sm font-semibold text-foreground transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
            >
              Cancel scan
            </button>
            {session.rootPath && (
              <span className="min-w-0 rounded-lg border border-border bg-surface px-3 py-2 font-mono text-[11px] text-muted">
                {session.rootPath}
              </span>
            )}
          </div>
        </div>

        {scanError && (
          <div role="alert" className="mt-4 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
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
                    <div key={warning} className="rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-sm text-warn">
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
            body="Use Import PDF Folder to choose a local archive. The first pass is dry-run only and creates review, rename, graph, and history previews."
          />
        )}
      </div>
    );
  }, [
    activeManifest,
    activePlan,
    activePlanMatchesTemplate,
    approvalStatusMessage,
    approvalStatusTone,
    approvalToken,
    approvalTokenExpired,
    applyPlanError,
    applyPlanTemplateStale,
    applyPlanLoading,
    applyPlanLoadingMore,
    applyPlanPage,
    approveButtonLabel,
    canApprovePlan,
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
    graphNoIdentifierRuns,
    graphPage,
    graphSourceRunCount,
    graphSuccessfulRuns,
    handleApplyPlan,
    handleApprovePlan,
    handleCancelScan,
    handleCreateApplyPlan,
    handleGapAction,
    handleImportPdfFolder,
    handleRepairManifest,
    handleReviewAction,
    handleSelectTemplateFormat,
    handleUndo,
    folderPickerLoading,
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
    session,
    totalGraphEdgeCount,
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
          <div role="alert" className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
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
