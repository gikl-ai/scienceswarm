import { describe, it, expect } from "vitest";
import {
  checkPdfTextLayer,
  MIN_WORDS_PER_PAGE,
} from "@/brain/ingest/text-layer-check";

describe("checkPdfTextLayer", () => {
  it("accepts a paper with more than the minimum words per page", () => {
    const result = checkPdfTextLayer({
      wordCount: 4000,
      pageCount: 6,
      fileName: "hubble-1929.pdf",
    });
    expect(result.ok).toBe(true);
    expect(result.wordsPerPage).toBeCloseTo(666.67, 1);
    expect(result.message).toBeUndefined();
  });

  it("accepts exactly the minimum threshold", () => {
    const result = checkPdfTextLayer({
      wordCount: MIN_WORDS_PER_PAGE * 3,
      pageCount: 3,
      fileName: "threshold.pdf",
    });
    expect(result.ok).toBe(true);
    expect(result.wordsPerPage).toBe(MIN_WORDS_PER_PAGE);
  });

  it("rejects an image-only scan with near-zero words per page", () => {
    const result = checkPdfTextLayer({
      wordCount: 1300,
      pageCount: 69,
      fileName: "mendel-1866-image-only.pdf",
    });
    expect(result.ok).toBe(false);
    expect(result.wordsPerPage).toBeLessThan(MIN_WORDS_PER_PAGE);
    expect(result.message).toContain("mendel-1866-image-only.pdf");
    expect(result.message).toContain("words/page");
    expect(result.message).toContain("OCR");
  });

  it("rejects when wordCount is zero", () => {
    const result = checkPdfTextLayer({
      wordCount: 0,
      pageCount: 10,
      fileName: "blank.pdf",
    });
    expect(result.ok).toBe(false);
    expect(result.wordsPerPage).toBe(0);
    expect(result.message).toContain("blank.pdf");
  });

  it("rejects when pageCount is zero", () => {
    const result = checkPdfTextLayer({
      wordCount: 5000,
      pageCount: 0,
      fileName: "broken.pdf",
    });
    expect(result.ok).toBe(false);
    expect(result.wordsPerPage).toBe(0);
    expect(result.message).toContain("broken.pdf");
    expect(result.message).toContain("could not extract");
  });

  it("rejects negative pageCount as the same class of failure", () => {
    const result = checkPdfTextLayer({
      wordCount: 1000,
      pageCount: -1,
      fileName: "corrupt.pdf",
    });
    expect(result.ok).toBe(false);
    expect(result.wordsPerPage).toBe(0);
  });

  it("includes the file name in the error so the user can identify it", () => {
    const result = checkPdfTextLayer({
      wordCount: 100,
      pageCount: 10,
      fileName: "my-upload.pdf",
    });
    expect(result.message).toContain("my-upload.pdf");
    expect(result.message).toContain("10 words/page");
  });
});
