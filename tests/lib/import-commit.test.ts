import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GbrainClient } from "@/brain/gbrain-client";
import {
  type IngestError,
  type IngestInputFile,
  type IngestSuccess,
  pageFileRefFromObject,
  toFileObjectId,
} from "@/brain/gbrain-data-contracts";
import type { IngestService } from "@/brain/ingest/service";
import type { ImportPreview } from "@/brain/types";
import type { ImportCommitRequest } from "@/lib/import/commit-import";
import {
  commitImportedProject,
  getImportedWorkspacePath,
} from "@/lib/import/commit-import";
import {
  getLegacyProjectManifestPath,
} from "@/lib/state/project-storage";
import { getLegacyProjectStudyFilePath } from "@/lib/studies/state";
import { hashContent } from "@/lib/workspace-manager";

const ROOT = join(tmpdir(), "scienceswarm-import-commit-test");

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

function buildPreview(): ImportPreview {
  return {
    analysis: "Import preview (local-scan)",
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
    duplicateGroups: [],
    warnings: [],
  };
}

function fakeGbrain(calls: Array<{ slug: string; content: string }>): GbrainClient {
  return {
    async putPage(slug, content) {
      calls.push({ slug, content });
      return { stdout: "", stderr: "" };
    },
    async linkPages() {
      return { stdout: "", stderr: "" };
    },
  };
}

function fakeIngestService(
  attached: IngestInputFile[],
  ingested: IngestInputFile[] = [],
  options: {
    ingestError?: IngestError;
    attachError?: IngestError;
  } = {},
): IngestService {
  return {
    async ingestFiles(files) {
      ingested.push(...files);
      if (options.ingestError) {
        return {
          slugs: [],
          errors: files.map((file) => ({ ...options.ingestError!, filename: file.filename })),
        };
      }
      return {
        slugs: await Promise.all(files.map((input) => attach(input, ingestSlug(input), ingestType(input)))),
        errors: [],
      };
    },
    async attachArtifactFile(input) {
      const success = await attach(input, input.pageSlug, "artifact");
      return { ...success, type: "artifact" };
    },
    async attachSourceFile(input) {
      if (options.attachError) {
        return { ...options.attachError, filename: input.filename };
      }
      return attach(input, input.pageSlug, "source");
    },
  };

  async function attach(
    input: IngestInputFile,
    pageSlug: string,
    type: IngestSuccess["type"],
  ): Promise<IngestSuccess> {
    attached.push(input);
    const sha256 = createHash("sha256").update(input.relativePath ?? input.filename).digest("hex");
    const file = {
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
      contentEncoding: "raw" as const,
    };
    return {
      slug: pageSlug,
      type,
      file,
      pageFileRef: pageFileRefFromObject(file, "source", input.relativePath ?? input.filename),
    };
  }

  function ingestType(input: IngestInputFile): IngestSuccess["type"] {
    if (input.filename.endsWith(".csv") || input.filename.endsWith(".tsv")) return "dataset";
    if (input.filename.endsWith(".pdf")) return "paper";
    return "code";
  }

  function ingestSlug(input: IngestInputFile): string {
    const base = (input.relativePath ?? input.filename)
      .replace(/\.[^.]+$/, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/-+/g, "-");
    const type = ingestType(input);
    return `${base}${type === "dataset" ? "-dataset" : type === "code" ? "-code" : ""}`;
  }
}

describe("commitImportedProject", () => {
  it("writes project pages, source pages, and deduped manifest source refs", async () => {
    const preview = buildPreview();
    const request: ImportCommitRequest = {
      folder: {
        name: "Alpha Project",
        basePath: "/tmp/alpha-project",
        totalFiles: 2,
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
            metadata: { rows: 1, columns: 2 },
          },
        ],
        analysis: "Approved import preview",
      },
      preview,
    };

    const first = await commitImportedProject(request, ROOT);
    const second = await commitImportedProject(request, ROOT);
    const summaryPath = `wiki/resources/imports/alpha-project/notes-summary-${hashContent("notes/summary.md").slice(0, 8)}.md`;
    const resultsPath = `wiki/resources/data/imports/alpha-project/data-results.csv-${hashContent("data/results.csv").slice(0, 8)}.md`;

    expect(first.project).toBe("alpha-project");
    expect(first.projectPagePath).toBe("wiki/projects/alpha-project.md");
    expect(first.manifestPath).toBe(getLegacyProjectManifestPath("alpha-project", join(ROOT, "state")));
    expect(first.sourcePagePaths).toEqual([summaryPath, resultsPath]);
    expect(existsSync(join(ROOT, first.projectPagePath))).toBe(true);
    expect(existsSync(join(ROOT, first.sourcePagePaths[0]))).toBe(true);
    expect(existsSync(join(ROOT, first.sourcePagePaths[1]))).toBe(true);

    const projectPage = readFileSync(join(ROOT, first.projectPagePath), "utf-8");
    expect(projectPage).toContain("type: project");
    expect(projectPage).toContain('source_refs: [{"kind":"import","ref":"notes/summary.md","hash":"hash-summary"}');
    expect(projectPage).toContain(`[[${summaryPath}]]`);

    const sourcePage = readFileSync(join(ROOT, first.sourcePagePaths[1]), "utf-8");
    expect(sourcePage).toContain("type: data");
    expect(sourcePage).toContain('tags: ["import","data"]');
    expect(sourcePage).toContain('format: "csv"');
    expect(sourcePage).toContain('import_classification: "data"');
    expect(sourcePage).toContain("## Metadata");
    expect(sourcePage).toContain('{"rows":1,"columns":2}');

    const manifest = JSON.parse(readFileSync(first.manifestPath, "utf-8"));
    expect(manifest.slug).toBe("alpha-project");
    expect(manifest.projectPagePath).toBe("wiki/projects/alpha-project.md");
    expect(manifest.sourceRefs).toEqual([
      { kind: "import", ref: "notes/summary.md", hash: "hash-summary" },
      { kind: "import", ref: "data/results.csv", hash: "hash-results" },
    ]);
    expect(manifest.dedupeKeys).toEqual([
      "import:notes/summary.md:hash-summary",
      "import:data/results.csv:hash-results",
    ]);

    const secondManifest = JSON.parse(readFileSync(second.manifestPath, "utf-8"));
    expect(secondManifest.sourceRefs).toHaveLength(2);
    expect(secondManifest.dedupeKeys).toHaveLength(2);
  });

  it("routes supported files through canonical ingest and keeps unsupported source fallback narrow", async () => {
    const preview = buildPreview();
    const request: ImportCommitRequest = {
      folder: {
        name: "Alpha Project",
        basePath: "/tmp/alpha-project",
        totalFiles: 2,
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
    };
    const attached: IngestInputFile[] = [];
    const ingested: IngestInputFile[] = [];
    const pages: Array<{ slug: string; content: string }> = [];

    const result = await commitImportedProject(request, ROOT, {
      enableGbrain: true,
      uploadedBy: "@tester",
      gbrain: fakeGbrain(pages),
      ingestService: fakeIngestService(attached, ingested),
    });

    expect(result.sourcePagePaths).toHaveLength(2);
    expect(ingested.map((file) => file.filename)).toEqual(["results.csv"]);
    expect(ingested.map((file) => file.relativePath)).toEqual(["data/results.csv"]);
    expect(attached.map((file) => file.relativePath)).toEqual([
      "notes/summary.md",
      "data/results.csv",
    ]);
    expect(attached[0].uploadedBy).toBe("@tester");
    expect(attached[0].source).toEqual({
      kind: "commit_import",
      sourcePath: "notes/summary.md",
    });
    expect(pages.map((page) => page.slug)).toEqual([
      result.sourcePagePaths[0].replace(/^wiki\//, "").replace(/\.md$/, ""),
      "projects/alpha-project",
    ]);
    expect(pages[0].content).toContain("file_refs:");
    expect(pages[0].content).toContain("source_file_object_id:");
    expect(pages[1].content).toContain("type: project");
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "source-fallback-unsupported",
        message: expect.stringContaining("not converted into typed paper/dataset/code pages"),
      }),
    ]));
  });

  it("mirrors supported gbrain commit imports into the workspace filesystem", async () => {
    process.env.SCIENCESWARM_DIR = ROOT;
    const sourceDir = join(ROOT, "incoming");
    mkdirSync(sourceDir, { recursive: true });
    const sourcePath = join(sourceDir, "results.csv");
    writeFileSync(sourcePath, "gene,score\nfoo,1\n", "utf-8");
    const preview = {
      ...buildPreview(),
      files: [buildPreview().files[1]!],
    };
    const request: ImportCommitRequest = {
      folder: {
        name: "Alpha Project",
        totalFiles: 1,
        files: [
          {
            path: "data/results.csv",
            name: "results.csv",
            type: "csv",
            size: 64,
            sourcePath,
            content: "gene,score\nparsed,0",
            hash: "hash-results",
          },
        ],
      },
      preview,
    };
    const attached: IngestInputFile[] = [];
    const ingested: IngestInputFile[] = [];

    await commitImportedProject(request, undefined, {
      enableGbrain: true,
      uploadedBy: "@tester",
      gbrain: fakeGbrain([]),
      ingestService: fakeIngestService(attached, ingested),
    });

    expect(ingested.map((file) => file.relativePath)).toEqual(["data/results.csv"]);
    expect(readFileSync(getImportedWorkspacePath("alpha-project", "data/results.csv"), "utf-8")).toBe(
      "gene,score\nfoo,1\n",
    );
  });

  it("falls back to a source page when canonical ingest reports a recoverable error", async () => {
    process.env.SCIENCESWARM_DIR = ROOT;
    const sourceDir = join(ROOT, "incoming");
    mkdirSync(sourceDir, { recursive: true });
    const sourcePath = join(sourceDir, "scanned.pdf");
    writeFileSync(sourcePath, "not a real pdf", "utf-8");
    const preview: ImportPreview = {
      ...buildPreview(),
      files: [
        {
          path: "papers/scanned.pdf",
          type: "pdf",
          size: 512,
          hash: "hash-scanned",
          classification: "paper",
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
          sourcePaths: ["papers/scanned.pdf"],
        },
      ],
    };
    const request: ImportCommitRequest = {
      folder: {
        name: "Alpha Project",
        totalFiles: 1,
        files: [
          {
            path: "papers/scanned.pdf",
            name: "scanned.pdf",
            type: "pdf",
            size: 512,
            sourcePath,
            content: "[No extracted content]",
            hash: "hash-scanned",
          },
        ],
      },
      preview,
    };
    const attached: IngestInputFile[] = [];
    const ingested: IngestInputFile[] = [];
    const pages: Array<{ slug: string; content: string }> = [];

    const result = await commitImportedProject(request, undefined, {
      enableGbrain: true,
      uploadedBy: "@tester",
      gbrain: fakeGbrain(pages),
      ingestService: fakeIngestService(attached, ingested, {
        ingestError: {
          filename: "scanned.pdf",
          code: "text_layer_too_thin",
          message: "PDF text layer is too thin for typed ingest.",
          recoverable: true,
        },
      }),
    });
    const fallbackPath =
      `wiki/entities/papers/imports/alpha-project/papers-scanned.pdf-${hashContent("papers/scanned.pdf").slice(0, 8)}.md`;

    expect(ingested.map((file) => file.relativePath)).toEqual(["papers/scanned.pdf"]);
    expect(attached.map((file) => file.relativePath)).toEqual(["papers/scanned.pdf"]);
    expect(result.sourcePagePaths).toEqual([fallbackPath]);
    expect(result.sourceRefs).toEqual([
      { kind: "import", ref: "papers/scanned.pdf", hash: "hash-scanned" },
    ]);
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: "papers/scanned.pdf",
        code: "ingest-text_layer_too_thin",
      }),
      expect.objectContaining({
        code: "source-fallback-recovered",
        message: expect.stringContaining("after typed page conversion failed"),
      }),
    ]));
    expect(pages.map((page) => page.slug)).toContain(
      fallbackPath.replace(/^wiki\//, "").replace(/\.md$/, ""),
    );
    expect(readFileSync(getImportedWorkspacePath("alpha-project", "papers/scanned.pdf"), "utf-8")).toBe(
      "not a real pdf",
    );
    const sourcePage = readFileSync(join(ROOT, "brain", fallbackPath), "utf-8");
    expect(sourcePage).toContain('"filename":"papers/scanned.pdf"');
  });

  it("keeps a source page and warning when recoverable fallback cannot attach original bytes", async () => {
    process.env.SCIENCESWARM_DIR = ROOT;
    const preview: ImportPreview = {
      ...buildPreview(),
      files: [
        {
          path: "data/huge.csv",
          type: "csv",
          size: 51 * 1024 * 1024,
          hash: "hash-huge",
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
          sourcePaths: ["data/huge.csv"],
        },
      ],
    };
    const request: ImportCommitRequest = {
      folder: {
        name: "Alpha Project",
        totalFiles: 1,
        files: [
          {
            path: "data/huge.csv",
            name: "huge.csv",
            type: "csv",
            size: 51 * 1024 * 1024,
            content: "too large for typed ingest",
            hash: "hash-huge",
          },
        ],
      },
      preview,
    };
    const pages: Array<{ slug: string; content: string }> = [];

    const result = await commitImportedProject(request, undefined, {
      enableGbrain: true,
      uploadedBy: "@tester",
      gbrain: fakeGbrain(pages),
      ingestService: fakeIngestService([], [], {
        ingestError: {
          filename: "huge.csv",
          code: "file_too_large",
          message: "File exceeds the gbrain file object limit.",
          recoverable: true,
        },
        attachError: {
          filename: "huge.csv",
          code: "file_too_large",
          message: "File exceeds the gbrain file object limit.",
          recoverable: true,
        },
      }),
    });

    expect(result.sourcePagePaths).toHaveLength(1);
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "data/huge.csv", code: "ingest-file_too_large" }),
      expect.objectContaining({ path: "data/huge.csv", code: "source-attachment-failed" }),
      expect.objectContaining({ code: "source-fallback-recovered" }),
    ]));
    expect(pages.map((page) => page.slug)).toEqual([
      result.sourcePagePaths[0]!.replace(/^wiki\//, "").replace(/\.md$/, ""),
      "projects/alpha-project",
    ]);
  });

  it("requires explicit uploadedBy for gbrain-enabled library callers", async () => {
    const originalHandle = process.env.SCIENCESWARM_USER_HANDLE;
    delete process.env.SCIENCESWARM_USER_HANDLE;
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(ROOT);
    const preview = buildPreview();
    const request: ImportCommitRequest = {
      folder: {
        name: "Alpha Project",
        totalFiles: 1,
        files: [
          {
            path: "notes/summary.md",
            name: "summary.md",
            type: "md",
            size: 42,
            content: "# Summary\nAlpha project notes",
            hash: "hash-summary",
          },
        ],
      },
      preview: {
        ...preview,
        files: [preview.files[0]!],
        duplicateGroups: [],
      },
    };

    try {
      await expect(
        commitImportedProject(request, ROOT, {
          enableGbrain: true,
          gbrain: fakeGbrain([]),
          ingestService: fakeIngestService([]),
        }),
      ).rejects.toThrow("uploadedBy is required when gbrain is enabled");
    } finally {
      cwd.mockRestore();
      if (originalHandle === undefined) {
        delete process.env.SCIENCESWARM_USER_HANDLE;
      } else {
        process.env.SCIENCESWARM_USER_HANDLE = originalHandle;
      }
    }
  });

  it("returns the canonical manifest helper path when no legacy brainRoot is provided", async () => {
    process.env.SCIENCESWARM_DIR = ROOT;
    const preview = buildPreview();
    const request: ImportCommitRequest = {
      folder: {
        name: "Alpha Project",
        totalFiles: 1,
        files: [
          {
            path: "notes/summary.md",
            name: "summary.md",
            type: "md",
            size: 42,
            content: "# Summary\nAlpha project notes",
            hash: "hash-summary",
          },
        ],
      },
      preview: {
        ...preview,
        files: [preview.files[0]!],
        duplicateGroups: [],
      },
    };

    const result = await commitImportedProject(request);

    expect(result.manifestPath).toBe(getLegacyProjectStudyFilePath("alpha-project", "manifest.json"));
  });

  it("copies sourcePath bytes into the legacy workspace mirror", async () => {
    process.env.SCIENCESWARM_DIR = ROOT;
    const sourceDir = join(ROOT, "source");
    mkdirSync(sourceDir, { recursive: true });
    const sourcePath = join(sourceDir, "summary.md");
    writeFileSync(sourcePath, "# Raw source\nnot just parsed preview\n", "utf-8");
    const preview = {
      ...buildPreview(),
      files: [buildPreview().files[0]!],
    };
    const request: ImportCommitRequest = {
      folder: {
        name: "Alpha Project",
        totalFiles: 1,
        files: [
          {
            path: "notes/summary.md",
            name: "summary.md",
            type: "md",
            size: 42,
            sourcePath,
            content: "# Parsed preview",
            hash: "hash-summary",
          },
        ],
      },
      preview,
    };

    await commitImportedProject(request);

    expect(readFileSync(getImportedWorkspacePath("alpha-project", "notes/summary.md"), "utf-8")).toBe(
      "# Raw source\nnot just parsed preview\n",
    );
  });

  it("places flat imported PDFs in the scientist-facing papers folder", () => {
    process.env.SCIENCESWARM_DIR = ROOT;

    expect(getImportedWorkspacePath("alpha-project", "hubble-1929.pdf")).toBe(
      join(ROOT, "projects", "alpha-project", "papers", "hubble-1929.pdf"),
    );
  });

  it("writes distinct source pages when flattened names would otherwise collide", async () => {
    const collisionPreview: ImportPreview = {
      ...buildPreview(),
      files: [
        {
          path: "notes/summary.md",
          type: "md",
          size: 42,
          hash: "hash-nested",
          classification: "text",
          projectCandidates: ["alpha-project"],
          warnings: [],
        },
        {
          path: "notes-summary.md",
          type: "md",
          size: 42,
          hash: "hash-flat",
          classification: "text",
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
          sourcePaths: ["notes/summary.md", "notes-summary.md"],
        },
      ],
    };

    const request: ImportCommitRequest = {
      folder: {
        name: "Alpha Project",
        totalFiles: 2,
        files: [
          {
            path: "notes/summary.md",
            name: "summary.md",
            type: "md",
            size: 42,
            content: "# Nested summary",
            hash: "hash-nested",
          },
          {
            path: "notes-summary.md",
            name: "notes-summary.md",
            type: "md",
            size: 42,
            content: "# Flat summary",
            hash: "hash-flat",
          },
        ],
      },
      preview: collisionPreview,
    };

    const result = await commitImportedProject(request, ROOT);
    expect(result.sourcePagePaths).toHaveLength(2);
    expect(new Set(result.sourcePagePaths).size).toBe(2);
    expect(readFileSync(join(ROOT, result.sourcePagePaths[0]), "utf-8")).toContain("# summary.md");
    expect(readFileSync(join(ROOT, result.sourcePagePaths[1]), "utf-8")).toContain("# notes-summary.md");
  });

  it("uses the selected preview project title when projectSlug overrides the first suggestion", async () => {
    const preview: ImportPreview = {
      ...buildPreview(),
      projects: [
        {
          slug: "alpha-project",
          title: "Alpha Project",
          confidence: "medium",
          reason: "Umbrella import bucket",
          sourcePaths: ["notes/summary.md", "data/results.csv"],
        },
        {
          slug: "active-research",
          title: "Active Research",
          confidence: "high",
          reason: "Analysis materials and active experiments",
          sourcePaths: ["notes/summary.md", "data/results.csv"],
        },
      ],
    };

    const request: ImportCommitRequest = {
      folder: {
        name: "Alpha Project",
        totalFiles: 2,
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
      },
      preview,
      projectSlug: "active-research",
    };

    const result = await commitImportedProject(request, ROOT);
    const manifest = JSON.parse(readFileSync(result.manifestPath, "utf-8"));
    const projectPage = readFileSync(join(ROOT, result.projectPagePath), "utf-8");

    expect(result.project).toBe("active-research");
    expect(result.title).toBe("Active Research");
    expect(result.projectPagePath).toBe("wiki/projects/active-research.md");
    expect(manifest.slug).toBe("active-research");
    expect(manifest.title).toBe("Active Research");
    expect(projectPage).toContain('# Active Research');
  });

  it("writes notebook imports as artifact pages with preserved classification metadata", async () => {
    const preview: ImportPreview = {
      analysis: "Import preview (local-scan)",
      backend: "local-scan",
      files: [
        {
          path: "analysis/notebooks/explore.ipynb",
          type: "ipynb",
          size: 128,
          hash: "hash-notebook",
          classification: "notebook",
          projectCandidates: ["active-research"],
          warnings: [],
        },
      ],
      projects: [
        {
          slug: "active-research",
          title: "Active Research",
          confidence: "high",
          reason: "Notebook-heavy research folder",
          sourcePaths: ["analysis/notebooks/explore.ipynb"],
        },
      ],
      duplicateGroups: [],
      warnings: [],
    };

    const request: ImportCommitRequest = {
      folder: {
        name: "Active Research",
        totalFiles: 1,
        files: [
          {
            path: "analysis/notebooks/explore.ipynb",
            name: "explore.ipynb",
            type: "ipynb",
            size: 128,
            content: "# Notebook preview",
            hash: "hash-notebook",
          },
        ],
      },
      preview,
    };

    const result = await commitImportedProject(request, ROOT);
    const notebookPath = `wiki/entities/artifacts/imports/active-research/analysis-notebooks-explore.ipynb-${hashContent("analysis/notebooks/explore.ipynb").slice(0, 8)}.md`;
    const notebookPage = readFileSync(join(ROOT, notebookPath), "utf-8");

    expect(result.sourcePagePaths).toEqual([notebookPath]);
    expect(notebookPage).toContain("type: artifact");
    expect(notebookPage).toContain('tags: ["import","notebook"]');
    expect(notebookPage).toContain('format: "ipynb"');
    expect(notebookPage).toContain('import_classification: "notebook"');
  });

  it("preserves classification-driven routing for files beyond the preview cap", async () => {
    const preview: ImportPreview = {
      analysis: "Import preview (local-scan)",
      backend: "local-scan",
      files: [
        {
          path: "notes/summary.md",
          type: "md",
          size: 42,
          hash: "hash-summary",
          classification: "note",
          projectCandidates: ["active-research"],
          warnings: [],
        },
      ],
      projects: [
        {
          slug: "active-research",
          title: "Active Research",
          confidence: "high",
          reason: "Imported from Active Research",
          sourcePaths: ["notes/summary.md"],
        },
      ],
      duplicateGroups: [],
      warnings: [
        {
          code: "file-limit",
          message: "Preview capped at 100 files out of 101.",
        },
      ],
    };

    const request: ImportCommitRequest = {
      folder: {
        name: "Active Research",
        totalFiles: 2,
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
            path: "analysis/notebooks/explore.ipynb",
            name: "explore.ipynb",
            type: "ipynb",
            size: 128,
            content: "# Notebook preview",
            hash: "hash-notebook",
          },
        ],
      },
      preview,
    };

    const result = await commitImportedProject(request, ROOT);
    const notebookPath = `wiki/entities/artifacts/imports/active-research/analysis-notebooks-explore.ipynb-${hashContent("analysis/notebooks/explore.ipynb").slice(0, 8)}.md`;

    expect(result.sourcePagePaths).toContain(notebookPath);
    expect(readFileSync(join(ROOT, notebookPath), "utf-8")).toContain("type: artifact");
  });

  it("skips duplicate copies after the first path in each duplicate group", async () => {
    const preview: ImportPreview = {
      analysis: "Import preview (local-scan)",
      backend: "local-scan",
      files: [
        {
          path: "papers/original.pdf",
          type: "pdf",
          size: 512,
          hash: "dup-hash",
          classification: "paper",
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
          sourcePaths: ["papers/original.pdf", "papers/copy.pdf"],
        },
      ],
      duplicateGroups: [
        {
          id: "dup-1",
          paths: ["papers/original.pdf", "papers/copy.pdf"],
          reason: "Identical content hash dup-hash",
        },
      ],
      warnings: [
        {
          code: "duplicates",
          message: "1 duplicate group(s) detected in the local scan.",
        },
      ],
    };

    const request: ImportCommitRequest = {
      folder: {
        name: "Alpha Project",
        totalFiles: 2,
        files: [
          {
            path: "papers/original.pdf",
            name: "original.pdf",
            type: "pdf",
            size: 512,
            content: "Original paper",
            hash: "dup-hash",
          },
          {
            path: "papers/copy.pdf",
            name: "copy.pdf",
            type: "pdf",
            size: 512,
            content: "Duplicate paper",
            hash: "dup-hash",
          },
        ],
      },
      preview,
    };

    const result = await commitImportedProject(request, ROOT);
    const projectPage = readFileSync(join(ROOT, result.projectPagePath), "utf-8");

    expect(result.sourcePagePaths).toHaveLength(1);
    expect(result.sourceRefs).toEqual([
      { kind: "import", ref: "papers/original.pdf", hash: "dup-hash" },
    ]);
    expect(projectPage).toContain("- papers/original.pdf (paper)");
    expect(projectPage).not.toContain("- papers/copy.pdf (paper)");
  });
});
