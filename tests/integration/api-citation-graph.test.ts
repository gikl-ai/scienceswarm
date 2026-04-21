import path from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Per-suite temp root, mirroring tests/integration/api-workspace.test.ts.
const ROOT = path.join(tmpdir(), "scienceswarm-api-citation-graph");
const ORIGINAL_SCIENCESWARM_DIR = process.env.SCIENCESWARM_DIR;

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
  process.env.SCIENCESWARM_DIR = ROOT;
});

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  // !== undefined — an empty-string original value must round-trip.
  if (ORIGINAL_SCIENCESWARM_DIR !== undefined) {
    process.env.SCIENCESWARM_DIR = ORIGINAL_SCIENCESWARM_DIR;
  } else {
    delete process.env.SCIENCESWARM_DIR;
  }
});

// Import after the env stub so path helpers resolve under ROOT.
async function importRoute() {
  return await import("@/app/api/citation-graph/[projectId]/route");
}

function seedProjectPaper(
  slug: string,
  relPath: string,
  contents: string,
): void {
  const full = path.join(ROOT, "projects", slug, "papers", relPath);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, contents, "utf-8");
}

function makeReq(slug: string): Request {
  return new Request(`http://localhost/api/citation-graph/${slug}`);
}

function makeCtx(slug: string) {
  return { params: Promise.resolve({ projectId: slug }) };
}

describe("GET /api/citation-graph/[projectId]", () => {
  it("returns a graph with nodes and edges for a seeded project", async () => {
    const slug = "alpha-project";
    seedProjectPaper(
      slug,
      "paper-a.md",
      [
        "---",
        "title: Paper A",
        "---",
        "Contains \\cite{paper-b} reference.",
      ].join("\n"),
    );
    seedProjectPaper(
      slug,
      "paper-b.md",
      ["---", "title: Paper B", "---", "Body."].join("\n"),
    );

    const { GET } = await importRoute();
    const res = await GET(makeReq(slug), makeCtx(slug));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.nodes).toBeDefined();
    expect(body.edges).toBeDefined();
    expect(body.nodes.map((n: { id: string }) => n.id).sort()).toEqual([
      "paper-a",
      "paper-b",
    ]);
    expect(body.edges).toContainEqual(
      expect.objectContaining({
        source: "paper-a",
        target: "paper-b",
        refType: "bibkey",
      }),
    );
  });

  it("returns 400 for an unsafe project slug (path traversal)", async () => {
    const { GET } = await importRoute();
    const res = await GET(makeReq("../etc"), makeCtx("../etc"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Invalid project slug");
  });

  it("returns 200 with an empty graph when the project directory is missing", async () => {
    const { GET } = await importRoute();
    const res = await GET(
      makeReq("never-existed"),
      makeCtx("never-existed"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.nodes).toEqual([]);
    expect(body.edges).toEqual([]);
    expect(body.externalRefs).toEqual({});
  });

  it("returns 200 with an empty graph when the project exists but has no papers/", async () => {
    const slug = "beta-project";
    // Create the project dir (with some other folder) but NOT papers/.
    mkdirSync(path.join(ROOT, "projects", slug, "code"), { recursive: true });
    writeFileSync(path.join(ROOT, "projects", slug, "code", "main.py"), "x=1");

    const { GET } = await importRoute();
    const res = await GET(makeReq(slug), makeCtx(slug));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.nodes).toEqual([]);
    expect(body.edges).toEqual([]);
  });

  it("returns the correct node and edge counts for a richer seeded project", async () => {
    const slug = "gamma-project";
    // Three markdown papers, one DOI reference, one \cite{} reference,
    // one external arxiv reference, plus an unscanned pdf.
    seedProjectPaper(
      slug,
      "one.md",
      [
        "---",
        "title: One",
        "doi: 10.1000/one.doi",
        "---",
        "Body one.",
      ].join("\n"),
    );
    seedProjectPaper(
      slug,
      "two.md",
      [
        "---",
        "title: Two",
        "---",
        "Refers to 10.1000/one.doi and \\cite{three}.",
        "Also arxiv:2999.00001 which is external.",
      ].join("\n"),
    );
    seedProjectPaper(
      slug,
      "three.md",
      ["---", "title: Three", "---", "Third body."].join("\n"),
    );
    seedProjectPaper(slug, "opaque.pdf", "%PDF fake");

    const { GET } = await importRoute();
    const res = await GET(makeReq(slug), makeCtx(slug));

    expect(res.status).toBe(200);
    const body = await res.json();
    const ids = (body.nodes as Array<{ id: string }>)
      .map((n) => n.id)
      .sort();
    expect(ids).toEqual(["one", "opaque", "three", "two"]);

    const edgesFromTwo = (
      body.edges as Array<{ source: string; target: string; refType: string }>
    ).filter((e) => e.source === "two");
    // two -> one (doi), two -> three (bibkey), two -> external:2999.00001 (arxiv)
    expect(edgesFromTwo).toHaveLength(3);
    expect(edgesFromTwo).toContainEqual(
      expect.objectContaining({ target: "one", refType: "doi" }),
    );
    expect(edgesFromTwo).toContainEqual(
      expect.objectContaining({ target: "three", refType: "bibkey" }),
    );
    expect(edgesFromTwo).toContainEqual(
      expect.objectContaining({
        target: "external:2999.00001",
        refType: "arxiv",
      }),
    );
    expect(body.externalRefs["external:2999.00001"]).toEqual({
      refType: "arxiv",
      count: 1,
    });
  });
});
