import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrainConfig } from "@/brain/types";
import type { BrainHealthReport } from "@/brain/brain-health";

const mockLoadBrainConfig = vi.hoisted(() => vi.fn());
const mockGenerateHealthReportWithGbrain = vi.hoisted(() => vi.fn());
const mockProbeGbrainCapabilities = vi.hoisted(() => vi.fn());

vi.mock("@/brain/config", () => ({
  loadBrainConfig: mockLoadBrainConfig,
}));

vi.mock("@/brain/brain-health", () => ({
  generateHealthReportWithGbrain: mockGenerateHealthReportWithGbrain,
}));

vi.mock("@/brain/gbrain-capabilities", () => ({
  probeGbrainCapabilities: mockProbeGbrainCapabilities,
}));

function makeConfig(): BrainConfig {
  const root = mkdtempSync(join(tmpdir(), "scienceswarm-maintenance-route-"));
  return {
    root,
    extractionModel: "test",
    synthesisModel: "test",
    rippleCap: 15,
    paperWatchBudget: 50,
    serendipityRate: 0.2,
  };
}

function makeReport(
  overrides: Partial<BrainHealthReport> = {},
): BrainHealthReport {
  return {
    generatedAt: "2026-04-16T00:00:00.000Z",
    source: "gbrain",
    score: 81,
    brainScore: 81,
    embedCoverage: 0.8,
    issueCounts: {
      stalePages: 0,
      orphanPages: 2,
      deadLinks: 0,
      missingEmbeddings: 5,
    },
    coverage: {
      totalPages: 12,
      papersWithAbstracts: 0,
      papersWithoutAbstracts: 0,
      papersWithCitations: 0,
      authorPagesCount: 0,
      conceptPagesCount: 0,
      coveragePercent: 80,
    },
    orphans: [],
    stalePages: [],
    missingLinks: [],
    embeddingGaps: 5,
    suggestions: [],
    ...overrides,
  };
}

function makeGetRequest(jobId?: string): Request {
  const url = new URL("http://localhost/api/brain/maintenance");
  if (jobId) {
    url.searchParams.set("jobId", jobId);
  }
  return new Request(url, { method: "GET" });
}

describe("GET /api/brain/maintenance", () => {
  let roots: string[] = [];

  beforeEach(() => {
    roots = [];
    vi.resetModules();
    mockLoadBrainConfig.mockReset();
    mockGenerateHealthReportWithGbrain.mockReset();
    mockProbeGbrainCapabilities.mockReset();
    mockProbeGbrainCapabilities.mockResolvedValue(undefined);
  });

  afterEach(() => {
    for (const root of roots) {
      rmSync(root, { recursive: true, force: true });
    }
    roots = [];
  });

  it("returns 503 when no brain is configured", async () => {
    mockLoadBrainConfig.mockReturnValue(null);
    const { GET } = await import("@/app/api/brain/maintenance/route");

    const response = await GET(makeGetRequest());

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error).toContain("No research brain is initialized yet");
    expect(body.code).toBe("brain_not_initialized");
    expect(body.details).not.toHaveProperty("brainRoot");
  });

  it("does not contradict brainMdExists in the not-initialized cause", async () => {
    const previousBrainRoot = process.env.BRAIN_ROOT;
    const root = mkdtempSync(join(tmpdir(), "scienceswarm-missing-config-"));
    roots.push(root);
    writeFileSync(join(root, "BRAIN.md"), "# Test Researcher\n");
    process.env.BRAIN_ROOT = root;

    try {
      mockLoadBrainConfig.mockReturnValue(null);
      const { GET } = await import("@/app/api/brain/maintenance/route");

      const response = await GET(makeGetRequest());

      expect(response.status).toBe(503);
      const body = await response.json();
      expect(body.details).toMatchObject({
        rootExists: true,
        brainMdExists: true,
      });
      expect(body.cause).toBe(
        "The brain root and BRAIN.md exist, but the configuration could not be loaded.",
      );
      expect(body.cause).not.toContain(root);
    } finally {
      if (previousBrainRoot === undefined) {
        delete process.env.BRAIN_ROOT;
      } else {
        process.env.BRAIN_ROOT = previousBrainRoot;
      }
    }
  });

  it("returns read-only maintenance recommendations", async () => {
    const config = makeConfig();
    roots.push(config.root);
    mockLoadBrainConfig.mockReturnValue(config);
    mockGenerateHealthReportWithGbrain.mockResolvedValue(makeReport());
    const { GET } = await import("@/app/api/brain/maintenance/route");

    const response = await GET(makeGetRequest());

    expect(response.status).toBe(200);
    expect(mockGenerateHealthReportWithGbrain).toHaveBeenCalledWith(config);
    const body = await response.json();
    expect(body).toMatchObject({
      source: "gbrain",
      score: 81,
      signals: {
        totalPages: 12,
        orphanPages: 2,
        missingEmbeddings: 5,
      },
    });
    expect(body.recommendations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "refresh-embeddings" }),
        expect.objectContaining({ id: "extract-links" }),
      ]),
    );
  });

  it("exposes structural capability state without enabling controls unless all gates pass", async () => {
    const config = makeConfig();
    roots.push(config.root);
    mockLoadBrainConfig.mockReturnValue(config);
    mockGenerateHealthReportWithGbrain.mockResolvedValue(makeReport());
    mockProbeGbrainCapabilities.mockResolvedValue({
      structuralNavigationAvailable: false,
      package: {
        requiredVersion: "0.21.0",
        requiredCommit: "f718c595b3a382b2a9a6a1f6553448ad047b5e94",
        expectedVersion: "0.21.0",
        expectedResolved: "git+ssh://git@github.com/garrytan/gbrain.git#f718c595b3a382b2a9a6a1f6553448ad047b5e94",
        installedVersion: "0.21.0",
        installedName: "gbrain",
        binPath: "/repo/node_modules/.bin/gbrain",
        binExists: true,
        inSync: true,
        ready: true,
      },
      doctor: {
        ok: true,
        schemaVersion: 29,
        rawStatus: "ready",
        message: "Version 29 (latest: 29)",
      },
      schema: {
        requiredVersion: 28,
        observedVersion: 29,
        requiredFieldsPresent: true,
        missingFields: [],
        rawStatus: "ready",
      },
      operations: {
        required: ["code-def", "code-refs", "code-callers", "code-callees", "reindex-code"],
        available: ["code-def", "code-refs", "code-callers", "code-callees", "reindex-code"],
        missing: [],
        rawStatus: "ready",
      },
      chunker: {
        requiredVersion: "4",
        sourceVersions: ["3"],
        supported: false,
        rawStatus: "degraded",
      },
      reindex: {
        status: "required",
        reason: "At least one source reports an older chunker version.",
      },
      blockers: ["one or more sources need explicit code reindexing."],
    });
    const { GET } = await import("@/app/api/brain/maintenance/route");

    const response = await GET(makeGetRequest());

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.signals.gbrainCapabilities).toMatchObject({
      structuralNavigationAvailable: false,
      package: { binPath: "[redacted]" },
      reindex: { status: "required" },
    });
    expect(body.signals.gbrainCapabilities.blockers).toContain(
      "one or more sources need explicit code reindexing.",
    );
  });

  it("keeps structural capability blockers visible when health falls back to disk", async () => {
    const config = makeConfig();
    roots.push(config.root);
    mockLoadBrainConfig.mockReturnValue(config);
    mockGenerateHealthReportWithGbrain.mockResolvedValue(makeReport({
      source: "disk-fallback",
      score: 60,
    }));
    mockProbeGbrainCapabilities.mockResolvedValue({
      structuralNavigationAvailable: false,
      package: {
        requiredVersion: "0.21.0",
        requiredCommit: "f718c595b3a382b2a9a6a1f6553448ad047b5e94",
        expectedVersion: "0.21.0",
        expectedResolved: "git+ssh://git@github.com/garrytan/gbrain.git#f718c595b3a382b2a9a6a1f6553448ad047b5e94",
        installedVersion: "0.21.0",
        installedName: "gbrain",
        binPath: "/repo/node_modules/.bin/gbrain",
        binExists: true,
        inSync: true,
        ready: true,
      },
      doctor: {
        ok: false,
        schemaVersion: null,
        rawStatus: "unknown",
        message: "column \"symbol_name\" does not exist",
      },
      schema: {
        requiredVersion: 28,
        observedVersion: null,
        requiredFieldsPresent: false,
        missingFields: ["content_chunks.symbol_name"],
        rawStatus: "unknown",
      },
      operations: {
        required: ["code-def", "code-refs", "code-callers", "code-callees", "reindex-code"],
        available: ["code-def", "code-refs", "code-callers", "code-callees", "reindex-code"],
        missing: [],
        rawStatus: "ready",
      },
      chunker: {
        requiredVersion: "4",
        sourceVersions: [],
        supported: true,
        rawStatus: "ready",
      },
      reindex: {
        status: "unknown",
        reason: "Local gbrain schema metadata was unavailable.",
      },
      blockers: ["local schema is missing required structural fields."],
    });
    const { GET } = await import("@/app/api/brain/maintenance/route");

    const response = await GET(makeGetRequest());

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.source).toBe("disk-fallback");
    expect(body.signals.gbrainCapabilities).toMatchObject({
      structuralNavigationAvailable: false,
      package: { binPath: "[redacted]" },
      schema: { missingFields: ["content_chunks.symbol_name"] },
    });
  });

  it("does not leak internal errors from maintenance plan generation", async () => {
    const config = makeConfig();
    roots.push(config.root);
    mockLoadBrainConfig.mockReturnValue(config);
    mockGenerateHealthReportWithGbrain.mockRejectedValue(
      new Error("database path /tmp/private/brain.pglite is corrupt"),
    );
    const { GET } = await import("@/app/api/brain/maintenance/route");

    const response = await GET(makeGetRequest());

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "Maintenance plan generation failed",
    });
  });

  it("creates and returns a dry-run maintenance job preview", async () => {
    const config = makeConfig();
    roots.push(config.root);
    mkdirSync(join(config.root, "wiki"), { recursive: true });
    writeFileSync(
      join(config.root, "wiki", "source.md"),
      [
        "# Source",
        "",
        "[Target](target.md)",
        "",
        "- **2026-04-16** | Lab notebook - Captured result.",
      ].join("\n"),
      "utf-8",
    );
    mockLoadBrainConfig.mockReturnValue(config);
    mockGenerateHealthReportWithGbrain.mockResolvedValue(makeReport());
    const { GET, POST } = await import("@/app/api/brain/maintenance/route");

    const response = await POST(
      new Request("http://localhost/api/brain/maintenance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "extract-links", mode: "dry-run" }),
      }),
    );

    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body).toMatchObject({
      ok: true,
      job: {
        action: "extract-links",
        mode: "dry-run",
        status: "completed",
        result: {
          metrics: {
            pages: 1,
            linkCandidates: 1,
          },
        },
      },
    });

    const poll = await GET(
      makeGetRequest(body.job.id),
    );
    expect(poll.status).toBe(200);
    await expect(poll.json()).resolves.toMatchObject({
      id: body.job.id,
      status: "completed",
    });
  });

  it("surfaces the research-layout bridge recommendation when legacy homes remain", async () => {
    const config = makeConfig();
    roots.push(config.root);
    mkdirSync(join(config.root, "concepts"), { recursive: true });
    writeFileSync(join(config.root, "concepts", "rlhf.md"), "# RLHF\n", "utf-8");
    mockLoadBrainConfig.mockReturnValue(config);
    mockGenerateHealthReportWithGbrain.mockResolvedValue(
      makeReport({
        score: 95,
        brainScore: 95,
        embedCoverage: 0.99,
        issueCounts: {
          stalePages: 0,
          orphanPages: 0,
          deadLinks: 0,
          missingEmbeddings: 0,
        },
        embeddingGaps: 0,
      }),
    );
    const { GET } = await import("@/app/api/brain/maintenance/route");

    const response = await GET(makeGetRequest());

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.recommendations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "bridge-research-layout" }),
      ]),
    );
  });

  it("returns a research-layout dry-run preview through the maintenance route", async () => {
    const config = makeConfig();
    roots.push(config.root);
    mkdirSync(join(config.root, "concepts"), { recursive: true });
    writeFileSync(join(config.root, "concepts", "rlhf.md"), "# RLHF\n", "utf-8");
    mockLoadBrainConfig.mockReturnValue(config);
    const { POST } = await import("@/app/api/brain/maintenance/route");

    const response = await POST(
      new Request("http://localhost/api/brain/maintenance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "bridge-research-layout", mode: "dry-run" }),
      }),
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      job: {
        action: "bridge-research-layout",
        mode: "dry-run",
        status: "completed",
        result: {
          metrics: {
            legacyHomesDetected: 1,
            bridgeableHomes: 1,
          },
        },
      },
    });
  });

  it("sanitizes persisted maintenance job errors before returning them", async () => {
    const config = makeConfig();
    roots.push(config.root);
    const jobId = "00000000-0000-4000-8000-000000000001";
    mkdirSync(join(config.root, "state", "maintenance-jobs"), { recursive: true });
    writeFileSync(
      join(config.root, "state", "maintenance-jobs", `${jobId}.json`),
      JSON.stringify({
        id: jobId,
        action: "extract-links",
        mode: "start",
        status: "failed",
        createdAt: "2026-04-16T00:00:00.000Z",
        updatedAt: "2026-04-16T00:00:01.000Z",
        storeId: "store",
        progress: {
          phase: "failed",
          message: "Maintenance job failed.",
        },
        result: null,
        error: "raw database path /tmp/private/brain.pglite failed",
      }),
      "utf-8",
    );
    mockLoadBrainConfig.mockReturnValue(config);
    const { GET } = await import("@/app/api/brain/maintenance/route");

    const response = await GET(
      makeGetRequest(jobId),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: jobId,
      status: "failed",
      error: "Maintenance job failed. Check server logs for details.",
    });
  });

  it("requires a dry-run preview before starting a mutating job", async () => {
    const config = makeConfig();
    roots.push(config.root);
    mockLoadBrainConfig.mockReturnValue(config);
    const { POST } = await import("@/app/api/brain/maintenance/route");

    const response = await POST(
      new Request("http://localhost/api/brain/maintenance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "extract-links", mode: "start" }),
      }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("dry-run preview"),
    });
  });
});
