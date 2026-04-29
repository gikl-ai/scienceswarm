import type { PaperLibraryGraph, RepairableState } from "../contracts";
import { readPaperLibraryGraph } from "../graph";
import type {
  BibliographyEntryArtifactStatus,
  BibliographyLocalStatus,
  PaperIngestManifest,
  PaperSourceCandidateStatus,
  PaperSourceType,
  PaperSummaryStatus,
  PaperSummaryTier,
} from "./contracts";
import { readPaperCorpusManifestByScan } from "./state";
import { getProjectStateRootForBrainRoot } from "@/lib/state/project-storage";

const SUMMARY_TIERS = ["relevance", "brief", "detailed"] as const satisfies readonly PaperSummaryTier[];

export type PaperCorpusOverallStatus =
  | "missing"
  | "malformed"
  | "unsupported_version"
  | "planned"
  | "queued"
  | "partial"
  | "current"
  | "stale"
  | "failed"
  | "in_progress"
  | "needs_attention"
  | "blocked"
  | "skipped";

export interface PaperCorpusImportStatus {
  project: string;
  scanId: string;
  manifestId?: string;
  status: PaperCorpusOverallStatus;
  paperCount: number;
  updatedAt?: string;
  sourcePreference: {
    status: PaperCorpusOverallStatus;
    candidateCount: number;
    selectedCount: number;
    preferredCount: number;
    fallbackCount: number;
    unavailableCount: number;
    blockedCount: number;
    selectedTypeCounts: Record<PaperSourceType, number>;
  };
  extractionQuality: {
    status: PaperCorpusOverallStatus;
    currentCount: number;
    staleCount: number;
    failedCount: number;
    blockedCount: number;
    plannedCount: number;
    missingCount: number;
    averageScore?: number;
    warningCount: number;
  };
  summaries: {
    status: PaperCorpusOverallStatus;
    byTier: Record<PaperSummaryTier, Record<PaperSummaryStatus, number>>;
  };
  bibliography: {
    status: PaperCorpusOverallStatus;
    entryCount: number;
    artifactStatusCounts: Record<BibliographyEntryArtifactStatus, number>;
    localStatusCounts: Record<BibliographyLocalStatus, number>;
  };
  graph: {
    status: "missing" | "current" | "stale";
    nodeCount: number;
    edgeCount: number;
    sourceRunCount: number;
    successfulSourceRunCount: number;
    warningCount: number;
    updatedAt?: string;
  };
  warnings: string[];
}

function sourceTypeCounts(): Record<PaperSourceType, number> {
  return {
    latex: 0,
    html: 0,
    pdf: 0,
    metadata: 0,
  };
}

function summaryStatusCounts(): Record<PaperSummaryStatus, number> {
  return {
    current: 0,
    stale: 0,
    missing: 0,
    failed: 0,
    queued: 0,
    blocked: 0,
  };
}

function bibliographyArtifactCounts(): Record<BibliographyEntryArtifactStatus, number> {
  return {
    current: 0,
    stale: 0,
    blocked: 0,
  };
}

function bibliographyLocalCounts(): Record<BibliographyLocalStatus, number> {
  return {
    local: 0,
    external: 0,
    metadata_only: 0,
    unresolved: 0,
  };
}

function increment<T extends string>(counts: Record<T, number>, key: T): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function extractionStatusFromCounts(input: {
  currentCount: number;
  staleCount: number;
  failedCount: number;
  blockedCount: number;
  plannedCount: number;
  missingCount: number;
  total: number;
}): PaperCorpusOverallStatus {
  if (input.total === 0) return "missing";
  if (input.failedCount > 0) return "needs_attention";
  if (input.blockedCount > 0) return "blocked";
  if (input.staleCount > 0) return "stale";
  if (input.currentCount === input.total) return "current";
  if (input.plannedCount > 0) return "planned";
  if (input.missingCount > 0) return "missing";
  return "partial";
}

function summaryStatusFromCounts(countsByTier: PaperCorpusImportStatus["summaries"]["byTier"]): PaperCorpusOverallStatus {
  const counts = SUMMARY_TIERS.reduce((accumulator, tier) => {
    const tierCounts = countsByTier[tier];
    accumulator.current += tierCounts.current;
    accumulator.stale += tierCounts.stale;
    accumulator.missing += tierCounts.missing;
    accumulator.failed += tierCounts.failed;
    accumulator.queued += tierCounts.queued;
    accumulator.blocked += tierCounts.blocked;
    return accumulator;
  }, summaryStatusCounts());
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  if (total === 0 || counts.missing === total) return "missing";
  if (counts.failed > 0) return "needs_attention";
  if (counts.blocked > 0) return "blocked";
  if (counts.stale > 0) return "stale";
  if (counts.queued > 0) return "in_progress";
  if (counts.current === total) return "current";
  return "partial";
}

function sourcePreferenceStatus(input: {
  paperCount: number;
  selectedCount: number;
  blockedCount: number;
  unavailableCount: number;
}): PaperCorpusOverallStatus {
  if (input.paperCount === 0) return "missing";
  if (input.selectedCount === input.paperCount) return "current";
  if (input.blockedCount > 0 && input.selectedCount === 0) return "blocked";
  if (input.unavailableCount > 0 || input.blockedCount > 0) return "needs_attention";
  return "partial";
}

function graphStatus(graph: PaperLibraryGraph | null, manifest: PaperIngestManifest | undefined): PaperCorpusImportStatus["graph"] {
  if (!graph) {
    return {
      status: "missing",
      nodeCount: 0,
      edgeCount: 0,
      sourceRunCount: 0,
      successfulSourceRunCount: 0,
      warningCount: 0,
    };
  }
  const stale = manifest ? Date.parse(graph.updatedAt) < Date.parse(manifest.updatedAt) : false;
  return {
    status: stale ? "stale" : "current",
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
    sourceRunCount: graph.sourceRuns.length,
    successfulSourceRunCount: graph.sourceRuns.filter((run) => run.status === "success").length,
    warningCount: graph.warnings.length,
    updatedAt: graph.updatedAt,
  };
}

function issueStatus(issue: RepairableState | undefined): PaperCorpusOverallStatus {
  if (!issue || issue.code === "missing") return "missing";
  return issue.code;
}

export function summarizePaperCorpusImportStatus(input: {
  project: string;
  scanId: string;
  manifest?: PaperIngestManifest;
  manifestIssue?: RepairableState;
  graph?: PaperLibraryGraph | null;
}): PaperCorpusImportStatus {
  const { manifest } = input;
  if (!manifest) {
    const status = issueStatus(input.manifestIssue);
    return {
      project: input.project,
      scanId: input.scanId,
      status,
      paperCount: 0,
      sourcePreference: {
        status,
        candidateCount: 0,
        selectedCount: 0,
        preferredCount: 0,
        fallbackCount: 0,
        unavailableCount: 0,
        blockedCount: 0,
        selectedTypeCounts: sourceTypeCounts(),
      },
      extractionQuality: {
        status,
        currentCount: 0,
        staleCount: 0,
        failedCount: 0,
        blockedCount: 0,
        plannedCount: 0,
        missingCount: 0,
        warningCount: 0,
      },
      summaries: {
        status,
        byTier: {
          relevance: summaryStatusCounts(),
          brief: summaryStatusCounts(),
          detailed: summaryStatusCounts(),
        },
      },
      bibliography: {
        status,
        entryCount: 0,
        artifactStatusCounts: bibliographyArtifactCounts(),
        localStatusCounts: bibliographyLocalCounts(),
      },
      graph: graphStatus(input.graph ?? null, undefined),
      warnings: input.manifestIssue && input.manifestIssue.code !== "missing" ? [input.manifestIssue.message] : [],
    };
  }

  const selectedTypeCounts = sourceTypeCounts();
  const candidateStatusCounts: Record<PaperSourceCandidateStatus, number> = {
    available: 0,
    preferred: 0,
    fallback: 0,
    unavailable: 0,
    blocked: 0,
  };
  let candidateCount = 0;
  let selectedCount = 0;

  let currentCount = 0;
  let staleCount = 0;
  let failedCount = 0;
  let blockedCount = 0;
  let plannedCount = 0;
  let missingCount = 0;
  let qualityScoreTotal = 0;
  let qualityScoreCount = 0;
  let warningCount = manifest.warnings.length;

  const byTier: PaperCorpusImportStatus["summaries"]["byTier"] = {
    relevance: summaryStatusCounts(),
    brief: summaryStatusCounts(),
    detailed: summaryStatusCounts(),
  };
  const artifactStatusCounts = bibliographyArtifactCounts();
  const localStatusCounts = bibliographyLocalCounts();
  let entryCount = 0;

  for (const paper of manifest.papers) {
    warningCount += paper.warnings.length;
    candidateCount += paper.sourceCandidates.length;
    for (const candidate of paper.sourceCandidates) {
      increment(candidateStatusCounts, candidate.status);
      warningCount += candidate.warnings.length;
    }
    const selected = paper.sourceCandidates.find((candidate) => candidate.id === paper.selectedSourceCandidateId);
    if (selected) {
      selectedCount += 1;
      increment(selectedTypeCounts, selected.sourceType);
    }

    const source = paper.sourceArtifact;
    if (!source) {
      missingCount += 1;
    } else {
      warningCount += source.warnings.length + source.quality.warnings.length;
      if (source.status === "current") currentCount += 1;
      else if (source.status === "stale") staleCount += 1;
      else if (source.status === "failed") failedCount += 1;
      else if (source.status === "blocked") blockedCount += 1;
      else if (source.status === "planned" || source.status === "queued") plannedCount += 1;
      else missingCount += 1;
      qualityScoreTotal += source.quality.score;
      qualityScoreCount += 1;
    }

    for (const tier of SUMMARY_TIERS) {
      const summary = paper.summaries.find((entry) => entry.tier === tier);
      increment(byTier[tier], summary?.status ?? "missing");
      warningCount += summary?.warnings.length ?? 0;
    }

    for (const entry of paper.bibliography) {
      entryCount += 1;
      increment(artifactStatusCounts, entry.status);
      increment(localStatusCounts, entry.localStatus);
      warningCount += entry.warnings.length;
    }
  }

  const bibliographyStatus: PaperCorpusOverallStatus =
    entryCount === 0
      ? "missing"
      : artifactStatusCounts.blocked > 0
        ? "blocked"
        : artifactStatusCounts.stale > 0
          ? "stale"
          : artifactStatusCounts.current === entryCount
            ? "current"
            : "partial";
  const extractionQuality = {
    status: extractionStatusFromCounts({
      currentCount,
      staleCount,
      failedCount,
      blockedCount,
      plannedCount,
      missingCount,
      total: manifest.papers.length,
    }),
    currentCount,
    staleCount,
    failedCount,
    blockedCount,
    plannedCount,
    missingCount,
    ...(qualityScoreCount > 0 ? { averageScore: qualityScoreTotal / qualityScoreCount } : {}),
    warningCount,
  };

  return {
    project: input.project,
    scanId: input.scanId,
    manifestId: manifest.id,
    status: manifest.status,
    paperCount: manifest.papers.length,
    updatedAt: manifest.updatedAt,
    sourcePreference: {
      status: sourcePreferenceStatus({
        paperCount: manifest.papers.length,
        selectedCount,
        blockedCount: candidateStatusCounts.blocked,
        unavailableCount: candidateStatusCounts.unavailable,
      }),
      candidateCount,
      selectedCount,
      preferredCount: candidateStatusCounts.preferred,
      fallbackCount: candidateStatusCounts.fallback,
      unavailableCount: candidateStatusCounts.unavailable,
      blockedCount: candidateStatusCounts.blocked,
      selectedTypeCounts,
    },
    extractionQuality,
    summaries: {
      status: summaryStatusFromCounts(byTier),
      byTier,
    },
    bibliography: {
      status: bibliographyStatus,
      entryCount,
      artifactStatusCounts,
      localStatusCounts,
    },
    graph: graphStatus(input.graph ?? null, manifest),
    warnings: manifest.warnings.map((warning) => warning.message),
  };
}

export async function readPaperCorpusImportStatus(input: {
  project: string;
  scanId: string;
  brainRoot: string;
}): Promise<PaperCorpusImportStatus> {
  const stateRoot = getProjectStateRootForBrainRoot(input.project, input.brainRoot);
  const manifest = await readPaperCorpusManifestByScan(input.project, input.scanId, stateRoot);
  const graph = await readPaperLibraryGraph(input.project, input.scanId, input.brainRoot);
  return summarizePaperCorpusImportStatus({
    project: input.project,
    scanId: input.scanId,
    manifest: manifest.ok ? manifest.data : undefined,
    manifestIssue: manifest.ok ? undefined : manifest.repairable,
    graph,
  });
}
