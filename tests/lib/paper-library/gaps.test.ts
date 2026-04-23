import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initBrain } from "@/brain/init";
import {
  buildPaperLibraryGaps,
  getOrBuildPaperLibraryGaps,
  updatePaperLibraryGapSuggestion,
} from "@/lib/paper-library/gaps";
import {
  getPaperLibraryClustersPath,
  getPaperLibraryGapsPath,
  getPaperLibraryGraphPath,
} from "@/lib/paper-library/state";
import { getProjectStateRootForBrainRoot } from "@/lib/state/project-storage";

const ORIGINAL_SCIENCESWARM_DIR = process.env.SCIENCESWARM_DIR;
const ORIGINAL_SCIENCESWARM_USER_HANDLE = process.env.SCIENCESWARM_USER_HANDLE;

let dataRoot: string;
let brainRoot: string;

function stateRoot(): string {
  return getProjectStateRootForBrainRoot("project-alpha", brainRoot);
}

function now(): string {
  return new Date().toISOString();
}

async function seedScan(): Promise<void> {
  const root = stateRoot();
  await mkdir(path.join(root, "paper-library", "scans"), { recursive: true });
  await writeFile(path.join(root, "paper-library", "scans", "scan-1.json"), JSON.stringify({
    version: 1,
    id: "scan-1",
    project: "project-alpha",
    rootPath: "/tmp/paper-library",
    rootRealpath: "/tmp/paper-library",
    status: "ready_for_apply",
    createdAt: now(),
    updatedAt: "2026-04-23T12:00:00.000Z",
    counters: {
      detectedFiles: 3,
      identified: 3,
      needsReview: 0,
      readyForApply: 3,
      failed: 0,
    },
    warnings: [],
    currentPath: null,
    reviewShardIds: ["0001"],
  }), "utf-8");
}

async function seedGraphAndClusters(): Promise<void> {
  const root = stateRoot();
  await mkdir(path.dirname(getPaperLibraryGraphPath("project-alpha", "scan-1", root)), { recursive: true });
  await mkdir(path.dirname(getPaperLibraryClustersPath("project-alpha", "scan-1", root)), { recursive: true });

  await writeFile(getPaperLibraryGraphPath("project-alpha", "scan-1", root), JSON.stringify({
    version: 1,
    project: "project-alpha",
    scanId: "scan-1",
    createdAt: "2026-04-23T12:00:00.000Z",
    updatedAt: "2026-04-23T12:00:00.000Z",
    nodes: [
      {
        id: "paper:doi:10.1000/a1",
        kind: "local_paper",
        paperIds: ["paper-a1"],
        title: "Protein Cluster A1",
        authors: ["Ada Lovelace"],
        year: 2024,
        venue: "Cluster Conf",
        identifiers: { doi: "10.1000/a1" },
        local: true,
        suggestion: false,
        sources: ["filename"],
        evidence: [],
      },
      {
        id: "paper:doi:10.1000/a2",
        kind: "local_paper",
        paperIds: ["paper-a2"],
        title: "Protein Cluster A2",
        authors: ["Grace Hopper"],
        year: 2025,
        venue: "Cluster Conf",
        identifiers: { doi: "10.1000/a2" },
        local: true,
        suggestion: false,
        sources: ["filename"],
        evidence: [],
      },
      {
        id: "paper:doi:10.1000/b1",
        kind: "local_paper",
        paperIds: ["paper-b1"],
        title: "Systems Cluster B1",
        authors: ["Katherine Johnson"],
        year: 2023,
        venue: "Bridge Symposium",
        identifiers: { doi: "10.1000/b1" },
        local: true,
        suggestion: false,
        sources: ["filename"],
        evidence: [],
      },
      {
        id: "paper:doi:10.2000/seminal",
        kind: "external_paper",
        paperIds: [],
        title: "Seminal Missing Paper",
        authors: ["Barbara Liskov"],
        year: 2025,
        venue: "Nature of Research",
        identifiers: { doi: "10.2000/seminal" },
        local: false,
        suggestion: false,
        sources: ["semantic_scholar"],
        evidence: ["semantic_scholar:references"],
      },
      {
        id: "paper:doi:10.3000/conflict-a",
        kind: "bridge_suggestion",
        paperIds: [],
        title: "Conflicted Gap Paper",
        authors: ["Source Alpha"],
        year: 2022,
        venue: "Uncertain Journal",
        identifiers: { doi: "10.3000/conflict-a" },
        local: false,
        suggestion: true,
        sources: ["semantic_scholar", "crossref"],
        evidence: ["semantic_scholar:bridge_suggestion"],
      },
      {
        id: "paper:doi:10.3000/conflict-b",
        kind: "external_paper",
        paperIds: [],
        title: "Conflicted Gap Paper",
        authors: ["Source Beta"],
        year: 2021,
        venue: "Uncertain Journal",
        identifiers: { doi: "10.3000/conflict-b" },
        local: false,
        suggestion: false,
        sources: ["openalex"],
        evidence: ["openalex:references"],
      },
    ],
    edges: [
      {
        id: "edge-1",
        sourceNodeId: "paper:doi:10.1000/a1",
        targetNodeId: "paper:doi:10.2000/seminal",
        kind: "references",
        source: "semantic_scholar",
        evidence: [],
      },
      {
        id: "edge-2",
        sourceNodeId: "paper:doi:10.1000/a2",
        targetNodeId: "paper:doi:10.2000/seminal",
        kind: "references",
        source: "semantic_scholar",
        evidence: [],
      },
      {
        id: "edge-3",
        sourceNodeId: "paper:doi:10.1000/b1",
        targetNodeId: "paper:doi:10.2000/seminal",
        kind: "cited_by",
        source: "semantic_scholar",
        evidence: [],
      },
      {
        id: "edge-4",
        sourceNodeId: "paper:doi:10.1000/a1",
        targetNodeId: "paper:doi:10.3000/conflict-a",
        kind: "bridge_suggestion",
        source: "semantic_scholar",
        evidence: [],
      },
      {
        id: "edge-5",
        sourceNodeId: "paper:doi:10.1000/b1",
        targetNodeId: "paper:doi:10.3000/conflict-b",
        kind: "references",
        source: "openalex",
        evidence: [],
      },
    ],
    sourceRuns: [],
    warnings: [],
  }), "utf-8");

  await writeFile(getPaperLibraryClustersPath("project-alpha", "scan-1", root), JSON.stringify({
    version: 1,
    project: "project-alpha",
    scanId: "scan-1",
    createdAt: "2026-04-23T12:00:00.000Z",
    updatedAt: "2026-04-23T12:00:00.000Z",
    model: {
      id: "paper-library-hash-embedding-v1",
      provider: "local_hash",
      dimensions: 256,
      chunking: "semantic-summary-v1",
      status: "ready",
      cacheHits: 0,
      generatedCount: 3,
      reusedGbrainCount: 0,
      fallbackCount: 3,
    },
    clusters: [
      {
        id: "cluster-a",
        label: "Protein Design",
        folderName: "protein-design",
        keywords: ["protein", "folding"],
        memberCount: 2,
        confidence: 0.82,
        representativePaperId: "paper-a1",
        members: [
          { itemId: "item-a1", paperId: "paper-a1", title: "Protein Cluster A1", confidence: 0.95, score: 0.88 },
          { itemId: "item-a2", paperId: "paper-a2", title: "Protein Cluster A2", confidence: 0.93, score: 0.84 },
        ],
      },
      {
        id: "cluster-b",
        label: "Systems Bridges",
        folderName: "systems-bridges",
        keywords: ["systems", "bridges"],
        memberCount: 1,
        confidence: 0.64,
        representativePaperId: "paper-b1",
        members: [
          { itemId: "item-b1", paperId: "paper-b1", title: "Systems Cluster B1", confidence: 0.91, score: 0.79 },
        ],
      },
    ],
    unclusteredPaperIds: [],
    warnings: [],
  }), "utf-8");
}

describe("paper-library gaps", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    dataRoot = await mkdtemp(path.join(os.tmpdir(), "scienceswarm-paper-library-gaps-"));
    brainRoot = path.join(dataRoot, "brain");
    process.env.SCIENCESWARM_DIR = dataRoot;
    process.env.SCIENCESWARM_USER_HANDLE = "@paper-library-gaps-test";
    initBrain({ root: brainRoot, name: "Test Researcher" });
    await seedScan();
    await seedGraphAndClusters();
  });

  afterEach(async () => {
    if (ORIGINAL_SCIENCESWARM_DIR) process.env.SCIENCESWARM_DIR = ORIGINAL_SCIENCESWARM_DIR;
    else delete process.env.SCIENCESWARM_DIR;
    if (ORIGINAL_SCIENCESWARM_USER_HANDLE) process.env.SCIENCESWARM_USER_HANDLE = ORIGINAL_SCIENCESWARM_USER_HANDLE;
    else delete process.env.SCIENCESWARM_USER_HANDLE;
    await import("@/brain/store").then((module) => module.resetBrainStore()).catch(() => {});
    await rm(dataRoot, { recursive: true, force: true });
  });

  it("ranks missing-paper suggestions from citation frequency, bridge position, cluster gaps, recency, and disagreement", async () => {
    const gaps = await buildPaperLibraryGaps({
      project: "project-alpha",
      scanId: "scan-1",
      brainRoot,
    });

    expect(gaps).not.toBeNull();
    expect(gaps?.suggestions).toHaveLength(3);
    expect(gaps?.suggestions[0]).toMatchObject({
      title: "Seminal Missing Paper",
      reasonCodes: expect.arrayContaining([
        "citation_frequency",
        "bridge_position",
        "cluster_gap",
        "recent_connected",
      ]),
      localConnectionCount: 3,
      state: "open",
    });
    expect(gaps?.suggestions[0]?.score.overall ?? 0).toBeGreaterThan(0.7);

    const conflicted = gaps?.suggestions.filter((suggestion) => suggestion.title === "Conflicted Gap Paper") ?? [];
    expect(conflicted).toHaveLength(2);
    expect(conflicted.every((suggestion) => suggestion.reasonCodes.includes("source_disagreement"))).toBe(true);
  });

  it("preserves ignored, saved, and imported states across gap rebuilds", async () => {
    const first = await buildPaperLibraryGaps({
      project: "project-alpha",
      scanId: "scan-1",
      brainRoot,
    });
    expect(first?.suggestions).toHaveLength(3);

    const [openSuggestion, secondSuggestion, thirdSuggestion] = first!.suggestions;
    await updatePaperLibraryGapSuggestion({
      project: "project-alpha",
      scanId: "scan-1",
      brainRoot,
      suggestionId: openSuggestion.id,
      action: "ignore",
    });
    await updatePaperLibraryGapSuggestion({
      project: "project-alpha",
      scanId: "scan-1",
      brainRoot,
      suggestionId: secondSuggestion.id,
      action: "save",
    });
    await updatePaperLibraryGapSuggestion({
      project: "project-alpha",
      scanId: "scan-1",
      brainRoot,
      suggestionId: thirdSuggestion.id,
      action: "import",
    });

    const rebuilt = await buildPaperLibraryGaps({
      project: "project-alpha",
      scanId: "scan-1",
      brainRoot,
    });

    expect(rebuilt?.suggestions.find((suggestion) => suggestion.id === openSuggestion.id)?.state).toBe("ignored");
    expect(rebuilt?.suggestions.find((suggestion) => suggestion.id === secondSuggestion.id)?.state).toBe("saved");
    expect(rebuilt?.suggestions.find((suggestion) => suggestion.id === thirdSuggestion.id)?.state).toBe("imported");
  });

  it("rebuilds malformed persisted gap caches instead of throwing", async () => {
    const root = stateRoot();
    await mkdir(path.dirname(getPaperLibraryGapsPath("project-alpha", "scan-1", root)), { recursive: true });
    await writeFile(getPaperLibraryGapsPath("project-alpha", "scan-1", root), JSON.stringify({
      version: 999,
      project: "project-alpha",
      scanId: "scan-1",
      updatedAt: now(),
    }), "utf-8");

    const rebuilt = await getOrBuildPaperLibraryGaps({
      project: "project-alpha",
      scanId: "scan-1",
      brainRoot,
    });

    expect(rebuilt?.suggestions).toHaveLength(3);
    expect(rebuilt?.suggestions[0]?.title).toBe("Seminal Missing Paper");
  });
});
