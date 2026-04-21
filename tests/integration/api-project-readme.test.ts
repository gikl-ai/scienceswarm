import path from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ROOT = path.join(tmpdir(), "scienceswarm-api-project-readme");
const ORIGINAL_SCIENCESWARM_DIR = process.env.SCIENCESWARM_DIR;

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  process.env.SCIENCESWARM_DIR = ROOT;
});

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  vi.resetModules();
  vi.restoreAllMocks();
  vi.doUnmock("@/lib/project-readme-gen");
  if (ORIGINAL_SCIENCESWARM_DIR !== undefined) {
    process.env.SCIENCESWARM_DIR = ORIGINAL_SCIENCESWARM_DIR;
  } else {
    delete process.env.SCIENCESWARM_DIR;
  }
});

// Import after env stub so the module-level path helpers resolve under ROOT.
async function importRoute() {
  return await import("@/app/api/projects/[slug]/readme/route");
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

describe("GET /api/projects/[slug]/readme", () => {
  it("returns a rendered README for a seeded project", async () => {
    const slug = "alpha";
    seedProject(slug, {
      "papers/one.pdf": "%PDF-1.4",
      "papers/two.pdf": "%PDF-1.4",
      "code/main.py": "print('hi')",
      "docs/notes.md": "alpha beta gamma",
    });

    const { GET } = await importRoute();
    const res = await GET(
      new Request(`http://localhost/api/projects/${slug}/readme`),
      { params: Promise.resolve({ slug }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.readme).toBe("string");
    expect(body.readme).toContain("# Alpha");
    expect(body.sections.overview).toContain("| papers | 2 |");
    expect(body.sections.overview).toContain("| code | 1 |");
    expect(body.sections.overview).toContain("| docs | 1 |");
    expect(body.sections.files).toContain("papers/one.pdf");
    expect(body.sections.files).toContain("code/main.py");
    expect(body.fileCounts).toEqual({
      papers: 2,
      code: 1,
      data: 0,
      docs: 1,
      figures: 0,
      config: 0,
      other: 0,
    });
  });

  it("returns 400 for unsafe slugs", async () => {
    const { GET } = await importRoute();
    const res = await GET(
      new Request("http://localhost/api/projects/..%2Fetc/readme"),
      { params: Promise.resolve({ slug: "../etc" }) },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Invalid project slug");
  });

  it("returns 200 with an empty-state README when the project is missing", async () => {
    mkdirSync(path.join(ROOT, "projects"), { recursive: true });

    const slug = "ghost";
    const { GET } = await importRoute();
    const res = await GET(
      new Request(`http://localhost/api/projects/${slug}/readme`),
      { params: Promise.resolve({ slug }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.readme).toContain("# Ghost");
    expect(body.sections.files).toContain("_No files yet._");
    expect(body.sections.lastActivity).toContain("_No activity yet._");
    for (const bucket of Object.keys(body.fileCounts)) {
      expect(body.fileCounts[bucket]).toBe(0);
    }
  });

  it("surfaces a ?title override in the README", async () => {
    const slug = "override-title";
    seedProject(slug, {
      "papers/p.pdf": "%PDF",
    });

    const { GET } = await importRoute();
    const res = await GET(
      new Request(
        `http://localhost/api/projects/${slug}/readme?title=${encodeURIComponent("Custom Title")}`,
      ),
      { params: Promise.resolve({ slug }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sections.header).toContain("# Custom Title");
    expect(body.readme).toContain("# Custom Title");
    // Default humanisation must not leak when overridden.
    expect(body.readme).not.toContain("# Override Title");
  });

  it("surfaces a ?description override in the README", async () => {
    const slug = "override-desc";
    seedProject(slug, {
      "papers/p.pdf": "%PDF",
    });

    const description = "An investigation into the ScienceSwarm workflow.";
    const { GET } = await importRoute();
    const res = await GET(
      new Request(
        `http://localhost/api/projects/${slug}/readme?description=${encodeURIComponent(description)}`,
      ),
      { params: Promise.resolve({ slug }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sections.header).toContain(description);
    expect(body.sections.overview).toContain(description);
    expect(body.readme).toContain(description);
  });

  it("sanitizes multiline title and description overrides before rendering markdown", async () => {
    const slug = "sanitize-overrides";
    seedProject(slug, {
      "papers/p.pdf": "%PDF",
    });

    const { GET } = await importRoute();
    const res = await GET(
      new Request(
        `http://localhost/api/projects/${slug}/readme?title=${encodeURIComponent("Title\n## injected")}&description=${encodeURIComponent("Line one\n- bullet")}`,
      ),
      { params: Promise.resolve({ slug }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sections.header).toContain("# Title ## injected");
    expect(body.sections.header).toContain("Line one - bullet");
    expect(body.readme).not.toContain("\n## injected");
    expect(body.readme).not.toContain("\n- bullet");
  });

  it("returns a generic 500 when README generation fails", async () => {
    vi.resetModules();
    const lib = await import("@/lib/project-readme-gen");
    vi.spyOn(lib, "generateProjectReadme").mockRejectedValue(
      new Error("boom: /tmp/private-path"),
    );

    const { GET } = await importRoute();
    const res = await GET(
      new Request("http://localhost/api/projects/alpha/readme"),
      { params: Promise.resolve({ slug: "alpha" }) },
    );

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to generate project README.");
    expect(JSON.stringify(body)).not.toContain("/tmp/private-path");
  });
});
