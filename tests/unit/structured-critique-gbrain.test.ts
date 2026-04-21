import { describe, expect, it } from "vitest";

import {
  buildStructuredCritiquePageMarkdown,
  computeStructuredCritiqueSeverityCounts,
  deriveCritiqueParentSlug,
  slugifyCritiqueParent,
} from "@/lib/structured-critique-gbrain";
import type { StructuredCritiqueJob } from "@/lib/structured-critique-schema";

function completedJob(overrides: Partial<StructuredCritiqueJob> = {}): StructuredCritiqueJob {
  return {
    id: "job-123",
    trace_id: "trace-abc",
    status: "COMPLETED",
    pdf_filename: "hubble-1929.pdf",
    style_profile: "professional",
    result: {
      title: "A Relation Between Distance and Radial Velocity",
      report_markdown: "# Report\n\nThe distance calibration is under-defended.",
      author_feedback: {
        overall_summary: "The paper's distance scale needs stronger support.",
        top_issues: [],
      },
      findings: [
        {
          finding_id: "F001",
          severity: "error",
          description: "Distance calibration fragility undermines major conclusions.",
          finding_kind: "critique",
        },
        {
          finding_id: "F002",
          severity: "warning",
          description: "Selection effects are not addressed.",
          finding_kind: "gap",
        },
      ],
    },
    ...overrides,
  };
}

describe("structured critique gbrain helpers", () => {
  it("derives safe parent slugs from filenames and titles", () => {
    expect(slugifyCritiqueParent("hubble-1929.pdf")).toBe("hubble-1929");
    expect(slugifyCritiqueParent("A Relation Between Distance & Velocity")).toBe(
      "a-relation-between-distance-velocity",
    );
    expect(deriveCritiqueParentSlug(completedJob())).toBe("hubble-1929");
  });

  it("builds audit-revise critique markdown with raw Descartes JSON", () => {
    const built = buildStructuredCritiquePageMarkdown({
      job: completedJob(),
      parentSlug: "hubble-1929",
      sourceFilename: "hubble-1929.pdf",
      uploadedAt: new Date("2026-04-18T04:45:00.000Z"),
      uploadedBy: "seiji",
    });

    expect(built.findingCount).toBe(2);
    expect(built.severityCounts).toEqual({ error: 1, warning: 1 });
    expect(built.brief).toBe("The paper's distance scale needs stronger support.");
    expect(built.markdown).toContain("type: critique");
    expect(built.markdown).toContain("parent: hubble-1929");
    expect(built.markdown).toContain("source_filename: hubble-1929.pdf");
    expect(built.markdown).toContain("descartes_job_id: job-123");
    expect(built.markdown).toContain("# Critique for [[hubble-1929]]");
    expect(built.markdown).toContain("## Raw Descartes response");
    expect(built.markdown).toContain('"finding_id": "F001"');
  });

  it("normalizes severity labels before counting", () => {
    expect(
      computeStructuredCritiqueSeverityCounts([
        { severity: " error " },
        { severity: "ERROR" },
        { severity: " " },
        {},
      ]),
    ).toEqual({ error: 2, unrated: 2 });
  });
});
