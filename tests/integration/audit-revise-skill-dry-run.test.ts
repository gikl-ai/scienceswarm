import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import matter from "gray-matter";

const SKILL_PATH = join(
  process.cwd(),
  ".openclaw/skills/audit-revise/SKILL.md",
);

const EXPECTED_TOOLS = [
  "resolve_artifact",
  "read_artifact",
  "critique_artifact",
  "draft_revision_plan",
  "approve_revision_plan",
  "run_job",
  "check_job",
  "cancel_job",
  "link_artifact",
];

describe("audit-revise SKILL.md (dry-run)", () => {
  it("ships at .openclaw/skills/audit-revise/SKILL.md", () => {
    expect(existsSync(SKILL_PATH)).toBe(true);
  });

  // Load the skill eagerly so every assertion below is a hard failure
  // when the file is missing instead of a silent pass through an
  // `if (!parsed) return` guard. Greptile P1 on PR #287: if SKILL.md
  // is deleted, the old guards would leave 8 of 9 tests silently
  // green.
  const raw = existsSync(SKILL_PATH) ? readFileSync(SKILL_PATH, "utf8") : "";
  if (!raw) {
    throw new Error(
      `audit-revise SKILL.md missing at ${SKILL_PATH} — this throws ` +
        "before any assertion so the suite fails loudly instead of " +
        "silently passing the downstream checks.",
    );
  }
  const parsed = matter(raw);

  it("has YAML frontmatter with name, description, runtime, tools", () => {
    const data = parsed.data as Record<string, unknown>;
    expect(data.name).toBe("audit-revise");
    expect(typeof data.description).toBe("string");
    expect(data.runtime).toBe("in-session");
    expect(Array.isArray(data.tools)).toBe(true);
  });

  it("declares exactly the nine-tool surface from plan §1.1", () => {
    const data = parsed.data as { tools?: unknown };
    expect(Array.isArray(data.tools)).toBe(true);
    const tools = (data.tools as string[]).slice().sort();
    expect(tools).toEqual(EXPECTED_TOOLS.slice().sort());
  });

  it("lists the required secrets used by the critique path", () => {
    const data = parsed.data as { secrets?: unknown };
    expect(Array.isArray(data.secrets)).toBe(true);
    const secrets = data.secrets as string[];
    expect(secrets).toContain("SCIENCESWARM_USER_HANDLE");
    expect(secrets).toContain("STRUCTURED_CRITIQUE_SERVICE_URL");
    expect(secrets).toContain("STRUCTURED_CRITIQUE_SERVICE_TOKEN");
  });

  it("documents the hard preconditions that enforce ordering", () => {
    const body = parsed.content;
    // The skill must forbid calling draft_revision_plan before
    // critique_artifact and run_job before approve_revision_plan.
    // Strip markdown backticks so the assertions do not care about
    // formatting changes that leave the rule text intact.
    const plain = body.replace(/`/g, "");
    expect(plain).toMatch(
      /critique_artifact\s+must\s+run\s+before\s+draft_revision_plan/i,
    );
    expect(plain).toMatch(
      /run_job\s+is\s+refused\s+without\s+an\s+approved\s+plan/i,
    );
    expect(plain).toMatch(
      /approve_revision_plan\s+waits\s+for\s+the\s+user/i,
    );
  });

  it("mentions the 8-10 minute wall-time expectation for critique", () => {
    expect(parsed.content).toContain("8-10 minutes");
  });

  it("lists the four job kinds the v1 demo ships", () => {
    const body = parsed.content;
    expect(body).toContain("revise_paper");
    expect(body).toContain("write_cover_letter");
    expect(body).toContain("rerun_stats_and_regenerate_figure");
    expect(body).toContain("translate_paper");
  });

  it("references the dashboard surfaces that render audit-revise output", () => {
    const body = parsed.content;
    expect(body).toContain("/dashboard/project");
    expect(body).toContain("/dashboard/reasoning?brain_slug=");
  });

  it("forbids calling tools outside the nine-tool surface", () => {
    const body = parsed.content;
    expect(body).toMatch(/Hallucinated tool names are forbidden/i);
    expect(body).toMatch(/nine-tool surface/i);
  });
});
