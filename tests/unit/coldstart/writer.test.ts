/**
 * Unit tests for `src/brain/coldstart/writer.ts`.
 *
 * The writer is the single filesystem write surface for coldstart and the
 * file Phase B will rewrite to call `gbrain.putPage`. These tests pin its
 * behavior: happy path per page builder, idempotency, and partial failure
 * handling.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "crypto";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import type { GbrainClient } from "@/brain/gbrain-client";
import {
  type IngestInputFile,
  type IngestSuccess,
  pageFileRefFromObject,
  toFileObjectId,
} from "@/brain/gbrain-data-contracts";
import type { IngestService } from "@/brain/ingest/service";
import {
  createProjectPage,
  createWikiPageFromText,
  createPaperPageFromPdf,
  createExperimentPage,
  createDataPage,
  importSingleFile,
} from "@/brain/coldstart/writer";
import type {
  BrainConfig,
  ImportPreviewFile,
  ImportPreviewProject,
} from "@/brain/types";
import type { LLMClient, LLMResponse } from "@/brain/llm";

let brainRoot: string;
let corpusDir: string;

beforeEach(() => {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  brainRoot = join(tmpdir(), `writer-brain-${id}`);
  corpusDir = join(tmpdir(), `writer-corpus-${id}`);
  mkdirSync(brainRoot, { recursive: true });
  mkdirSync(corpusDir, { recursive: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const d of [brainRoot, corpusDir]) {
    if (existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
});

function makeConfig(): BrainConfig {
  return {
    root: brainRoot,
    extractionModel: "test",
    synthesisModel: "test",
    rippleCap: 5,
    paperWatchBudget: 10,
    serendipityRate: 0.1,
  };
}

function makeMockLLM(): LLMClient {
  return {
    async complete(): Promise<LLMResponse> {
      return {
        content: "---\ntitle: \"Mock\"\n---\n\n# Mock\nbody",
        cost: { inputTokens: 10, outputTokens: 5, estimatedUsd: 0.0001, model: "test" },
      };
    },
  };
}

function makeFile(rel: string, content: string, type: string): ImportPreviewFile {
  const abs = join(corpusDir, rel);
  const dir = abs.replace(/\/[^/]+$/, "");
  mkdirSync(dir, { recursive: true });
  writeFileSync(abs, content);
  return {
    path: abs,
    type,
    size: content.length,
    hash: "h",
    classification: type,
    projectCandidates: [],
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

function fakeIngestService(attached: IngestInputFile[]): IngestService {
  return {
    async ingestFiles() {
      return { slugs: [], errors: [] };
    },
    async attachArtifactFile(input) {
      const success = await attach(input);
      return { ...success, type: "artifact" };
    },
    async attachSourceFile(input) {
      return attach(input);
    },
  };

  async function attach(input: IngestInputFile & { pageSlug: string }): Promise<IngestSuccess> {
    attached.push(input);
    const sha256 = createHash("sha256").update(input.filename).digest("hex");
    const file = {
      id: toFileObjectId(sha256),
      sha256,
      sizeBytes: input.sizeBytes,
      mime: input.mime,
      originalFilename: input.filename,
      project: input.project,
      uploadedAt: "2026-04-16T00:00:00.000Z",
      uploadedBy: input.uploadedBy,
      source: input.source,
      storagePath: `objects/files/${sha256}`,
      contentEncoding: "raw" as const,
    };
    return {
      slug: input.pageSlug,
      type: "source",
      file,
      pageFileRef: pageFileRefFromObject(file, "source", input.filename),
    };
  }
}

// ── createProjectPage ─────────────────────────────────

describe("createProjectPage", () => {
  it("writes a project landing page on first call", () => {
    const config = makeConfig();
    const project: ImportPreviewProject = {
      slug: "alpha",
      title: "Alpha",
      confidence: "high",
      reason: "Detected from directory",
      sourcePaths: ["/x/y.md"],
    };
    const path = createProjectPage(config, project);
    expect(path).toBe("wiki/projects/alpha.md");
    expect(existsSync(join(brainRoot, "wiki/projects/alpha.md"))).toBe(true);
    const body = readFileSync(join(brainRoot, "wiki/projects/alpha.md"), "utf-8");
    expect(body).toContain("# Alpha");
    expect(body).toContain("type: project");
  });

  it("is idempotent (returns null on second call, file untouched)", () => {
    const config = makeConfig();
    const project: ImportPreviewProject = {
      slug: "alpha",
      title: "Alpha",
      confidence: "high",
      reason: "r",
      sourcePaths: [],
    };
    expect(createProjectPage(config, project)).toBe("wiki/projects/alpha.md");
    const before = readFileSync(join(brainRoot, "wiki/projects/alpha.md"), "utf-8");
    expect(createProjectPage(config, project)).toBeNull();
    const after = readFileSync(join(brainRoot, "wiki/projects/alpha.md"), "utf-8");
    expect(after).toBe(before);
  });
});

// ── createWikiPageFromText ────────────────────────────

describe("createWikiPageFromText", () => {
  it("uses the LLM happy path and writes a wiki page", async () => {
    const config = makeConfig();
    const file = makeFile("notes/research.md", "# Research\nbody", "note");
    const path = await createWikiPageFromText(config, makeMockLLM(), file, "note");
    expect(path).toBeTruthy();
    expect(existsSync(join(brainRoot, path!))).toBe(true);
  });

  it("falls back to a simple page when the LLM throws", async () => {
    const config = makeConfig();
    const file = makeFile("notes/oops.md", "# Oops\nfailing", "note");
    const failingLlm: LLMClient = {
      async complete() {
        throw new Error("LLM unavailable");
      },
    };
    const path = await createWikiPageFromText(config, failingLlm, file, "note");
    expect(path).toBeTruthy();
    const body = readFileSync(join(brainRoot, path!), "utf-8");
    expect(body).toContain("# Oops");
    expect(body).toContain("type: note");
  });

  it("falls back to a simple page when the LLM stalls", async () => {
    vi.stubEnv("SCIENCESWARM_COLDSTART_TEXT_LLM_TIMEOUT_MS", "100");
    const config = makeConfig();
    const file = makeFile("notes/slow.md", "# Slow\nbody", "note");
    const stalledLlm: LLMClient = {
      complete: () => new Promise<LLMResponse>(() => {}),
    };

    const path = await createWikiPageFromText(config, stalledLlm, file, "note");

    expect(path).toBeTruthy();
    const body = readFileSync(join(brainRoot, path!), "utf-8");
    expect(body).toContain("# Slow");
    expect(body).toContain("type: note");
  });

  it("is idempotent (does not overwrite an existing page)", async () => {
    const config = makeConfig();
    const file = makeFile("notes/dup.md", "# Dup\nfirst", "note");
    const first = await createWikiPageFromText(config, makeMockLLM(), file, "note");
    expect(first).toBeTruthy();
    const second = await createWikiPageFromText(config, makeMockLLM(), file, "note");
    expect(second).toBeNull();
  });

  it("threads the active project slug into mirrored page frontmatter", async () => {
    const config = makeConfig();
    const file = makeFile("notes/project-memory.md", "# Memory\nbody", "note");
    const gbrainCalls: Array<{ slug: string; content: string }> = [];
    const attached: IngestInputFile[] = [];

    const pagePath = await importSingleFile(config, makeMockLLM(), file, {
      enableGbrain: true,
      gbrain: fakeGbrain(gbrainCalls),
      ingestService: fakeIngestService(attached),
      uploadedBy: "@writer-test",
      projectSlug: "project-alpha",
    });

    expect(pagePath).toBeTruthy();
    const pageContent = readFileSync(join(brainRoot, pagePath!), "utf-8");
    expect(pageContent).toContain("project: project-alpha");
    expect(pageContent).toContain("- project-alpha");
    expect(gbrainCalls[0]?.content).toContain("project: project-alpha");
    expect(attached[0]?.project).toBe("project-alpha");
    expect(attached[0]?.filename).toBe("docs/project-memory.md");
  });
});

// ── createPaperPageFromPdf ────────────────────────────

describe("createPaperPageFromPdf", () => {
  it("writes a paper stub for a PDF", () => {
    const config = makeConfig();
    const file = makeFile("papers/attention.pdf", "%PDF", "paper");
    const path = createPaperPageFromPdf(config, file);
    expect(path).toBeTruthy();
    const body = readFileSync(join(brainRoot, path!), "utf-8");
    expect(body).toContain("type: paper");
    expect(body).toContain("Imported from: attention.pdf");
  });

  it("captures the arXiv ID when present", () => {
    const config = makeConfig();
    const file = makeFile("papers/2301.12345.pdf", "%PDF", "paper");
    const path = createPaperPageFromPdf(config, file);
    const body = readFileSync(join(brainRoot, path!), "utf-8");
    expect(body).toContain("arxiv: \"2301.12345\"");
  });

  it("is idempotent for the same source filename", () => {
    const config = makeConfig();
    const file = makeFile("papers/x.pdf", "%PDF", "paper");
    expect(createPaperPageFromPdf(config, file)).toBeTruthy();
    expect(createPaperPageFromPdf(config, file)).toBeNull();
  });
});

// ── createExperimentPage ──────────────────────────────

describe("createExperimentPage", () => {
  it("writes an experiment stub for a notebook", () => {
    const config = makeConfig();
    const file = makeFile(
      "notebooks/run.ipynb",
      JSON.stringify({ cells: [], metadata: {}, nbformat: 4, nbformat_minor: 5 }),
      "experiment",
    );
    const path = createExperimentPage(config, file);
    expect(path).toBeTruthy();
    const body = readFileSync(join(brainRoot, path!), "utf-8");
    expect(body).toContain("type: experiment");
  });

  it("is idempotent", () => {
    const config = makeConfig();
    const file = makeFile("notebooks/dup.ipynb", "{}", "experiment");
    expect(createExperimentPage(config, file)).toBeTruthy();
    expect(createExperimentPage(config, file)).toBeNull();
  });
});

// ── createDataPage ────────────────────────────────────

describe("createDataPage", () => {
  it("writes a data page for a CSV", () => {
    const config = makeConfig();
    const file = makeFile("data/results.csv", "a,b\n1,2", "data");
    const path = createDataPage(config, file);
    expect(path).toBeTruthy();
    const body = readFileSync(join(brainRoot, path!), "utf-8");
    expect(body).toContain("type: data");
    expect(body).toContain("format: csv");
  });

  it("is idempotent", () => {
    const config = makeConfig();
    const file = makeFile("data/dup.csv", "x,y", "data");
    expect(createDataPage(config, file)).toBeTruthy();
    expect(createDataPage(config, file)).toBeNull();
  });
});

// ── importSingleFile dispatcher ───────────────────────

describe("importSingleFile", () => {
  it("returns null for missing files", async () => {
    const config = makeConfig();
    const ghost: ImportPreviewFile = {
      path: join(corpusDir, "ghost.md"),
      type: "note",
      size: 0,
      hash: "",
      classification: "note",
      projectCandidates: [],
      warnings: [],
    };
    expect(await importSingleFile(config, makeMockLLM(), ghost)).toBeNull();
  });

  it("imports a markdown note via the text path", async () => {
    const config = makeConfig();
    const file = makeFile("notes/idea.md", "# Idea\nbody", "note");
    const path = await importSingleFile(config, makeMockLLM(), file);
    expect(path).toBeTruthy();
    expect(path).toMatch(/wiki\/resources\//);
  });

  it("imports a notebook via the experiment path", async () => {
    const config = makeConfig();
    const file = makeFile(
      "nb/run.ipynb",
      JSON.stringify({ cells: [], metadata: {}, nbformat: 4, nbformat_minor: 5 }),
      "experiment",
    );
    const path = await importSingleFile(config, makeMockLLM(), file);
    expect(path).toBeTruthy();
    expect(path).toMatch(/wiki\/experiments\//);
  });

  it("imports a CSV via the data path", async () => {
    const config = makeConfig();
    const file = makeFile("d/x.csv", "a,b\n1,2", "data");
    const path = await importSingleFile(config, makeMockLLM(), file);
    expect(path).toBeTruthy();
    expect(path).toMatch(/wiki\/resources\//);
  });

  it("attaches a gbrain source file ref and mirrors the page when enabled", async () => {
    const config = makeConfig();
    const file = makeFile("d/x.csv", "a,b\n1,2", "data");
    const attached: IngestInputFile[] = [];
    const pages: Array<{ slug: string; content: string }> = [];

    const path = await importSingleFile(config, makeMockLLM(), file, {
      enableGbrain: true,
      uploadedBy: "@tester",
      projectSlug: "alpha",
      gbrain: fakeGbrain(pages),
      ingestService: fakeIngestService(attached),
    });

    expect(path).toMatch(/wiki\/resources\//);
    expect(attached).toHaveLength(1);
    expect(attached[0].project).toBe("alpha");
    expect(attached[0].uploadedBy).toBe("@tester");
    expect(attached[0].source).toEqual({
      kind: "coldstart",
      sourcePath: file.path,
    });
    expect(pages).toHaveLength(1);
    expect(pages[0].slug).toBe(path!.replace(/^wiki\//, "").replace(/\.md$/, ""));
    expect(pages[0].content).toContain("file_refs:");
    const mirrored = readFileSync(join(brainRoot, path!), "utf-8");
    expect(mirrored).toContain("source_file_object_id:");
  });

  it("imports a PDF via the paper path (Docling fallback)", async () => {
    const config = makeConfig();
    const file = makeFile("p/x.pdf", "%PDF", "paper");
    const path = await importSingleFile(config, makeMockLLM(), file);
    expect(path).toBeTruthy();
    expect(path).toMatch(/wiki\/entities\/papers\//);
  });

  it("copies the raw source file under raw/", async () => {
    const config = makeConfig();
    const file = makeFile("notes/copy-me.md", "# Copy", "note");
    await importSingleFile(config, makeMockLLM(), file);
    const rawDir = join(brainRoot, "raw/notes");
    expect(existsSync(rawDir)).toBe(true);
    const rawFiles = readdirSync(rawDir);
    expect(rawFiles).toContain("copy-me.md");
  });

  it("partial-failure: one bad file does not break a batch", async () => {
    const config = makeConfig();
    const llm = makeMockLLM();
    const good = makeFile("notes/good.md", "# Good", "note");
    const bad: ImportPreviewFile = {
      path: join(corpusDir, "missing.md"),
      type: "note",
      size: 0,
      hash: "",
      classification: "note",
      projectCandidates: [],
      warnings: [],
    };

    // Simulate batch behavior: caller iterates, each call independent.
    const results: Array<string | null> = [];
    for (const f of [good, bad, good]) {
      try {
        results.push(await importSingleFile(config, llm, f));
      } catch {
        results.push(null);
      }
    }
    // good (page), bad (null), good again (null because idempotent)
    expect(results[0]).toBeTruthy();
    expect(results[1]).toBeNull();
    expect(results[2]).toBeNull();
  });
});

// ── Idempotency at the dispatcher level ───────────────

describe("importSingleFile idempotency", () => {
  it("importing the same file twice produces a single page, not duplicates", async () => {
    const config = makeConfig();
    const llm = makeMockLLM();
    const file = makeFile("notes/once.md", "# Once\nbody", "note");
    const first = await importSingleFile(config, llm, file);
    const second = await importSingleFile(config, llm, file);
    expect(first).toBeTruthy();
    expect(second).toBeNull();

    const dir = join(brainRoot, "wiki/resources");
    const entries = readdirSync(dir);
    expect(entries.length).toBe(1);
  });
});
