import path from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { extractAbstractFromPdfText, extractPdfText } from "@/lib/pdf-text-extractor";

const TMP_ROOT = path.join(tmpdir(), "scienceswarm-pdf-extractor-test");
const FAKE_PDF = path.join(TMP_ROOT, "sample.pdf");
const MISSING_PDF = path.join(TMP_ROOT, "does-not-exist.pdf");
const CORRUPT_PDF = path.join(TMP_ROOT, "corrupt.pdf");
const require = createRequire(import.meta.url);

function minimalPdfBuffer(text = "Hello World"): Buffer {
  const pdf = [
    "%PDF-1.0",
    "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj",
    "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj",
    "3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj",
    `4 0 obj<</Length ${32 + text.length}>>stream`,
    `BT /F1 12 Tf 100 700 Td (${text}) Tj ET`,
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

beforeEach(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
  mkdirSync(TMP_ROOT, { recursive: true });
  writeFileSync(FAKE_PDF, minimalPdfBuffer("Hello World"));
  writeFileSync(CORRUPT_PDF, "%PDF-1.4 broken");
});

afterEach(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

describe("extractPdfText", () => {
  it("returns a typed result with text, pageCount, wordCount, firstSentence, and info", async () => {
    const result = await extractPdfText(FAKE_PDF);
    expect(result.text).toContain("Hello World");
    expect(result.pageCount).toBe(1);
    expect(result.wordCount).toBeGreaterThan(0);
    expect(result.firstSentence).toBe("Hello World");
    expect(result.info).toMatchObject({
      PDFFormatVersion: "1.0",
      IsLinearized: false,
    });
  });

  it("keeps the extracted text when optional metadata parsing fails", async () => {
    const { PDFParse } = require("pdf-parse") as {
      PDFParse: {
        prototype: {
          getInfo: () => Promise<unknown>;
        };
      };
    };
    const getInfoSpy = vi
      .spyOn(PDFParse.prototype, "getInfo")
      .mockRejectedValueOnce(new Error("metadata unavailable"));

    try {
      const result = await extractPdfText(FAKE_PDF);
      expect(result.text).toContain("Hello World");
      expect(result.pageCount).toBe(1);
      expect(result.info).toBeUndefined();
    } finally {
      getInfoSpy.mockRestore();
    }
  });

  it("strips null and control bytes from extracted PDF text", async () => {
    const { PDFParse } = require("pdf-parse") as {
      PDFParse: {
        prototype: {
          getText: () => Promise<{ text: string; total: number }>;
        };
      };
    };
    const getTextSpy = vi
      .spyOn(PDFParse.prototype, "getText")
      .mockResolvedValueOnce({ text: "Hello\u0000 World\u0001Again", total: 1 });

    try {
      const result = await extractPdfText(FAKE_PDF);
      expect(result.text).toBe("Hello World Again");
      expect(result.wordCount).toBe(3);
      expect(result.firstSentence).toBe("Hello World Again");
    } finally {
      getTextSpy.mockRestore();
    }
  });

  it("extracts an abstract section from PDF text", async () => {
    const { PDFParse } = require("pdf-parse") as {
      PDFParse: {
        prototype: {
          getText: () => Promise<{ text: string; total: number }>;
        };
      };
    };
    const getTextSpy = vi
      .spyOn(PDFParse.prototype, "getText")
      .mockResolvedValueOnce({
        text: [
          "A Study of Local Research Graphs",
          "Abstract",
          "We introduce a graph interface for inspecting local paper libraries and their citation neighborhoods.",
          "Introduction",
          "The rest of the paper starts here.",
        ].join("\n"),
        total: 1,
      });

    try {
      const result = await extractPdfText(FAKE_PDF);
      expect(result.abstract).toBe("We introduce a graph interface for inspecting local paper libraries and their citation neighborhoods.");
    } finally {
      getTextSpy.mockRestore();
    }
  });

  it("stops abstract extraction at keyword or reference headings", () => {
    expect(extractAbstractFromPdfText([
      "Title",
      "Abstract",
      "This abstract has enough content to be useful for the graph details panel.",
      "Keywords",
      "graph, papers",
    ].join("\n"))).toBe("This abstract has enough content to be useful for the graph details panel.");

    expect(extractAbstractFromPdfText([
      "Title",
      "Abstract",
      "This short note explains the selected paper for a local research graph.",
      "References",
      "[1] Later citation.",
    ].join("\n"))).toBe("This short note explains the selected paper for a local research graph.");
  });

  it("does not treat decimals inside an abstract as numeric section headings", () => {
    expect(extractAbstractFromPdfText([
      "Abstract",
      "We report a 1.2x improvement for local graph inspection while preserving paper context.",
      "1. Introduction",
      "The body starts here.",
    ].join("\n"))).toBe("We report a 1.2x improvement for local graph inspection while preserving paper context.");
  });

  it("does not treat keywords or references in prose as section headings", () => {
    expect(extractAbstractFromPdfText([
      "Abstract",
      "We compare keywords and references in normal prose while preserving enough context for selected papers.",
      "Introduction",
      "The body starts here.",
    ].join("\n"))).toBe("We compare keywords and references in normal prose while preserving enough context for selected papers.");
  });

  it("throws 'PDF file not found' for a missing path", async () => {
    await expect(extractPdfText(MISSING_PDF)).rejects.toThrow(/^PDF file not found$/);
  });

  it("wraps parse failures as 'Invalid PDF'", async () => {
    await expect(extractPdfText(CORRUPT_PDF)).rejects.toThrow(/^Invalid PDF$/);
  });
});
