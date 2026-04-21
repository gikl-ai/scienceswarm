import path from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ROOT = path.join(tmpdir(), "scienceswarm-api-research-questions");
const ORIGINAL_SCIENCESWARM_DIR = process.env.SCIENCESWARM_DIR;

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  process.env.SCIENCESWARM_DIR = ROOT;
});

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  // Use undefined check (not truthy) so an empty-string original env value
  // round-trips correctly instead of being deleted across tests.
  if (ORIGINAL_SCIENCESWARM_DIR !== undefined) {
    process.env.SCIENCESWARM_DIR = ORIGINAL_SCIENCESWARM_DIR;
  } else {
    delete process.env.SCIENCESWARM_DIR;
  }
});

async function importRoute() {
  return await import("@/app/api/research-questions/[projectId]/route");
}

function projectWikiDir(slug: string): string {
  return path.join(ROOT, "brain", "wiki", "projects", slug);
}

function projectWikiPage(slug: string): string {
  return path.join(ROOT, "brain", "wiki", "projects", `${slug}.md`);
}

function mockContext(projectId: string) {
  return { params: Promise.resolve({ projectId }) };
}

describe("GET /api/research-questions/[projectId]", () => {
  it("returns the scan for a seeded project wiki (happy path)", async () => {
    const slug = "alpha";
    const dir = projectWikiDir(slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "plan.md"),
      ["RQ1: Does alpha reach the target latency?", ""].join("\n"),
      "utf-8",
    );

    const { GET } = await importRoute();
    const res = await GET(
      new Request(`http://localhost/api/research-questions/${slug}`),
      mockContext(slug),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scannedFiles).toBe(1);
    expect(body.questions).toHaveLength(1);
    expect(body.questions[0].id).toBe("RQ1");
    expect(body.questions[0].text).toBe(
      "Does alpha reach the target latency?",
    );
    expect(typeof body.scannedAt).toBe("string");
  });

  it("falls back to the project wiki page file when no project directory exists", async () => {
    const slug = "file-backed";
    mkdirSync(path.dirname(projectWikiPage(slug)), { recursive: true });
    writeFileSync(
      projectWikiPage(slug),
      ["## Research questions", "- Does the single project page get scanned?"].join("\n"),
      "utf-8",
    );

    const { GET } = await importRoute();
    const res = await GET(
      new Request(`http://localhost/api/research-questions/${slug}`),
      mockContext(slug),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scannedFiles).toBe(1);
    expect(body.questions).toHaveLength(1);
    expect(body.questions[0].file).toBe("file-backed.md");
    expect(body.questions[0].text).toBe("Does the single project page get scanned?");
  });

  it("returns 400 on an unsafe project slug", async () => {
    const { GET } = await importRoute();
    const res = await GET(
      new Request("http://localhost/api/research-questions/..%2Fetc"),
      mockContext("../etc"),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Invalid project slug");
  });

  it("returns an empty 200 scan for an unknown slug", async () => {
    const { GET } = await importRoute();
    const res = await GET(
      new Request("http://localhost/api/research-questions/ghost"),
      mockContext("ghost"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.questions).toEqual([]);
    expect(body.scannedFiles).toBe(0);
  });

  it("extracts all three forms from a seeded project wiki", async () => {
    const slug = "beta";
    const dir = projectWikiDir(slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "index.md"),
      [
        "# Beta",
        "",
        "RQ1: Does the retriever help on long docs?",
        "Research question: How should we measure success?",
        "",
        "## Research questions",
        "- What is the latency budget?",
        "- How do we gate release?",
        "",
        "## Notes",
        "Outside the section — ignored trailing question?",
      ].join("\n"),
      "utf-8",
    );

    const { GET } = await importRoute();
    const res = await GET(
      new Request(`http://localhost/api/research-questions/${slug}`),
      mockContext(slug),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    const texts = (body.questions as Array<{ text: string }>).map(
      (q) => q.text,
    );
    expect(texts).toContain("Does the retriever help on long docs?");
    expect(texts).toContain("How should we measure success?");
    expect(texts).toContain("What is the latency budget?");
    expect(texts).toContain("How do we gate release?");
    // The trailing-? prose in `## Notes` must NOT be dragged in.
    expect(
      texts.some((t) => t.includes("Outside the section")),
    ).toBe(false);

    const byId = new Map<string, string>();
    for (const q of body.questions as Array<{
      id: string;
      text: string;
    }>) {
      if (q.id) byId.set(q.id, q.text);
    }
    expect(byId.get("RQ1")).toBe("Does the retriever help on long docs?");
  });

  it("handles a larger seed (10 files) end-to-end", async () => {
    const slug = "gamma";
    const dir = projectWikiDir(slug);
    mkdirSync(dir, { recursive: true });
    for (let i = 1; i <= 10; i += 1) {
      writeFileSync(
        path.join(dir, `note-${i}.md`),
        [
          `# Note ${i}`,
          "",
          `RQ${i}: Does condition ${i} hold under load?`,
          "",
          "## Research questions",
          `- Follow-up bullet for note ${i}?`,
        ].join("\n"),
        "utf-8",
      );
    }

    const { GET } = await importRoute();
    const res = await GET(
      new Request(`http://localhost/api/research-questions/${slug}`),
      mockContext(slug),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scannedFiles).toBe(10);
    // 10 RQ\d: lines + 10 bullet lines = 20 total.
    expect(body.questions).toHaveLength(20);
    const ids = new Set(
      (body.questions as Array<{ id: string }>).map((q) => q.id),
    );
    for (let i = 1; i <= 10; i += 1) {
      expect(ids.has(`RQ${i}`)).toBe(true);
    }
  });
});
