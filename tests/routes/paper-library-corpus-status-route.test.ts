import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initBrain } from "@/brain/init";
import { PaperLibraryGraphSchema } from "@/lib/paper-library/contracts";
import { PaperIngestManifestSchema, writePaperCorpusManifestByScan } from "@/lib/paper-library/corpus";
import { getPaperLibraryGraphPath } from "@/lib/paper-library/state";
import { getProjectStateRootForBrainRoot } from "@/lib/state/project-storage";
import { phase0CorpusFixtureDescriptors } from "../fixtures/paper-library/corpus/phase0-fixtures";

const mockIsLocal = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
const ORIGINAL_SCIENCESWARM_DIR = process.env.SCIENCESWARM_DIR;
const ORIGINAL_SCIENCESWARM_USER_HANDLE = process.env.SCIENCESWARM_USER_HANDLE;
const now = "2026-04-28T12:00:00.000Z";

vi.mock("@/lib/local-guard", () => ({
  isLocalRequest: () => mockIsLocal(),
}));

let dataRoot: string;
let brainRoot: string;

function stateRoot(): string {
  return getProjectStateRootForBrainRoot("project-alpha", brainRoot);
}

async function seedCorpusState(): Promise<void> {
  const fixture = phase0CorpusFixtureDescriptors.find((descriptor) => descriptor.kind === "good_text_layer_pdf");
  if (!fixture?.expectedCandidate || !fixture.expectedSourceArtifact || !fixture.expectedRelevanceSummary) {
    throw new Error("Expected good text-layer PDF fixture.");
  }

  const manifest = PaperIngestManifestSchema.parse({
    version: 1,
    id: "corpus-scan-1",
    project: "project-alpha",
    scanId: "scan-1",
    status: "current",
    createdAt: now,
    updatedAt: now,
    parserConcurrencyLimit: 2,
    summaryConcurrencyLimit: 1,
    papers: [
      {
        paperId: fixture.paperId,
        paperSlug: fixture.paperSlug,
        identifiers: { doi: "10.1000/example-good-pdf" },
        title: "Good PDF fixture",
        status: "current",
        sourceCandidates: [fixture.expectedCandidate],
        selectedSourceCandidateId: fixture.expectedCandidate.id,
        sourceArtifact: fixture.expectedSourceArtifact,
        summaries: [fixture.expectedRelevanceSummary],
        bibliography: fixture.expectedBibliography ?? [],
      },
    ],
  });
  await writePaperCorpusManifestByScan("project-alpha", "scan-1", manifest, stateRoot());

  const graph = PaperLibraryGraphSchema.parse({
    version: 1,
    project: "project-alpha",
    scanId: "scan-1",
    createdAt: now,
    updatedAt: now,
    abstractsExtracted: true,
    nodes: [
      {
        id: "paper:doi:10.1000/example-good-pdf",
        kind: "local_paper",
        paperIds: [fixture.paperId],
        title: "Good PDF fixture",
        local: true,
        suggestion: false,
        sources: ["pdf_text"],
      },
      {
        id: "paper:doi:10.1000/example-reference",
        kind: "external_paper",
        paperIds: [],
        title: "Good PDF reference",
        local: false,
        suggestion: false,
        sources: ["pdf_text"],
      },
    ],
    edges: [
      {
        id: "edge-1",
        sourceNodeId: "paper:doi:10.1000/example-good-pdf",
        targetNodeId: "paper:doi:10.1000/example-reference",
        kind: "references",
        source: "pdf_text",
        evidence: ["fixture reference"],
      },
    ],
    sourceRuns: [
      {
        id: "run-1",
        source: "pdf_text",
        status: "success",
        paperId: fixture.paperId,
        attempts: 1,
        fetchedCount: 1,
        cacheHits: 0,
        startedAt: now,
        completedAt: now,
      },
    ],
    warnings: [],
  });
  const graphPath = getPaperLibraryGraphPath("project-alpha", "scan-1", stateRoot());
  await mkdir(path.dirname(graphPath), { recursive: true });
  await writeFile(graphPath, JSON.stringify(graph), "utf-8");
}

describe("paper-library corpus status route", () => {
  beforeEach(async () => {
    vi.resetModules();
    mockIsLocal.mockResolvedValue(true);
    dataRoot = await mkdtemp(path.join(os.tmpdir(), "scienceswarm-paper-library-corpus-status-"));
    process.env.SCIENCESWARM_DIR = dataRoot;
    process.env.SCIENCESWARM_USER_HANDLE = "@paper-library-corpus-status-test";
    brainRoot = path.join(dataRoot, "brain");
    initBrain({ root: brainRoot, name: "Test Researcher" });
  });

  afterEach(async () => {
    if (ORIGINAL_SCIENCESWARM_DIR) process.env.SCIENCESWARM_DIR = ORIGINAL_SCIENCESWARM_DIR;
    else delete process.env.SCIENCESWARM_DIR;
    if (ORIGINAL_SCIENCESWARM_USER_HANDLE) process.env.SCIENCESWARM_USER_HANDLE = ORIGINAL_SCIENCESWARM_USER_HANDLE;
    else delete process.env.SCIENCESWARM_USER_HANDLE;
    await import("@/brain/store").then((module) => module.resetBrainStore()).catch(() => {});
    await rm(dataRoot, { recursive: true, force: true });
  });

  it("returns an explicit missing status when no corpus manifest exists", async () => {
    const { GET } = await import("@/app/api/brain/paper-library/corpus-status/route");
    const response = await GET(new Request(
      "http://localhost/api/brain/paper-library/corpus-status?project=project-alpha&scanId=scan-missing",
    ));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      status: {
        status: "missing",
        scanId: "scan-missing",
        sourcePreference: { status: "missing" },
        graph: { status: "missing" },
      },
    });
  });

  it("summarizes source, extraction, summary, bibliography, and graph status", async () => {
    await seedCorpusState();
    const { GET } = await import("@/app/api/brain/paper-library/corpus-status/route");
    const response = await GET(new Request(
      "http://localhost/api/brain/paper-library/corpus-status?project=project-alpha&scanId=scan-1",
    ));

    expect(response.status).toBe(200);
    const body = await response.json() as {
      ok: boolean;
      status: {
        sourcePreference: { selectedCount: number; candidateCount: number };
        extractionQuality: { currentCount: number; averageScore: number };
        summaries: { byTier: { relevance: { current: number }; brief: { missing: number } } };
        bibliography: { entryCount: number; localStatusCounts: { metadata_only: number } };
        graph: { status: string; nodeCount: number; edgeCount: number };
      };
    };
    expect(body.ok).toBe(true);
    expect(body.status.sourcePreference).toMatchObject({ selectedCount: 1, candidateCount: 1 });
    expect(body.status.extractionQuality.currentCount).toBe(1);
    expect(body.status.extractionQuality.averageScore).toBeCloseTo(0.76);
    expect(body.status.summaries.byTier.relevance.current).toBe(1);
    expect(body.status.summaries.byTier.brief.missing).toBe(1);
    expect(body.status.bibliography).toMatchObject({
      entryCount: 1,
      localStatusCounts: { metadata_only: 1 },
    });
    expect(body.status.graph).toMatchObject({
      status: "current",
      nodeCount: 2,
      edgeCount: 1,
    });
  });

  it("rejects non-local requests", async () => {
    mockIsLocal.mockResolvedValue(false);
    const { GET } = await import("@/app/api/brain/paper-library/corpus-status/route");
    const response = await GET(new Request(
      "http://localhost/api/brain/paper-library/corpus-status?project=project-alpha&scanId=scan-1",
    ));
    expect(response.status).toBe(403);
  });
});
