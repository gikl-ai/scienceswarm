import { describe, expect, it } from "vitest";
import {
  createIdentityCandidateFromEvidence,
  deriveTitleHintFromPath,
  deriveTitleHintFromText,
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

  it("prefers the PDF title and ignores identifiers that only appear in references", () => {
    const evidence = extractPaperIdentityEvidence({
      relativePath: "Leonardo de Moura 2021 - The Lean 4 Theorem Prover.pdf",
      text: [
        "Seed-Prover 1.5: Mastering Undergraduate-Level",
        "Theorem Proving via Learning from Experience",
        "ByteDance Seed AI4Math",
        "Abstract",
        "We train a theorem proving model.",
        "References",
        "[1] Leonardo de Moura and Sebastian Ullrich. The Lean 4 Theorem Prover and Programming Language. doi: 10.1007/978-3-030-79876-5_37.",
      ].join("\n"),
      wordCount: 200,
    });

    expect(evidence.titleHint).toBe("Seed-Prover 1.5: Mastering Undergraduate-Level Theorem Proving via Learning from Experience");
    expect(evidence.identifiers.doi).toBeUndefined();
    expect(evidence.evidence).toContain("title_from_pdf_text");
  });

  it("keeps PDF-text title evidence even when the filename matches the extracted title", () => {
    const evidence = extractPaperIdentityEvidence({
      relativePath: "Interesting Paper.pdf",
      text: [
        "Interesting Paper",
        "Abstract",
        "A paper with a matching filename.",
      ].join("\n"),
      wordCount: 120,
    });

    expect(evidence.titleHint).toBe("Interesting Paper");
    expect(evidence.evidence).toContain("title_from_pdf_text");
    expect(evidence.evidence).not.toContain("title_from_filename");
  });

  it("derives a title from the front matter before falling back to the filename", () => {
    expect(deriveTitleHintFromText("arXiv:2601.00001\n\nA Minimal Agent for Automated Theorem Proving\n\nAbstract")).toBe("A Minimal Agent for Automated Theorem Proving");
    expect(deriveTitleHintFromText("Technical Report\nGOEDEL-PROVER-V2: SCALING FORMAL THEOREM\nPROVING WITH SCAFFOLDED DATA SYNTHESIS\nAuthors")).toBe(
      "GOEDEL-PROVER-V2: SCALING FORMAL THEOREM PROVING WITH SCAFFOLDED DATA SYNTHESIS",
    );
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

  it("strips common year and author prefixes from structured filenames", () => {
    expect(deriveTitleHintFromPath("papers/2024 - Smith - Local Latex.pdf")).toBe("Local Latex");
    expect(deriveTitleHintFromPath("papers/2024 - Smith-Jones - Local Latex.pdf")).toBe("Local Latex");
    expect(deriveTitleHintFromPath("papers/2024 - Local Latex.pdf")).toBe("Local Latex");
    expect(deriveTitleHintFromPath("papers/Smith 2024 - Local Latex.pdf")).toBe("Local Latex");
    expect(deriveTitleHintFromPath("papers/Smith-Jones 2024 - Local Latex.pdf")).toBe("Local Latex");
    expect(deriveTitleHintFromPath("papers/Scaling Laws 2024 Update.pdf")).toBe("Scaling Laws 2024 Update");
  });
});
