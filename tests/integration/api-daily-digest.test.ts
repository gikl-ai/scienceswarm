import path from "node:path";
import { mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ROOT = path.join(tmpdir(), "scienceswarm-api-daily-digest");
const ORIGINAL_SCIENCESWARM_DIR = process.env.SCIENCESWARM_DIR;

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  process.env.SCIENCESWARM_DIR = ROOT;
});

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  vi.resetModules();
  vi.restoreAllMocks();
  vi.doUnmock("@/lib/daily-digest");
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
  return await import("@/app/api/digest/[projectId]/route");
}

function seed(slug: string, rel: string, body = "x"): string {
  const full = path.join(ROOT, "projects", slug, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, body);
  return full;
}

function setMtime(full: string, when: Date): void {
  utimesSync(full, when, when);
}

function makeParams(projectId: string): { params: Promise<{ projectId: string }> } {
  return { params: Promise.resolve({ projectId }) };
}

describe("GET /api/digest/[projectId]", () => {
  it("returns a digest for a seeded project", async () => {
    const slug = "test-project";
    const recent = seed(slug, "papers/recent.pdf", "%PDF-1.4 fake");
    const old = seed(slug, "papers/old.pdf", "%PDF-1.4 fake");
    // Recent file: touched 1h ago.
    setMtime(recent, new Date(Date.now() - 1 * 3600 * 1000));
    // Old file: touched 48h ago, outside the default 24h window.
    setMtime(old, new Date(Date.now() - 48 * 3600 * 1000));

    const { GET } = await importRoute();
    const res = await GET(
      new Request(`http://localhost/api/digest/${slug}`),
      makeParams(slug),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.windowHours).toBe(24);
    const all = [...body.added, ...body.modified].map(
      (f: { path: string }) => f.path,
    );
    expect(all).toContain("papers/recent.pdf");
    expect(all).not.toContain("papers/old.pdf");
    expect(body.byBucket.papers).toBe(1);
  });

  it("rejects unsafe project slugs with 400", async () => {
    const { GET } = await importRoute();
    const res = await GET(
      new Request("http://localhost/api/digest/%2E%2E%2Fetc"),
      makeParams("../etc"),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Invalid project slug");
  });

  it("returns an empty digest for an unknown slug (200, not 404)", async () => {
    const { GET } = await importRoute();
    const res = await GET(
      new Request("http://localhost/api/digest/phantom-project"),
      makeParams("phantom-project"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.added).toEqual([]);
    expect(body.modified).toEqual([]);
    expect(body.totals).toEqual({ added: 0, modified: 0 });
    expect(body.byBucket).toEqual({});
  });

  it("narrows the window when `?hours=1` is supplied", async () => {
    const slug = "narrow-window";
    const recent = seed(slug, "code/recent.py", "print('hi')");
    const twoHoursAgo = seed(slug, "code/older.py", "print('old')");
    setMtime(recent, new Date(Date.now() - 15 * 60 * 1000));
    setMtime(twoHoursAgo, new Date(Date.now() - 2 * 3600 * 1000));

    const { GET } = await importRoute();
    const res = await GET(
      new Request(`http://localhost/api/digest/${slug}?hours=1`),
      makeParams(slug),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.windowHours).toBe(1);
    const all = [...body.added, ...body.modified].map(
      (f: { path: string }) => f.path,
    );
    expect(all).toContain("code/recent.py");
    expect(all).not.toContain("code/older.py");
  });

  it("clamps `?hours=999` to 168", async () => {
    const slug = "clamp-test";
    // Make sure the project dir exists so the digest isn't the missing-path
    // early-return — we specifically want to assert the clamped windowHours
    // that computeDailyDigest actually saw.
    mkdirSync(path.join(ROOT, "projects", slug), { recursive: true });

    const { GET } = await importRoute();
    const res = await GET(
      new Request(`http://localhost/api/digest/${slug}?hours=999`),
      makeParams(slug),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.windowHours).toBe(168);
  });

  it("clamps `?hours=0` up to 1", async () => {
    const slug = "clamp-low";
    mkdirSync(path.join(ROOT, "projects", slug), { recursive: true });

    const { GET } = await importRoute();
    const res = await GET(
      new Request(`http://localhost/api/digest/${slug}?hours=0`),
      makeParams(slug),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.windowHours).toBe(1);
  });

  it("falls back to the default 24h when `?hours` is not a number", async () => {
    const slug = "default-hours";
    mkdirSync(path.join(ROOT, "projects", slug), { recursive: true });

    const { GET } = await importRoute();
    const res = await GET(
      new Request(`http://localhost/api/digest/${slug}?hours=abc`),
      makeParams(slug),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.windowHours).toBe(24);
  });

  it("returns a generic 500 when digest computation throws", async () => {
    vi.resetModules();
    const lib = await import("@/lib/daily-digest");
    vi.spyOn(lib, "computeDailyDigest").mockRejectedValue(
      new Error("leaked /tmp/private-path"),
    );

    const { GET } = await importRoute();
    const res = await GET(
      new Request("http://localhost/api/digest/test-project"),
      makeParams("test-project"),
    );

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Digest error");
    expect(JSON.stringify(body)).not.toContain("/tmp/private-path");
  });
});
