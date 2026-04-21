import path from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ROOT = path.join(tmpdir(), "scienceswarm-api-backlinks");
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

// Import after env stub so the module-level path helpers resolve under ROOT.
async function importRoute() {
  return await import("@/app/api/backlinks/[projectId]/route");
}

function seedProjectWiki(
  slug: string,
  files: Record<string, string>,
): string {
  const projectWikiDir = path.join(ROOT, "brain", "wiki", "projects", slug);
  mkdirSync(projectWikiDir, { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    const full = path.join(projectWikiDir, name);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return projectWikiDir;
}

function seedProjectWikiPage(slug: string, contents: string): string {
  const projectWikiPage = path.join(ROOT, "brain", "wiki", "projects", `${slug}.md`);
  mkdirSync(path.dirname(projectWikiPage), { recursive: true });
  writeFileSync(projectWikiPage, contents);
  return projectWikiPage;
}

function makeParams(projectId: string): { params: Promise<{ projectId: string }> } {
  return { params: Promise.resolve({ projectId }) };
}

describe("GET /api/backlinks/[projectId]", () => {
  it("returns a backlink graph for a seeded project (happy path)", async () => {
    seedProjectWiki("my-project", {
      "alpha.md": "Refers to [[beta]] here.",
      "beta.md": "And back to [[alpha]].",
    });

    const { GET } = await importRoute();
    const res = await GET(
      new Request("http://localhost/api/backlinks/my-project"),
      makeParams("my-project"),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scannedFiles).toBe(2);
    expect(body.forward["alpha.md"]).toEqual(["beta"]);
    expect(body.forward["beta.md"]).toEqual(["alpha"]);
    expect(body.backward["alpha"]).toEqual(["beta.md"]);
    expect(body.backward["beta"]).toEqual(["alpha.md"]);
    expect(body.brokenLinks).toEqual([]);
    expect(typeof body.scannedAt).toBe("string");
  });

  it("rejects an unsafe project slug with 400", async () => {
    const { GET } = await importRoute();
    const res = await GET(
      new Request("http://localhost/api/backlinks/..%2Fetc"),
      makeParams("../etc"),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Invalid project slug");
  });

  it("returns 200 with an empty graph for an unknown slug", async () => {
    const { GET } = await importRoute();
    const res = await GET(
      new Request("http://localhost/api/backlinks/does-not-exist"),
      makeParams("does-not-exist"),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scannedFiles).toBe(0);
    expect(body.forward).toEqual({});
    expect(body.backward).toEqual({});
    expect(body.brokenLinks).toEqual([]);
  });

  it("surfaces broken links in the brokenLinks array", async () => {
    seedProjectWiki("broken-proj", {
      "only.md": "Links to [[missing-target]] nowhere.",
    });

    const { GET } = await importRoute();
    const res = await GET(
      new Request("http://localhost/api/backlinks/broken-proj"),
      makeParams("broken-proj"),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.brokenLinks).toHaveLength(1);
    expect(body.brokenLinks[0]).toMatchObject({
      src: "only.md",
      target: "missing-target",
      line: 1,
    });
    expect(body.backward["missing-target"]).toBeUndefined();
  });

  it("falls back to the project wiki page file when no project directory exists", async () => {
    seedProjectWikiPage("file-backed", "Links to [[ghost]].");

    const { GET } = await importRoute();
    const res = await GET(
      new Request("http://localhost/api/backlinks/file-backed"),
      makeParams("file-backed"),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scannedFiles).toBe(1);
    expect(body.forward["file-backed.md"]).toEqual(["ghost"]);
    expect(body.brokenLinks).toHaveLength(1);
  });

  it("handles a larger seed of 10 files and 20 links end-to-end", async () => {
    // 10 files named f0..f9; each links forward to the next two (with wraparound),
    // giving 20 unique (src, target) edges.
    const files: Record<string, string> = {};
    for (let i = 0; i < 10; i++) {
      const next1 = `f${(i + 1) % 10}`;
      const next2 = `f${(i + 2) % 10}`;
      files[`f${i}.md`] = `Points to [[${next1}]] and [[${next2}]].`;
    }
    seedProjectWiki("big", files);

    const { GET } = await importRoute();
    const res = await GET(
      new Request("http://localhost/api/backlinks/big"),
      makeParams("big"),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scannedFiles).toBe(10);
    // Every forward list has exactly 2 unique targets.
    for (let i = 0; i < 10; i++) {
      expect(body.forward[`f${i}.md`]).toHaveLength(2);
    }
    // Every target should be linked from exactly 2 distinct sources.
    for (let i = 0; i < 10; i++) {
      const sources = body.backward[`f${i}`] as string[];
      expect(sources).toBeDefined();
      expect(sources).toHaveLength(2);
    }
    expect(body.brokenLinks).toEqual([]);
  });
});
