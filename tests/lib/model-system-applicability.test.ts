import { describe, expect, it } from "vitest";

import {
  buildModelSystemApplicabilityAssessment,
  isModelSystemApplicabilityRequest,
  looksLikeModelSystemArtifact,
} from "@/lib/model-system-applicability";

const organoidMemo = `
KRAS-mutant colorectal organoid drug-response memo

Patient-derived organoid line CRC-214 carries KRAS G12D and TP53 loss.
Viability readout at day 7 after EGFR + MEK inhibition, n=4 wells per dose.
No immune co-culture or stromal compartment is included. Vehicle controls are included.
`;

describe("model-system applicability", () => {
  it("detects fit, transfer, validation, and comparison requests", () => {
    expect(
      isModelSystemApplicabilityRequest(
        "Is this organoid model applicable to our patient biomarker question?",
      ),
    ).toBe(true);
    expect(
      isModelSystemApplicabilityRequest(
        "Compare the organoid vs mouse model for this immune-context question.",
      ),
    ).toBe(true);
    expect(isModelSystemApplicabilityRequest("Summarize the latest chart.")).toBe(false);
  });

  it("recognizes likely model-system artifacts", () => {
    expect(looksLikeModelSystemArtifact("docs/organoid-validation-memo.md")).toBe(true);
    expect(looksLikeModelSystemArtifact("data/pdx_response_table.csv")).toBe(true);
    expect(looksLikeModelSystemArtifact("figures/overview.png")).toBe(false);
  });

  it("builds an applicability report with transfer risks and a validation ladder", () => {
    const assessment = buildModelSystemApplicabilityAssessment({
      prompt:
        "Is this organoid model a strong fit for deciding whether the EGFR + MEK result should influence our patient biomarker plan?",
      sources: [
        {
          workspacePath: "docs/organoid-validation-memo.md",
          sourceFilename: "organoid-validation-memo.md",
          text: organoidMemo,
        },
      ],
    });

    expect(assessment.systems).toContain("patient-derived organoid");
    expect(assessment.summary).toMatch(/moderate fit|provisional/i);
    expect(assessment.transferRisks.join("\n")).toMatch(/immune|stromal|microenvironment/i);
    expect(assessment.validationLadder.join("\n")).toMatch(/PDX|mouse|patient/i);
    expect(assessment.markdown).toContain("## Missing Metadata ScienceSwarm Will Not Assume");
  });

  it("makes two-system tradeoffs visible when a comparison is requested", () => {
    const assessment = buildModelSystemApplicabilityAssessment({
      prompt:
        "Compare the patient-derived organoid versus mouse model for an immune microenvironment question.",
      sources: [
        {
          sourceFilename: "model-options.md",
          text: [
            "Option A: patient-derived organoid with KRAS mutation and viability readout.",
            "Option B: mouse model with in vivo dosing and tumor microenvironment readout.",
          ].join("\n"),
        },
      ],
    });

    expect(assessment.comparedSystems.length).toBeGreaterThanOrEqual(2);
    expect(assessment.markdown).toContain("Candidate-System Comparison");
    expect(assessment.markdown).toContain("mouse model");
    expect(assessment.markdown).toContain("patient-derived organoid");
  });

  it("names missing metadata instead of inventing context", () => {
    const assessment = buildModelSystemApplicabilityAssessment({
      prompt:
        "Is this model system applicable to the target question if the source does not specify the assay context?",
      sources: [
        {
          sourceFilename: "thin-note.txt",
          text: "A convenient model system showed a promising response.",
        },
      ],
    });

    expect(assessment.missingMetadata).toEqual(
      expect.arrayContaining([
        "model identity, tissue, or lineage",
        "assay or readout definition",
        "replication, cohort size, or sampling plan",
      ]),
    );
    expect(assessment.summary).toMatch(/cannot make a strong|provisional/i);
  });
});
