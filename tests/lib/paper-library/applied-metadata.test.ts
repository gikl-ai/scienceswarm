import { describe, expect, it } from "vitest";

import { buildAppliedPaperMetadata } from "@/lib/paper-library/applied-metadata";
import type { ApplyOperation, PaperReviewItem } from "@/lib/paper-library/contracts";

function baseOperation(): ApplyOperation {
  return {
    id: "operation-1",
    paperId: "paper-1",
    kind: "rename",
    destinationRelativePath: "2024 - Interesting Paper.pdf",
    reason: "test",
    confidence: 0.91,
    conflictCodes: [],
  };
}

function baseReviewItem(): PaperReviewItem {
  return {
    id: "review-1",
    scanId: "scan-1",
    paperId: "paper-1",
    state: "corrected",
    reasonCodes: [],
    candidates: [{
      id: "candidate-1",
      identifiers: {},
      title: "Interesting Paper",
      authors: ["Ada Lovelace"],
      year: 2024,
      venue: "Journal of Tests",
      source: "pdf_text",
      confidence: 0.91,
      evidence: [],
      conflicts: [],
    }],
    selectedCandidateId: "candidate-1",
    correction: {},
    version: 1,
    updatedAt: "2026-04-23T00:00:00.000Z",
  };
}

describe("buildAppliedPaperMetadata", () => {
  it("keeps a valid corrected year", () => {
    const reviewItem = baseReviewItem();
    reviewItem.correction = { year: "2025" };

    const metadata = buildAppliedPaperMetadata(baseOperation(), reviewItem);

    expect(metadata.year).toBe(2025);
  });

  it("drops an invalid corrected year and falls back to the candidate year", () => {
    const reviewItem = baseReviewItem();
    reviewItem.correction = { year: "99999" };

    const metadata = buildAppliedPaperMetadata(baseOperation(), reviewItem);

    expect(metadata.year).toBe(2024);
  });
});
