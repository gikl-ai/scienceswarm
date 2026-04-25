import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initBrain } from "@/brain/init";
import { getBrainStore } from "@/brain/store";
import {
  getPaperLibraryAcquisitionPlanPath,
  getPaperLibraryClustersPath,
  getPaperLibraryGraphPath,
} from "@/lib/paper-library/state";
import { getProjectStateRootForBrainRoot } from "@/lib/state/project-storage";

const mockIsLocal = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
const mockDownloadArxivPdf = vi.hoisted(() => vi.fn());
const ORIGINAL_SCIENCESWARM_DIR = process.env.SCIENCESWARM_DIR;
const ORIGINAL_SCIENCESWARM_USER_HANDLE = process.env.SCIENCESWARM_USER_HANDLE;

vi.mock("@/brain/arxiv-download", () => ({
  downloadArxivPdf: mockDownloadArxivPdf,
}));

vi.mock("@/lib/local-guard", () => ({
  isLocalRequest: () => mockIsLocal(),
}));

let dataRoot: string;
let brainRoot: string;
const PDF_FIXTURE = path.join(process.cwd(), "tests/fixtures/audit-revise/mendel-1866-textlayer.pdf");

function stateRoot(): string {
  return getProjectStateRootForBrainRoot("project-alpha", brainRoot);
}

function jsonRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

async function copyFixturePdf(arxivId: string, destDir: string): Promise<string> {
  await mkdir(destDir, { recursive: true });
  const pdfPath = path.join(destDir, `${arxivId}.pdf`);
  await copyFile(PDF_FIXTURE, pdfPath);
  return pdfPath;
}

async function seedState(): Promise<void> {
  const root = stateRoot();
  await mkdir(path.join(root, "paper-library", "scans"), { recursive: true });
  await mkdir(path.dirname(getPaperLibraryGraphPath("project-alpha", "scan-1", root)), { recursive: true });
  await mkdir(path.dirname(getPaperLibraryClustersPath("project-alpha", "scan-1", root)), { recursive: true });

  await writeFile(path.join(root, "paper-library", "scans", "scan-1.json"), JSON.stringify({
    version: 1,
    id: "scan-1",
    project: "project-alpha",
    rootPath: "/tmp/papers",
    rootRealpath: "/tmp/papers",
    status: "ready_for_apply",
    createdAt: "2026-04-23T12:00:00.000Z",
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

  await writeFile(getPaperLibraryGraphPath("project-alpha", "scan-1", root), JSON.stringify({
    version: 1,
    project: "project-alpha",
    scanId: "scan-1",
    createdAt: "2026-04-23T12:00:00.000Z",
    updatedAt: "2026-04-23T12:00:00.000Z",
    nodes: [
      {
        id: "paper:doi:10.1000/local-a",
        kind: "local_paper",
        paperIds: ["paper-a"],
        title: "Local Paper A",
        authors: ["Ada"],
        year: 2024,
        venue: "Local Conf",
        identifiers: { doi: "10.1000/local-a" },
        local: true,
        suggestion: false,
        sources: ["filename"],
        evidence: [],
      },
      {
        id: "paper:doi:10.1000/local-b",
        kind: "local_paper",
        paperIds: ["paper-b"],
        title: "Local Paper B",
        authors: ["Grace"],
        year: 2025,
        venue: "Local Conf",
        identifiers: { doi: "10.1000/local-b" },
        local: true,
        suggestion: false,
        sources: ["filename"],
        evidence: [],
      },
      {
        id: "paper:arxiv:2401.01234",
        kind: "external_paper",
        paperIds: [],
        title: "Missing Open Access Paper",
        authors: ["Barbara"],
        year: 2025,
        venue: "arXiv",
        identifiers: { arxivId: "2401.01234" },
        local: false,
        suggestion: false,
        sources: ["semantic_scholar", "arxiv"],
        evidence: [],
      },
      {
        id: "paper:doi:10.3000/metadata",
        kind: "external_paper",
        paperIds: [],
        title: "Missing Metadata Only Paper",
        authors: ["Katherine"],
        year: 2020,
        venue: "Route Journal",
        identifiers: { doi: "10.3000/metadata" },
        local: false,
        suggestion: false,
        sources: ["openalex"],
        evidence: [],
      },
    ],
    edges: [
      {
        id: "edge-1",
        sourceNodeId: "paper:doi:10.1000/local-a",
        targetNodeId: "paper:arxiv:2401.01234",
        kind: "references",
        source: "semantic_scholar",
        evidence: [],
      },
      {
        id: "edge-2",
        sourceNodeId: "paper:doi:10.1000/local-b",
        targetNodeId: "paper:arxiv:2401.01234",
        kind: "references",
        source: "semantic_scholar",
        evidence: [],
      },
      {
        id: "edge-3",
        sourceNodeId: "paper:doi:10.1000/local-b",
        targetNodeId: "paper:doi:10.3000/metadata",
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
      generatedCount: 2,
      reusedGbrainCount: 0,
      fallbackCount: 2,
    },
    clusters: [
      {
        id: "cluster-route",
        label: "Route Cluster",
        folderName: "route-cluster",
        keywords: ["route"],
        memberCount: 2,
        confidence: 0.74,
        representativePaperId: "paper-a",
        members: [
          { itemId: "item-a", paperId: "paper-a", title: "Local Paper A", confidence: 0.9, score: 0.8 },
          { itemId: "item-b", paperId: "paper-b", title: "Local Paper B", confidence: 0.9, score: 0.8 },
        ],
      },
    ],
    unclusteredPaperIds: [],
    warnings: [],
  }), "utf-8");
}

describe("paper-library acquisition route", () => {
  beforeEach(async () => {
    vi.resetModules();
    mockIsLocal.mockResolvedValue(true);
    mockDownloadArxivPdf.mockReset();
    dataRoot = await mkdtemp(path.join(os.tmpdir(), "scienceswarm-paper-library-acquisition-route-"));
    process.env.SCIENCESWARM_DIR = dataRoot;
    process.env.SCIENCESWARM_USER_HANDLE = "@paper-library-acquisition-route-test";
    brainRoot = path.join(dataRoot, "brain");
    initBrain({ root: brainRoot, name: "Test Researcher" });
    mockDownloadArxivPdf.mockImplementation(copyFixturePdf);
    await seedState();
  });

  afterEach(async () => {
    vi.doUnmock("@/lib/paper-library/library-enrichment");
    if (ORIGINAL_SCIENCESWARM_DIR) process.env.SCIENCESWARM_DIR = ORIGINAL_SCIENCESWARM_DIR;
    else delete process.env.SCIENCESWARM_DIR;
    if (ORIGINAL_SCIENCESWARM_USER_HANDLE) process.env.SCIENCESWARM_USER_HANDLE = ORIGINAL_SCIENCESWARM_USER_HANDLE;
    else delete process.env.SCIENCESWARM_USER_HANDLE;
    await import("@/brain/store").then((module) => module.resetBrainStore()).catch(() => {});
    await rm(dataRoot, { recursive: true, force: true });
  });

  it("creates an acquisition plan from graph gap suggestions", async () => {
    const route = await import("@/app/api/brain/paper-library/acquisition/route");
    const response = await route.POST(jsonRequest("http://localhost/api/brain/paper-library/acquisition", {
      action: "create",
      project: "project-alpha",
      scanId: "scan-1",
      limit: 2,
    }));

    expect(response.status).toBe(200);
    const body = await response.json() as {
      acquisitionPlanId: string;
      plan: {
        itemCount: number;
        downloadableCount: number;
        items: Array<{
          title: string;
          mode: string;
          rationale: string;
          selectedLocation?: { source: string; canDownloadPdf: boolean };
        }>;
      };
    };
    expect(body.plan.itemCount).toBe(2);
    expect(body.plan.downloadableCount).toBe(1);
    expect(body.plan.items[0]).toMatchObject({
      title: "Missing Open Access Paper",
      mode: "download_pdf",
      selectedLocation: { source: "arxiv", canDownloadPdf: true },
    });
    expect(body.plan.items[0]?.rationale).toContain("Connected to 2 papers already in the library.");

    const lookup = await route.GET(new Request(
      `http://localhost/api/brain/paper-library/acquisition?project=project-alpha&id=${body.acquisitionPlanId}`,
    ));
    expect(lookup.status).toBe(200);
    await expect(lookup.json()).resolves.toMatchObject({
      ok: true,
      plan: { id: body.acquisitionPlanId, itemCount: 2 },
    });
  });

  it("executes confirmed arXiv downloads and marks acquired gaps imported", async () => {
    const route = await import("@/app/api/brain/paper-library/acquisition/route");
    const createResponse = await route.POST(jsonRequest("http://localhost/api/brain/paper-library/acquisition", {
      action: "create",
      project: "project-alpha",
      scanId: "scan-1",
      limit: 2,
    }));
    const created = await createResponse.json() as { acquisitionPlanId: string };

    const executeResponse = await route.POST(jsonRequest("http://localhost/api/brain/paper-library/acquisition", {
      action: "execute",
      project: "project-alpha",
      acquisitionPlanId: created.acquisitionPlanId,
      userConfirmation: true,
    }));
    expect(executeResponse.status).toBe(200);
    const executed = await executeResponse.json() as {
      status: string;
      acquiredCount: number;
      failedCount: number;
      plan: {
        metadataOnlyCount: number;
        items: Array<{
          title: string;
          status: string;
          localPath?: string;
          sourceUrl?: string;
          gbrainSlug?: string;
          checksum?: string;
        }>;
      };
    };
    expect(executed.status).toBe("completed");
    expect(executed.acquiredCount).toBe(1);
    expect(executed.failedCount).toBe(0);
    expect(executed.plan.metadataOnlyCount).toBe(1);
    expect(mockDownloadArxivPdf).toHaveBeenCalledWith(
      "2401.01234",
      expect.stringContaining(path.join("paper-library", "acquisitions", created.acquisitionPlanId, "downloads")),
    );
    expect(executed.plan.items.find((item) => item.title === "Missing Open Access Paper")).toMatchObject({
      status: "acquired",
      localPath: expect.stringContaining("2401.01234.pdf"),
      sourceUrl: "https://arxiv.org/pdf/2401.01234.pdf",
      gbrainSlug: "wiki/entities/papers/arxiv-2401-01234",
      checksum: expect.any(String),
    });
    expect(executed.plan.items.find((item) => item.title === "Missing Metadata Only Paper")).toMatchObject({
      status: "metadata_only",
      sourceUrl: "https://doi.org/10.3000/metadata",
      gbrainSlug: "wiki/entities/papers/doi-10-3000-metadata",
    });

    const store = getBrainStore({ root: brainRoot });
    const downloadedPage = await store.getPage("wiki/entities/papers/arxiv-2401-01234");
    expect(downloadedPage?.content).toContain("## Research Library Enrichment");
    expect(downloadedPage?.content).toContain("Source URL: https://arxiv.org/pdf/2401.01234.pdf");
    expect(downloadedPage?.content).toContain("### Imported PDF Text");
    expect(downloadedPage?.frontmatter.paper_library_enrichment).toMatchObject({
      project: "project-alpha",
      status: "downloaded",
      tool: "arxiv",
    });

    const metadataOnlyPage = await store.getPage("wiki/entities/papers/doi-10-3000-metadata");
    expect(metadataOnlyPage?.content).toContain("Download status: no legal open PDF was persisted");
    expect(metadataOnlyPage?.frontmatter.paper_library_enrichment).toMatchObject({
      project: "project-alpha",
      status: "metadata_persisted",
      source_url: "https://doi.org/10.3000/metadata",
    });

    const gapsRoute = await import("@/app/api/brain/paper-library/gaps/route");
    const gapsResponse = await gapsRoute.GET(new Request(
      "http://localhost/api/brain/paper-library/gaps?project=project-alpha&scanId=scan-1&limit=10",
    ));
    const gaps = await gapsResponse.json() as {
      suggestions: Array<{ title: string; state: string }>;
    };
    expect(gaps.suggestions.find((suggestion) => suggestion.title === "Missing Open Access Paper")).toMatchObject({
      state: "imported",
    });

    const enrichmentRoute = await import("@/app/api/brain/paper-library/enrichment/route");
    const enrichmentResponse = await enrichmentRoute.GET(new Request(
      "http://localhost/api/brain/paper-library/enrichment?project=project-alpha&question=Which%20papers%20improve%20this%20answer%3F",
    ));
    expect(enrichmentResponse.status).toBe(200);
    const enrichment = await enrichmentResponse.json() as {
      graph: {
        question: string;
        nodes: Array<{ title?: string; gbrainSlug?: string; localStatus: string }>;
      };
      suggestions: Array<{ title: string; downloadStatus: string; recommendedAction: string }>;
    };
    expect(enrichment.graph.question).toBe("Which papers improve this answer?");
    expect(enrichment.graph.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        gbrainSlug: "wiki/entities/papers/arxiv-2401-01234",
        localStatus: "gbrain_page",
      }),
    ]));
    expect(enrichment.suggestions.find((suggestion) => suggestion.title === "Missing Open Access Paper")).toMatchObject({
      downloadStatus: "already_local",
      recommendedAction: "cite_only",
    });
  });

  it("rejects re-executing a terminal acquisition plan without downloading again", async () => {
    const route = await import("@/app/api/brain/paper-library/acquisition/route");
    const createResponse = await route.POST(jsonRequest("http://localhost/api/brain/paper-library/acquisition", {
      action: "create",
      project: "project-alpha",
      scanId: "scan-1",
      limit: 1,
    }));
    const created = await createResponse.json() as { acquisitionPlanId: string };

    const firstExecute = await route.POST(jsonRequest("http://localhost/api/brain/paper-library/acquisition", {
      action: "execute",
      project: "project-alpha",
      acquisitionPlanId: created.acquisitionPlanId,
      userConfirmation: true,
    }));
    expect(firstExecute.status).toBe(200);
    expect(mockDownloadArxivPdf).toHaveBeenCalledTimes(1);
    mockDownloadArxivPdf.mockClear();

    const secondExecute = await route.POST(jsonRequest("http://localhost/api/brain/paper-library/acquisition", {
      action: "execute",
      project: "project-alpha",
      acquisitionPlanId: created.acquisitionPlanId,
      userConfirmation: true,
    }));

    expect(secondExecute.status).toBe(409);
    await expect(secondExecute.json()).resolves.toMatchObject({
      ok: false,
      error: {
        code: "invalid_state",
        message: 'Acquisition plan has already been executed with status "completed".',
      },
    });
    expect(mockDownloadArxivPdf).not.toHaveBeenCalled();
  });

  it("returns a typed conflict for concurrent execution of the same acquisition plan", async () => {
    const route = await import("@/app/api/brain/paper-library/acquisition/route");
    const createResponse = await route.POST(jsonRequest("http://localhost/api/brain/paper-library/acquisition", {
      action: "create",
      project: "project-alpha",
      scanId: "scan-1",
      limit: 1,
    }));
    const created = await createResponse.json() as { acquisitionPlanId: string };
    let releaseDownload!: () => void;
    let downloadStarted!: () => void;
    const releaseDownloadPromise = new Promise<void>((resolve) => {
      releaseDownload = resolve;
    });
    const downloadStartedPromise = new Promise<void>((resolve) => {
      downloadStarted = resolve;
    });
    mockDownloadArxivPdf.mockImplementationOnce(async (arxivId: string, destDir: string) => {
      downloadStarted();
      await releaseDownloadPromise;
      return copyFixturePdf(arxivId, destDir);
    });

    const firstExecutePromise = route.POST(jsonRequest("http://localhost/api/brain/paper-library/acquisition", {
      action: "execute",
      project: "project-alpha",
      acquisitionPlanId: created.acquisitionPlanId,
      userConfirmation: true,
    }));
    await downloadStartedPromise;

    const secondExecute = await route.POST(jsonRequest("http://localhost/api/brain/paper-library/acquisition", {
      action: "execute",
      project: "project-alpha",
      acquisitionPlanId: created.acquisitionPlanId,
      userConfirmation: true,
    }));
    expect(secondExecute.status).toBe(409);
    await expect(secondExecute.json()).resolves.toMatchObject({
      ok: false,
      error: {
        code: "job_already_running",
        message: "Acquisition plan is already running.",
      },
    });

    releaseDownload();
    const firstExecute = await firstExecutePromise;
    expect(firstExecute.status).toBe(200);
    expect(mockDownloadArxivPdf).toHaveBeenCalledTimes(1);
  });

  it("returns a typed conflict when an acquisition plan is already running", async () => {
    const route = await import("@/app/api/brain/paper-library/acquisition/route");
    const createResponse = await route.POST(jsonRequest("http://localhost/api/brain/paper-library/acquisition", {
      action: "create",
      project: "project-alpha",
      scanId: "scan-1",
      limit: 1,
    }));
    const created = await createResponse.json() as { acquisitionPlanId: string; plan: Record<string, unknown> };
    await writeFile(
      getPaperLibraryAcquisitionPlanPath("project-alpha", created.acquisitionPlanId, stateRoot()),
      JSON.stringify({ ...created.plan, status: "running" }),
      "utf-8",
    );

    const executeResponse = await route.POST(jsonRequest("http://localhost/api/brain/paper-library/acquisition", {
      action: "execute",
      project: "project-alpha",
      acquisitionPlanId: created.acquisitionPlanId,
      userConfirmation: true,
    }));

    expect(executeResponse.status).toBe(409);
    await expect(executeResponse.json()).resolves.toMatchObject({
      ok: false,
      error: {
        code: "job_already_running",
        message: "Acquisition plan is already running.",
      },
    });
  });

  it("returns a structured error when enrichment graph context fails", async () => {
    vi.doMock("@/lib/paper-library/library-enrichment", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@/lib/paper-library/library-enrichment")>();
      return {
        ...actual,
        buildLibraryCitationGraphContext: vi.fn(async () => {
          throw new Error("Malformed paper-library graph state.");
        }),
      };
    });
    const route = await import("@/app/api/brain/paper-library/enrichment/route");

    const response = await route.GET(new Request(
      "http://localhost/api/brain/paper-library/enrichment?project=project-alpha&scanId=scan-1",
    ));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: {
        code: "invalid_state",
        message: "Malformed paper-library graph state.",
      },
    });
  });

  it("rejects malformed enrichment refresh values before building context", async () => {
    const route = await import("@/app/api/brain/paper-library/enrichment/route");
    const response = await route.GET(new Request(
      "http://localhost/api/brain/paper-library/enrichment?project=project-alpha&question=Which%20papers%3F&refresh=maybe",
    ));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_state" },
    });
  });

  it("accepts case-insensitive true-like enrichment refresh values", async () => {
    const route = await import("@/app/api/brain/paper-library/enrichment/route");
    const response = await route.GET(new Request(
      "http://localhost/api/brain/paper-library/enrichment?project=project-alpha&question=Which%20papers%3F&refresh=TRUE",
    ));
    expect(response.status).toBe(200);
  });
});
