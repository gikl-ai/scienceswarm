import { describe, expect, it } from "vitest";
import {
  buildMetadataField,
  mergeMetadataField,
  scorePaperIdentity,
} from "@/lib/paper-library/metadata-merge";
import type { PaperIdentityCandidate, PaperMetadataField } from "@/lib/paper-library/contracts";

const candidate = (overrides: Partial<PaperIdentityCandidate> = {}): PaperIdentityCandidate => ({
  id: "c1",
  identifiers: { doi: "10.1000/example" },
  title: "Attention Is All You Need",
  authors: ["Vaswani"],
  year: 2017,
  source: "crossref",
  confidence: 0.91,
  evidence: ["doi_verified"],
  conflicts: [],
  ...overrides,
});

describe("paper-library metadata merge", () => {
  it("prefers user and gbrain values over external sources", () => {
    const result = mergeMetadataField([
      buildMetadataField("title", "External title", "crossref", 0.95),
      buildMetadataField("title", "My corrected title", "user", 0.99),
    ]);

    expect(result.field?.value).toBe("My corrected title");
    expect(result.field?.conflict).toBe(true);
  });

  it("preserves source-unavailable as evidence rather than absence", () => {
    const unavailable: PaperMetadataField = {
      name: "title",
      value: null,
      source: "openalex",
      confidence: 0,
      evidence: [],
      conflict: false,
      sourceStatus: "unavailable",
    };
    const result = mergeMetadataField([
      unavailable,
      buildMetadataField("title", "PDF title", "pdf_text", 0.6),
    ]);

    expect(result.field?.value).toBe("PDF title");
    expect(result.field?.evidence).toContain("openalex:unavailable");
    expect(result.unavailableSources).toHaveLength(1);
  });

  it("scores deterministic identifiers as high confidence", () => {
    expect(scorePaperIdentity({ candidate: candidate(), metadataFields: [] })).toMatchObject({
      band: "high",
    });
  });

  it("blocks on metadata conflicts and template/path problems", () => {
    const conflictedField = {
      ...buildMetadataField("title", "A", "crossref", 0.9),
      conflict: true,
    };
    const score = scorePaperIdentity({
      candidate: candidate({ confidence: 0.95 }),
      metadataFields: [conflictedField],
      requiredTemplateFieldsMissing: ["venue"],
      pathConflictCodes: ["case_collision"],
    });

    expect(score.band).toBe("blocked");
    expect(score.blockReasons).toEqual(expect.arrayContaining(["metadata_conflict", "missing:venue", "case_collision"]));
  });
});
