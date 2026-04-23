import { describe, expect, it } from "vitest";
import {
  createIdentityCandidateFromEvidence,
  deriveTitleHintFromPath,
  extractPaperIdentityEvidence,
  normalizeArxivId,
  normalizeDoi,
} from "@/lib/paper-library/identity";

describe("paper-library identity", () => {
  it("normalizes DOI and arXiv identifiers", () => {
    expect(normalizeDoi("https://doi.org/10.1038/S41586-023-06747-5.")).toBe("10.1038/s41586-023-06747-5");
    expect(normalizeArxivId("arXiv:2401.08890v2.")).toBe("2401.08890v2");
  });

  it("extracts DOI, arXiv, PMID, year, and filename title hints", () => {
    const evidence = extractPaperIdentityEvidence({
      relativePath: "downloads/2024 - Vaswani - Attention_is_all_you_need.pdf",
      text: "DOI: 10.1145/1234567.8901234 arXiv:2401.08890 PMID: 12345678",
      wordCount: 200,
    });

    expect(evidence.identifiers).toMatchObject({
      doi: "10.1145/1234567.8901234",
      arxivId: "2401.08890",
      pmid: "12345678",
    });
    expect(evidence.yearHint).toBe(2024);
    expect(evidence.titleHint).toContain("Attention is all you need");
    expect(evidence.textLayerTooThin).toBe(false);
  });

  it("marks low-text PDFs without identifiers for review", () => {
    const evidence = extractPaperIdentityEvidence({
      relativePath: "scan001.pdf",
      text: "short",
      wordCount: 1,
    });

    expect(evidence.textLayerTooThin).toBe(true);
    const candidate = createIdentityCandidateFromEvidence(evidence, "scan001.pdf");
    expect(candidate.conflicts).toContain("text_layer_too_thin");
  });

  it("cleans title hints from bad filenames", () => {
    expect(deriveTitleHintFromPath("papers/final-copy_Gene-Editing-Review-v2.pdf")).toBe("Gene Editing Review");
  });
});

