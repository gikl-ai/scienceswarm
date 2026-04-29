"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from "react";
import {
  ArrowsClockwise,
  ArrowSquareOut,
  CheckCircle,
  ClockCounterClockwise,
  DotsThree,
  FunnelSimple,
  FolderOpen,
  Graph,
  ListBullets,
  MagnifyingGlass,
  ShareNetwork,
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
import type { PaperCorpusImportStatus, PaperCorpusOverallStatus } from "@/lib/paper-library/corpus/status";
import { computeGraphInsights } from "@/lib/paper-library/graph-insights";
import { buildWorkspaceHrefForSlug } from "@/lib/project-navigation";

type PaperLibraryStep = "scan" | "review" | "apply" | "graph" | "history";
type ReviewFilter = Extract<PaperReviewItemState, "needs_review" | "accepted" | "ignored" | "unresolved">;
const DEFAULT_REVIEW_FILTER: ReviewFilter = "needs_review";
type GapFilter = GapSuggestionState | "all";
type GraphPerspective = "all" | "prior" | "derivative";
type GraphNodeFilter = "all" | "local" | "external" | "bridge";

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
const GRAPH_OVERVIEW_THRESHOLD = 80;
const GRAPH_OVERVIEW_GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const CITATION_GRAPH_STYLE = {
  "--citation-graph-node-local": "var(--chart-ocean-2)",
  "--citation-graph-node-external": "var(--chart-amber)",
  "--citation-graph-node-bridge": "var(--chart-violet)",
  "--citation-graph-edge-pdf": "var(--chart-mint)",
  "--citation-graph-edge-reference": "var(--chart-ocean-4)",
  "--citation-graph-edge-identity": "var(--chart-amber)",
  "--citation-graph-edge-bridge": "var(--chart-violet)",
} as CSSProperties;

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

function scanTimestamp(scan: Pick<PaperLibraryScan, "updatedAt" | "createdAt">): number {
  const updatedAt = Date.parse(scan.updatedAt);
  if (Number.isFinite(updatedAt)) return updatedAt;
  const createdAt = Date.parse(scan.createdAt);
  return Number.isFinite(createdAt) ? createdAt : 0;
}

function shouldPromoteLatestScan({
  currentScan,
  currentSession,
  latestScan,
}: {
  currentScan: PaperLibraryScan | null;
  currentSession: PaperLibrarySession;
  latestScan: PaperLibraryScan;
}): boolean {
  if (!currentSession.scanId) return true;
  if (currentSession.scanId === latestScan.id) return true;
  if (!currentScan || isScanInFlight(currentScan)) return false;
  if (currentSession.step !== "scan") return false;
  return scanTimestamp(latestScan) > scanTimestamp(currentScan);
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

function corpusStatusTone(status: PaperCorpusOverallStatus | PaperCorpusImportStatus["graph"]["status"]): "neutral" | "success" | "warning" | "danger" {
  if (status === "current") return "success";
  if (status === "malformed" || status === "unsupported_version" || status === "needs_attention" || status === "blocked" || status === "failed") return "danger";
  if (status === "stale" || status === "partial" || status === "missing" || status === "skipped") return "warning";
  return "neutral";
}

function formatPercent(value: number | undefined): string {
  return typeof value === "number" ? `${Math.round(value * 100)}%` : "not scored";
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function selectedSourceTypes(status: PaperCorpusImportStatus): string {
  const values = Object.entries(status.sourcePreference.selectedTypeCounts)
    .filter(([, count]) => count > 0)
    .map(([type, count]) => `${count} ${formatStatus(type)}`);
  return values.length > 0 ? values.join(" / ") : "No preferred source yet";
}

function summaryTierLine(status: PaperCorpusImportStatus, tier: "relevance" | "brief" | "detailed"): string {
  const counts = status.summaries.byTier[tier];
  return `${tier}: ${counts.current} current, ${counts.stale} stale, ${counts.missing} missing`;
}

function CorpusStatusMetric({
  detail,
  label,
  primary,
  status,
}: {
  detail: string;
  label: string;
  primary: string;
  status: PaperCorpusOverallStatus | PaperCorpusImportStatus["graph"]["status"];
}) {
  return (
    <div className="min-w-0 border-l border-border pl-3">
      <div className="flex min-h-7 flex-wrap items-center gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">{label}</p>
        <StatusBadge tone={corpusStatusTone(status)} value={status} />
      </div>
      <p className="mt-2 text-sm font-semibold text-foreground">{primary}</p>
      <p className="mt-1 text-xs leading-5 text-muted">{detail}</p>
    </div>
  );
}

function CorpusImportStatusPanel({
  error,
  loading,
  onRefresh,
  status,
}: {
  error: string | null;
  loading: boolean;
  onRefresh: () => void;
  status: PaperCorpusImportStatus | null;
}) {
  if (loading && !status) {
    return (
      <section className="rounded-xl border border-border bg-white p-4 lg:col-span-2">
        <div className="flex items-center gap-2 text-sm text-muted">
          <SpinnerGap className="animate-spin" size={16} />
          Loading corpus status...
        </div>
      </section>
    );
  }

  if (!status) {
    return (
      <section className="rounded-xl border border-border bg-white p-4 lg:col-span-2">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-foreground">Scientific corpus status</p>
            <p className="mt-1 text-sm text-muted">Corpus source, extraction, summary, bibliography, and graph status appears after a scan is selected.</p>
          </div>
          <button
            type="button"
            onClick={onRefresh}
            className="inline-flex items-center gap-2 rounded-lg border border-border bg-white px-3 py-2 text-xs font-semibold text-foreground transition-colors hover:border-accent hover:text-accent"
          >
            <ArrowsClockwise size={14} />
            Refresh
          </button>
        </div>
        {error && (
          <div role="alert" className="mt-3 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
            {error}
          </div>
        )}
      </section>
    );
  }

  const summaryCurrent = ["relevance", "brief", "detailed"].reduce((total, tier) => (
    total + status.summaries.byTier[tier as "relevance" | "brief" | "detailed"].current
  ), 0);
  const summaryMissing = ["relevance", "brief", "detailed"].reduce((total, tier) => (
    total + status.summaries.byTier[tier as "relevance" | "brief" | "detailed"].missing
  ), 0);
  const bibliographyDetail = [
    pluralize(status.bibliography.localStatusCounts.local, "local entry", "local entries"),
    pluralize(status.bibliography.localStatusCounts.metadata_only, "metadata-only entry", "metadata-only entries"),
    pluralize(status.bibliography.localStatusCounts.unresolved, "unresolved entry", "unresolved entries"),
  ].join(" / ");
  const graphDetail = status.graph.status === "missing"
    ? "Open or refresh the graph after scan review to build citation context."
    : `${status.graph.sourceRunCount} source runs, ${status.graph.successfulSourceRunCount} with relations, ${status.graph.warningCount} warnings`;

  return (
    <section className="rounded-xl border border-border bg-white p-4 lg:col-span-2">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-semibold text-foreground">Scientific corpus status</p>
            <StatusBadge tone={corpusStatusTone(status.status)} value={status.status} />
          </div>
          <p className="mt-1 text-sm text-muted">
            {status.paperCount > 0
              ? `${status.paperCount} ${status.paperCount === 1 ? "paper" : "papers"} tracked by corpus artifacts.`
              : "No corpus manifest is available for this scan yet."}
          </p>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="inline-flex items-center gap-2 rounded-lg border border-border bg-white px-3 py-2 text-xs font-semibold text-foreground transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
        >
          {loading ? <SpinnerGap className="animate-spin" size={14} /> : <ArrowsClockwise size={14} />}
          Refresh
        </button>
      </div>

      {error && (
        <div role="alert" className="mt-3 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </div>
      )}

      <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        <CorpusStatusMetric
          label="Source preference"
          status={status.sourcePreference.status}
          primary={`${status.sourcePreference.selectedCount}/${status.paperCount} selected`}
          detail={`${status.sourcePreference.candidateCount} candidates / ${selectedSourceTypes(status)}`}
        />
        <CorpusStatusMetric
          label="Extraction quality"
          status={status.extractionQuality.status}
          primary={`${status.extractionQuality.currentCount} current / ${status.extractionQuality.missingCount} missing`}
          detail={`Average quality ${formatPercent(status.extractionQuality.averageScore)} / ${status.extractionQuality.warningCount} extraction warnings`}
        />
        <CorpusStatusMetric
          label="Summary status"
          status={status.summaries.status}
          primary={`${summaryCurrent} current / ${summaryMissing} missing`}
          detail={[
            summaryTierLine(status, "relevance"),
            summaryTierLine(status, "brief"),
            summaryTierLine(status, "detailed"),
          ].join(" / ")}
        />
        <CorpusStatusMetric
          label="Bibliography"
          status={status.bibliography.status}
          primary={pluralize(status.bibliography.entryCount, "entry", "entries")}
          detail={bibliographyDetail}
        />
        <CorpusStatusMetric
          label="Graph"
          status={status.graph.status}
          primary={`${status.graph.nodeCount} nodes / ${status.graph.edgeCount} edges`}
          detail={graphDetail}
        />
      </div>

      {status.warnings.length > 0 && (
        <div className="mt-4 space-y-2">
          {status.warnings.slice(0, 3).map((warning) => (
            <div key={warning} className="rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-sm text-warn">
              {warning}
            </div>
          ))}
        </div>
      )}
    </section>
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

type GraphMapNode = PaperLibraryGraphResponse["nodes"][number];
type GraphMapEdge = PaperLibraryGraphResponse["edges"][number];

interface GraphMapPoint {
  x: number;
  y: number;
  labelX: number;
  labelY: number;
  anchor: "start" | "middle" | "end";
  radius: number;
}

interface GraphOverviewPoint {
  x: number;
  y: number;
  radius: number;
}

function graphEdgeColor(edge: GraphMapEdge): string {
  if (edge.source === "pdf_text") return "var(--citation-graph-edge-pdf)";
  if (edge.kind === "same_identity") return "var(--citation-graph-edge-identity)";
  if (edge.kind === "bridge_suggestion") return "var(--citation-graph-edge-bridge)";
  return "var(--citation-graph-edge-reference)";
}

function graphEdgeDash(edge: GraphMapEdge): string | undefined {
  if (edge.kind === "same_identity") return "2 5";
  if (edge.kind === "bridge_suggestion") return "7 6";
  return undefined;
}

function stableGraphHash(value: string): number {
  let hash = 0;
  for (const char of value) {
    hash = ((hash * 33) + char.charCodeAt(0)) % 2_147_483_647;
  }
  return hash;
}

function graphNodeTitle(node: GraphMapNode): string {
  return node.title?.trim() || node.id;
}

function graphNodeFill(node: GraphMapNode): string {
  if (node.local) return "var(--citation-graph-node-local)";
  if (node.suggestion || node.kind === "bridge_suggestion") return "var(--citation-graph-node-bridge)";
  return "var(--citation-graph-node-external)";
}

function graphNodeKindLabel(node: GraphMapNode): string {
  if (node.local) return "local PDF";
  if (node.suggestion || node.kind === "bridge_suggestion") return "bridge";
  return "reference";
}

function graphNodeAuthors(node: GraphMapNode): string {
  const authors = node.authors.map((author) => author.trim()).filter(Boolean);
  if (authors.length === 0) return "Unknown authors";
  if (authors.length <= 3) return authors.join(", ");
  return `${authors.slice(0, 3).join(", ")} +${authors.length - 3}`;
}

function graphNodeMeta(node: GraphMapNode): string {
  return [
    graphNodeKindLabel(node),
    node.year ? String(node.year) : undefined,
    node.venue?.trim() || undefined,
  ].filter(Boolean).join(" / ");
}

function graphNodeIdentifier(node: GraphMapNode): string {
  const identifiers = node.identifiers ?? {};
  if (identifiers.doi) return `doi:${identifiers.doi}`;
  if (identifiers.arxivId) return `arxiv:${identifiers.arxivId}`;
  if (identifiers.pmid) return `pmid:${identifiers.pmid}`;
  if (identifiers.openAlexId) return `openalex:${identifiers.openAlexId}`;
  return node.id;
}

function graphNodeAbstract(node: GraphMapNode): string | null {
  const abstract = node.abstract?.trim();
  return abstract && abstract.length > 0 ? abstract : null;
}

function graphNodeMatchesFilter(node: GraphMapNode, filter: GraphNodeFilter): boolean {
  if (filter === "all") return true;
  if (filter === "local") return node.local;
  if (filter === "bridge") return node.suggestion || node.kind === "bridge_suggestion";
  return !node.local && !node.suggestion && node.kind !== "bridge_suggestion";
}

function graphNodeMatchesQuery(node: GraphMapNode, query: string): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return true;
  const haystack = [
    node.id,
    node.title,
    node.venue,
    node.year ? String(node.year) : undefined,
    ...node.authors,
    ...node.paperIds,
    node.identifiers?.doi,
    node.identifiers?.arxivId,
    node.identifiers?.pmid,
    node.identifiers?.openAlexId,
  ].filter(Boolean).join(" ").toLowerCase();
  return haystack.includes(normalizedQuery);
}

function graphEdgeMatchesPerspective(edge: GraphMapEdge, perspective: GraphPerspective): boolean {
  if (perspective === "prior") return edge.kind === "references";
  if (perspective === "derivative") return edge.kind === "cited_by";
  return true;
}

function summarizeGraphWarnings(warnings: string[]): string[] {
  const cappedWarnings = warnings.filter((warning) => warning.toLowerCase().includes("local reference extraction capped at 250 references"));
  const remaining = warnings.filter((warning) => !warning.toLowerCase().includes("local reference extraction capped at 250 references"));
  if (cappedWarnings.length <= 1) return [...remaining, ...cappedWarnings];
  return [
    ...remaining,
    `${cappedWarnings.length} papers hit the local reference extraction cap of 250 references; the graph includes all captured edges from this scan.`,
  ];
}

function CitationGraphDetailMap({
  graphPage,
  onSelectNode,
  selectedNodeId,
}: {
  graphPage: PaperLibraryGraphResponse | null;
  onSelectNode?: (nodeId: string) => void;
  selectedNodeId?: string | null;
}) {
  const layout = useMemo(() => {
    const nodes = graphPage?.nodes ?? [];
    const edges = graphPage?.edges ?? [];
    const degreeByNodeId = new Map<string, number>();
    for (const edge of edges) {
      degreeByNodeId.set(edge.sourceNodeId, (degreeByNodeId.get(edge.sourceNodeId) ?? 0) + 1);
      degreeByNodeId.set(edge.targetNodeId, (degreeByNodeId.get(edge.targetNodeId) ?? 0) + 1);
    }
    const sortedNodes = [...nodes].sort((left, right) => {
      const degreeDelta = (degreeByNodeId.get(right.id) ?? 0) - (degreeByNodeId.get(left.id) ?? 0);
      if (degreeDelta !== 0) return degreeDelta;
      if (left.local !== right.local) return left.local ? -1 : 1;
      return (left.title ?? left.id).localeCompare(right.title ?? right.id);
    });
    const connectedNodes = sortedNodes.filter((node) => (degreeByNodeId.get(node.id) ?? 0) > 0);
    const visibleNodes = (connectedNodes.length ? connectedNodes : sortedNodes).slice(0, GRAPH_MAP_NODE_LIMIT);
    const visibleIds = new Set(visibleNodes.map((node) => node.id));
    const visibleEdges = edges.filter((edge) => visibleIds.has(edge.sourceNodeId) && visibleIds.has(edge.targetNodeId));
    const positions = new Map<string, GraphMapPoint>();
    const center = { x: 460, y: 245 };

    if (!visibleEdges.length) {
      const columns = Math.min(4, Math.max(1, Math.ceil(Math.sqrt(visibleNodes.length || 1))));
      const rows = Math.max(1, Math.ceil((visibleNodes.length || 1) / columns));
      visibleNodes.forEach((node, index) => {
        const column = index % columns;
        const row = Math.floor(index / columns);
        const x = 170 + (column * (580 / Math.max(1, columns - 1 || 1)));
        const y = 105 + (row * (260 / Math.max(1, rows - 1 || 1)));
        positions.set(node.id, {
          x,
          y,
          labelX: x,
          labelY: y + 24,
          anchor: "middle",
          radius: node.local ? 8 : 7,
        });
      });
    } else {
      const [hub, ...ringNodes] = visibleNodes;
      positions.set(hub.id, {
        x: center.x,
        y: center.y,
        labelX: center.x,
        labelY: center.y - 22,
        anchor: "middle",
        radius: Math.min(17, 10 + (degreeByNodeId.get(hub.id) ?? 0)),
      });

      const localRing = ringNodes.filter((node) => node.local);
      const externalRing = ringNodes.filter((node) => !node.local);
      const placeRing = (
        ring: GraphMapNode[],
        radiusX: number,
        radiusY: number,
        offset: number,
      ) => {
        ring.forEach((node, index) => {
          const angle = offset + ((Math.PI * 2 * index) / Math.max(1, ring.length));
          const x = center.x + Math.cos(angle) * radiusX;
          const y = center.y + Math.sin(angle) * radiusY;
          const anchor = x < center.x - 70 ? "end" : x > center.x + 70 ? "start" : "middle";
          const labelX = anchor === "end" ? x - 18 : anchor === "start" ? x + 18 : x;
          const labelY = anchor === "middle" ? y + 28 : y + 4;
          positions.set(node.id, {
            x,
            y,
            labelX,
            labelY,
            anchor,
            radius: Math.min(14, 7 + Math.sqrt(degreeByNodeId.get(node.id) ?? 1) * 1.8),
          });
        });
      };

      if (externalRing.length) {
        placeRing(localRing, 230, 145, -Math.PI / 2);
        placeRing(externalRing, 360, 205, -Math.PI / 2 + (Math.PI / Math.max(4, externalRing.length)));
      } else {
        placeRing(ringNodes, 320, 190, -Math.PI / 2);
      }
    }

    return { nodes: visibleNodes, edges: visibleEdges, positions, degreeByNodeId };
  }, [graphPage]);

  if (layout.nodes.length === 0) {
    return (
      <div className="flex h-[32rem] items-center justify-center rounded-[var(--radius-2)] border border-dashed border-rule bg-sunk text-sm text-dim">
        The citation map appears after graph data is available.
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-[var(--radius-2)] border border-rule bg-raised" style={CITATION_GRAPH_STYLE}>
      <svg
        aria-label="Citation graph map"
        className="h-[32rem] w-full"
        role="img"
        viewBox="0 0 920 520"
      >
        <defs>
          <radialGradient cx="50%" cy="48%" id="citation-map-bg" r="70%">
            <stop offset="0%" stopColor="var(--surface-raised)" />
            <stop offset="65%" stopColor="var(--surface-raised)" />
            <stop offset="100%" stopColor="var(--surface-sunk)" />
          </radialGradient>
          <filter id="node-shadow" x="-30%" y="-30%" width="160%" height="160%">
            <feDropShadow dx="0" dy="5" floodColor="var(--surface-ink)" floodOpacity="0.22" stdDeviation="5" />
          </filter>
        </defs>
        <rect width="920" height="520" fill="url(#citation-map-bg)" />
        <ellipse cx="460" cy="245" fill="none" rx="238" ry="151" stroke="var(--rule-soft)" strokeDasharray="5 9" />
        <ellipse cx="460" cy="245" fill="none" rx="368" ry="213" stroke="var(--rule-hair)" strokeDasharray="3 12" />
        {layout.edges.map((edge, index) => {
          const source = layout.positions.get(edge.sourceNodeId);
          const target = layout.positions.get(edge.targetNodeId);
          if (!source || !target) return null;
          const sweep = index % 2 === 0 ? 1 : -1;
          const controlX = (source.x + target.x) / 2 + sweep * 52;
          const controlY = (source.y + target.y) / 2 - sweep * 34;
          return (
            <path
              d={`M ${source.x} ${source.y} Q ${controlX} ${controlY} ${target.x} ${target.y}`}
              fill="none"
              key={edge.id}
              stroke={graphEdgeColor(edge)}
              strokeDasharray={graphEdgeDash(edge)}
              strokeLinecap="round"
              strokeOpacity={edge.source === "pdf_text" ? 0.72 : 0.48}
              strokeWidth={edge.source === "pdf_text" ? 2.8 : 2}
            />
          );
        })}
        {layout.nodes.map((node) => {
          const point = layout.positions.get(node.id) ?? {
            x: 460,
            y: 245,
            labelX: 460,
            labelY: 275,
            anchor: "middle" as const,
            radius: 8,
          };
          const fill = graphNodeFill(node);
          const degree = layout.degreeByNodeId.get(node.id) ?? 0;
          const selected = selectedNodeId === node.id;
          return (
            <g
              aria-label={`Select ${graphNodeTitle(node)}`}
              className="cursor-pointer outline-none"
              key={node.id}
              onClick={() => onSelectNode?.(node.id)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                onSelectNode?.(node.id);
              }}
              role="button"
              tabIndex={0}
            >
              <title>{graphNodeTitle(node)}</title>
              <circle
                cx={point.x}
                cy={point.y}
                fill={selected ? "var(--accent-faint)" : "var(--surface-raised)"}
                filter="url(#node-shadow)"
                r={point.radius + (selected ? 9 : 5)}
                stroke={selected ? "var(--accent)" : "transparent"}
                strokeWidth={selected ? 2 : 0}
              />
              <circle
                cx={point.x}
                cy={point.y}
                fill={fill}
                opacity={node.local ? 0.95 : 0.88}
                r={point.radius}
                stroke="var(--surface-raised)"
                strokeWidth={3}
              />
              {degree > 1 && (
                <text
                  dominantBaseline="middle"
                  fill="var(--accent-fg)"
                  fontSize="9"
                  fontWeight="700"
                  textAnchor="middle"
                  x={point.x}
                  y={point.y}
                >
                  {degree}
                </text>
              )}
              <text
                fill="var(--text-strong)"
                fontSize="12"
                fontWeight={node.local ? 700 : 600}
                textAnchor={point.anchor}
                x={point.labelX}
                y={point.labelY}
              >
                {truncateGraphLabel(node.title, node.id, point.anchor === "middle" ? 30 : 34)}
              </text>
              <text
                fill="var(--text-dim)"
                fontSize="10"
                textAnchor={point.anchor}
                x={point.labelX}
                y={point.labelY + 15}
              >
                {graphNodeKindLabel(node)}
                {node.year ? ` • ${node.year}` : ""}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-rule bg-sunk px-4 py-3 text-xs text-dim">
        <span className="inline-flex items-center gap-2"><span className="size-2.5 rounded-full" style={{ backgroundColor: "var(--citation-graph-node-local)" }} />Local PDFs</span>
        <span className="inline-flex items-center gap-2"><span className="size-2.5 rounded-full" style={{ backgroundColor: "var(--citation-graph-node-external)" }} />Referenced papers</span>
        <span className="inline-flex items-center gap-2"><span className="h-0.5 w-7 rounded" style={{ backgroundColor: "var(--citation-graph-edge-pdf)" }} />PDF reference links</span>
      </div>
    </div>
  );
}

function CitationGraphOverviewMap({
  graphPage,
  onSelectNode,
  selectedNodeId,
}: {
  graphPage: PaperLibraryGraphResponse | null;
  onSelectNode?: (nodeId: string) => void;
  selectedNodeId?: string | null;
}) {
  const layout = useMemo(() => {
    const nodes = graphPage?.nodes ?? [];
    const edges = graphPage?.edges ?? [];
    const adjacency = new Map<string, string[]>();
    const degreeByNodeId = new Map<string, number>();
    for (const node of nodes) {
      adjacency.set(node.id, []);
      degreeByNodeId.set(node.id, 0);
    }
    for (const edge of edges) {
      adjacency.get(edge.sourceNodeId)?.push(edge.targetNodeId);
      adjacency.get(edge.targetNodeId)?.push(edge.sourceNodeId);
      degreeByNodeId.set(edge.sourceNodeId, (degreeByNodeId.get(edge.sourceNodeId) ?? 0) + 1);
      degreeByNodeId.set(edge.targetNodeId, (degreeByNodeId.get(edge.targetNodeId) ?? 0) + 1);
    }

    const sortedNodes = [...nodes].sort((left, right) => {
      const localDelta = Number(right.local) - Number(left.local);
      if (localDelta !== 0) return localDelta;
      const degreeDelta = (degreeByNodeId.get(right.id) ?? 0) - (degreeByNodeId.get(left.id) ?? 0);
      if (degreeDelta !== 0) return degreeDelta;
      return (left.title ?? left.id).localeCompare(right.title ?? right.id);
    });
    const seedIds = sortedNodes.filter((node) => node.local).map((node) => node.id);
    const traversal = seedIds.length
      ? seedIds
      : sortedNodes[0]?.id
        ? [sortedNodes[0].id]
        : [];
    const distanceByNodeId = new Map<string, number>(traversal.map((id) => [id, 0]));
    const visited = new Set(traversal);
    for (let index = 0; index < traversal.length; index += 1) {
      const currentId = traversal[index];
      const nextDistance = (distanceByNodeId.get(currentId) ?? 0) + 1;
      for (const neighbor of adjacency.get(currentId) ?? []) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        distanceByNodeId.set(neighbor, nextDistance);
        traversal.push(neighbor);
      }
    }

    const fallbackDistance = Math.max(0, ...distanceByNodeId.values()) + 1;
    const orderedNodes = [...nodes].sort((left, right) => {
      const leftDistance = distanceByNodeId.get(left.id) ?? fallbackDistance;
      const rightDistance = distanceByNodeId.get(right.id) ?? fallbackDistance;
      if (leftDistance !== rightDistance) return leftDistance - rightDistance;
      if (left.local !== right.local) return left.local ? -1 : 1;
      const degreeDelta = (degreeByNodeId.get(right.id) ?? 0) - (degreeByNodeId.get(left.id) ?? 0);
      if (degreeDelta !== 0) return degreeDelta;
      return (left.title ?? left.id).localeCompare(right.title ?? right.id);
    });

    const center = { x: 700, y: 430 };
    const maxIndex = Math.max(1, orderedNodes.length - 1);
    const radialScale = 395 / Math.sqrt(maxIndex);
    const positions = new Map<string, GraphOverviewPoint>();
    for (const [index, node] of orderedNodes.entries()) {
      const distance = distanceByNodeId.get(node.id) ?? fallbackDistance;
      const baseRadius = Math.sqrt(index) * radialScale;
      const distanceBias = distance * 26;
      const radius = Math.min(430, baseRadius + distanceBias);
      const angleJitter = ((stableGraphHash(node.id) % 360) * Math.PI) / 180;
      const angle = (index * GRAPH_OVERVIEW_GOLDEN_ANGLE) + (angleJitter * 0.14);
      positions.set(node.id, {
        x: center.x + (Math.cos(angle) * radius * 1.18),
        y: center.y + (Math.sin(angle) * radius * 0.82),
        radius: node.local
          ? 5.6
          : node.suggestion
            ? 4.1
            : Math.min(3.8, 2.1 + (Math.log1p(degreeByNodeId.get(node.id) ?? 0) * 0.42)),
      });
    }

    const labeledIds = new Set(
      orderedNodes
        .filter((node) => node.local)
        .slice(0, 18)
        .map((node) => node.id),
    );

    return { degreeByNodeId, edges, labeledIds, nodes: orderedNodes, positions };
  }, [graphPage]);

  if (layout.nodes.length === 0) {
    return (
      <div className="flex h-[40rem] items-center justify-center rounded-[var(--radius-2)] border border-dashed border-rule bg-sunk text-sm text-dim">
        The citation graph appears after graph data is available.
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-[var(--radius-2)] border border-rule bg-raised" style={CITATION_GRAPH_STYLE}>
      <svg
        aria-label="Citation graph map"
        className="h-[40rem] w-full"
        role="img"
        viewBox="0 0 1400 900"
      >
        <defs>
          <linearGradient id="citation-overview-bg" x1="0%" x2="100%" y1="0%" y2="100%">
            <stop offset="0%" stopColor="var(--surface-raised)" />
            <stop offset="100%" stopColor="var(--surface-sunk)" />
          </linearGradient>
        </defs>
        <rect width="1400" height="900" fill="url(#citation-overview-bg)" />
        <ellipse cx="700" cy="430" fill="none" rx="190" ry="132" stroke="var(--rule-soft)" strokeDasharray="3 7" />
        <ellipse cx="700" cy="430" fill="none" rx="360" ry="246" stroke="var(--rule-hair)" strokeDasharray="2 10" />
        <ellipse cx="700" cy="430" fill="none" rx="515" ry="356" stroke="var(--rule-hair)" strokeDasharray="2 12" />
        {layout.edges.map((edge) => {
          const source = layout.positions.get(edge.sourceNodeId);
          const target = layout.positions.get(edge.targetNodeId);
          if (!source || !target) return null;
          return (
            <line
              key={edge.id}
              stroke={graphEdgeColor(edge)}
              strokeOpacity={edge.source === "pdf_text" ? 0.22 : 0.09}
              strokeWidth={edge.source === "pdf_text" ? 1.2 : 0.8}
              x1={source.x}
              x2={target.x}
              y1={source.y}
              y2={target.y}
            />
          );
        })}
        {layout.nodes.map((node) => {
          const point = layout.positions.get(node.id);
          if (!point) return null;
          const fill = graphNodeFill(node);
          const selected = selectedNodeId === node.id;
          return (
            <g
              aria-label={`Select ${graphNodeTitle(node)}`}
              className="cursor-pointer outline-none"
              key={node.id}
              onClick={() => onSelectNode?.(node.id)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                onSelectNode?.(node.id);
              }}
              role="button"
              tabIndex={0}
            >
              <title>{graphNodeTitle(node)}</title>
              {selected && (
                <circle
                  cx={point.x}
                  cy={point.y}
                  fill="var(--accent-faint)"
                  r={point.radius + 8}
                  stroke="var(--accent)"
                  strokeWidth={2}
                />
              )}
              <circle
                cx={point.x}
                cy={point.y}
                fill={fill}
                opacity={node.local ? 0.95 : 0.78}
                r={point.radius}
                stroke="var(--surface-raised)"
                strokeWidth={node.local ? 1.8 : 0.9}
              />
              {layout.labeledIds.has(node.id) && (
                <>
                  <text
                    fill="var(--text-strong)"
                    fontSize="12"
                    fontWeight="700"
                    textAnchor={point.x < 700 ? "end" : "start"}
                    x={point.x < 700 ? point.x - 10 : point.x + 10}
                    y={point.y - 6}
                  >
                    {truncateGraphLabel(node.title, node.id, 34)}
                  </text>
                  <text
                    fill="var(--text-dim)"
                    fontSize="10"
                    textAnchor={point.x < 700 ? "end" : "start"}
                    x={point.x < 700 ? point.x - 10 : point.x + 10}
                    y={point.y + 9}
                  >
                    {node.year ? `${node.year} • ` : ""}{layout.degreeByNodeId.get(node.id) ?? 0} links
                  </text>
                </>
              )}
            </g>
          );
        })}
      </svg>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-rule bg-sunk px-4 py-3 text-xs text-dim">
        <span className="inline-flex items-center gap-2"><span className="size-2.5 rounded-full" style={{ backgroundColor: "var(--citation-graph-node-local)" }} />Local PDFs</span>
        <span className="inline-flex items-center gap-2"><span className="size-2.5 rounded-full" style={{ backgroundColor: "var(--citation-graph-node-external)" }} />Referenced papers</span>
        <span className="inline-flex items-center gap-2"><span className="size-2.5 rounded-full" style={{ backgroundColor: "var(--citation-graph-node-bridge)" }} />Bridge suggestions</span>
        <span className="inline-flex items-center gap-2"><span className="h-0.5 w-7 rounded" style={{ backgroundColor: "var(--citation-graph-edge-pdf)" }} />PDF-derived citation edges</span>
      </div>
    </div>
  );
}

function CitationGraphMap({
  graphPage,
  onSelectNode,
  selectedNodeId,
}: {
  graphPage: PaperLibraryGraphResponse | null;
  onSelectNode?: (nodeId: string) => void;
  selectedNodeId?: string | null;
}) {
  const nodeCount = graphPage?.nodes.length ?? 0;
  if (nodeCount > GRAPH_OVERVIEW_THRESHOLD) {
    return (
      <CitationGraphOverviewMap
        graphPage={graphPage}
        onSelectNode={onSelectNode}
        selectedNodeId={selectedNodeId}
      />
    );
  }
  return (
    <CitationGraphDetailMap
      graphPage={graphPage}
      onSelectNode={onSelectNode}
      selectedNodeId={selectedNodeId}
    />
  );
}

export function PaperLibraryCommandCenter({
  projectSlug,
}: {
  projectSlug: string;
}) {
  const skipLatestRestoreRef = useRef(false);
  const templateSelectionDirtyRef = useRef(false);
  const graphActionMessageTimeoutRef = useRef<number | null>(null);
  const graphMoreRef = useRef<HTMLDivElement>(null);
  const folderPickerRequestSeqRef = useRef(0);
  const manualRootPathDirtyRef = useRef(false);
  const [session, setSession] = useState<PaperLibrarySession>(() => defaultSession());
  const [restoredProjectSlug, setRestoredProjectSlug] = useState<string | null>(null);
  const sessionRestored = restoredProjectSlug === projectSlug;
  const sessionRef = useRef(session);
  const [scan, setScan] = useState<PaperLibraryScan | null>(null);
  const scanRef = useRef<PaperLibraryScan | null>(scan);
  const [scanLoading, setScanLoading] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [folderPickerLoading, setFolderPickerLoading] = useState(false);
  const [manualRootPath, setManualRootPath] = useState("");
  const [manualScanLoading, setManualScanLoading] = useState(false);
  const [corpusStatus, setCorpusStatus] = useState<PaperCorpusImportStatus | null>(null);
  const [corpusStatusLoading, setCorpusStatusLoading] = useState(false);
  const [corpusStatusError, setCorpusStatusError] = useState<string | null>(null);

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
  const [applyActionLoading, setApplyActionLoading] = useState(false);

  const [manifestLoading, setManifestLoading] = useState(false);
  const [manifestLoadingMore, setManifestLoadingMore] = useState(false);
  const [manifestError, setManifestError] = useState<string | null>(null);
  const [manifestPage, setManifestPage] = useState<ManifestPage | null>(null);
  const [repairingManifest, setRepairingManifest] = useState(false);
  const [undoing, setUndoing] = useState(false);

  const [graphLoading, setGraphLoading] = useState(false);
  const [graphError, setGraphError] = useState<string | null>(null);
  const [graphOverview, setGraphOverview] = useState<PaperLibraryGraphResponse | null>(null);
  const [graphOverviewLoading, setGraphOverviewLoading] = useState(false);
  const [graphPage, setGraphPage] = useState<PaperLibraryGraphResponse | null>(null);
  const [graphLoadingMore, setGraphLoadingMore] = useState(false);
  const [graphPerspective, setGraphPerspective] = useState<GraphPerspective>("all");
  const [graphNodeFilter, setGraphNodeFilter] = useState<GraphNodeFilter>("all");
  const [graphQuery, setGraphQuery] = useState("");
  const [graphListView, setGraphListView] = useState(false);
  const [selectedGraphNodeId, setSelectedGraphNodeId] = useState<string | null>(null);
  const [graphMoreOpen, setGraphMoreOpen] = useState(false);
  const [graphActionMessage, setGraphActionMessage] = useState<string | null>(null);

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
    setGraphOverview(null);
    setGraphPage(null);
    setGraphError(null);
    setGraphPerspective("all");
    setGraphNodeFilter("all");
    setGraphQuery("");
    setGraphListView(false);
    setSelectedGraphNodeId(null);
    setGraphMoreOpen(false);
    setGraphActionMessage(null);
    setClustersPage(null);
    setClustersError(null);
    setGapPage(null);
    setGapsError(null);
    setGapFilter("all");
    setApprovalToken(null);
    setApplyActionLoading(false);
    setReviewFilter(DEFAULT_REVIEW_FILTER);
    setDraftsByItemId({});
    setCorpusStatus(null);
    setCorpusStatusError(null);
    setCorpusStatusLoading(false);
  }, []);

  useEffect(() => {
    return () => {
      if (graphActionMessageTimeoutRef.current !== null) {
        window.clearTimeout(graphActionMessageTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!graphMoreOpen) return;

    function handlePointerDown(event: MouseEvent) {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (graphMoreRef.current?.contains(target)) return;
      setGraphMoreOpen(false);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setGraphMoreOpen(false);
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [graphMoreOpen]);

  useEffect(() => {
    skipLatestRestoreRef.current = false;
    templateSelectionDirtyRef.current = false;
    manualRootPathDirtyRef.current = false;
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
    if (!sessionRestored) return;
    if (manualRootPathDirtyRef.current) return;
    setManualRootPath(session.rootPath);
  }, [session.rootPath, sessionRestored]);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  useEffect(() => {
    scanRef.current = scan;
  }, [scan]);

  const loadScan = useCallback(async (scanId: string) => {
    setScanLoading(true);
    setScanError(null);
    try {
      const payload = await paperLibraryFetchJson<{ ok: true; scan: PaperLibraryScan }>(
        `/api/brain/paper-library/scan?study=${encodeURIComponent(projectSlug)}&id=${encodeURIComponent(scanId)}`,
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
        `/api/brain/paper-library/scan?study=${encodeURIComponent(projectSlug)}&latest=1`,
      );
      const restoredScan = payload?.scan;
      if (!restoredScan) {
        return;
      }
      const currentSession = sessionRef.current;
      const currentScan = scanRef.current;
      if (
        skipLatestRestoreRef.current
        || !shouldPromoteLatestScan({
          currentScan,
          currentSession,
          latestScan: restoredScan,
        })
      ) {
        return;
      }
      setSession((current) => skipLatestRestoreRef.current
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

  const loadCorpusStatus = useCallback(async (scanId: string) => {
    setCorpusStatusLoading(true);
    setCorpusStatusError(null);
    try {
      const params = new URLSearchParams({
        study: projectSlug,
        scanId,
      });
      const payload = await paperLibraryFetchJson<{ ok: true; status: PaperCorpusImportStatus }>(
        `/api/brain/paper-library/corpus-status?${params.toString()}`,
      );
      setCorpusStatus(payload.status);
    } catch (error) {
      setCorpusStatusError(error instanceof Error ? error.message : "Could not load corpus status.");
    } finally {
      setCorpusStatusLoading(false);
    }
  }, [projectSlug]);

  const loadReview = useCallback(async ({ cursor, append = false }: { cursor?: string; append?: boolean } = {}) => {
    if (!session.scanId) return;
    if (append) setReviewLoadingMore(true);
    else setReviewLoading(true);
    setReviewError(null);
    try {
      const params = new URLSearchParams({
        study: projectSlug,
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
        study: projectSlug,
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
        study: projectSlug,
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
        study: projectSlug,
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

  const loadGraphOverview = useCallback(async ({ refresh = false }: {
    refresh?: boolean;
  } = {}) => {
    const scanId = session.scanId;
    if (!scanId) return;
    setGraphOverviewLoading(true);
    setGraphError(null);
    try {
      const params = new URLSearchParams({
        study: projectSlug,
        scanId,
        all: "1",
      });
      if (refresh) params.set("refresh", "1");
      const payload = await paperLibraryFetchJson<
        { ok: true } & PaperLibraryGraphResponse
      >(`/api/brain/paper-library/graph?${params.toString()}`);
      if (sessionRef.current.scanId === scanId) {
        setGraphOverview(payload);
      }
    } catch (error) {
      if (sessionRef.current.scanId === scanId) {
        setGraphError(error instanceof Error ? error.message : "Could not load the full citation graph.");
      }
    } finally {
      if (sessionRef.current.scanId === scanId) {
        setGraphOverviewLoading(false);
      }
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
        study: projectSlug,
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
        study: projectSlug,
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

  const currentScanCreatedAt = scan?.createdAt;
  const currentScanId = scan?.id;
  const currentScanInFlight = scan ? isScanInFlight(scan) : false;
  const currentScanStatus = scan?.status;
  const currentScanUpdatedAt = scan?.updatedAt;

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
    if (skipLatestRestoreRef.current) return;
    if (session.scanId) {
      if (session.step !== "scan") return;
      if (!currentScanId || currentScanInFlight) return;
    }
    void loadLatestScan();
  }, [
    currentScanCreatedAt,
    currentScanId,
    currentScanInFlight,
    currentScanUpdatedAt,
    loadLatestScan,
    session.scanId,
    session.step,
    sessionRestored,
  ]);

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
    if (!session.scanId) {
      setCorpusStatus(null);
      setCorpusStatusError(null);
      setCorpusStatusLoading(false);
      return;
    }
    void loadCorpusStatus(session.scanId);
  }, [currentScanStatus, loadCorpusStatus, session.scanId, sessionRestored]);

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
    void loadGraphOverview();
    void loadGraph();
    void loadClusters();
  }, [loadClusters, loadGraph, loadGraphOverview, session.scanId, session.step, sessionRestored]);

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
            study: projectSlug,
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
    const requestSeq = folderPickerRequestSeqRef.current + 1;
    folderPickerRequestSeqRef.current = requestSeq;
    setFolderPickerLoading(true);
    setCommandError(null);
    setScanError(null);
    try {
      const payload = await paperLibraryFetchJson<{ path?: string; cancelled?: boolean }>(
        "/api/local-folder-picker",
        { method: "POST" },
      );
      if (folderPickerRequestSeqRef.current !== requestSeq) return;
      if (payload.cancelled) return;
      const rootPath = payload.path?.trim();
      if (!rootPath) throw new Error("Folder picker returned no path.");
      skipLatestRestoreRef.current = true;
      manualRootPathDirtyRef.current = false;
      await startScanForRoot(rootPath);
    } catch (error) {
      if (folderPickerRequestSeqRef.current === requestSeq) {
        setCommandError(error instanceof Error ? error.message : "Could not choose a PDF folder.");
      }
    } finally {
      if (folderPickerRequestSeqRef.current === requestSeq) {
        setFolderPickerLoading(false);
      }
    }
  }, [startScanForRoot]);

  const handleManualRootPathSubmit = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const rootPath = manualRootPath.trim();
    if (!rootPath) {
      setCommandError("Enter a local PDF folder path to start a dry-run scan.");
      return;
    }

    setManualScanLoading(true);
    folderPickerRequestSeqRef.current += 1;
    manualRootPathDirtyRef.current = false;
    setFolderPickerLoading(false);
    skipLatestRestoreRef.current = true;
    try {
      await startScanForRoot(rootPath);
    } finally {
      setManualScanLoading(false);
    }
  }, [manualRootPath, startScanForRoot]);

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
            study: projectSlug,
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
            study: projectSlug,
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
      await loadCorpusStatus(session.scanId);
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : "Could not update the review item.");
    } finally {
      setReviewActionItemId(null);
    }
  }, [
    draftsByItemId,
    loadReview,
    loadScan,
    loadCorpusStatus,
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
            study: projectSlug,
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

  const requestApprovalToken = useCallback(async (applyPlanId: string) => {
    setCommandError(null);
    const payload = await paperLibraryFetchJson<{ ok: true; approvalToken: string; expiresAt: string }>(
      "/api/brain/paper-library/apply-plan/approve",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          study: projectSlug,
          applyPlanId,
          userConfirmation: true,
        }),
      },
    );
    setApprovalToken({ token: payload.approvalToken, expiresAt: payload.expiresAt });
    await loadApplyPlan({ applyPlanId });
    if (Date.parse(payload.expiresAt) <= Date.now()) {
      setApprovalToken(null);
      throw new Error(`Approval expired at ${new Date(payload.expiresAt).toLocaleString()}. Applying will refresh approval first.`);
    }
    return payload.approvalToken;
  }, [loadApplyPlan, projectSlug]);

  const handleApproveAndApplyPlan = useCallback(async () => {
    const planMatchesSelectedTemplate = applyPlanPage?.plan.templateFormat === session.templateFormat;
    if (!session.applyPlanId || !planMatchesSelectedTemplate || applyActionLoading) return;
    setApplyActionLoading(true);
    setCommandError(null);
    try {
      const freshToken = approvalToken && Date.parse(approvalToken.expiresAt) > Date.now()
        ? approvalToken.token
        : await requestApprovalToken(session.applyPlanId);
      const payload = await paperLibraryFetchJson<{ ok: true; manifestId: string }>(
        "/api/brain/paper-library/apply",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            study: projectSlug,
            applyPlanId: session.applyPlanId,
            approvalToken: freshToken,
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
      setCommandError(error instanceof Error ? error.message : "Could not apply the plan.");
    } finally {
      setApplyActionLoading(false);
    }
  }, [
    applyPlanPage?.plan.templateFormat,
    applyActionLoading,
    approvalToken,
    loadManifest,
    loadApplyPlan,
    loadScan,
    patchSession,
    projectSlug,
    requestApprovalToken,
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
            study: projectSlug,
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
            study: projectSlug,
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
            study: projectSlug,
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
  const graphData = graphOverview ?? graphPage;
  const graphDisplayData = useMemo<PaperLibraryGraphResponse | null>(() => {
    if (!graphData) return null;
    const nodes = graphData.nodes.filter((node) => (
      graphNodeMatchesFilter(node, graphNodeFilter)
      && graphNodeMatchesQuery(node, graphQuery)
    ));
    const nodeIds = new Set(nodes.map((node) => node.id));
    const edges = graphData.edges
      .filter((edge) => graphEdgeMatchesPerspective(edge, graphPerspective))
      .filter((edge) => nodeIds.has(edge.sourceNodeId) && nodeIds.has(edge.targetNodeId));
    return {
      ...graphData,
      nodes,
      edges,
      loadedNodeCount: nodes.length,
      filteredCount: nodes.length,
      totalEdgeCount: edges.length,
    };
  }, [graphData, graphNodeFilter, graphPerspective, graphQuery]);
  const graphInsights = useMemo(
    () =>
      computeGraphInsights({
        nodes: graphDisplayData?.nodes ?? [],
        edges: graphDisplayData?.edges ?? [],
        selectedNodeId: selectedGraphNodeId,
      }),
    [graphDisplayData, selectedGraphNodeId],
  );
  const graphCount = graphData?.filteredCount ?? graphData?.totalCount ?? 0;
  const historyCount = activeManifest?.appliedCount ?? 0;
  const totalGraphEdgeCount = graphData?.totalEdgeCount ?? graphData?.edges.length ?? 0;
  const displayedGraphEdgeCount = graphDisplayData?.totalEdgeCount ?? graphDisplayData?.edges.length ?? 0;
  const graphSourceRunCount = graphData?.sourceRuns.length ?? 0;
  const graphSuccessfulRuns = graphData?.sourceRuns.filter((run) => run.status === "success").length ?? 0;
  const graphNoIdentifierRuns = graphData?.sourceRuns.filter((run) => (
    run.status === "negative" && run.message?.toLowerCase().includes("no supported identifier")
  )).length ?? 0;
  const graphPdfTextRuns = graphData?.sourceRuns.filter((run) => run.source === "pdf_text").length ?? 0;
  const graphPdfTextSuccessfulRuns = graphData?.sourceRuns.filter((run) => (
    run.source === "pdf_text" && run.status === "success"
  )).length ?? 0;
  const graphPdfTextReferenceCount = graphData?.sourceRuns
    .filter((run) => run.source === "pdf_text")
    .reduce((total, run) => total + run.fetchedCount, 0) ?? 0;
  const graphHasPdfTextEdges = graphData?.edges.some((edge) => edge.source === "pdf_text") ?? false;
  const graphWarnings = useMemo(() => (
    graphData ? summarizeGraphWarnings(graphData.warnings) : []
  ), [graphData]);
  const setTimedGraphActionMessage = useCallback((message: string) => {
    if (graphActionMessageTimeoutRef.current !== null) {
      window.clearTimeout(graphActionMessageTimeoutRef.current);
    }
    setGraphActionMessage(message);
    graphActionMessageTimeoutRef.current = window.setTimeout(() => {
      setGraphActionMessage(null);
      graphActionMessageTimeoutRef.current = null;
    }, 4_000);
  }, []);
  const handleCopyGraphLink = useCallback(async (node?: GraphMapNode | null) => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    url.searchParams.set("view", "paper-library");
    url.hash = node ? `citation-graph:${encodeURIComponent(node.id)}` : "citation-graph";
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("Clipboard unavailable");
      }
      await navigator.clipboard.writeText(url.toString());
      setTimedGraphActionMessage(node ? "Copied selected paper link." : "Copied graph link.");
    } catch {
      setTimedGraphActionMessage(node ? "Selected paper link is ready in the address bar." : "Graph link is ready in the address bar.");
      window.history.replaceState(null, "", url.toString());
    }
  }, [setTimedGraphActionMessage]);
  const handleResetGraphView = useCallback(() => {
    setGraphPerspective("all");
    setGraphNodeFilter("all");
    setGraphQuery("");
    setGraphListView(false);
    setSelectedGraphNodeId(null);
    setGraphMoreOpen(false);
    setTimedGraphActionMessage("Graph filters reset.");
  }, [setTimedGraphActionMessage]);
  const handleSelectMostConnectedGraphNode = useCallback(() => {
    const node = [...graphInsights.sortedNodes].sort((left, right) => {
      const degreeDelta = (graphInsights.degreeByNodeId.get(right.id) ?? 0) - (graphInsights.degreeByNodeId.get(left.id) ?? 0);
      if (degreeDelta !== 0) return degreeDelta;
      if (left.local !== right.local) return left.local ? -1 : 1;
      return graphNodeTitle(left).localeCompare(graphNodeTitle(right));
    })[0];
    if (!node) return;
    setSelectedGraphNodeId(node.id);
    setGraphMoreOpen(false);
    setTimedGraphActionMessage("Selected the most connected paper.");
  }, [graphInsights.degreeByNodeId, graphInsights.sortedNodes, setTimedGraphActionMessage]);
  const approvalTokenExpired = approvalToken
    ? Date.parse(approvalToken.expiresAt) <= Date.now()
    : false;
  const persistedApprovalExpiresAt = activePlan?.approvalExpiresAt ?? null;
  const persistedApprovalExpired = persistedApprovalExpiresAt
    ? Date.parse(persistedApprovalExpiresAt) <= Date.now()
    : false;
  const canApplyPlan = Boolean(
    activePlan
    && activePlanMatchesTemplate
    && activePlan.conflictCount === 0
    && !activePlan.manifestId
    && (activePlan.status === "validated" || activePlan.status === "approved")
  );
  const applyButtonLabel = applyActionLoading
    ? "Applying..."
    : activePlan
      ? `Apply ${activePlan.operationCount} ${activePlan.operationCount === 1 ? "change" : "changes"}`
      : "Apply changes";
  const approvalStatusMessage = approvalToken
    ? (
        approvalTokenExpired
          ? `Approval expired at ${new Date(approvalToken.expiresAt).toLocaleString()}. Applying will refresh approval first.`
          : `Plan approved until ${new Date(approvalToken.expiresAt).toLocaleString()}.`
      )
    : activePlan?.status === "approved"
      ? (
          persistedApprovalExpiresAt
            ? persistedApprovalExpired
              ? `Approval expired at ${new Date(persistedApprovalExpiresAt).toLocaleString()}. Applying will refresh approval first.`
              : `Plan approved until ${new Date(persistedApprovalExpiresAt).toLocaleString()}. Applying will refresh the browser token first.`
            : "Plan is already approved. Applying will refresh the browser token first."
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

              <div className={`rounded-xl border p-4 ${
                canApplyPlan && !applyPlanTemplateStale
                  ? "border-accent/40 bg-accent-faint"
                  : "border-border bg-surface"
              }`}>
                <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-foreground">
                      {activePlan.manifestId
                        ? "Plan applied"
                        : canApplyPlan
                          ? "Ready to write this library"
                          : "Plan needs attention"}
                    </p>
                    <p className="mt-1 max-w-2xl text-xs leading-5 text-muted">
                      {activePlan.manifestId
                        ? "The manifest records every file move and gbrain paper record written from this plan."
                        : canApplyPlan
                          ? "Applies this exact preview: renames PDFs, writes gbrain paper records, and opens the undoable manifest."
                          : applyPlanTemplateStale
                            ? "Regenerate the preview for the selected format before applying changes."
                            : activePlan.conflictCount > 0
                              ? "Resolve review items or path conflicts before applying changes."
                              : "Create a validated preview before applying changes."}
                    </p>
                  </div>
                  {activePlan.manifestId ? (
                    <button
                      type="button"
                      onClick={() => patchSession({ step: "history" })}
                      className="inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-lg border border-border bg-white px-3 text-xs font-semibold text-foreground transition-colors hover:border-accent hover:text-accent"
                    >
                      <ClockCounterClockwise size={15} />
                      Open history
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void handleApproveAndApplyPlan()}
                      disabled={!canApplyPlan || applyActionLoading || applyPlanTemplateStale}
                      className="inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-lg bg-accent px-4 text-sm font-semibold text-white transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {applyActionLoading ? <SpinnerGap className="animate-spin" size={16} /> : <CheckCircle size={16} />}
                      {applyButtonLabel}
                    </button>
                  )}
                </div>

                {approvalStatusMessage && !activePlan.manifestId && (
                  <div
                    className={`mt-3 rounded-lg border px-3 py-2 text-sm ${approvalStatusTone}`}
                  >
                    {approvalStatusMessage}
                  </div>
                )}
              </div>

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
      const selectedNode = graphInsights.selectedNode;
      const selectedNodeAbstract = selectedNode ? graphNodeAbstract(selectedNode) : null;

      return (
        <div className="bg-ink px-4 py-4 text-body">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-rule pb-4">
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-dim">Graph</p>
              <h3 className="mt-1 text-xl font-semibold text-strong">Citation graph overview</h3>
              <p className="mt-1 max-w-3xl text-sm text-dim">
                A local map of scanned papers, cited work, derivative links, semantic clusters, and gap candidates.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => {
                  void loadGraphOverview({ refresh: true });
                  void loadGraph({ refresh: true });
                }}
                className="inline-flex items-center gap-2 rounded-[var(--radius-1)] border border-rule bg-raised px-3 py-2 text-xs font-semibold text-strong transition-colors hover:border-accent hover:text-accent"
              >
                <ArrowsClockwise size={14} />
                Refresh graph
              </button>
              <button
                type="button"
                onClick={() => void loadClusters({ refresh: true })}
                className="rounded-[var(--radius-1)] border border-rule bg-raised px-3 py-2 text-xs font-semibold text-strong transition-colors hover:border-accent hover:text-accent"
              >
                Refresh clusters
              </button>
              <button
                type="button"
                onClick={() => void loadGaps({ refresh: true })}
                className="rounded-[var(--radius-1)] border border-rule bg-raised px-3 py-2 text-xs font-semibold text-strong transition-colors hover:border-accent hover:text-accent"
              >
                Refresh gaps
              </button>
            </div>
          </div>

          {graphError && (
            <div role="alert" className="mt-4 rounded-[var(--radius-2)] border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
              {graphError}
            </div>
          )}

          {clustersError && (
            <div role="alert" className="mt-4 rounded-[var(--radius-2)] border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
              {clustersError}
            </div>
          )}

          {gapsError && (
            <div role="alert" className="mt-4 rounded-[var(--radius-2)] border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
              {gapsError}
            </div>
          )}

          {((graphLoading || graphOverviewLoading) && !graphData) ? (
            <div className="flex items-center gap-2 px-1 py-6 text-sm text-dim">
              <SpinnerGap className="animate-spin" size={16} />
              Loading graph...
            </div>
          ) : (
            <div className="space-y-4 py-4">
              <div className="grid gap-3 md:grid-cols-[minmax(16rem,0.9fr)_minmax(18rem,1.4fr)_minmax(16rem,0.95fr)]">
                <div className="rounded-[var(--radius-2)] border border-rule bg-raised p-3">
                  <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-dim">Window</p>
                  <p className="mt-1 text-2xl font-semibold tabular-nums text-strong">{graphDisplayData?.nodes.length ?? 0}</p>
                  <p className="text-xs text-dim">visible papers</p>
                </div>
                <div className="rounded-[var(--radius-2)] border border-rule bg-raised p-3">
                  <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-dim">Connections</p>
                  <p className="mt-1 text-2xl font-semibold tabular-nums text-strong">{displayedGraphEdgeCount}</p>
                  <p className="text-xs text-dim">{totalGraphEdgeCount} total citation edges</p>
                </div>
                <div className="rounded-[var(--radius-2)] border border-rule bg-raised p-3">
                  <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-dim">Sources</p>
                  <p className="mt-1 text-2xl font-semibold tabular-nums text-strong">{graphSourceRunCount}</p>
                  <p className="text-xs text-dim">{graphSuccessfulRuns} with relations</p>
                </div>
              </div>

              <div className="rounded-[var(--radius-2)] border border-rule bg-raised p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="relative min-w-64 flex-1">
                    <MagnifyingGlass className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-dim" size={15} />
                    <input
                      aria-label="Search graph papers"
                      className="h-9 w-full rounded-[var(--radius-1)] border border-rule bg-sunk pl-9 pr-3 text-sm text-strong outline-none transition-colors placeholder:text-quiet focus:border-accent focus:ring-2 focus:ring-accent/20"
                      onChange={(event) => setGraphQuery(event.target.value)}
                      placeholder="Search papers, authors, identifiers"
                      type="search"
                      value={graphQuery}
                    />
                  </div>
                  {([
                    ["all", "All links"],
                    ["prior", "Prior works"],
                    ["derivative", "Derivative works"],
                  ] as const).map(([value, label]) => (
                    <button
                      aria-pressed={graphPerspective === value}
                      className={`rounded-[var(--radius-1)] border px-3 py-2 text-xs font-semibold transition-colors ${
                        graphPerspective === value
                          ? "border-accent bg-accent-faint text-strong"
                          : "border-rule bg-sunk text-dim hover:text-strong"
                      }`}
                      key={value}
                      onClick={() => setGraphPerspective(value)}
                      type="button"
                    >
                      {label}
                    </button>
                  ))}
                  <button
                    aria-pressed={graphListView}
                    className={`inline-flex items-center gap-2 rounded-[var(--radius-1)] border px-3 py-2 text-xs font-semibold transition-colors ${
                      graphListView
                        ? "border-accent bg-accent-faint text-strong"
                        : "border-rule bg-sunk text-dim hover:text-strong"
                    }`}
                    onClick={() => setGraphListView((current) => !current)}
                    type="button"
                  >
                    <ListBullets size={14} />
                    List view
                  </button>
                  <div className="inline-flex items-center gap-2 rounded-[var(--radius-1)] border border-rule bg-sunk px-2 py-1.5">
                    <FunnelSimple size={14} className="text-dim" />
                    {([
                      ["all", "All"],
                      ["local", "Local"],
                      ["external", "References"],
                      ["bridge", "Bridge"],
                    ] as const).map(([value, label]) => (
                      <button
                        aria-pressed={graphNodeFilter === value}
                        className={`rounded-[var(--radius-1)] px-2 py-1 text-[11px] font-semibold transition-colors ${
                          graphNodeFilter === value ? "bg-raised text-strong" : "text-dim hover:text-strong"
                        }`}
                        key={value}
                        onClick={() => setGraphNodeFilter(value)}
                        type="button"
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <div className="relative" ref={graphMoreRef}>
                    <button
                      aria-expanded={graphMoreOpen}
                      aria-label="More graph actions"
                      className="inline-grid h-9 w-9 place-items-center rounded-[var(--radius-1)] border border-rule bg-sunk text-dim transition-colors hover:text-strong"
                      onClick={() => setGraphMoreOpen((current) => !current)}
                      title="More graph actions"
                      type="button"
                    >
                      <DotsThree size={18} weight="bold" />
                    </button>
                    {graphMoreOpen && (
                      <div className="absolute right-0 top-10 z-20 w-56 overflow-hidden rounded-[var(--radius-2)] border border-rule bg-raised shadow-[var(--shadow-2)]">
                        <button
                          className="block w-full px-3 py-2 text-left text-xs font-semibold text-strong transition-colors hover:bg-sunk"
                          onClick={handleSelectMostConnectedGraphNode}
                          type="button"
                        >
                          Select most connected
                        </button>
                        <button
                          className="block w-full px-3 py-2 text-left text-xs font-semibold text-strong transition-colors hover:bg-sunk"
                          onClick={handleResetGraphView}
                          type="button"
                        >
                          Reset graph view
                        </button>
                        <button
                          className="block w-full px-3 py-2 text-left text-xs font-semibold text-strong transition-colors hover:bg-sunk"
                          onClick={() => void handleCopyGraphLink()}
                          type="button"
                        >
                          Copy graph link
                        </button>
                      </div>
                    )}
                  </div>
                </div>
                {graphActionMessage && (
                  <p className="mt-2 text-xs font-medium text-dim" role="status">
                    {graphActionMessage}
                  </p>
                )}
              </div>

              <div className="grid gap-4 xl:grid-cols-[18rem_minmax(0,1fr)_22rem]">
                <aside className="min-h-0 rounded-[var(--radius-2)] border border-rule bg-raised">
                  <div className="border-b border-rule px-4 py-3">
                    <p className="text-sm font-semibold text-strong">Papers in this graph window</p>
                    <p className="mt-1 text-xs text-dim">
                      {graphData
                        ? `${graphData.loadedNodeCount ?? graphData.nodes.length} of ${graphData.filteredCount} papers loaded`
                        : "No graph loaded"}
                    </p>
                  </div>
                  <div className="max-h-[42rem] divide-y divide-rule overflow-y-auto">
                    {graphInsights.sortedNodes.map((node) => {
                      const selected = selectedNode?.id === node.id;
                      return (
                        <button
                          className={`block w-full px-4 py-3 text-left transition-colors ${
                            selected
                              ? "bg-accent-faint"
                              : "hover:bg-sunk"
                          }`}
                          key={node.id}
                          onClick={() => setSelectedGraphNodeId(node.id)}
                          type="button"
                        >
                          <span className="flex items-start gap-3">
                            <span
                              className="mt-1 size-2.5 shrink-0 rounded-full"
                              style={{ backgroundColor: graphNodeFill(node) }}
                            />
                            <span className="min-w-0">
                              <span className="block truncate text-sm font-semibold text-strong">{graphNodeTitle(node)}</span>
                              <span className="mt-1 block truncate text-xs text-dim">{graphNodeMeta(node)}</span>
                              <span className="mt-2 inline-flex items-center rounded-[var(--radius-1)] border border-rule bg-sunk px-2 py-0.5 font-mono text-[10px] text-quiet">
                                {graphInsights.degreeByNodeId.get(node.id) ?? 0} links
                              </span>
                            </span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  {graphPage?.nextCursor && (
                    <div className="border-t border-rule px-4 py-3">
                      <button
                        type="button"
                        onClick={() => void loadGraph({ cursor: graphPage.nextCursor, append: true })}
                        disabled={graphLoadingMore}
                        className="rounded-[var(--radius-1)] border border-rule bg-sunk px-3 py-2 text-xs font-semibold text-strong transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
                      >
                        {graphLoadingMore ? "Loading..." : "Load more nodes"}
                      </button>
                    </div>
                  )}
                </aside>

                <section className="min-w-0 space-y-4">
                  <div className="rounded-[var(--radius-2)] border border-rule bg-raised">
                    <div className="border-b border-rule px-4 py-3">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <p className="text-sm font-semibold text-strong">Citation graph overview</p>
                          <p className="mt-1 text-xs text-dim">
                            {graphData && (graphData.loadedNodeCount ?? graphData.nodes.length) >= graphData.filteredCount
                              ? "Showing every loaded paper node and citation edge, including references extracted from scanned PDFs."
                              : "Showing connected neighbors with each loaded node so citation edges stay visible in context."}
                          </p>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          <StatusBadge tone="neutral" value={`${graphDisplayData?.nodes.length ?? 0}_visible_nodes`} />
                          <StatusBadge tone={displayedGraphEdgeCount > 0 ? "success" : "warning"} value={`${displayedGraphEdgeCount}_citation_edges`} />
                        </div>
                      </div>
                    </div>
                    <div className="p-4">
                      {graphListView ? (
                        <div className="overflow-hidden rounded-[var(--radius-2)] border border-rule">
                          <div className="grid grid-cols-[minmax(0,1.3fr)_7rem_7rem_7rem] border-b border-rule bg-sunk px-3 py-2 text-[11px] font-bold uppercase tracking-[0.16em] text-dim">
                            <span>Paper</span>
                            <span>Kind</span>
                            <span>Prior</span>
                            <span>Derivative</span>
                          </div>
                          <div className="max-h-[32rem] divide-y divide-rule overflow-y-auto bg-raised">
                            {graphInsights.sortedNodes.map((node) => (
                              <button
                                className="grid w-full grid-cols-[minmax(0,1.3fr)_7rem_7rem_7rem] gap-3 px-3 py-3 text-left text-sm transition-colors hover:bg-sunk"
                                key={node.id}
                                onClick={() => setSelectedGraphNodeId(node.id)}
                                type="button"
                              >
                                <span className="min-w-0">
                                  <span className="block truncate font-semibold text-strong">{graphNodeTitle(node)}</span>
                                  <span className="block truncate text-xs text-dim">{graphNodeAuthors(node)}</span>
                                </span>
                                <span className="text-xs text-dim">{graphNodeKindLabel(node)}</span>
                                <span className="font-mono text-xs tabular-nums text-strong">{graphInsights.priorByNodeId.get(node.id) ?? 0}</span>
                                <span className="font-mono text-xs tabular-nums text-strong">{graphInsights.derivativeByNodeId.get(node.id) ?? 0}</span>
                              </button>
                            ))}
                          </div>
                        </div>
                      ) : (
                        <CitationGraphMap
                          graphPage={graphDisplayData}
                          onSelectNode={setSelectedGraphNodeId}
                          selectedNodeId={selectedNode?.id}
                        />
                      )}
                    </div>
                  </div>

                  {graphData && totalGraphEdgeCount === 0 && (
                    <div className="rounded-[var(--radius-2)] border border-warn/30 bg-warn/10 px-3 py-2 text-sm text-warn">
                      No citation edges yet. {graphPdfTextRuns > 0
                        ? `Local PDF reference extraction checked ${graphPdfTextRuns} papers and found ${graphPdfTextReferenceCount} references; review missing titles or identifiers if none match the library.`
                        : graphNoIdentifierRuns > 0
                          ? `${graphNoIdentifierRuns} papers need DOI, arXiv, PMID, or OpenAlex identifiers before external citation lookup can connect them.`
                          : "Refresh graph after identifier enrichment, or review missing metadata so external citation lookup has stable IDs."}
                    </div>
                  )}
                  {graphData && totalGraphEdgeCount > 0 && graphHasPdfTextEdges && (
                    <div className="rounded-[var(--radius-2)] border border-ok/30 bg-ok/10 px-3 py-2 text-sm text-ok">
                      Local PDF extraction found {graphPdfTextReferenceCount} references across {graphPdfTextSuccessfulRuns} papers and connected the citation map.
                    </div>
                  )}
                  {graphWarnings.length ? (
                    <div className="space-y-2">
                      {graphWarnings.map((warning) => (
                        <div key={warning} className="rounded-[var(--radius-2)] border border-warn/30 bg-warn/10 px-3 py-2 text-sm text-warn">
                          {warning}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </section>

                <aside className="space-y-4">
                  <div className="rounded-[var(--radius-2)] border border-rule bg-raised p-4">
                    {selectedNode ? (
                      <>
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-dim">Selected paper</p>
                            <h4 className="mt-2 text-base font-semibold leading-tight text-strong">{graphNodeTitle(selectedNode)}</h4>
                            <p className="mt-2 text-xs text-dim">{graphNodeAuthors(selectedNode)}</p>
                          </div>
                          <span
                            className="mt-1 size-3 shrink-0 rounded-full"
                            style={{ backgroundColor: graphNodeFill(selectedNode) }}
                          />
                        </div>
                        <dl className="mt-4 grid grid-cols-3 gap-2 text-xs">
                          <div className="rounded-[var(--radius-1)] border border-rule bg-sunk p-2">
                            <dt className="text-dim">Links</dt>
                            <dd className="mt-1 font-mono text-sm tabular-nums text-strong">{graphInsights.degreeByNodeId.get(selectedNode.id) ?? 0}</dd>
                          </div>
                          <div className="rounded-[var(--radius-1)] border border-rule bg-sunk p-2">
                            <dt className="text-dim">Refs</dt>
                            <dd className="mt-1 font-mono text-sm tabular-nums text-strong">{selectedNode.referenceCount ?? 0}</dd>
                          </div>
                          <div className="rounded-[var(--radius-1)] border border-rule bg-sunk p-2">
                            <dt className="text-dim">Cites</dt>
                            <dd className="mt-1 font-mono text-sm tabular-nums text-strong">{selectedNode.citationCount ?? 0}</dd>
                          </div>
                        </dl>
                        <div className="mt-4 rounded-[var(--radius-1)] border border-rule bg-sunk p-3">
                          <p className="text-xs text-dim">{graphNodeMeta(selectedNode)}</p>
                          <p className="mt-2 break-all font-mono text-[11px] text-quiet">{graphNodeIdentifier(selectedNode)}</p>
                        </div>
                        {selectedNodeAbstract && (
                          <div className="mt-4 border-t border-rule pt-4">
                            <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-dim">Abstract</p>
                            <p className="mt-2 max-h-64 overflow-y-auto pr-1 text-sm leading-6 text-strong">
                              {selectedNodeAbstract}
                            </p>
                          </div>
                        )}
                        {graphInsights.derivativeNeighbors.length > 0 && (() => {
                          const total = graphInsights.derivativeByNodeId.get(selectedNode.id) ?? 0;
                          const shown = graphInsights.derivativeNeighbors.length;
                          const truncated = total > shown;
                          return (
                            <div className="mt-4">
                              <p className="text-xs font-semibold text-strong">
                                Cited by{" "}
                                <span className="font-mono text-[10px] tabular-nums text-dim">
                                  {total}
                                  {truncated ? ` (showing ${shown})` : ""}
                                </span>
                              </p>
                              <p className="mt-1 text-[11px] text-quiet">Papers in the graph that cite this one (forward citations).</p>
                              <div className="mt-2 space-y-2">
                                {graphInsights.derivativeNeighbors.map((node) => (
                                  <button
                                    className="flex w-full items-center gap-2 rounded-[var(--radius-1)] border border-rule bg-sunk px-2 py-2 text-left text-xs text-dim transition-colors hover:text-strong"
                                    key={node.id}
                                    onClick={() => setSelectedGraphNodeId(node.id)}
                                    type="button"
                                  >
                                    <span className="size-2 rounded-full" style={{ backgroundColor: graphNodeFill(node) }} />
                                    <span className="min-w-0 truncate">{graphNodeTitle(node)}</span>
                                  </button>
                                ))}
                              </div>
                            </div>
                          );
                        })()}
                        {graphInsights.priorNeighbors.length > 0 && (() => {
                          const total = graphInsights.priorByNodeId.get(selectedNode.id) ?? 0;
                          const shown = graphInsights.priorNeighbors.length;
                          const truncated = total > shown;
                          return (
                            <div className="mt-4">
                              <p className="text-xs font-semibold text-strong">
                                References{" "}
                                <span className="font-mono text-[10px] tabular-nums text-dim">
                                  {total}
                                  {truncated ? ` (showing ${shown})` : ""}
                                </span>
                              </p>
                              <p className="mt-1 text-[11px] text-quiet">Papers this one cites (backward references).</p>
                              <div className="mt-2 space-y-2">
                                {graphInsights.priorNeighbors.map((node) => (
                                  <button
                                    className="flex w-full items-center gap-2 rounded-[var(--radius-1)] border border-rule bg-sunk px-2 py-2 text-left text-xs text-dim transition-colors hover:text-strong"
                                    key={node.id}
                                    onClick={() => setSelectedGraphNodeId(node.id)}
                                    type="button"
                                  >
                                    <span className="size-2 rounded-full" style={{ backgroundColor: graphNodeFill(node) }} />
                                    <span className="min-w-0 truncate">{graphNodeTitle(node)}</span>
                                  </button>
                                ))}
                              </div>
                            </div>
                          );
                        })()}
                        {graphInsights.priorNeighbors.length === 0 && graphInsights.derivativeNeighbors.length === 0 && graphInsights.neighborNodes.length > 0 && (
                          <div className="mt-4">
                            <p className="text-xs font-semibold text-strong">Related papers</p>
                            <div className="mt-2 space-y-2">
                              {graphInsights.neighborNodes.map((node) => (
                                <button
                                  className="flex w-full items-center gap-2 rounded-[var(--radius-1)] border border-rule bg-sunk px-2 py-2 text-left text-xs text-dim transition-colors hover:text-strong"
                                  key={node.id}
                                  onClick={() => setSelectedGraphNodeId(node.id)}
                                  type="button"
                                >
                                  <span className="size-2 rounded-full" style={{ backgroundColor: graphNodeFill(node) }} />
                                  <span className="min-w-0 truncate">{graphNodeTitle(node)}</span>
                                </button>
                              ))}
                            </div>
                          </div>
                        )}
                        <div className="mt-4 flex flex-wrap gap-2">
                          <button
                            className="inline-flex items-center gap-2 rounded-[var(--radius-1)] border border-rule bg-sunk px-3 py-2 text-xs font-semibold text-strong transition-colors hover:border-accent hover:text-accent"
                            onClick={() => setGraphQuery(graphNodeTitle(selectedNode))}
                            type="button"
                          >
                            <MagnifyingGlass size={13} />
                            Isolate
                          </button>
                          <button
                            className="inline-flex items-center gap-2 rounded-[var(--radius-1)] border border-rule bg-sunk px-3 py-2 text-xs font-semibold text-strong transition-colors hover:border-accent hover:text-accent"
                            onClick={() => void handleCopyGraphLink(selectedNode)}
                            type="button"
                          >
                            <ShareNetwork size={13} />
                            Share
                          </button>
                        </div>
                      </>
                    ) : (
                      <p className="text-sm text-dim">Select a graph node to inspect paper metadata and local citation context.</p>
                    )}
                  </div>

                  <div className="rounded-[var(--radius-2)] border border-rule bg-raised p-4">
                    <p className="text-sm font-semibold text-strong">Semantic clusters</p>
                  {clustersLoading && !clustersPage ? (
                    <div className="mt-3 flex items-center gap-2 text-sm text-dim">
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
                        <span className="text-sm text-dim">
                          {clustersPage.clusters.length} clusters • {clustersPage.unclusteredCount} unclustered papers
                        </span>
                      </div>
                      {clustersPage.warnings.length ? (
                        <div className="mt-3 space-y-2">
                          {clustersPage.warnings.map((warning) => (
                            <div key={warning} className="rounded-[var(--radius-1)] border border-warn/30 bg-warn/10 px-3 py-2 text-sm text-warn">
                              {warning}
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </>
                  ) : (
                    <p className="mt-3 text-sm text-dim">
                      Semantic organization appears here after a completed scan.
                    </p>
                  )}
                </div>

                {clustersPage?.clusters.map((cluster) => (
                  <div key={cluster.id} className="rounded-[var(--radius-2)] border border-rule bg-raised p-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-strong">{cluster.label}</p>
                        <p className="mt-1 text-xs text-dim">
                          folder token {cluster.folderName} • confidence {Math.round(cluster.confidence * 100)}%
                        </p>
                      </div>
                      <span className="text-xs text-dim">{cluster.memberCount} papers</span>
                    </div>
                    {cluster.keywords.length > 0 && (
                      <div className="mt-3 flex flex-wrap gap-2">
                        {cluster.keywords.map((keyword) => (
                          <span key={keyword} className="rounded-full border border-rule bg-sunk px-2 py-1 text-[11px] font-semibold text-dim">
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
                    className="rounded-[var(--radius-1)] border border-rule bg-raised px-3 py-2 text-xs font-semibold text-strong transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
                  >
                    {clustersLoadingMore ? "Loading..." : "Load more clusters"}
                  </button>
                )}

                <div className="rounded-[var(--radius-2)] border border-rule bg-raised p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-strong">Gap suggestions</p>
                      <p className="mt-1 text-xs text-dim">
                        Missing seminal papers ranked from your local citation graph, cluster coverage, and recency cues.
                      </p>
                    </div>
                    {gapPage && (
                      <span className="text-xs text-dim">
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
                            ? "border-accent bg-accent-faint text-strong"
                            : "border-rule bg-sunk text-dim hover:text-strong"
                        }`}
                      >
                        {value.replaceAll("_", " ")} {count}
                      </button>
                    ))}
                  </div>

                  {gapsLoading && !gapPage ? (
                    <div className="mt-4 flex items-center gap-2 text-sm text-dim">
                      <SpinnerGap className="animate-spin" size={16} />
                      Loading gap suggestions...
                    </div>
                  ) : gapPage ? (
                    <>
                      {gapPage.warnings.length > 0 && (
                        <div className="mt-4 space-y-2">
                          {gapPage.warnings.map((warning) => (
                            <div key={warning} className="rounded-[var(--radius-1)] border border-warn/30 bg-warn/10 px-3 py-2 text-sm text-warn">
                              {warning}
                            </div>
                          ))}
                        </div>
                      )}

                      {gapPage.suggestions.length > 0 ? (
                        <div className="mt-4 space-y-3">
                          {gapPage.suggestions.map((suggestion) => (
                            <div key={suggestion.id} className="rounded-[var(--radius-2)] border border-rule bg-sunk p-4">
                              <div className="flex flex-wrap items-start justify-between gap-3">
                                <div>
                                  <p className="text-sm font-semibold text-strong">
                                    {suggestion.title}
                                    {suggestion.year ? ` (${suggestion.year})` : ""}
                                  </p>
                                  <p className="mt-1 text-xs text-dim">
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
                                  <span key={reason} className="rounded-full border border-rule bg-raised px-2 py-1 text-[11px] font-semibold text-dim">
                                    {reason.replaceAll("_", " ")}
                                  </span>
                                ))}
                              </div>

                              <p className="mt-3 text-xs text-dim">
                                Evidence papers: {suggestion.evidencePaperIds.join(", ") || "none"}
                              </p>

                              <div className="mt-3 flex flex-wrap gap-2">
                                {suggestion.state !== "watching" && (
                                  <button
                                    type="button"
                                    onClick={() => void handleGapAction(suggestion.id, "watch")}
                                    disabled={gapActionSuggestionId === suggestion.id}
                                    className="rounded-[var(--radius-1)] border border-rule bg-raised px-3 py-2 text-xs font-semibold text-strong transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
                                  >
                                    Watch
                                  </button>
                                )}
                                {suggestion.state !== "ignored" && (
                                  <button
                                    type="button"
                                    onClick={() => void handleGapAction(suggestion.id, "ignore")}
                                    disabled={gapActionSuggestionId === suggestion.id}
                                    className="rounded-[var(--radius-1)] border border-rule bg-raised px-3 py-2 text-xs font-semibold text-strong transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
                                  >
                                    Ignore
                                  </button>
                                )}
                                {suggestion.state !== "saved" && (
                                  <button
                                    type="button"
                                    onClick={() => void handleGapAction(suggestion.id, "save")}
                                    disabled={gapActionSuggestionId === suggestion.id}
                                    className="rounded-[var(--radius-1)] border border-rule bg-raised px-3 py-2 text-xs font-semibold text-strong transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
                                  >
                                    Save
                                  </button>
                                )}
                                {suggestion.state !== "imported" && (
                                  <button
                                    type="button"
                                    onClick={() => void handleGapAction(suggestion.id, "import")}
                                    disabled={gapActionSuggestionId === suggestion.id}
                                    className="rounded-[var(--radius-1)] bg-accent px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
                                  >
                                    Mark imported
                                  </button>
                                )}
                                {suggestion.state !== "open" && (
                                  <button
                                    type="button"
                                    onClick={() => void handleGapAction(suggestion.id, "reopen")}
                                    disabled={gapActionSuggestionId === suggestion.id}
                                    className="rounded-[var(--radius-1)] border border-rule bg-raised px-3 py-2 text-xs font-semibold text-strong transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
                                  >
                                    Reopen
                                  </button>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="mt-4 text-sm text-dim">
                          No gap suggestions match this filter yet.
                        </p>
                      )}

                      {gapPage.nextCursor && (
                        <button
                          type="button"
                          onClick={() => void loadGaps({ cursor: gapPage.nextCursor, append: true })}
                          disabled={gapsLoadingMore}
                          className="mt-4 rounded-[var(--radius-1)] border border-rule bg-raised px-3 py-2 text-xs font-semibold text-strong transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
                        >
                          {gapsLoadingMore ? "Loading..." : "Load more suggestions"}
                        </button>
                      )}
                    </>
                  ) : (
                    <p className="mt-4 text-sm text-dim">
                      Gap suggestions appear here after graph enrichment and clustering finish.
                    </p>
                  )}
                </div>
                </aside>
              </div>
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
                onClick={() => patchSession({ step: "graph" })}
                disabled={!session.scanId}
                className="inline-flex items-center gap-2 rounded-lg border border-border bg-white px-3 py-2 text-xs font-semibold text-foreground transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
              >
                <Graph size={14} />
                Open graph
              </button>
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
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <div className="rounded-lg border border-border bg-surface px-3 py-3">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">Filesystem</p>
                  <p className="mt-1 text-sm font-semibold text-foreground">
                    {activeManifest.appliedCount} PDFs processed
                  </p>
                </div>
                <div className="rounded-lg border border-border bg-surface px-3 py-3">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">gbrain index</p>
                  <p className="mt-1 text-sm font-semibold text-foreground">
                    {activeManifest.status === "applied"
                      ? `${activeManifest.appliedCount} paper records updated`
                      : activeManifest.status === "applied_with_repair_required"
                        ? "Repair required"
                        : formatStatus(activeManifest.status)}
                  </p>
                </div>
              </div>
              <div className="mt-3 rounded-lg border border-border bg-surface px-3 py-3">
                <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">Graph context</p>
                <p className="mt-1 text-sm text-muted">
                  {graphData
                    ? `${graphData.filteredCount} papers and ${totalGraphEdgeCount} citation edges loaded.`
                    : "Open graph to build citation context, clusters, and gap suggestions from this scan."}
                </p>
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
          <form
            className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end"
            onSubmit={(event) => void handleManualRootPathSubmit(event)}
          >
            <label className="min-w-0 flex-1">
              <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted">Local folder path</span>
              <input
                type="text"
                value={manualRootPath}
                onChange={(event) => {
                  manualRootPathDirtyRef.current = true;
                  setManualRootPath(event.target.value);
                }}
                disabled={manualScanLoading || scanLoading || isScanInFlight(scan)}
                placeholder="/Users/you/papers"
                className="mt-2 w-full rounded-lg border border-border bg-white px-3 py-2 font-mono text-sm text-foreground outline-none transition-colors placeholder:text-muted/70 focus:border-accent disabled:opacity-50"
              />
            </label>
            <button
              type="submit"
              disabled={manualScanLoading || scanLoading || isScanInFlight(scan) || manualRootPath.trim().length === 0}
              className="inline-flex min-h-[38px] items-center justify-center gap-2 rounded-lg border border-border bg-white px-4 py-2 text-sm font-semibold text-foreground transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
            >
              {manualScanLoading ? <SpinnerGap className="animate-spin" size={16} /> : <FolderOpen size={16} />}
              Start dry-run scan
            </button>
          </form>
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

            <CorpusImportStatusPanel
              error={corpusStatusError}
              loading={corpusStatusLoading}
              onRefresh={() => {
                if (session.scanId) void loadCorpusStatus(session.scanId);
              }}
              status={corpusStatus}
            />
          </div>
        ) : (
          <EmptyState
            title="No paper-library scan yet"
            body="Choose or paste a local PDF archive path. The first pass is dry-run only and creates review, rename, graph, and history previews."
          />
        )}
      </div>
    );
  }, [
    activeManifest,
    activePlan,
    approvalStatusMessage,
    approvalStatusTone,
    applyActionLoading,
    applyButtonLabel,
    applyPlanError,
    applyPlanTemplateStale,
    applyPlanLoading,
    applyPlanLoadingMore,
    applyPlanPage,
    canApplyPlan,
    clustersError,
    clustersLoading,
    clustersLoadingMore,
    clustersPage,
    corpusStatus,
    corpusStatusError,
    corpusStatusLoading,
    draftsByItemId,
    gapActionSuggestionId,
    gapFilter,
    gapPage,
    gapsError,
    gapsLoading,
    gapsLoadingMore,
    graphError,
    graphActionMessage,
    graphData,
    graphDisplayData,
    graphHasPdfTextEdges,
    graphInsights,
    graphListView,
    graphLoading,
    graphLoadingMore,
    graphMoreOpen,
    graphNoIdentifierRuns,
    graphNodeFilter,
    graphOverviewLoading,
    graphPage,
    graphPdfTextReferenceCount,
    graphPdfTextRuns,
    graphPdfTextSuccessfulRuns,
    graphPerspective,
    graphSourceRunCount,
    graphSuccessfulRuns,
    graphQuery,
    graphWarnings,
    handleApproveAndApplyPlan,
    handleCancelScan,
    handleCopyGraphLink,
    handleCreateApplyPlan,
    handleGapAction,
    handleImportPdfFolder,
    handleManualRootPathSubmit,
    handleRepairManifest,
    handleReviewAction,
    handleResetGraphView,
    handleSelectMostConnectedGraphNode,
    handleSelectTemplateFormat,
    handleUndo,
    folderPickerLoading,
    manualRootPath,
    manualScanLoading,
    loadApplyPlan,
    loadClusters,
    loadGaps,
    loadGraph,
    loadGraphOverview,
    loadCorpusStatus,
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
    displayedGraphEdgeCount,
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
