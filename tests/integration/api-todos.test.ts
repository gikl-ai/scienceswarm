import path from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Each test gets its own mkdtemp-allocated directory so parallel vitest
// shards/workers in CI cannot race on a shared fixed path.
let ROOT: string;
const ORIGINAL_SCIENCESWARM_DIR = process.env.SCIENCESWARM_DIR;

beforeEach(() => {
  ROOT = mkdtempSync(path.join(tmpdir(), "scienceswarm-api-todos-"));
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
  return await import("@/app/api/todos/[projectId]/route");
}

function projectWikiDir(slug: string): string {
  return path.join(ROOT, "brain", "wiki", "projects", slug);
}

function seedFile(slug: string, relPath: string, contents: string): void {
  const full = path.join(projectWikiDir(slug), relPath);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, contents);
}

function invokeGet(
  GET: (
    req: Request,
    ctx: { params: Promise<{ projectId: string }> },
  ) => Promise<Response>,
  projectId: string,
): Promise<Response> {
  return GET(
    new Request(`http://localhost/api/todos/${projectId}`),
    { params: Promise.resolve({ projectId }) },
  );
}

describe("GET /api/todos/[projectId]", () => {
  it("returns scanned todos for a seeded project", async () => {
    const slug = "alpha-project";
    seedFile(slug, "index.md", "- [ ] read paper\n- [x] outline intro\n");
    seedFile(slug, "sub/notes.md", "# notes\n- [ ] next step\n");

    const { GET } = await importRoute();
    const res = await invokeGet(GET, slug);

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.scannedFiles).toBe(2);
    expect(Array.isArray(body.todos)).toBe(true);
    expect(body.todos).toHaveLength(3);

    const byText = (body.todos as Array<{ text: string }>).map((t) => t.text).sort();
    expect(byText).toEqual(["next step", "outline intro", "read paper"]);

    expect(typeof body.scannedAt).toBe("string");
    expect(Number.isFinite(Date.parse(body.scannedAt))).toBe(true);
  });

  it("rejects unsafe slugs (path traversal) with 400", async () => {
    const { GET } = await importRoute();
    const res = await invokeGet(GET, "../etc");

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Invalid project slug");
  });

  it("returns an empty result for an unknown slug (nothing seeded)", async () => {
    const { GET } = await importRoute();
    const res = await invokeGet(GET, "ghost-project");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.todos).toEqual([]);
    expect(body.scannedFiles).toBe(0);
    expect(typeof body.scannedAt).toBe("string");
  });

  it("does not export a POST handler (GET-only surface)", async () => {
    const mod = await importRoute();
    // Only GET is defined — Next's default behaviour returns 405 for
    // unhandled methods. We assert the module contract rather than invoking
    // the framework dispatcher here.
    expect(typeof mod.GET).toBe("function");
    expect(
      (mod as unknown as { POST?: unknown }).POST,
    ).toBeUndefined();
  });

  it("scans 10 seeded .md files with mixed todos", async () => {
    const slug = "big-project";
    for (let i = 0; i < 10; i++) {
      // Half the files have todos, half don't — scannedFiles still counts all.
      if (i % 2 === 0) {
        seedFile(
          slug,
          `n${i}.md`,
          `# file ${i}\n- [ ] do ${i}\n- [x] did ${i}\n`,
        );
      } else {
        seedFile(slug, `n${i}.md`, `just prose for ${i}\n`);
      }
    }

    const { GET } = await importRoute();
    const res = await invokeGet(GET, slug);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scannedFiles).toBe(10);
    // 5 files x 2 todos each = 10 todo items.
    expect(body.todos).toHaveLength(10);
  });
});
