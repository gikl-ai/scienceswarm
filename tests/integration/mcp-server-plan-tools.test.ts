import { describe, it, expect, beforeEach } from "vitest";
import matter from "gray-matter";

import {
  approveRevisionPlan,
  cancelJob,
  draftRevisionPlan,
  isJobCancelled,
  __resetCancelRegistry,
} from "@/brain/audit-revise-plan";

// These assertions exercise the same handlers the MCP server wraps. The
// real MCP server wiring is covered by the unit tests plus the typecheck
// gate — here we focus on the end-to-end "draft → approve → cancel"
// flow against the fenced-JSON Descartes payload the critique tool writes into
// critique pages.

const FIXED_NOW = new Date("2026-04-15T01:00:00Z");

function buildCritiquePage(): {
  frontmatter: Record<string, unknown>;
  content: string;
} {
  const payload = {
    findings: [
      {
        id: "F001",
        severity: "error",
        description: "Distance ladder is single-threaded.",
        suggested_fix: "Add error bars + sensitivity analysis.",
      },
      {
        id: "F002",
        severity: "warning",
        description: "Missing Lemaître 1927 citation.",
        suggested_fix: "Add footnote referencing Annales 47, 49.",
      },
      {
        id: "F003",
        severity: "note",
        description: "Conclusion framed more strongly than evidence.",
        suggested_fix: "Soften the language in §5.",
      },
    ],
  };
  const body = [
    "# Critique for [[hubble-1929]]",
    "",
    "## Brief",
    "",
    "High-level summary of findings.",
    "",
    "## Raw Descartes response",
    "",
    "```json",
    JSON.stringify(payload, null, 2),
    "```",
    "",
  ].join("\n");
  return {
    frontmatter: {
      type: "critique",
      project: "hubble-1929",
      parent: "hubble-1929",
      style_profile: "professional",
      finding_count: 3,
    },
    content: body,
  };
}

beforeEach(() => {
  __resetCancelRegistry();
});

describe("plan flow: draft → approve → cancel", () => {
  it("drafts a plan from a persisted critique page, then approves it", () => {
    const critique = buildCritiquePage();
    const match = critique.content.match(/```json\s*\n([\s\S]*?)\n```/);
    expect(match).not.toBeNull();
    const payload = JSON.parse(match![1]);

    const draft = draftRevisionPlan({
      paperSlug: "hubble-1929",
      project: "hubble-1929",
      critiqueSlug: "hubble-1929-critique",
      critiquePayload: payload,
      userHandle: "@scienceswarm-demo",
      now: FIXED_NOW,
    });

    expect(draft.slug).toBe("hubble-1929-revision-plan");
    expect(draft.findingCount).toBe(3);
    expect(draft.frontmatter.status).toBe("draft");
    expect(draft.markdown).toContain("F001");
    expect(draft.markdown).toContain("F002");
    expect(draft.markdown).toContain("F003");
    expect(draft.markdown).toContain("status: draft");

    const approvedNow = new Date("2026-04-15T01:05:00Z");
    const approved = approveRevisionPlan({
      slug: draft.slug,
      markdown: draft.markdown,
      userHandle: "@scienceswarm-demo",
      now: approvedNow,
    });
    expect(approved.frontmatter.status).toBe("approved");
    expect(approved.frontmatter.approved_at).toBe("2026-04-15T01:05:00Z");
    expect(approved.markdown).toContain("status: approved");
  });

  it("approving a non-draft plan throws", () => {
    const already = matter.stringify("# body", {
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
        markdown: already,
        userHandle: "@scienceswarm-demo",
      }),
    ).toThrow(/expected 'draft'/);
  });

  it("cancel_job writes to the in-memory flag map", () => {
    expect(isJobCancelled("job_42")).toBe(false);
    const cancelled = cancelJob("job_42", "user pressed cancel");
    expect(cancelled.ok).toBe(true);
    expect(isJobCancelled("job_42")).toBe(true);
  });

  it("cancel_job rejects empty handles loudly", () => {
    expect(() => cancelJob("")).toThrow();
  });
});
