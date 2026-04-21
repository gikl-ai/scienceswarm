import path from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ROOT = path.join(tmpdir(), "scienceswarm-api-project-stats");
const ORIGINAL_SCIENCESWARM_DIR = process.env.SCIENCESWARM_DIR;

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  process.env.SCIENCESWARM_DIR = ROOT;
});

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  if (ORIGINAL_SCIENCESWARM_DIR !== undefined) {
    process.env.SCIENCESWARM_DIR = ORIGINAL_SCIENCESWARM_DIR;
  } else {
    delete process.env.SCIENCESWARM_DIR;
  }
});

// Import after env stub so the module-level path helpers resolve under ROOT.
async function importRoute() {
  return await import("@/app/api/projects/[slug]/stats/route");
}

async function importLib() {
  return await import("@/lib/project-stats");
}

function seedProject(slug: string, files: Record<string, string | Buffer>) {
  const projectDir = path.join(ROOT, "projects", slug);
  for (const [rel, contents] of Object.entries(files)) {
    const absPath = path.join(projectDir, rel);
    mkdirSync(path.dirname(absPath), { recursive: true });
    writeFileSync(absPath, contents);
  }
  return projectDir;
}

describe("GET /api/projects/[slug]/stats", () => {
  it("returns computed stats for a seeded project", async () => {
    const slug = "alpha";
    seedProject(slug, {
      "papers/one.pdf": "%PDF-1.4",
      "papers/two.pdf": "%PDF-1.4",
      "code/main.py": "print('hi')",
      "docs/notes.md": "alpha beta gamma",
    });

    const { GET } = await importRoute();
    const res = await GET(
      new Request(`http://localhost/api/projects/${slug}/stats`),
      { params: Promise.resolve({ slug }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.slug).toBe(slug);
    expect(body.folderCounts.papers).toBe(2);
    expect(body.folderCounts.code).toBe(1);
    expect(body.folderCounts.docs).toBe(1);
    expect(body.totals.files).toBe(4);
    expect(body.byExtension[".pdf"]).toBe(2);
    expect(body.byExtension[".md"]).toBe(1);
    expect(body.byExtension[".py"]).toBe(1);
    // docs/notes.md → 3 words; code/main.py → 1 word ("print('hi')").
    expect(body.totals.words).toBe(4);
  });

  it("returns 400 for unsafe slugs", async () => {
    const { GET } = await importRoute();
    const res = await GET(
      new Request("http://localhost/api/projects/..%2Fetc/stats"),
      { params: Promise.resolve({ slug: "../etc" }) },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Invalid project slug");
  });

  it("returns 200 with all-zero stats when the project directory is missing", async () => {
    // Ensure ROOT exists but no project directory.
    mkdirSync(path.join(ROOT, "projects"), { recursive: true });

    const slug = "ghost";
    const { GET } = await importRoute();
    const res = await GET(
      new Request(`http://localhost/api/projects/${slug}/stats`),
      { params: Promise.resolve({ slug }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.slug).toBe(slug);
    expect(body.totals.files).toBe(0);
    expect(body.totals.directories).toBe(0);
    expect(body.totals.bytes).toBe(0);
    expect(body.totals.words).toBe(0);
    expect(body.byExtension).toEqual({});
    expect(body.folderCounts.papers).toBe(0);
    expect(body.lastModified).toBeUndefined();
  });

  it("matches the lib output byte-for-byte on shared content", async () => {
    const slug = "parity";
    const projectDir = seedProject(slug, {
      "papers/p.pdf": "%PDF-1.4",
      "code/m.ts": "export const x = 1;",
      "data/d.csv": "a,b\n1,2",
      "figures/plot.png": Buffer.alloc(16),
      "config/env.json": '{"a":1}',
      "docs/readme.md": "one two three",
    });

    const { GET } = await importRoute();
    const res = await GET(
      new Request(`http://localhost/api/projects/${slug}/stats`),
      { params: Promise.resolve({ slug }) },
    );
    expect(res.status).toBe(200);
    const apiBody = await res.json();

    const { computeProjectStats } = await importLib();
    const libStats = await computeProjectStats(projectDir, slug);

    // computedAt will differ between the two calls, so compare all other fields.
    expect(apiBody.slug).toBe(libStats.slug);
    expect(apiBody.folderCounts).toEqual(libStats.folderCounts);
    expect(apiBody.byExtension).toEqual(libStats.byExtension);
    expect(apiBody.totals).toEqual(libStats.totals);
    expect(apiBody.lastModified).toBe(libStats.lastModified);
  });

  it("accepts slugs containing dashes and digits", async () => {
    const slug = "project-alpha";
    seedProject(slug, {
      "papers/sample-paper.pdf": "%PDF-1.4",
      "code/proof.py": "print('qed')",
    });

    const { GET } = await importRoute();
    const res = await GET(
      new Request(`http://localhost/api/projects/${slug}/stats`),
      { params: Promise.resolve({ slug }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.slug).toBe(slug);
    expect(body.folderCounts.papers).toBe(1);
    expect(body.folderCounts.code).toBe(1);
    expect(body.totals.files).toBe(2);
  });
});
