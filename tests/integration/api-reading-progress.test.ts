import path from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadReadingProgress } from "@/lib/reading-progress";

const ROOT = path.join(tmpdir(), "scienceswarm-api-reading-progress");
const ORIGINAL_SCIENCESWARM_DIR = process.env.SCIENCESWARM_DIR;
const ORIGINAL_BRAIN_ROOT = process.env.BRAIN_ROOT;

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
  if (ORIGINAL_BRAIN_ROOT !== undefined) {
    process.env.BRAIN_ROOT = ORIGINAL_BRAIN_ROOT;
  } else {
    delete process.env.BRAIN_ROOT;
  }
});

// Import after env stub so the module-level path helpers resolve under ROOT.
async function importRoute() {
  return await import("@/app/api/reading-progress/[projectId]/route");
}

function params(projectId: string): { params: Promise<{ projectId: string }> } {
  return { params: Promise.resolve({ projectId }) };
}

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/api/reading-progress/any", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("/api/reading-progress/[projectId]", () => {
  it("GET returns an empty store when no data exists", async () => {
    const { GET } = await importRoute();
    const res = await GET(
      new Request("http://localhost/api/reading-progress/alpha"),
      params("alpha"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ version: 1, entries: {} });
  });

  it("POST upsert creates an entry", async () => {
    const { POST, GET } = await importRoute();
    const res = await POST(
      jsonRequest({
        action: "upsert",
        paperId: "papers/intro.pdf",
        status: "reading",
        notes: "interesting",
      }),
      params("alpha"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.entry.paperId).toBe("papers/intro.pdf");
    expect(body.entry.status).toBe("reading");
    expect(body.entry.notes).toBe("interesting");
    expect(typeof body.entry.updatedAt).toBe("string");

    const getRes = await GET(
      new Request("http://localhost/api/reading-progress/alpha"),
      params("alpha"),
    );
    const store = await getRes.json();
    expect(store.entries["papers/intro.pdf"].status).toBe("reading");
  });

  it("POST upsert updates an existing entry", async () => {
    const { POST } = await importRoute();

    await POST(
      jsonRequest({ action: "upsert", paperId: "paper.pdf", status: "reading" }),
      params("beta"),
    );

    const res = await POST(
      jsonRequest({
        action: "upsert",
        paperId: "paper.pdf",
        status: "done",
        notes: "finished",
      }),
      params("beta"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.entry.status).toBe("done");
    expect(body.entry.notes).toBe("finished");
  });

  it("POST delete removes an entry", async () => {
    const { POST } = await importRoute();
    await POST(
      jsonRequest({ action: "upsert", paperId: "paper.pdf", status: "reading" }),
      params("gamma"),
    );

    const res = await POST(
      jsonRequest({ action: "delete", paperId: "paper.pdf" }),
      params("gamma"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deleted).toBe(true);
  });

  it("POST delete on missing id returns { deleted: false }", async () => {
    const { POST } = await importRoute();
    const res = await POST(
      jsonRequest({ action: "delete", paperId: "nope.pdf" }),
      params("delta"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deleted).toBe(false);
  });

  it("POST with an unknown action → 400", async () => {
    const { POST } = await importRoute();
    const res = await POST(
      jsonRequest({ action: "nuke", paperId: "paper.pdf" }),
      params("epsilon"),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it("POST with no action → 400", async () => {
    const { POST } = await importRoute();
    const res = await POST(jsonRequest({ paperId: "paper.pdf" }), params("epsilon"));
    expect(res.status).toBe(400);
  });

  it("POST upsert with an invalid status → 400", async () => {
    const { POST } = await importRoute();
    const res = await POST(
      jsonRequest({ action: "upsert", paperId: "paper.pdf", status: "skimmed" }),
      params("zeta"),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Invalid status");
  });

  it("invalid project slug → 400 on GET", async () => {
    const { GET } = await importRoute();
    const res = await GET(
      new Request("http://localhost/api/reading-progress/..%2Fetc"),
      params("../etc"),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Invalid project slug");
  });

  it("invalid project slug → 400 on POST", async () => {
    const { POST } = await importRoute();
    const res = await POST(
      jsonRequest({ action: "upsert", paperId: "paper.pdf", status: "reading" }),
      params("../etc"),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Invalid project slug");
  });

  it("reads legacy reading-progress data from an explicit BRAIN_ROOT", async () => {
    process.env.BRAIN_ROOT = path.join(ROOT, "legacy-brain");
    const legacyProjectDir = path.join(process.env.BRAIN_ROOT, "state", "projects", "alpha");
    mkdirSync(legacyProjectDir, { recursive: true });
    writeFileSync(
      path.join(legacyProjectDir, "reading-progress.json"),
      JSON.stringify({
        version: 1,
        entries: {
          "papers/legacy.pdf": {
            paperId: "papers/legacy.pdf",
            status: "reading",
            updatedAt: "2026-04-12T00:00:00.000Z",
          },
        },
      }, null, 2),
    );

    const { GET } = await importRoute();
    const res = await GET(
      new Request("http://localhost/api/reading-progress/alpha"),
      params("alpha"),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.entries["papers/legacy.pdf"].status).toBe("reading");
  });

  it("prefers project-local reading progress when canonical and legacy stores both exist", async () => {
    const canonicalStateRoot = path.join(ROOT, "projects", "alpha", ".brain", "state");
    const legacyStateRoot = path.join(ROOT, "brain", "state");

    mkdirSync(canonicalStateRoot, { recursive: true });
    writeFileSync(path.join(canonicalStateRoot, "manifest.json"), JSON.stringify({ version: 1 }), "utf-8");
    writeFileSync(
      path.join(canonicalStateRoot, "reading-progress.json"),
      JSON.stringify({
        version: 1,
        entries: {
          "papers/canonical.pdf": {
            paperId: "papers/canonical.pdf",
            status: "done",
            updatedAt: "2026-04-12T00:00:00.000Z",
          },
        },
      }, null, 2),
    );

    mkdirSync(path.join(legacyStateRoot, "projects", "alpha"), { recursive: true });
    writeFileSync(
      path.join(legacyStateRoot, "projects", "alpha", "reading-progress.json"),
      JSON.stringify({
        version: 1,
        entries: {
          "papers/legacy.pdf": {
            paperId: "papers/legacy.pdf",
            status: "reading",
            updatedAt: "2026-04-11T00:00:00.000Z",
          },
        },
      }, null, 2),
    );

    const { GET, POST } = await importRoute();
    const getRes = await GET(
      new Request("http://localhost/api/reading-progress/alpha"),
      params("alpha"),
    );

    expect(getRes.status).toBe(200);
    await expect(getRes.json()).resolves.toEqual({
      version: 1,
      entries: {
        "papers/canonical.pdf": {
          paperId: "papers/canonical.pdf",
          status: "done",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
      },
    });

    const postRes = await POST(
      jsonRequest({ action: "upsert", paperId: "papers/new.pdf", status: "reading" }),
      params("alpha"),
    );
    expect(postRes.status).toBe(200);

    const canonicalStore = await loadReadingProgress(canonicalStateRoot, "alpha");
    const legacyStore = await loadReadingProgress(legacyStateRoot, "alpha");
    expect(canonicalStore.entries["papers/new.pdf"]?.status).toBe("reading");
    expect(legacyStore.entries["papers/new.pdf"]).toBeUndefined();
  });
});
