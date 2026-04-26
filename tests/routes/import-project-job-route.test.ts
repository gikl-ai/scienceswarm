import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  pageFileRefFromObject,
  toFileObjectId,
  type GbrainFileObject,
  type IngestInputFile,
  type IngestSuccess,
} from "@/brain/gbrain-data-contracts";
import type { GbrainClient } from "@/brain/gbrain-client";
import { initBrain } from "@/brain/init";
import type { IngestService } from "@/brain/ingest/service";
import { getLegacyProjectStudyFilePath } from "@/lib/studies/state";

const mockIsLocal = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
const ORIGINAL_SCIENCESWARM_DIR = process.env.SCIENCESWARM_DIR;
const ORIGINAL_SCIENCESWARM_USER_HANDLE = process.env.SCIENCESWARM_USER_HANDLE;

vi.mock("@/lib/local-guard", () => ({
  isLocalRequest: () => mockIsLocal(),
}));

let dataRoot: string;
let importRoot: string;

async function waitForCompletedJob(
  GET: (request: Request) => Promise<Response>,
  jobId: string,
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const pollResponse = await GET(new Request(`http://localhost/api/brain/import-project-job?id=${jobId}`));
    expect(pollResponse.status).toBe(200);
    const body = await pollResponse.json() as Record<string, unknown>;
    if (body.status === "completed") {
      return body;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error(`Timed out waiting for import job ${jobId}`);
}

function fakeGbrain(): GbrainClient {
  return {
    async putPage() {
      return { stdout: "", stderr: "" };
    },
    async linkPages() {
      return { stdout: "", stderr: "" };
    },
  };
}

function buildSuccess(input: IngestInputFile, type: IngestSuccess["type"]): IngestSuccess {
  const sha256 = createHash("sha256").update(input.relativePath ?? input.filename).digest("hex");
  const file: GbrainFileObject = {
    id: toFileObjectId(sha256),
    sha256,
    sizeBytes: input.sizeBytes,
    mime: input.mime,
    originalFilename: input.relativePath ?? input.filename,
    project: input.project,
    uploadedAt: "2026-04-16T00:00:00.000Z",
    uploadedBy: input.uploadedBy,
    source: input.source,
    storagePath: `objects/files/${sha256}`,
    contentEncoding: "raw",
  };
  const slugBase = (input.relativePath ?? input.filename)
    .replace(/\.[^.]+$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
  const suffix = type === "dataset" ? "-dataset" : type === "code" ? "-code" : "";
  return {
    slug: `${slugBase}${suffix}`,
    type,
    file,
    pageFileRef: pageFileRefFromObject(file, "source", input.relativePath ?? input.filename),
  };
}

describe("background import project job route", () => {
  beforeEach(async () => {
    vi.resetModules();
    mockIsLocal.mockResolvedValue(true);

    dataRoot = await mkdtemp(path.join(os.tmpdir(), "scienceswarm-import-job-"));
    process.env.SCIENCESWARM_DIR = dataRoot;
    process.env.SCIENCESWARM_USER_HANDLE = "@import-job-test";
    initBrain({ root: path.join(dataRoot, "brain"), name: "Test Researcher" });

    const homeTmp = path.join(os.homedir(), "tmp");
    await mkdir(homeTmp, { recursive: true });
    importRoot = await mkdtemp(path.join(homeTmp, "scienceswarm-import-job-source-"));
    await writeFile(path.join(importRoot, "README.md"), "# Project Alpha\n\nBackground import.\n", "utf-8");
    await writeFile(path.join(importRoot, "notes.md"), "Imported notes.\n", "utf-8");
    await writeFile(path.join(importRoot, "notes-copy.md"), "Imported notes.\n", "utf-8");
  });

  afterEach(async () => {
    if (ORIGINAL_SCIENCESWARM_DIR) {
      process.env.SCIENCESWARM_DIR = ORIGINAL_SCIENCESWARM_DIR;
    } else {
      delete process.env.SCIENCESWARM_DIR;
    }
    if (ORIGINAL_SCIENCESWARM_USER_HANDLE) {
      process.env.SCIENCESWARM_USER_HANDLE = ORIGINAL_SCIENCESWARM_USER_HANDLE;
    } else {
      delete process.env.SCIENCESWARM_USER_HANDLE;
    }
    await import("@/lib/import/background-import-job").then((module) => {
      module.__setBackgroundImportGbrainDepsOverride(null);
    }).catch(() => {});
    await import("@/brain/store").then((module) => module.resetBrainStore()).catch(() => {});
    await rm(dataRoot, { recursive: true, force: true });
    await rm(importRoot, { recursive: true, force: true });
  });

  it("starts a local background import and persists the completed job", async () => {
    await writeFile(path.join(importRoot, ".DS_Store"), "Finder metadata", "utf-8");

    const { GET, POST } = await import("@/app/api/brain/import-project-job/route");

    const startResponse = await POST(new Request("http://localhost/api/brain/import-project-job", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "start",
        path: importRoot,
        projectSlug: "project-alpha",
      }),
    }));

    expect(startResponse.status).toBe(200);
    const started = await startResponse.json() as {
      ok: boolean;
      job: { id: string; status: string };
    };
    expect(started.ok).toBe(true);
    expect(started.job.status).toBe("queued");

    const completed = await waitForCompletedJob(GET, started.job.id);

    expect(completed).toMatchObject({
      id: started.job.id,
      project: "project-alpha",
      status: "completed",
      result: {
        project: "project-alpha",
        importedFiles: 2,
        detectedItems: 3,
        duplicateGroups: 1,
      },
    });

    const persistedJob = await readFile(
      path.join(dataRoot, "brain", "state", "import-jobs", `${started.job.id}.json`),
      "utf-8",
    );
    expect(persistedJob).toContain("\"status\": \"completed\"");
    expect(persistedJob).toContain("\"duplicateGroups\": 1");

    const importSummary = await readFile(
      getLegacyProjectStudyFilePath("project-alpha", "import-summary.json"),
      "utf-8",
    );
    expect(importSummary).toContain("\"preparedFiles\": 2");
    expect(importSummary).toContain("\"source\": \"background-local-import\"");

    const importSource = await readFile(
      getLegacyProjectStudyFilePath("project-alpha", "import-source.json"),
      "utf-8",
    );
    expect(importSource).toContain(`"folderPath": ${JSON.stringify(importRoot)}`);

    await expect(
      readFile(path.join(dataRoot, "projects", "project-alpha", "docs", "README.md"), "utf-8"),
    ).resolves.toContain("# Project Alpha");
    await expect(
      readFile(path.join(dataRoot, "projects", "project-alpha", ".DS_Store"), "utf-8"),
    ).rejects.toThrow();
    const importedNotesPath = (
      await import("node:fs/promises").then(async ({ access }) => {
        const preferred = path.join(dataRoot, "projects", "project-alpha", "docs", "notes.md");
        try {
          await access(preferred);
          return preferred;
        } catch {
          return path.join(dataRoot, "projects", "project-alpha", "docs", "notes-copy.md");
        }
      })
    );
    await expect(readFile(importedNotesPath, "utf-8")).resolves.toContain("Imported notes.");
  });

  it("uses IngestService for supported PDF, CSV, and code files", async () => {
    const supportedRoot = await mkdtemp(path.join(os.homedir(), "tmp", "scienceswarm-supported-import-"));
    const captured: IngestInputFile[] = [];
    const ingestService: IngestService = {
      async ingestFiles(files) {
        captured.push(...files);
        return {
          slugs: files.map((file) => {
            if (file.filename.endsWith(".csv")) return buildSuccess(file, "dataset");
            if (file.filename.endsWith(".py")) return buildSuccess(file, "code");
            return buildSuccess(file, "paper");
          }),
          errors: [],
        };
      },
      async attachSourceFile() {
        throw new Error("supported files should not use source fallback");
      },
      async attachArtifactFile() {
        throw new Error("supported files should not use artifact fallback");
      },
    };

    try {
      await mkdir(path.join(supportedRoot, "papers"), { recursive: true });
      await mkdir(path.join(supportedRoot, "data"), { recursive: true });
      await mkdir(path.join(supportedRoot, "code"), { recursive: true });
      await writeFile(path.join(supportedRoot, "papers", "paper.pdf"), Buffer.from("%PDF-1.4\n%%EOF\n"));
      await writeFile(path.join(supportedRoot, "data", "results.csv"), "gene,score\nabc,1\n", "utf-8");
      await writeFile(path.join(supportedRoot, "code", "analysis.py"), "print('ok')\n", "utf-8");

      const backgroundModule = await import("@/lib/import/background-import-job");
      backgroundModule.__setBackgroundImportGbrainDepsOverride({
        gbrain: fakeGbrain(),
        ingestService,
        uploadedBy: "@import-job-test",
      });
      const { GET, POST } = await import("@/app/api/brain/import-project-job/route");

      const startResponse = await POST(new Request("http://localhost/api/brain/import-project-job", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "start",
          path: supportedRoot,
          projectSlug: "project-alpha",
        }),
      }));
      const started = await startResponse.json() as { job: { id: string } };
      const completed = await waitForCompletedJob(GET, started.job.id);

      expect(completed).toMatchObject({
        status: "completed",
        result: {
          importedFiles: 3,
          sourcePageCount: 3,
        },
      });
      expect(captured.map((input) => input.filename).sort()).toEqual([
        "analysis.py",
        "paper.pdf",
        "results.csv",
      ]);
      expect(captured.map((input) => input.relativePath).sort()).toEqual([
        "code/analysis.py",
        "data/results.csv",
        "papers/paper.pdf",
      ]);
      expect(captured.every((input) => input.source.kind === "commit_import")).toBe(true);
    } finally {
      await rm(supportedRoot, { recursive: true, force: true });
    }
  });

  it("preserves original bytes for unparseable files copied into the workspace", async () => {
    const binaryPath = path.join(importRoot, "figures", "plot.bin");
    await mkdir(path.dirname(binaryPath), { recursive: true });
    const original = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03]);
    await writeFile(binaryPath, original);

    const { GET, POST } = await import("@/app/api/brain/import-project-job/route");
    const startResponse = await POST(new Request("http://localhost/api/brain/import-project-job", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "start",
        path: importRoot,
        projectSlug: "project-alpha",
      }),
    }));

    const started = await startResponse.json() as { job: { id: string } };
    const completed = await waitForCompletedJob(GET, started.job.id) as {
      result?: { warnings?: Array<{ code: string; message: string }> };
    };

    const copied = await readFile(path.join(dataRoot, "projects", "project-alpha", "figures", "plot.bin"));
    expect(Buffer.compare(copied, original)).toBe(0);
    expect(completed.result?.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "source-fallback-unsupported",
        message: expect.stringContaining("figures/plot.bin"),
      }),
    ]));
  });

  it("fails background import start with a clear attribution preflight error", async () => {
    delete process.env.SCIENCESWARM_USER_HANDLE;
    const { POST } = await import("@/app/api/brain/import-project-job/route");

    const response = await POST(new Request("http://localhost/api/brain/import-project-job", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "start",
        path: importRoot,
        projectSlug: "project-alpha",
      }),
    }));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("Cannot start background folder import because SCIENCESWARM_USER_HANDLE is not configured"),
    });
    await expect(
      readFile(path.join(dataRoot, "brain", "state", "import-jobs"), "utf-8"),
    ).rejects.toThrow();
  });

  it("refreshes the workspace file tree from gbrain state after import", async () => {
    await mkdir(path.join(importRoot, "data"), { recursive: true });
    await mkdir(path.join(importRoot, "code"), { recursive: true });
    await writeFile(path.join(importRoot, "data", "results.csv"), "gene,score\nabc,1\n", "utf-8");
    await writeFile(path.join(importRoot, "code", "analysis.py"), "print('ok')\n", "utf-8");
    const { GET, POST } = await import("@/app/api/brain/import-project-job/route");

    const startResponse = await POST(new Request("http://localhost/api/brain/import-project-job", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "start",
        path: importRoot,
        projectSlug: "project-alpha",
      }),
    }));

    const started = await startResponse.json() as { job: { id: string } };
    await waitForCompletedJob(GET, started.job.id);
    await rm(path.join(dataRoot, "projects", "project-alpha"), { recursive: true, force: true });
    await rm(importRoot, { recursive: true, force: true });

    const workspaceRoute = await import("@/app/api/workspace/route");
    const treeResponse = await workspaceRoute.GET(
      new Request("http://localhost/api/workspace?action=tree&projectId=project-alpha"),
    );
    const treeBody = await treeResponse.json() as {
      tree: Array<{ name: string; type: string; children?: Array<{ name: string }> }>;
      totalFiles: number;
    };

    expect(treeResponse.status).toBe(200);
    expect(treeBody.totalFiles).toBeGreaterThanOrEqual(2);
    const dataDir = treeBody.tree.find((node) => node.name === "data");
    const codeDir = treeBody.tree.find((node) => node.name === "code");
    expect(dataDir?.children).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "results.csv" }),
    ]));
    expect(codeDir?.children).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "analysis.py" }),
    ]));
  });

  it("rejects polling requests with an invalid job id", async () => {
    const { GET } = await import("@/app/api/brain/import-project-job/route");

    const response = await GET(new Request("http://localhost/api/brain/import-project-job?id=../brain/state/secrets"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "id is required and must be a valid job ID",
    });
  });

  it("fails stale queued jobs that no longer have a live worker", async () => {
    const { GET } = await import("@/app/api/brain/import-project-job/route");

    const staleId = "00000000-0000-4000-8000-000000000001";
    const staleJobPath = path.join(dataRoot, "brain", "state", "import-jobs", `${staleId}.json`);
    await mkdir(path.dirname(staleJobPath), { recursive: true });
    await writeFile(
      staleJobPath,
      JSON.stringify({
        id: staleId,
        project: "project-alpha",
        folderName: "project-alpha",
        folderPath: importRoot,
        status: "queued",
        createdAt: "2026-04-11T12:00:00.000Z",
        updatedAt: "2026-04-11T12:00:00.000Z",
        progress: {
          phase: "importing",
          detectedFiles: 8,
          detectedItems: 12,
          detectedBytes: 1024,
          importedFiles: 4,
          skippedDuplicates: 2,
          duplicateGroups: 1,
          currentPath: "notes/summary.md",
        },
        result: null,
        error: null,
      }, null, 2),
      "utf-8",
    );

    const response = await GET(new Request(`http://localhost/api/brain/import-project-job?id=${staleId}`));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: staleId,
      status: "failed",
      error: "Background import worker stopped before completion after 12 items scanned, 4 unique files imported, 2 duplicate files skipped. Re-scan the local folder to restart it.",
    });

    const persisted = await readFile(staleJobPath, "utf-8");
    expect(persisted).toContain("\"status\": \"failed\"");
    expect(persisted).toContain("12 items scanned, 4 unique files imported, 2 duplicate files skipped");
  });
});
