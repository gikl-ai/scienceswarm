import { describe, it, expect, beforeEach } from "vitest";
import matter from "gray-matter";

import {
  approveRevisionPlan,
  cancelJob,
  draftRevisionPlan,
  extractFindings,
  isJobCancelled,
  resolveScope,
  __resetCancelRegistry,
} from "@/brain/audit-revise-plan";

const FIXED_NOW = new Date("2026-04-15T00:30:00Z");

beforeEach(() => {
  __resetCancelRegistry();
});

describe("extractFindings", () => {
  it("reads synthesized_findings when present", () => {
    const findings = extractFindings({
      synthesized_findings: [
        { finding_id: "F001", severity: "error", description: "broken" },
      ],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      id: "F001",
      severity: "error",
      description: "broken",
    });
  });

  it("falls back to findings when synthesized_findings is missing", () => {
    const findings = extractFindings({
      findings: [
        { id: "FX", severity: "warning", description: "meh", suggested_fix: "do better" },
      ],
    });
    expect(findings).toEqual([
      {
        id: "FX",
        severity: "warning",
        description: "meh",
        suggestedFix: "do better",
      },
    ]);
  });

  it("returns an empty array for invalid shapes", () => {
    expect(extractFindings(null)).toEqual([]);
    expect(extractFindings("nope")).toEqual([]);
    expect(extractFindings({ findings: "still nope" })).toEqual([]);
  });

  it("generates fallback ids when entries omit one", () => {
    const findings = extractFindings({
      findings: [
        { description: "first" },
        { description: "second" },
      ],
    });
    expect(findings[0].id).toBe("F1");
    expect(findings[1].id).toBe("F2");
  });
});

describe("resolveScope", () => {
  it.each([
    ["translate this", "translation"],
    ["full revision please", "full"],
    ["text only", "text_only"],
    ["rerun stats", "data_and_text"],
    [undefined, "text_only"],
    ["", "text_only"],
    ["data_and_text", "data_and_text"],
  ])("maps '%s' → %s", (hint, expected) => {
    expect(resolveScope(hint ?? undefined)).toBe(expected);
  });
});

describe("draftRevisionPlan", () => {
  it("builds a draft plan with per-finding rows and locked status", () => {
    const result = draftRevisionPlan({
      paperSlug: "hubble-1929",
      project: "hubble-1929",
      critiqueSlug: "hubble-1929-critique",
      critiquePayload: {
        findings: [
          {
            id: "F001",
            severity: "error",
            description: "The distance ladder is shaky.",
            suggested_fix: "Add error bars.",
          },
          {
            id: "F002",
            severity: "warning",
            description: "Missing Lemaître 1927 citation.",
            suggested_fix: "Add footnote.",
          },
        ],
      },
      userHandle: "@scienceswarm-demo",
      now: FIXED_NOW,
    });

    expect(result.slug).toBe("hubble-1929-revision-plan");
    expect(result.frontmatter.status).toBe("draft");
    expect(result.frontmatter.version).toBe(1);
    expect(result.frontmatter.parent).toBe("hubble-1929");
    expect(result.frontmatter.critique).toBe("hubble-1929-critique");
    expect(result.findingCount).toBe(2);
    expect(result.markdown).toContain("# Revision plan for [[hubble-1929]]");
    expect(result.markdown).toContain("## Intent");
    expect(result.markdown).toContain("## Findings in scope");
    expect(result.markdown).toContain("## Required inputs");
    expect(result.markdown).toContain("## Expected outputs");
    expect(result.markdown).toContain("## Assumptions and non-goals");
    expect(result.markdown).toContain("F001");
    expect(result.markdown).toContain("Missing Lemaître 1927 citation.");
    expect(result.markdown).toContain("| 1 | F001 | error | The distance ladder is shaky. | fix |");
    expect(result.markdown).toContain("| 2 | F002 | warning | Missing Lemaître 1927 citation. | fix |");
    expect(result.markdown).toContain(
      "This is plan [[hubble-1929-revision-plan]] (status: draft). Reply approve",
    );
    expect(result.markdown).toContain("status: draft");
    expect(result.markdown).toContain("uploaded_at: '2026-04-15T00:30:00Z'");
  });

  it("emits a no-findings placeholder when the critique payload has none", () => {
    const result = draftRevisionPlan({
      paperSlug: "x",
      project: "x",
      critiqueSlug: "x-critique",
      critiquePayload: { findings: [] },
      userHandle: "@scienceswarm-demo",
      now: FIXED_NOW,
    });
    expect(result.findingCount).toBe(0);
    expect(result.markdown).toContain("No findings extracted");
  });

  it("picks up scope hints from the user (translation wins over data)", () => {
    const result = draftRevisionPlan({
      paperSlug: "mendel-1866",
      project: "mendel-1866",
      critiqueSlug: "mendel-1866-critique",
      critiquePayload: { findings: [] },
      scopeHints: "rerun stats and translate",
      userHandle: "@scienceswarm-demo",
      now: FIXED_NOW,
    });
    // "translate" is matched first by resolveScope's rule order because
    // translation is a narrower signal than the catch-all data hint.
    expect(result.frontmatter.scope).toBe("translation");
  });

  it("falls back to data_and_text when only data hints are present", () => {
    const result = draftRevisionPlan({
      paperSlug: "mendel-1866",
      project: "mendel-1866",
      critiqueSlug: "mendel-1866-critique",
      critiquePayload: { findings: [] },
      scopeHints: "rerun stats",
      userHandle: "@scienceswarm-demo",
      now: FIXED_NOW,
    });
    expect(result.frontmatter.scope).toBe("data_and_text");
  });
});

describe("approveRevisionPlan", () => {
  function buildDraftMarkdown(): string {
    return matter.stringify("# body", {
      type: "revision_plan",
      project: "hubble-1929",
      parent: "hubble-1929",
      critique: "hubble-1929-critique",
      status: "draft",
      version: 1,
      scope: "text_only",
    });
  }

  it("flips a draft plan to approved and stamps approved_at", () => {
    const markdown = buildDraftMarkdown();
    const result = approveRevisionPlan({
      slug: "hubble-1929-revision-plan",
      markdown,
      userHandle: "@scienceswarm-demo",
      now: FIXED_NOW,
    });
    expect(result.previousStatus).toBe("draft");
    expect(result.frontmatter.status).toBe("approved");
    expect(result.frontmatter.approved_at).toBe("2026-04-15T00:30:00Z");
    expect(result.markdown).toContain("status: approved");
  });

  it("refuses to approve a plan that is not in the draft state", () => {
    const markdown = matter.stringify("# body", {
      type: "revision_plan",
      project: "hubble-1929",
      parent: "hubble-1929",
      critique: "hubble-1929-critique",
      status: "approved",
      version: 1,
      scope: "text_only",
      approved_at: "2026-04-14T22:00:00Z",
    });
    expect(() =>
      approveRevisionPlan({
        slug: "hubble-1929-revision-plan",
        markdown,
        userHandle: "@scienceswarm-demo",
        now: FIXED_NOW,
      }),
    ).toThrow(/has status 'approved', expected 'draft'/);
  });

  it("throws when the frontmatter fails Zod validation", () => {
    const markdown = matter.stringify("# body", {
      type: "revision_plan",
      project: "hubble-1929",
      parent: "hubble-1929",
      critique: "hubble-1929-critique",
      status: "broken",
      version: 0,
      scope: "text_only",
    });
    expect(() =>
      approveRevisionPlan({
        slug: "x",
        markdown,
        userHandle: "@scienceswarm-demo",
      }),
    ).toThrow();
  });
});

describe("cancelJob", () => {
  it("marks a handle as cancelled", () => {
    const out = cancelJob("job_123", "user pressed cancel");
    expect(out.ok).toBe(true);
    expect(out.handle).toBe("job_123");
    expect(isJobCancelled("job_123")).toBe(true);
  });

  it("returns the cancelled timestamp as an ISO string", () => {
    const out = cancelJob("job_abc");
    expect(() => new Date(out.cancelledAt).toISOString()).not.toThrow();
  });

  it("rejects empty handles loudly", () => {
    expect(() => cancelJob("")).toThrow(/handle is required/);
    expect(() => cancelJob("   ")).toThrow(/handle is required/);
  });

  it("isJobCancelled returns false for unknown handles", () => {
    expect(isJobCancelled("never-set")).toBe(false);
  });
});
