import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import matter from "gray-matter";

// We mock child_process.execFile — the module promisifies it internally
vi.mock("child_process", () => ({
  execFile: vi.fn(),
}));

// Mock pdf-metadata to avoid needing real PDFs
vi.mock("@/brain/pdf-metadata", () => ({
  extractPdfMetadata: vi.fn(),
}));

import { execFile as execFileCb } from "child_process";
import { extractPdfMetadata } from "@/brain/pdf-metadata";
import {
  checkDoclingInstalled,
  resetDoclingCache,
  convertPdfsToMarkdown,
  enrichWithFrontmatter,
  convertSinglePdf,
} from "@/brain/pdf-to-markdown";

// ── Helpers ─────────────────────────────────────────

const execFileRaw = vi.mocked(execFileCb);

/**
 * Helper to mock execFile calls. The module uses `promisify(execFile)`, which
 * calls the original with a callback as the last argument. We intercept that.
 */
function mockExecFile(
  impl: (cmd: string, args: string[]) => { stdout: string; stderr: string } | Error,
): void {
  execFileRaw.mockImplementation((...allArgs: unknown[]) => {
    const cmd = allArgs[0] as string;
    const args = (allArgs[1] ?? []) as string[];

    // promisify(execFile) calls the original with (...originalArgs, callback)
    // Find the callback — it's the last function argument
    let cb: ((err: Error | null, stdout: string, stderr: string) => void) | undefined;
    for (let i = allArgs.length - 1; i >= 0; i--) {
      if (typeof allArgs[i] === "function") {
        cb = allArgs[i] as typeof cb;
        break;
      }
    }

    if (!cb) {
      // No callback — shouldn't happen with promisify, but be safe
      return {} as ReturnType<typeof execFileCb>;
    }

    try {
      const result = impl(cmd, args);
      if (result instanceof Error) {
        cb(result, "", "");
      } else {
        cb(null, result.stdout, result.stderr);
      }
    } catch (e) {
      cb(e instanceof Error ? e : new Error(String(e)), "", "");
    }

    return {} as ReturnType<typeof execFileCb>;
  });
}
const extractMock = vi.mocked(extractPdfMetadata);

let tempDir: string;

function makeTempDir(): string {
  const dir = join(tmpdir(), `pdf-to-md-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

beforeEach(() => {
  tempDir = makeTempDir();
  resetDoclingCache();
  vi.clearAllMocks();
});

afterEach(() => {
  if (existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// ── checkDoclingInstalled ───────────────────────────

describe("checkDoclingInstalled", () => {
  it("returns ok when docling is available", async () => {
    mockExecFile(() => ({ stdout: "Usage: docling 2.69.1 [OPTIONS]", stderr: "" }));

    const result = await checkDoclingInstalled();
    expect(result.ok).toBe(true);
  });

  it("returns error when docling is not found", async () => {
    mockExecFile(() => {
      const err = new Error("spawn docling ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      return err;
    });

    const result = await checkDoclingInstalled();
    expect(result.ok).toBe(false);
    expect(result.error).toContain("pip install docling");
  });

  it("caches the result across calls", async () => {
    mockExecFile(() => ({ stdout: "Usage: docling", stderr: "" }));

    await checkDoclingInstalled();
    await checkDoclingInstalled();
    expect(execFileRaw).toHaveBeenCalledTimes(1);
  });
});

// ── convertPdfsToMarkdown ───────────────────────────

describe("convertPdfsToMarkdown", () => {
  it("returns empty results for empty directory", async () => {
    const pdfDir = join(tempDir, "empty");
    mkdirSync(pdfDir);
    const stagingDir = join(tempDir, "staging");

    const result = await convertPdfsToMarkdown(pdfDir, stagingDir);
    expect(result.converted).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
  });

  it("returns empty results for nonexistent directory", async () => {
    const result = await convertPdfsToMarkdown(
      join(tempDir, "nonexistent"),
      join(tempDir, "staging"),
    );
    expect(result.converted).toHaveLength(0);
  });

  it("converts PDFs via batch mode", async () => {
    const pdfDir = join(tempDir, "pdfs");
    mkdirSync(pdfDir);
    writeFileSync(join(pdfDir, "paper1.pdf"), "%PDF-fake");
    writeFileSync(join(pdfDir, "paper2.pdf"), "%PDF-fake");

    const stagingDir = join(tempDir, "staging");

    mockExecFile(() => {
      mkdirSync(stagingDir, { recursive: true });
      writeFileSync(join(stagingDir, "paper1.md"), "# Paper 1\n\nContent here.");
      writeFileSync(join(stagingDir, "paper2.md"), "# Paper 2\n\nMore content.");
      return { stdout: "Converted 2 files", stderr: "" };
    });

    const result = await convertPdfsToMarkdown(pdfDir, stagingDir);
    expect(result.converted).toHaveLength(2);
    expect(result.failed).toHaveLength(0);
  });

  it("falls back to per-file on batch failure", async () => {
    const pdfDir = join(tempDir, "pdfs");
    mkdirSync(pdfDir);
    writeFileSync(join(pdfDir, "good.pdf"), "%PDF-fake");
    writeFileSync(join(pdfDir, "bad.pdf"), "%PDF-corrupt");

    const stagingDir = join(tempDir, "staging");
    let callCount = 0;

    mockExecFile((_cmd, args) => {
      callCount++;
      if (callCount === 1) return new Error("batch failed");

      const inputPath = args[0] ?? "";
      if (inputPath.includes("good")) {
        mkdirSync(stagingDir, { recursive: true });
        writeFileSync(join(stagingDir, "good.md"), "# Good paper");
        return { stdout: "ok", stderr: "" };
      }
      return new Error("corrupt PDF");
    });

    const result = await convertPdfsToMarkdown(pdfDir, stagingDir);
    expect(result.converted).toHaveLength(1);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].path).toContain("bad.pdf");
  });
});

// ── enrichWithFrontmatter ───────────────────────────

describe("enrichWithFrontmatter", () => {
  it("adds frontmatter from PDF metadata", async () => {
    const stagingDir = join(tempDir, "staging");
    const pdfDir = join(tempDir, "pdfs");
    mkdirSync(stagingDir, { recursive: true });
    mkdirSync(pdfDir, { recursive: true });

    writeFileSync(join(stagingDir, "wang-2025.md"), "## Title\n\nSome content.");
    writeFileSync(join(pdfDir, "wang-2025.pdf"), "%PDF-fake");

    extractMock.mockResolvedValue({
      title: "Learning Diffusion Models",
      authors: ["Chenyu Wang", "Cai Zhou"],
      abstract: "We present a framework...",
      doi: "10.1234/example",
      arxivId: "2501.12345",
      pageCount: 15,
      textPreview: "some text",
      extractionConfidence: "high",
    });

    await enrichWithFrontmatter(stagingDir, pdfDir);

    const result = readFileSync(join(stagingDir, "wang-2025.md"), "utf-8");
    const parsed = matter(result);

    expect(parsed.data.title).toBe("Learning Diffusion Models");
    expect(parsed.data.authors).toEqual(["Chenyu Wang", "Cai Zhou"]);
    expect(parsed.data.doi).toBe("10.1234/example");
    expect(parsed.data.arxiv).toBe("2501.12345");
    expect(parsed.data.type).toBe("paper");
    expect(parsed.data.tags).toContain("pdf-import");
    expect(parsed.content).toContain("Some content.");
  });

  it("skips files that already have frontmatter with title", async () => {
    const stagingDir = join(tempDir, "staging");
    const pdfDir = join(tempDir, "pdfs");
    mkdirSync(stagingDir, { recursive: true });
    mkdirSync(pdfDir, { recursive: true });

    const existing = matter.stringify("Body text.", { title: "Already Set" });
    writeFileSync(join(stagingDir, "existing.md"), existing);

    await enrichWithFrontmatter(stagingDir, pdfDir);

    // extractPdfMetadata should NOT have been called
    expect(extractMock).not.toHaveBeenCalled();

    const result = readFileSync(join(stagingDir, "existing.md"), "utf-8");
    const parsed = matter(result);
    expect(parsed.data.title).toBe("Already Set");
  });

  it("handles titles with YAML-special characters", async () => {
    const stagingDir = join(tempDir, "staging");
    const pdfDir = join(tempDir, "pdfs");
    mkdirSync(stagingDir, { recursive: true });
    mkdirSync(pdfDir, { recursive: true });

    writeFileSync(join(stagingDir, "special.md"), "# Content");
    writeFileSync(join(pdfDir, "special.pdf"), "%PDF-fake");

    extractMock.mockResolvedValue({
      title: 'TopK vs L1: A "Comparison" of SAE Methods',
      authors: ["Author: First"],
      abstract: null,
      doi: null,
      arxivId: null,
      pageCount: 5,
      textPreview: "",
      extractionConfidence: "medium",
    });

    await enrichWithFrontmatter(stagingDir, pdfDir);

    const result = readFileSync(join(stagingDir, "special.md"), "utf-8");
    const parsed = matter(result);
    // gray-matter handles YAML escaping correctly
    expect(parsed.data.title).toBe('TopK vs L1: A "Comparison" of SAE Methods');
  });

  it("uses filename as fallback title when no PDF found", async () => {
    const stagingDir = join(tempDir, "staging");
    const pdfDir = join(tempDir, "pdfs");
    mkdirSync(stagingDir, { recursive: true });
    mkdirSync(pdfDir, { recursive: true });
    // No matching PDF in pdfDir

    writeFileSync(join(stagingDir, "orphan-paper.md"), "# Some content");

    await enrichWithFrontmatter(stagingDir, pdfDir);

    const result = readFileSync(join(stagingDir, "orphan-paper.md"), "utf-8");
    const parsed = matter(result);
    expect(parsed.data.title).toBe("orphan paper");
    expect(parsed.data.extractionConfidence).toBe("low");
  });
});

// ── convertSinglePdf ────────────────────────────────

describe("convertSinglePdf", () => {
  it("skips tiny truncated PDFs before invoking Docling", async () => {
    const pdfPath = join(tempDir, "tiny.pdf");
    writeFileSync(pdfPath, "%PDF");

    const result = await convertSinglePdf(pdfPath, tempDir);

    expect(result).toBeNull();
    expect(execFileRaw).not.toHaveBeenCalled();
  });

  it("returns null when docling is not installed", async () => {
    mockExecFile(() => {
      const err = new Error("ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      return err;
    });

    const result = await convertSinglePdf("/fake/paper.pdf", tempDir);
    expect(result).toBeNull();
  });

  it("returns null when wiki page already exists", async () => {
    mockExecFile(() => ({ stdout: "Usage: docling", stderr: "" }));

    const wikiDir = join(tempDir, "wiki", "entities", "papers");
    mkdirSync(wikiDir, { recursive: true });
    writeFileSync(join(wikiDir, "my-paper.md"), "existing");

    const result = await convertSinglePdf("/fake/My Paper.pdf", tempDir);
    expect(result).toBeNull();
  });

  it("converts PDF and writes enriched wiki page", async () => {
    const pdfPath = join(tempDir, "Test Paper 2025.pdf");
    writeFileSync(pdfPath, `%PDF-fake\n${"A".repeat(2048)}`);

    let callCount = 0;
    mockExecFile((_cmd, args) => {
      callCount++;
      if (callCount === 1) {
        return { stdout: "Usage: docling", stderr: "" };
      }
      // docling convert — write output
      const outputIdx = args.indexOf("--output");
      const outputDir = outputIdx >= 0 ? args[outputIdx + 1] : undefined;
      if (outputDir) {
        mkdirSync(outputDir, { recursive: true });
        writeFileSync(
          join(outputDir, "Test Paper 2025.md"),
          "## Test Paper\n\nAbstract goes here.\n\n## Introduction\n\nBody text.",
        );
      }
      return { stdout: "ok", stderr: "" };
    });

    extractMock.mockResolvedValue({
      title: "Test Paper 2025",
      authors: ["Alice", "Bob"],
      abstract: "Abstract goes here.",
      doi: null,
      arxivId: "2501.99999",
      pageCount: 10,
      textPreview: "test",
      extractionConfidence: "high",
    });

    const result = await convertSinglePdf(pdfPath, tempDir);

    expect(result).toBe("wiki/entities/papers/test-paper-2025.md");

    const content = readFileSync(
      join(tempDir, "wiki", "entities", "papers", "test-paper-2025.md"),
      "utf-8",
    );
    const parsed = matter(content);
    expect(parsed.data.title).toBe("Test Paper 2025");
    expect(parsed.data.authors).toEqual(["Alice", "Bob"]);
    expect(parsed.data.arxiv).toBe("2501.99999");
    expect(parsed.content).toContain("Body text.");
  });
});
