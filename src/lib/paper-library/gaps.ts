import { createHash } from "node:crypto";

import {
  PAPER_LIBRARY_STATE_VERSION,
  PaperLibraryGapStateCountsSchema,
  PaperLibraryGapsSchema,
  type GapSuggestion,
  type GapSuggestionState,
  type PaperLibraryGapActionRequest,
  type PaperLibraryGapStateCounts,
  type PaperLibraryGaps,
  type PaperLibraryGapsResponse,
  type PaperLibraryGraph,
  type SemanticCluster,
} from "./contracts";
import { readPaperLibraryScan } from "./jobs";
import { readPaperLibraryClusters, getOrBuildPaperLibraryClusters } from "./clustering";
import {
  getOrBuildPaperLibraryGraph,
  normalizePaperIdentifiers,
  readPaperLibraryGraph,
} from "./graph";
import {
  getPaperLibraryGapsPath,
  readCursorWindow,
  readPersistedState,
} from "./state";
import { readJsonFile, writeJsonFile } from "@/lib/state/atomic-json";
import { getProjectStateRootForBrainRoot } from "@/lib/state/project-storage";

export interface BuildPaperLibraryGapsInput {
  project: string;
  scanId: string;
  brainRoot: string;
  refresh?: boolean;
}

function nowIso(): string {
  return new Date().toISOString();
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function normalizeGaps(value: unknown): PaperLibraryGaps {
  const parsed = PaperLibraryGapsSchema.parse(value);
  return {
    ...parsed,
    suggestions: parsed.suggestions ?? [],
    warnings: parsed.warnings ?? [],
  };
}

function normalizeTitle(value: string | undefined): string {
  return value?.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim() ?? "";
}

function identifierSignature(identifiers: GapSuggestion["identifiers"]): string {
  const normalized = normalizePaperIdentifiers(identifiers);
  return JSON.stringify(normalized);
}

function suggestionId(scanId: string, nodeId: string): string {
  return `gap:${stableHash({ scanId, nodeId })}`;
}

function clusterMembership(clusters: SemanticCluster[]): Map<string, string[]> {
  const memberships = new Map<string, string[]>();
  for (const cluster of clusters) {
    for (const member of cluster.members) {
      const current = memberships.get(member.paperId) ?? [];
      current.push(cluster.id);
      memberships.set(member.paperId, current);
    }
  }
  return memberships;
}

function clusterSizes(clusters: SemanticCluster[]): Map<string, number> {
  return new Map(clusters.map((cluster) => [cluster.id, cluster.memberCount]));
}

function countStates(suggestions: GapSuggestion[]): PaperLibraryGapStateCounts {
  const counts = {
    open: 0,
    watching: 0,
    ignored: 0,
    saved: 0,
    imported: 0,
  };
  for (const suggestion of suggestions) counts[suggestion.state] += 1;
  return PaperLibraryGapStateCountsSchema.parse(counts);
}

function sortSuggestions(left: GapSuggestion, right: GapSuggestion): number {
  const statePriority: Record<GapSuggestionState, number> = {
    open: 0,
    watching: 1,
    saved: 2,
    imported: 3,
    ignored: 4,
  };
  return statePriority[left.state] - statePriority[right.state]
    || right.score.overall - left.score.overall
    || (right.year ?? 0) - (left.year ?? 0)
    || left.title.localeCompare(right.title);
}

export function rankPaperLibraryGapSuggestions(input: {
  scanId: string;
  graph: PaperLibraryGraph;
  clusters: SemanticCluster[];
  previousSuggestions?: GapSuggestion[];
  now?: string;
}): GapSuggestion[] {
  const createdAt = input.now ?? nowIso();
  const previousById = new Map((input.previousSuggestions ?? []).map((suggestion) => [suggestion.id, suggestion]));
  const memberships = clusterMembership(input.clusters);
  const sizes = clusterSizes(input.clusters);
  const nodes = new Map(input.graph.nodes.map((node) => [node.id, node]));
  const externalNodes = input.graph.nodes.filter((node) => !node.local);

  const conflictingTitles = new Set<string>();
  const titleBuckets = new Map<string, Array<{ nodeId: string; signature: string }>>();
  for (const node of externalNodes) {
    const normalizedTitle = normalizeTitle(node.title);
    if (!normalizedTitle) continue;
    const bucket = titleBuckets.get(normalizedTitle) ?? [];
    bucket.push({ nodeId: node.id, signature: identifierSignature(node.identifiers) });
    titleBuckets.set(normalizedTitle, bucket);
  }
  for (const bucket of titleBuckets.values()) {
    const signatures = new Set(bucket.map((entry) => entry.signature));
    if (bucket.length > 1 && signatures.size > 1) {
      for (const entry of bucket) conflictingTitles.add(entry.nodeId);
    }
  }

  const suggestions: GapSuggestion[] = [];
  for (const node of externalNodes) {
    const localNeighborNodeIds = new Set<string>();
    const edgeKinds = new Set<string>();
    for (const edge of input.graph.edges) {
      const neighborId = edge.sourceNodeId === node.id
        ? edge.targetNodeId
        : edge.targetNodeId === node.id
          ? edge.sourceNodeId
          : null;
      if (!neighborId) continue;
      const neighbor = nodes.get(neighborId);
      if (!neighbor?.local) continue;
      localNeighborNodeIds.add(neighborId);
      edgeKinds.add(edge.kind);
    }

    const localNeighborPaperIds = Array.from(new Set(
      Array.from(localNeighborNodeIds)
        .flatMap((nodeId) => nodes.get(nodeId)?.paperIds ?? []),
    )).sort();
    if (localNeighborPaperIds.length === 0) continue;

    const connectedClusterIds = Array.from(new Set(
      localNeighborPaperIds.flatMap((paperId) => memberships.get(paperId) ?? []),
    )).sort();
    const clusterCoverage = connectedClusterIds.reduce((best, clusterId) => {
      const size = sizes.get(clusterId) ?? 0;
      if (size <= 0) return best;
      const connectedCount = localNeighborPaperIds.filter((paperId) => (memberships.get(paperId) ?? []).includes(clusterId)).length;
      return Math.max(best, connectedCount / size);
    }, 0);
    const citationConnections = localNeighborNodeIds.size;
    const citationFrequency = clamp(citationConnections / 4);
    const bridgePosition = clamp((connectedClusterIds.length - 1) / 2);
    const clusterGap = clamp(clusterCoverage);
    const maxLocalYear = Math.max(
      0,
      ...Array.from(localNeighborNodeIds).map((nodeId) => nodes.get(nodeId)?.year ?? 0),
    );
    const yearDistance = node.year && maxLocalYear ? Math.abs(node.year - maxLocalYear) : undefined;
    const recentConnected = yearDistance === undefined
      ? 0
      : yearDistance <= 1
        ? 1
        : yearDistance <= 3
          ? 0.7
          : yearDistance <= 5
            ? 0.4
            : 0.1;
    const disagreementPenalty = conflictingTitles.has(node.id) || node.sources.length > 1 ? 0.25 : 0;
    const overall = clamp(
      (citationFrequency * 0.45)
      + (bridgePosition * 0.25)
      + (clusterGap * 0.2)
      + (recentConnected * 0.1)
      - disagreementPenalty,
    );

    const reasonCodes: GapSuggestion["reasonCodes"] = [];
    if (citationConnections >= 2 || edgeKinds.has("references") || edgeKinds.has("cited_by")) {
      reasonCodes.push("citation_frequency");
    }
    if (connectedClusterIds.length > 1 || edgeKinds.has("bridge_suggestion")) {
      reasonCodes.push("bridge_position");
    }
    if (clusterGap >= 0.5) {
      reasonCodes.push("cluster_gap");
    }
    if (recentConnected >= 0.4) {
      reasonCodes.push("recent_connected");
    }
    if (disagreementPenalty > 0) {
      reasonCodes.push("source_disagreement");
    }

    const id = suggestionId(input.scanId, node.id);
    const existing = previousById.get(id);
    suggestions.push({
      id,
      scanId: input.scanId,
      nodeId: node.id,
      title: node.title ?? node.id,
      authors: node.authors,
      year: node.year,
      venue: node.venue,
      identifiers: node.identifiers,
      sources: node.sources,
      state: existing?.state ?? "open",
      reasonCodes,
      score: {
        overall,
        citationFrequency,
        bridgePosition,
        clusterGap,
        recentConnected,
        disagreementPenalty,
      },
      localConnectionCount: localNeighborPaperIds.length,
      evidencePaperIds: localNeighborPaperIds,
      evidenceClusterIds: connectedClusterIds,
      evidenceNodeIds: Array.from(localNeighborNodeIds).sort(),
      createdAt: existing?.createdAt ?? createdAt,
      updatedAt: existing?.updatedAt ?? createdAt,
    });
  }

  return suggestions.sort(sortSuggestions);
}

export async function readPaperLibraryGaps(
  project: string,
  scanId: string,
  brainRoot: string,
): Promise<PaperLibraryGaps | null> {
  const stateRoot = getProjectStateRootForBrainRoot(project, brainRoot);
  const parsed = await readPersistedState(
    getPaperLibraryGapsPath(project, scanId, stateRoot),
    PaperLibraryGapsSchema,
    "paper-library gaps",
  );
  return parsed.ok ? normalizeGaps(parsed.data) : null;
}

export async function buildPaperLibraryGaps(
  input: BuildPaperLibraryGapsInput,
): Promise<PaperLibraryGaps | null> {
  const graph = await getOrBuildPaperLibraryGraph({
    project: input.project,
    scanId: input.scanId,
    brainRoot: input.brainRoot,
    refresh: input.refresh,
  });
  if (!graph) return null;
  const clusters = await getOrBuildPaperLibraryClusters({
    project: input.project,
    scanId: input.scanId,
    brainRoot: input.brainRoot,
    refresh: input.refresh,
  });

  const stateRoot = getProjectStateRootForBrainRoot(input.project, input.brainRoot);
  const existingRaw = await readJsonFile<unknown>(getPaperLibraryGapsPath(input.project, input.scanId, stateRoot));
  let existing: PaperLibraryGaps | null = null;
  if (existingRaw) {
    try {
      existing = normalizeGaps(existingRaw);
    } catch {
      existing = null;
    }
  }

  const updatedAt = nowIso();
  const suggestions = rankPaperLibraryGapSuggestions({
    scanId: input.scanId,
    graph,
    clusters: clusters?.clusters ?? [],
    previousSuggestions: existing?.suggestions,
    now: updatedAt,
  });
  const warnings = Array.from(new Set([
    ...graph.warnings,
    ...(clusters?.warnings ?? []),
  ])).sort();

  const persisted = PaperLibraryGapsSchema.parse({
    version: PAPER_LIBRARY_STATE_VERSION,
    project: input.project,
    scanId: input.scanId,
    createdAt: existing?.createdAt ?? updatedAt,
    updatedAt,
    suggestions,
    warnings,
  });
  await writeJsonFile(getPaperLibraryGapsPath(input.project, input.scanId, stateRoot), persisted);
  return persisted;
}

export async function getOrBuildPaperLibraryGaps(
  input: BuildPaperLibraryGapsInput,
): Promise<PaperLibraryGaps | null> {
  if (!input.refresh) {
    const stateRoot = getProjectStateRootForBrainRoot(input.project, input.brainRoot);
    const raw = await readJsonFile<unknown>(getPaperLibraryGapsPath(input.project, input.scanId, stateRoot));
    if (raw) {
      try {
        const gaps = normalizeGaps(raw);
        const [scan, graph, clusters] = await Promise.all([
          readPaperLibraryScan(input.project, input.scanId, input.brainRoot),
          readPaperLibraryGraph(input.project, input.scanId, input.brainRoot),
          readPaperLibraryClusters(input.project, input.scanId, input.brainRoot),
        ]);
        if (!scan) return null;
        const latestDependency = Math.max(
          Date.parse(scan.updatedAt),
          Date.parse(graph?.updatedAt ?? scan.updatedAt),
          Date.parse(clusters?.updatedAt ?? scan.updatedAt),
        );
        if (Date.parse(gaps.updatedAt) >= latestDependency) return gaps;
      } catch {
        // Malformed or version-mismatched gap cache falls through to a rebuild.
      }
    }
  }
  return buildPaperLibraryGaps(input);
}

export function windowPaperLibraryGaps(
  gaps: PaperLibraryGaps,
  options: { cursor?: string; limit?: number; state?: GapSuggestionState },
): PaperLibraryGapsResponse {
  const filtered = options.state
    ? gaps.suggestions.filter((suggestion) => suggestion.state === options.state)
    : gaps.suggestions;
  const page = readCursorWindow(filtered, options);
  return {
    suggestions: page.items,
    nextCursor: page.nextCursor,
    totalCount: gaps.suggestions.length,
    filteredCount: filtered.length,
    stateCounts: countStates(gaps.suggestions),
    warnings: gaps.warnings,
  };
}

export async function updatePaperLibraryGapSuggestion(input: {
  project: string;
  scanId: string;
  brainRoot: string;
  suggestionId: string;
  action: PaperLibraryGapActionRequest["action"];
}): Promise<GapSuggestion | null> {
  const gaps = await getOrBuildPaperLibraryGaps({
    project: input.project,
    scanId: input.scanId,
    brainRoot: input.brainRoot,
  });
  if (!gaps) return null;

  const index = gaps.suggestions.findIndex((suggestion) => suggestion.id === input.suggestionId);
  if (index < 0) return null;

  const nextState: Record<PaperLibraryGapActionRequest["action"], GapSuggestionState> = {
    watch: "watching",
    ignore: "ignored",
    save: "saved",
    import: "imported",
    reopen: "open",
  };
  const updated = {
    ...gaps.suggestions[index],
    state: nextState[input.action],
    updatedAt: nowIso(),
  } satisfies GapSuggestion;
  const persisted = {
    ...gaps,
    updatedAt: updated.updatedAt,
    suggestions: gaps.suggestions.map((suggestion, suggestionIndex) => suggestionIndex === index ? updated : suggestion),
  } satisfies PaperLibraryGaps;
  await writeJsonFile(
    getPaperLibraryGapsPath(input.project, input.scanId, getProjectStateRootForBrainRoot(input.project, input.brainRoot)),
    PaperLibraryGapsSchema.parse(persisted),
  );
  return updated;
}
