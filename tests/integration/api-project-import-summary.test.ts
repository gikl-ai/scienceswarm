import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ImportPreview } from "@/brain/types";
import { commitImportedProject } from "@/lib/import/commit-import";
import {
  getProjectImportSummaryPath,
  writeProjectImportSummary,
} from "@/lib/state/project-import-summary";

let tempDir: string | null = null;
let originalBrainRoot: string | undefined;
let originalScienceSwarmDir: string | undefined;

function buildPreview(): ImportPreview {
  return {
    analysis: "Local scan preview (local-scan)",
    backend: "local-scan",
    files: [
      {
        path: "notes/summary.md",
        type: "md",
        size: 42,
        hash: "hash-summary",
        classification: "text",
        projectCandidates: ["alpha-project"],
        warnings: [],
      },
      {
        path: "data/results.csv",
        type: "csv",
        size: 64,
        hash: "hash-results",
        classification: "data",
        projectCandidates: ["alpha-project"],
        warnings: [],
      },
    ],
    projects: [
      {
        slug: "alpha-project",
        title: "Alpha Project",
        confidence: "high",
        reason: "Imported from Alpha Project",
        sourcePaths: ["notes/summary.md", "data/results.csv"],
      },
    ],
    duplicateGroups: [
      {
        id: "dup-1",
        paths: ["notes/summary.md", "data/results.csv"],
        reason: "Identical content hash deadbeef",
      },
    ],
    warnings: [],
  };
}

async function createRoot(): Promise<string> {
  const tmpRoot = os.tmpdir();
  tempDir = await mkdtemp(path.join(tmpRoot, "scienceswarm-import-summary-"));
  return tempDir;
}

afterEach(async () => {
  vi.resetModules();
  vi.doUnmock("@/lib/state/project-import-summary");

  if (originalBrainRoot === undefined) {
    delete process.env.BRAIN_ROOT;
  } else {
    process.env.BRAIN_ROOT = originalBrainRoot;
  }
  originalBrainRoot = undefined;

  if (originalScienceSwarmDir === undefined) {
    delete process.env.SCIENCESWARM_DIR;
  } else {
    process.env.SCIENCESWARM_DIR = originalScienceSwarmDir;
  }
  originalScienceSwarmDir = undefined;

  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe("GET /api/projects/[slug]/import-summary", () => {
  it("returns the persisted import summary after a successful import commit", async () => {
    const root = await createRoot();
    originalBrainRoot = process.env.BRAIN_ROOT;
    originalScienceSwarmDir = process.env.SCIENCESWARM_DIR;
    process.env.SCIENCESWARM_DIR = root;

    const preview = buildPreview();
    await commitImportedProject(
      {
        folder: {
          name: "Alpha Project",
          basePath: "/tmp/alpha-project",
          backend: "local-scan",
          totalFiles: 2,
          detectedItems: 4,
          detectedBytes: 5120,
          files: [
            {
              path: "notes/summary.md",
              name: "summary.md",
              type: "md",
              size: 42,
              content: "# Summary\nAlpha project notes",
              hash: "hash-summary",
            },
            {
              path: "data/results.csv",
              name: "results.csv",
              type: "csv",
              size: 64,
              content: "gene,score\nfoo,1",
              hash: "hash-results",
            },
          ],
          analysis: "Approved import preview",
        },
        preview,
      },
    );

    const { GET } = await import("@/app/api/projects/[slug]/import-summary/route");
    const response = await GET(new Request("http://localhost/api/projects/alpha-project/import-summary"), {
      params: Promise.resolve({ slug: "alpha-project" }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.project).toBe("alpha-project");
    expect(body.lastImport).toMatchObject({
      name: "Alpha Project",
      preparedFiles: 1,
      detectedItems: 4,
      detectedBytes: 5120,
      duplicateGroups: 1,
      source: "local-scan",
    });
    expect(typeof body.lastImport.generatedAt).toBe("string");
  });

  it("returns null when no import summary exists yet", async () => {
    const root = await createRoot();
    originalBrainRoot = process.env.BRAIN_ROOT;
    originalScienceSwarmDir = process.env.SCIENCESWARM_DIR;
    process.env.SCIENCESWARM_DIR = root;

    const { GET } = await import("@/app/api/projects/[slug]/import-summary/route");
    const response = await GET(new Request("http://localhost/api/projects/alpha-project/import-summary"), {
      params: Promise.resolve({ slug: "alpha-project" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      project: "alpha-project",
      lastImport: null,
    });
  });

  it("rejects unsafe project slugs", async () => {
    const root = await createRoot();
    originalBrainRoot = process.env.BRAIN_ROOT;
    originalScienceSwarmDir = process.env.SCIENCESWARM_DIR;
    process.env.SCIENCESWARM_DIR = root;

    const { GET } = await import("@/app/api/projects/[slug]/import-summary/route");
    const response = await GET(new Request("http://localhost/api/projects/bad/slug/import-summary"), {
      params: Promise.resolve({ slug: "bad/slug" }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "Invalid project slug" });
  });

  it("returns a generic error when the summary lookup throws unexpectedly", async () => {
    const root = await createRoot();
    originalBrainRoot = process.env.BRAIN_ROOT;
    originalScienceSwarmDir = process.env.SCIENCESWARM_DIR;
    process.env.SCIENCESWARM_DIR = root;

    vi.resetModules();
    vi.doMock("@/lib/state/project-import-summary", async () => {
      const actual = await vi.importActual<typeof import("@/lib/state/project-import-summary")>(
        "@/lib/state/project-import-summary",
      );
      return {
        ...actual,
        readProjectImportSummary: vi.fn(async () => {
          throw new Error("secret filesystem detail");
        }),
      };
    });

    const { GET } = await import("@/app/api/projects/[slug]/import-summary/route");
    const response = await GET(new Request("http://localhost/api/projects/alpha-project/import-summary"), {
      params: Promise.resolve({ slug: "alpha-project" }),
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "Failed to read import summary",
    });
  });

  it("uses an explicit project-local state root for summary reads and writes", async () => {
    const root = await createRoot();
    originalBrainRoot = process.env.BRAIN_ROOT;
    originalScienceSwarmDir = process.env.SCIENCESWARM_DIR;
    process.env.SCIENCESWARM_DIR = root;

    const explicitStateRoot = path.join(root, "projects", "alpha-project", ".brain", "state");

    await writeProjectImportSummary("alpha-project", {
      name: "Alpha Project",
      preparedFiles: 12,
      generatedAt: "2026-04-11T00:00:00.000Z",
      source: "explicit-test",
    }, explicitStateRoot);

    expect(getProjectImportSummaryPath("alpha-project", explicitStateRoot)).toBe(
      path.join(explicitStateRoot, "import-summary.json"),
    );
  });

  it("falls back to a legacy summary under an explicit BRAIN_ROOT", async () => {
    const root = await createRoot();
    originalBrainRoot = process.env.BRAIN_ROOT;
    originalScienceSwarmDir = process.env.SCIENCESWARM_DIR;
    process.env.SCIENCESWARM_DIR = path.join(root, "data");
    process.env.BRAIN_ROOT = path.join(root, "legacy-brain");

    await writeProjectImportSummary(
      "alpha-project",
      {
        name: "Legacy Alpha Project",
        preparedFiles: 3,
        generatedAt: "2026-04-11T12:00:00.000Z",
        source: "local-scan",
      },
      path.join(process.env.BRAIN_ROOT, "state"),
    );

    const { GET } = await import("@/app/api/projects/[slug]/import-summary/route");
    const response = await GET(new Request("http://localhost/api/projects/alpha-project/import-summary"), {
      params: Promise.resolve({ slug: "alpha-project" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      project: "alpha-project",
      lastImport: {
        name: "Legacy Alpha Project",
        preparedFiles: 3,
        source: "local-scan",
      },
    });
  });
});
