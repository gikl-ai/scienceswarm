import { describe, expect, it } from "vitest";

import {
  buildTargetPrioritizationAssessment,
  isTargetPrioritizationRequest,
  looksLikeTargetPrioritizationArtifact,
} from "@/lib/target-biomarker-prioritizer";

const candidateMemo = `
Target candidates for residual CRC cells

- EGFR + MEK: patient-derived organoid response replicated in n=4 wells with viability assay. Mechanism fits KRAS feedback rebound. Existing inhibitors and western readout are available.
- AXL: resistance marker enriched after treatment, but only one RNA-seq observation and no perturbation assay yet.
- ERBB3: plausible bypass pathway with antibody reagent available, but evidence is weaker and timeline is longer.
`;

describe("target biomarker prioritizer", () => {
  it("detects ranking requests for targets, biomarkers, and combinations", () => {
    expect(
      isTargetPrioritizationRequest(
        "Rank these target and biomarker candidates for the next validation wave.",
      ),
    ).toBe(true);
    expect(
      isTargetPrioritizationRequest(
        "Which combination should we prioritize for resistance validation?",
      ),
    ).toBe(true);
    expect(isTargetPrioritizationRequest("Summarize this file.")).toBe(false);
  });

  it("recognizes likely prioritization artifacts", () => {
    expect(looksLikeTargetPrioritizationArtifact("docs/target-ranking.md")).toBe(true);
    expect(looksLikeTargetPrioritizationArtifact("data/biomarker_candidates.csv")).toBe(true);
    expect(looksLikeTargetPrioritizationArtifact("figures/model-fit.png")).toBe(false);
  });

  it("builds a source-backed ranking with legible criteria", () => {
    const assessment = buildTargetPrioritizationAssessment({
      prompt: "Prioritize the target and biomarker candidates for the next validation wave.",
      sources: [
        {
          workspacePath: "docs/target-candidates.md",
          sourceFilename: "target-candidates.md",
          text: candidateMemo,
        },
      ],
    });

    expect(assessment.candidates[0].name).toMatch(/EGFR|MEK/);
    expect(assessment.criteria).toEqual(
      expect.arrayContaining(["evidence strength", "mechanism fit", "timeline fit"]),
    );
    expect(assessment.markdown).toContain("## Priority Ranking");
    expect(assessment.markdown).toContain("Evidence:");
  });

  it("changes ranking logic under short-window constraints", () => {
    const defaultAssessment = buildTargetPrioritizationAssessment({
      prompt: "Rank candidates for mechanism validation.",
      sources: [{ sourceFilename: "candidates.md", text: candidateMemo }],
    });
    const constrainedAssessment = buildTargetPrioritizationAssessment({
      prompt:
        "Reprioritize these target candidates for a short two-week lab window with limited assay support.",
      sources: [{ sourceFilename: "candidates.md", text: candidateMemo }],
    });

    expect(constrainedAssessment.constraintNotes.join("\n")).toMatch(/Short-window|Limited assay/i);
    expect(constrainedAssessment.candidates[0].score).toBeGreaterThanOrEqual(
      defaultAssessment.candidates[0].score,
    );
  });

  it("is honest when candidate evidence is thin", () => {
    const assessment = buildTargetPrioritizationAssessment({
      prompt: "Prioritize AXL, MET, and YAP1 as biomarkers from this thin note.",
      sources: [
        {
          sourceFilename: "thin-candidates.txt",
          text: "AXL, MET, and YAP1 are tempting ideas, but no assay or cohort details are available.",
        },
      ],
    });

    expect(assessment.thinEvidenceWarnings.join("\n")).toMatch(/thin|not explicit|not visible/i);
    expect(assessment.markdown).toContain("## Thin Evidence and Missing Information");
  });
});
