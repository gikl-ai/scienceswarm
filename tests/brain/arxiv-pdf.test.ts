import {
  describe,
  expect,
  it,
  vi,
  beforeEach,
  afterEach,
} from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// ── Module mocks ─────────────────────────────────────

vi.resetModules();

// ── Test fixtures ────────────────────────────────────

let testDir: string;

function fixture(relPath: string, content: string | Buffer = ""): string {
  const absPath = join(testDir, relPath);
  const dir = absPath.replace(/\/[^/]+$/, "");
  mkdirSync(dir, { recursive: true });
  writeFileSync(absPath, content);
  return absPath;
}

/**
 * Minimal valid PDF buffer for testing.
 * This is a hand-crafted minimal PDF that pdf-parse can handle.
 * For tests that need text extraction, we mock pdf-parse instead.
 */
function minimalPdfBuffer(text?: string): Buffer {
  // Minimal PDF 1.4 structure with optional text
  const content = text ?? "Hello World";
  const stream = `BT /F1 12 Tf 100 700 Td (${content}) Tj ET`;
  const streamBytes = Buffer.from(stream, "ascii");

  const pdf = [
    "%PDF-1.4",
    "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj",
    "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj",
    `3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Contents 4 0 R/Resources<</Font<</F1<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>>>>>>>endobj`,
    `4 0 obj<</Length ${streamBytes.length}>>stream\n${stream}\nendstream\nendobj`,
    "xref",
    "0 5",
    "0000000000 65535 f ",
    "0000000009 00000 n ",
    "0000000058 00000 n ",
    "0000000115 00000 n ",
    "0000000310 00000 n ",
    "trailer<</Size 5/Root 1 0 R>>",
    "startxref",
    "406",
    "%%EOF",
  ].join("\n");

  return Buffer.from(pdf, "ascii");
}

beforeEach(() => {
  vi.resetModules();
  testDir = join(
    tmpdir(),
    `arxiv-pdf-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
  }
});

// ── arXiv ID Resolution ──────────────────────────────

describe("resolveArxivSource", () => {
  // We import dynamically to respect module reset
  async function getResolve() {
    const mod = await import("@/brain/arxiv-download");
    return mod.resolveArxivSource;
  }

  it("parses a plain arXiv ID", async () => {
    const resolve = await getResolve();
    const result = resolve("2309.08600");
    expect(result).not.toBeNull();
    expect(result!.arxivId).toBe("2309.08600");
    expect(result!.pdfUrl).toBe("https://arxiv.org/pdf/2309.08600.pdf");
  });

  it("parses a versioned arXiv ID", async () => {
    const resolve = await getResolve();
    const result = resolve("2309.08600v2");
    expect(result).not.toBeNull();
    expect(result!.arxivId).toBe("2309.08600v2");
    expect(result!.pdfUrl).toBe("https://arxiv.org/pdf/2309.08600v2.pdf");
  });

  it("parses arXiv: prefix (mixed case)", async () => {
    const resolve = await getResolve();
    const result = resolve("arXiv:2309.08600");
    expect(result).not.toBeNull();
    expect(result!.arxivId).toBe("2309.08600");

    const result2 = resolve("arxiv:2309.08600v2");
    expect(result2).not.toBeNull();
    expect(result2!.arxivId).toBe("2309.08600v2");
  });

  it("parses arXiv abstract URL", async () => {
    const resolve = await getResolve();
    const result = resolve("https://arxiv.org/abs/2309.08600");
    expect(result).not.toBeNull();
    expect(result!.arxivId).toBe("2309.08600");
    expect(result!.pdfUrl).toBe("https://arxiv.org/pdf/2309.08600.pdf");
  });

  it("parses arXiv PDF URL with .pdf extension", async () => {
    const resolve = await getResolve();
    const result = resolve("https://arxiv.org/pdf/2309.08600.pdf");
    expect(result).not.toBeNull();
    expect(result!.arxivId).toBe("2309.08600");
  });

  it("parses arXiv PDF URL without .pdf extension", async () => {
    const resolve = await getResolve();
    const result = resolve("https://arxiv.org/pdf/2309.08600");
    expect(result).not.toBeNull();
    expect(result!.arxivId).toBe("2309.08600");
  });

  it("parses versioned arXiv URL", async () => {
    const resolve = await getResolve();
    const result = resolve("https://arxiv.org/abs/2309.08600v3");
    expect(result).not.toBeNull();
    expect(result!.arxivId).toBe("2309.08600v3");
  });

  it("returns null for invalid inputs", async () => {
    const resolve = await getResolve();
    expect(resolve("not-an-arxiv-id")).toBeNull();
    expect(resolve("https://google.com")).toBeNull();
    expect(resolve("12345")).toBeNull();
    expect(resolve("")).toBeNull();
    expect(resolve("2309")).toBeNull();
    expect(resolve("some random text")).toBeNull();
  });

  it("handles 5-digit arXiv IDs", async () => {
    const resolve = await getResolve();
    const result = resolve("2301.12345");
    expect(result).not.toBeNull();
    expect(result!.arxivId).toBe("2301.12345");
  });
});

// ── isArxivReference ─────────────────────────────────

describe("isArxivReference", () => {
  async function getIsRef() {
    const mod = await import("@/brain/arxiv-download");
    return mod.isArxivReference;
  }

  it("returns true for all valid arXiv formats", async () => {
    const isRef = await getIsRef();
    expect(isRef("2309.08600")).toBe(true);
    expect(isRef("arXiv:2309.08600")).toBe(true);
    expect(isRef("https://arxiv.org/abs/2309.08600")).toBe(true);
    expect(isRef("https://arxiv.org/pdf/2309.08600.pdf")).toBe(true);
  });

  it("returns false for non-arXiv inputs", async () => {
    const isRef = await getIsRef();
    expect(isRef("hello world")).toBe(false);
    expect(isRef("10.1038/nature12373")).toBe(false);
    expect(isRef("/path/to/file.pdf")).toBe(false);
  });
});

// ── arXiv Download ───────────────────────────────────

describe("downloadArxivPdf", () => {
  it("downloads and saves a PDF when fetch succeeds", async () => {
    const { downloadArxivPdf, resetRateLimit } = await import(
      "@/brain/arxiv-download"
    );
    resetRateLimit();

    const pdfContent = minimalPdfBuffer("Test arXiv paper");

    // Mock global fetch
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/pdf" }),
      arrayBuffer: () => Promise.resolve(pdfContent.buffer.slice(
        pdfContent.byteOffset,
        pdfContent.byteOffset + pdfContent.byteLength,
      )),
    });
    vi.stubGlobal("fetch", mockFetch);

    const destDir = join(testDir, "downloads");
    const path = await downloadArxivPdf("2309.08600", destDir);

    expect(path).toBe(join(destDir, "2309.08600.pdf"));
    expect(existsSync(path)).toBe(true);

    // Verify the saved file starts with %PDF
    const saved = readFileSync(path);
    expect(saved.subarray(0, 4).toString("ascii")).toBe("%PDF");

    // Verify fetch was called with the right URL
    expect(mockFetch).toHaveBeenCalledWith(
      "https://arxiv.org/pdf/2309.08600.pdf",
      expect.objectContaining({
        headers: expect.objectContaining({
          "User-Agent": expect.stringContaining("ScienceSwarm"),
        }),
      }),
    );

    vi.unstubAllGlobals();
  });

  it("returns existing file without re-downloading", async () => {
    const { downloadArxivPdf, resetRateLimit } = await import(
      "@/brain/arxiv-download"
    );
    resetRateLimit();

    // Pre-create the PDF file
    const destDir = join(testDir, "downloads");
    mkdirSync(destDir, { recursive: true });
    const existingPath = join(destDir, "2309.08600.pdf");
    writeFileSync(existingPath, minimalPdfBuffer());

    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    const path = await downloadArxivPdf("2309.08600", destDir);
    expect(path).toBe(existingPath);
    // fetch should NOT have been called
    expect(mockFetch).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it("throws ArxivDownloadError on HTTP failure", async () => {
    const { downloadArxivPdf, ArxivDownloadError, resetRateLimit } =
      await import("@/brain/arxiv-download");
    resetRateLimit();

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: "Not Found",
        headers: new Headers(),
      }),
    );

    await expect(
      downloadArxivPdf("9999.99999", join(testDir, "dl")),
    ).rejects.toThrow(ArxivDownloadError);

    vi.unstubAllGlobals();
  });

  it("throws ArxivDownloadError on wrong content type", async () => {
    const { downloadArxivPdf, ArxivDownloadError, resetRateLimit } =
      await import("@/brain/arxiv-download");
    resetRateLimit();

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "text/html" }),
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      }),
    );

    await expect(
      downloadArxivPdf("2309.08600", join(testDir, "dl")),
    ).rejects.toThrow(ArxivDownloadError);

    vi.unstubAllGlobals();
  });

  it("throws ArxivDownloadError when response is not a valid PDF", async () => {
    const { downloadArxivPdf, ArxivDownloadError, resetRateLimit } =
      await import("@/brain/arxiv-download");
    resetRateLimit();

    const notPdf = Buffer.from("This is not a PDF file");

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/pdf" }),
        arrayBuffer: () =>
          Promise.resolve(
            notPdf.buffer.slice(
              notPdf.byteOffset,
              notPdf.byteOffset + notPdf.byteLength,
            ),
          ),
      }),
    );

    await expect(
      downloadArxivPdf("2309.08600", join(testDir, "dl")),
    ).rejects.toThrow(ArxivDownloadError);

    vi.unstubAllGlobals();
  });
});

// ── PDF Metadata Extraction ──────────────────────────

describe("extractFromText (text heuristics)", () => {
  async function getExtractFromText() {
    const mod = await import("@/brain/pdf-metadata");
    return mod.extractFromText;
  }

  it("extracts DOI from text", async () => {
    const extract = await getExtractFromText();
    const result = extract("Some text with DOI 10.1038/nature12373 in it.");
    expect(result.doi).toBe("10.1038/nature12373");
  });

  it("extracts arXiv ID from text", async () => {
    const extract = await getExtractFromText();
    const result = extract("Paper available at arXiv:2309.08600v2");
    expect(result.arxivId).toBe("2309.08600v2");
  });

  it("extracts abstract when present", async () => {
    const extract = await getExtractFromText();
    const text = [
      "A Great Paper Title",
      "Author One, Author Two",
      "",
      "Abstract",
      "This is the abstract of the paper describing the key findings",
      "and contributions of this work to the field of machine learning.",
      "",
      "1. Introduction",
      "Here we begin the introduction...",
    ].join("\n");

    const result = extract(text);
    expect(result.abstract).not.toBeNull();
    expect(result.abstract).toContain("key findings");
  });

  it("extracts title from first substantial line", async () => {
    const extract = await getExtractFromText();
    const text = [
      "Attention Is All You Need",
      "Ashish Vaswani, Noam Shazeer, Niki Parmar",
      "",
      "Abstract",
      "The dominant sequence transduction models...",
    ].join("\n");

    const result = extract(text);
    expect(result.title).toBe("Attention Is All You Need");
  });

  it("extracts authors from comma-separated line", async () => {
    const extract = await getExtractFromText();
    const text = [
      "Attention Is All You Need",
      "Ashish Vaswani, Noam Shazeer, Niki Parmar",
      "",
      "Abstract",
      "Some abstract text here that is long enough to match.",
    ].join("\n");

    const result = extract(text);
    expect(result.authors).not.toBeNull();
    expect(result.authors!.length).toBeGreaterThanOrEqual(2);
    expect(result.authors![0]).toContain("Vaswani");
  });

  it("returns nulls for empty text", async () => {
    const extract = await getExtractFromText();
    const result = extract("");
    expect(result.title).toBeNull();
    expect(result.authors).toBeNull();
    expect(result.abstract).toBeNull();
    expect(result.doi).toBeNull();
    expect(result.arxivId).toBeNull();
  });

  it("cleans trailing punctuation from DOI", async () => {
    const extract = await getExtractFromText();
    const result = extract("DOI: 10.1000/xyz123.)");
    expect(result.doi).toBe("10.1000/xyz123");
  });
});

describe("extractPdfMetadata", () => {
  it("returns low confidence for non-PDF files", async () => {
    const { extractPdfMetadata } = await import("@/brain/pdf-metadata");
    const path = fixture("not-a-pdf.pdf", "This is plain text, not a PDF");
    const result = await extractPdfMetadata(path);

    expect(result.extractionConfidence).toBe("low");
    expect(result.pageCount).toBe(0);
    expect(result.title).toBe("not-a-pdf"); // falls back to filename
  });

  it("handles a minimal valid PDF buffer", async () => {
    const { extractPdfMetadata } = await import("@/brain/pdf-metadata");
    const path = fixture("valid.pdf", minimalPdfBuffer("Test Title Content"));

    // pdf-parse may or may not work with our minimal PDF;
    // the key assertion is that it doesn't throw and returns a PdfMetadata
    const result = await extractPdfMetadata(path);
    expect(result).toHaveProperty("title");
    expect(result).toHaveProperty("authors");
    expect(result).toHaveProperty("pageCount");
    expect(result).toHaveProperty("extractionConfidence");
    expect(["high", "medium", "low"]).toContain(result.extractionConfidence);
  });
});

// ── Enhanced Scan Preview ────────────────────────────

describe("scanCorpus with PDF metadata", () => {
  it("includes metadata for PDF files in scan results", async () => {
    // Create a PDF fixture
    fixture("papers/test-paper.pdf", minimalPdfBuffer("Machine Learning Paper"));

    // Also create a non-PDF to verify it doesn't get metadata
    fixture("notes/todo.md", "# TODO\n\n- Write tests");

    const { scanCorpus } = await import("@/brain/coldstart");
    const result = await scanCorpus([testDir]);

    expect(result.files.length).toBeGreaterThanOrEqual(2);

    const pdfFile = result.files.find((f) => f.path.endsWith(".pdf"));
    expect(pdfFile).toBeDefined();
    // PDF files should have a metadata field (even if extraction is minimal)
    expect(pdfFile!.metadata).toBeDefined();
    expect(pdfFile!.metadata).toHaveProperty("extractionConfidence");
    expect(pdfFile!.metadata).toHaveProperty("pageCount");

    const mdFile = result.files.find((f) => f.path.endsWith(".md"));
    expect(mdFile).toBeDefined();
    // Non-PDF files should NOT have metadata
    expect(mdFile!.metadata).toBeUndefined();
  });

  it("scan preview shows paper title from metadata", async () => {
    // We'll mock extractPdfMetadata to return known values
    vi.doMock("@/brain/pdf-metadata", () => ({
      extractPdfMetadata: vi.fn().mockResolvedValue({
        title: "Attention Is All You Need",
        authors: ["Vaswani", "Shazeer"],
        abstract: "The dominant sequence transduction models...",
        doi: "10.5555/3295222.3295349",
        arxivId: "1706.03762",
        pageCount: 15,
        textPreview: "Attention Is All You Need...",
        extractionConfidence: "high" as const,
      }),
    }));

    fixture("research/transformer.pdf", minimalPdfBuffer());

    const { scanCorpus } = await import("@/brain/coldstart");
    const result = await scanCorpus([testDir]);

    const pdfFile = result.files.find((f) => f.path.endsWith(".pdf"));
    expect(pdfFile).toBeDefined();
    expect(pdfFile!.metadata).toBeDefined();
    expect(pdfFile!.metadata!.title).toBe("Attention Is All You Need");
    expect(pdfFile!.metadata!.authors).toEqual(["Vaswani", "Shazeer"]);
    expect(pdfFile!.metadata!.doi).toBe("10.5555/3295222.3295349");
    expect(pdfFile!.metadata!.arxivId).toBe("1706.03762");
    expect(pdfFile!.metadata!.pageCount).toBe(15);
    expect(pdfFile!.metadata!.extractionConfidence).toBe("high");
  });
});

// ── Engine: arXiv classification ─────────────────────

describe("engine classifySource handles arXiv formats", () => {
  it("classifies arXiv URLs as paper", async () => {
    // We test the classifySource function indirectly by testing that
    // isArxivReference works for all formats that the engine uses
    const { isArxivReference } = await import("@/brain/arxiv-download");

    // These should all be recognized as arXiv references
    expect(isArxivReference("https://arxiv.org/abs/2309.08600")).toBe(true);
    expect(isArxivReference("https://arxiv.org/pdf/2309.08600.pdf")).toBe(true);
    expect(isArxivReference("arXiv:2309.08600")).toBe(true);
    expect(isArxivReference("arxiv:2309.08600v2")).toBe(true);
    expect(isArxivReference("2309.08600")).toBe(true);
  });
});

// ── Edge Cases ───────────────────────────────────────

describe("edge cases", () => {
  it("resolveArxivSource handles whitespace-padded input", async () => {
    const { resolveArxivSource } = await import("@/brain/arxiv-download");
    const result = resolveArxivSource("  2309.08600  ");
    expect(result).not.toBeNull();
    expect(result!.arxivId).toBe("2309.08600");
  });

  it("resolveArxivSource handles old-style arXiv IDs (4-digit)", async () => {
    const { resolveArxivSource } = await import("@/brain/arxiv-download");
    const result = resolveArxivSource("2309.0860");
    expect(result).not.toBeNull();
    expect(result!.arxivId).toBe("2309.0860");
  });

  it("extractFromText handles text with no recognizable structure", async () => {
    vi.doUnmock("@/brain/pdf-metadata");
    const { extractFromText } = await import("@/brain/pdf-metadata");
    const result = extractFromText(
      "aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii jjjj",
    );
    // Should not crash and should return mostly nulls
    expect(result.doi).toBeNull();
    expect(result.arxivId).toBeNull();
    expect(result.abstract).toBeNull();
  });

  it("extractPdfMetadata handles corrupt PDF gracefully", async () => {
    vi.doUnmock("@/brain/pdf-metadata");
    const { extractPdfMetadata } = await import("@/brain/pdf-metadata");
    // Write a file that starts with %PDF but is otherwise garbage
    const path = fixture(
      "corrupt.pdf",
      Buffer.from("%PDF-1.4 CORRUPT DATA FOLLOWS @#$%^&*"),
    );
    const result = await extractPdfMetadata(path);
    // Should not throw — returns metadata with low confidence
    expect(result).toHaveProperty("extractionConfidence");
    // pageCount may be 0 or non-zero depending on parser behavior with corrupt data
    expect(typeof result.pageCount).toBe("number");
  });

  it("ArxivDownloadError includes arxivId and httpStatus", async () => {
    const { ArxivDownloadError } = await import("@/brain/arxiv-download");
    const err = new ArxivDownloadError("test error", "2309.08600", 404);
    expect(err.arxivId).toBe("2309.08600");
    expect(err.httpStatus).toBe(404);
    expect(err.name).toBe("ArxivDownloadError");
    expect(err.message).toBe("test error");
  });
});
