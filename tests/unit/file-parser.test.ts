import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import { parseFile } from "@/lib/file-parser";

/**
 * Unit tests for file-parser.
 *
 * PDF parsing tests use a minimal valid PDF buffer (the simplest
 * well-formed PDF) because vitest cannot mock the CJS require("pdf-parse")
 * call inside the source module. Text file tests use the real module
 * directly.
 */

const require = createRequire(import.meta.url);

// Minimal valid PDF that pdf-parse can handle. This is the smallest
// well-formed PDF 1.0 document.
function minimalPdfBuffer(): Buffer {
  const pdf = [
    "%PDF-1.0",
    "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj",
    "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj",
    "3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj",
    "4 0 obj<</Length 44>>stream",
    "BT /F1 12 Tf 100 700 Td (Hello World) Tj ET",
    "endstream endobj",
    "5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj",
    "xref",
    "0 6",
    "0000000000 65535 f ",
    "0000000009 00000 n ",
    "0000000058 00000 n ",
    "0000000115 00000 n ",
    "0000000266 00000 n ",
    "0000000360 00000 n ",
    "trailer<</Size 6/Root 1 0 R>>",
    "startxref",
    "430",
    "%%EOF",
  ].join("\n");
  return Buffer.from(pdf);
}

function minimalWorkbookBuffer(): Buffer {
  const base64 =
    "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";
  return Buffer.from(base64, "base64");
}

function multiRowWorkbookBuffer(): Buffer {
  const base64 =
    "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";
  return Buffer.from(base64, "base64");
}

describe("file-parser", () => {
  // ── Text file parsing ──────────────────────────────────────────

  describe("text file parsing", () => {
    it("parses a plain text file", async () => {
      const content = "Hello, world!";
      const buffer = Buffer.from(content);
      const result = await parseFile(buffer, "readme.txt");
      expect(result.text).toBe(content);
      expect(result.pages).toBeUndefined();
    });

    it("parses a CSV file as text", async () => {
      const content = "name,age\nAlice,30\nBob,25";
      const buffer = Buffer.from(content);
      const result = await parseFile(buffer, "data.csv");
      expect(result.text).toBe(content);
    });

    it("parses .py files as text", async () => {
      const content = "print('hello')";
      const buffer = Buffer.from(content);
      const result = await parseFile(buffer, "script.py");
      expect(result.text).toBe(content);
    });

    it("parses .tex files as text", async () => {
      const content = "\\documentclass{article}";
      const buffer = Buffer.from(content);
      const result = await parseFile(buffer, "paper.tex");
      expect(result.text).toBe(content);
    });

    it("parses markdown as text", async () => {
      const content = "# Heading\n\nParagraph.";
      const buffer = Buffer.from(content);
      const result = await parseFile(buffer, "notes.md");
      expect(result.text).toBe(content);
    });

    it("formats Jupyter notebooks into readable cell text", async () => {
      const notebook = {
        cells: [
          { cell_type: "markdown", source: ["# Notebook title\n", "Intro text.\n"] },
          { cell_type: "code", source: ["print('hello')\n"] },
        ],
      };
      const buffer = Buffer.from(JSON.stringify(notebook));
      const result = await parseFile(buffer, "analysis.ipynb");
      expect(result.text).toContain("Notebook: analysis.ipynb");
      expect(result.text).toContain("Cell 1 [markdown]");
      expect(result.text).toContain("# Notebook title");
      expect(result.metadata).toMatchObject({ cells: 2, markdownCells: 1, codeCells: 1 });
    });

    it("extracts workbook text from xlsx files", async () => {
      const result = await parseFile(minimalWorkbookBuffer(), "metrics.xlsx");
      expect(result.text).toContain("Workbook: metrics.xlsx");
      expect(result.text).toContain("Sheet: Sheet1");
      expect(result.text).toContain("sample_id | value");
      expect(result.text).toContain("SRG-A01 | 4.82");
      expect(result.metadata).toMatchObject({ rows: 1, columns: 2, sheets: ["Sheet1"] });
    });

    it("counts workbook rows beyond the preview slice", async () => {
      const result = await parseFile(multiRowWorkbookBuffer(), "many-rows.xlsx");
      expect(result.text).toContain("Workbook: many-rows.xlsx");
      expect(result.metadata).toMatchObject({ rows: 14, columns: 2, sheets: ["Sheet1"] });
    });

    it("rejects xlsx archives that exceed the parser size guard", async () => {
      await expect(
        parseFile(minimalWorkbookBuffer(), "oversized.xlsx", { zipEntryByteLimit: 32 }),
      ).rejects.toThrow(
        /size limit/i,
      );
    });
  });

  // ── Truncation ─────────────────────────────────────────────────

  describe("truncation", () => {
    it("truncates text files at 80k characters", async () => {
      const longContent = "x".repeat(100_000);
      const buffer = Buffer.from(longContent);
      const result = await parseFile(buffer, "long.txt");
      expect(result.text.length).toBeLessThan(100_000);
      expect(result.text).toContain("[... truncated ...]");
      expect(result.text.startsWith("x".repeat(80_000))).toBe(true);
    });

    it("does not truncate files under 80k", async () => {
      const content = "x".repeat(79_999);
      const buffer = Buffer.from(content);
      const result = await parseFile(buffer, "medium.txt");
      expect(result.text).toBe(content);
      expect(result.text).not.toContain("truncated");
    });

    it("truncates at exactly 80k boundary", async () => {
      const content = "x".repeat(80_001);
      const buffer = Buffer.from(content);
      const result = await parseFile(buffer, "boundary.txt");
      expect(result.text).toContain("[... truncated ...]");
    });
  });

  // ── Empty file ─────────────────────────────────────────────────

  describe("empty file handling", () => {
    it("returns empty text for an empty file", async () => {
      const buffer = Buffer.from("");
      const result = await parseFile(buffer, "empty.txt");
      expect(result.text).toBe("");
    });
  });

  // ── PDF handling (uses minimal valid PDF) ──────────────────────

  describe("PDF handling", () => {
    it("parses a PDF and returns text with page count", async () => {
      const buffer = minimalPdfBuffer();
      const result = await parseFile(buffer, "paper.pdf");

      // pdf-parse should extract at least some text from our minimal PDF
      expect(result.text).toBeDefined();
      expect(typeof result.text).toBe("string");
      expect(result.pages).toBeGreaterThanOrEqual(1);
    });

    it("strips null and control bytes from PDF previews", async () => {
      const { PDFParse } = require("pdf-parse") as {
        PDFParse: {
          prototype: {
            getText: () => Promise<{ text: string; total: number }>;
          };
        };
      };
      const getTextSpy = vi
        .spyOn(PDFParse.prototype, "getText")
        .mockResolvedValueOnce({ text: "Alpha\u0000 Beta\u0001Gamma", total: 1 });

      try {
        const result = await parseFile(minimalPdfBuffer(), "paper.pdf");
        expect(result.text).toBe("Alpha Beta Gamma");
        expect(result.pages).toBe(1);
      } finally {
        getTextSpy.mockRestore();
      }
    });

    it("detects extension case-insensitively", async () => {
      // Non-PDF extension: should be treated as text
      const buffer = Buffer.from("plain text");
      const result = await parseFile(buffer, "readme.TXT");
      expect(result.text).toBe("plain text");
      expect(result.pages).toBeUndefined();
    });
  });

  // ── Error handling ─────────────────────────────────────────────

  describe("error handling", () => {
    it("throws on corrupt PDF data", async () => {
      const buffer = Buffer.from("this is not a valid PDF");
      await expect(parseFile(buffer, "corrupt.pdf")).rejects.toThrow();
    });
  });
});
