import { describe, expect, it } from "vitest";

import {
  buildExperimentDesignCritiqueJob,
  isExperimentDesignCritiqueRequest,
  looksLikeExperimentDesignArtifact,
  summarizeExperimentDesignIteration,
} from "@/lib/experiment-design-critique";

const memo = `
EGFR + MEK residual-cell mechanism experiment plan

We will treat one KRAS-mutant organoid line with dual EGFR + MEK inhibition.
n=2 wells/group. Endpoint viability at day 7 plus one immunoblot.
If residual viability remains, we will conclude a durable rebound mechanism is present.
`;

describe("experiment design critique", () => {
  it("detects natural-language design critique requests", () => {
    expect(
      isExperimentDesignCritiqueRequest(
        "Critique this experimental design and tell me what controls are missing.",
      ),
    ).toBe(true);
    expect(
      isExperimentDesignCritiqueRequest(
        "Run a full revise-and-resubmit audit of this manuscript package.",
      ),
    ).toBe(false);
    expect(isExperimentDesignCritiqueRequest("Summarize this figure caption.")).toBe(false);
  });

  it("recognizes likely design artifacts", () => {
    expect(looksLikeExperimentDesignArtifact("protocols/residual-cell-plan.md")).toBe(true);
    expect(looksLikeExperimentDesignArtifact("results/viability-table.csv")).toBe(false);
  });

  it("builds a structured critique job with concrete design findings", () => {
    const job = buildExperimentDesignCritiqueJob({
      workspacePath: "protocols/egfr_mek_design_memo.txt",
      sourceFilename: "egfr_mek_design_memo.txt",
      text: memo,
    });

    expect(job.status).toBe("COMPLETED");
    expect(job.result?.title).toContain("Experimental design critique");
    expect(job.result?.findings.length).toBeGreaterThanOrEqual(4);
    expect(
      job.result?.findings.some((finding) => finding.flaw_type === "sampling_plan"),
    ).toBe(true);
    expect(
      job.result?.findings.some((finding) => finding.flaw_type === "controls"),
    ).toBe(true);
    expect(
      job.result?.findings.some((finding) => finding.flaw_type === "claim_strength"),
    ).toBe(true);
    expect(job.result?.author_feedback?.overall_summary).toMatch(/design/i);
  });

  it("summarizes what improved and what still needs attention across iterations", () => {
    const previous = buildExperimentDesignCritiqueJob({
      sourceFilename: "design.txt",
      text: [
        "Use one organoid model.",
        "n=2 wells.",
        "No randomization is planned.",
      ].join("\n"),
    });
    const current = buildExperimentDesignCritiqueJob({
      sourceFilename: "design.txt",
      text: [
        "Use two organoid models.",
        "n=4 wells per model.",
        "Randomize plate positions.",
        "No washout or rechallenge is planned.",
      ].join("\n"),
    });

    const summary = summarizeExperimentDesignIteration(
      previous.result?.findings ?? [],
      current.result?.findings ?? [],
    );

    expect(summary.improved).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Sampling plan is too weak or unspecified"),
        expect.stringContaining("Bias-control and batch-handling details are missing"),
      ]),
    );
    expect(summary.stillWeak).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Transfer across models is not established"),
      ]),
    );
  });
});
