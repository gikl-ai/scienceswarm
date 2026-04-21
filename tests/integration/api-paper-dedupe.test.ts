import path from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ROOT = path.join(tmpdir(), "scienceswarm-api-paper-dedupe");
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
  return await import("@/app/api/papers/dedupe/[projectId]/route");
}

function seedPapersDir(slug: string): string {
  const papersDir = path.join(ROOT, "projects", slug, "papers");
  mkdirSync(papersDir, { recursive: true });
  return papersDir;
}

function writeCompanion(
  papersDir: string,
  base: string,
  fm: { title?: string; doi?: string },
): void {
  const lines = ["---"];
  if (fm.title !== undefined) lines.push(`title: ${fm.title}`);
  if (fm.doi !== undefined) lines.push(`doi: ${fm.doi}`);
  lines.push("---");
  writeFileSync(path.join(papersDir, `${base}.md`), lines.join("\n"));
}

describe("GET /api/papers/dedupe/[projectId]", () => {
  it("returns the dedupe result for a seeded project", async () => {
    const slug = "dedupe-happy";
    const papersDir = seedPapersDir(slug);
    writeFileSync(path.join(papersDir, "intro.pdf"), "%PDF-1.4 fake");
    writeCompanion(papersDir, "intro", { title: "Intro to Transformers" });
    writeFileSync(path.join(papersDir, "other.pdf"), "%PDF-1.4 fake");
    writeCompanion(papersDir, "other", { title: "Survey of Diffusion" });

    const { GET } = await importRoute();
    const res = await GET(
      new Request(`http://localhost/api/papers/dedupe/${slug}`),
      { params: Promise.resolve({ projectId: slug }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.candidates).toHaveLength(2);
    expect(body.duplicates).toEqual([]);
    expect(typeof body.scannedAt).toBe("string");
  });

  it("returns 400 for an invalid project slug", async () => {
    const { GET } = await importRoute();
    const res = await GET(
      new Request("http://localhost/api/papers/dedupe/..%2Fetc"),
      { params: Promise.resolve({ projectId: "../etc" }) },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Invalid project slug");
  });

  it("returns 200 with an empty result for an unknown slug", async () => {
    const { GET } = await importRoute();
    const res = await GET(
      new Request("http://localhost/api/papers/dedupe/phantom-project"),
      { params: Promise.resolve({ projectId: "phantom-project" }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.candidates).toEqual([]);
    expect(body.duplicates).toEqual([]);
  });

  it("surfaces a seeded duplicate pair via shared-doi", async () => {
    const slug = "dedupe-duplicates";
    const papersDir = seedPapersDir(slug);
    writeFileSync(path.join(papersDir, "a.pdf"), "%PDF-1.4 fake");
    writeCompanion(papersDir, "a", {
      title: "Wildly Different Title One",
      doi: "10.1234/shared",
    });
    writeFileSync(path.join(papersDir, "b.pdf"), "%PDF-1.4 fake");
    writeCompanion(papersDir, "b", {
      title: "Wildly Different Title Two",
      doi: "10.1234/shared",
    });

    const { GET } = await importRoute();
    const res = await GET(
      new Request(`http://localhost/api/papers/dedupe/${slug}`),
      { params: Promise.resolve({ projectId: slug }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.duplicates).toHaveLength(1);
    expect(body.duplicates[0].reason).toBe("shared-doi");
    expect(body.duplicates[0].similarity).toBe(1);
    expect([body.duplicates[0].a, body.duplicates[0].b].sort()).toEqual([
      "a.pdf",
      "b.pdf",
    ]);
  });

  it("returns 200 with duplicates: [] when there are no duplicates", async () => {
    const slug = "dedupe-clean";
    const papersDir = seedPapersDir(slug);
    writeFileSync(path.join(papersDir, "one.pdf"), "%PDF-1.4 fake");
    writeCompanion(papersDir, "one", { title: "Some Distinct Topic" });
    writeFileSync(path.join(papersDir, "two.pdf"), "%PDF-1.4 fake");
    writeCompanion(papersDir, "two", { title: "Totally Unrelated Matter" });

    const { GET } = await importRoute();
    const res = await GET(
      new Request(`http://localhost/api/papers/dedupe/${slug}`),
      { params: Promise.resolve({ projectId: slug }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.duplicates).toEqual([]);
    expect(body.candidates.length).toBeGreaterThanOrEqual(2);
  });
});
