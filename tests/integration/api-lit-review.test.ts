import path from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  summarizeLiteratureReview,
} = vi.hoisted(() => ({
  summarizeLiteratureReview: vi.fn(async ({ papers }: { papers: Array<unknown> }) =>
    `LLM literature review for ${papers.length} papers`,
  ),
}));

vi.mock("@/lib/lit-review-summarizer", () => {
  class LiteratureReviewSummarizerUnavailableError extends Error {
    readonly status = 503;
  }

  return {
    summarizeLiteratureReview,
    LiteratureReviewSummarizerUnavailableError,
  };
});

const ROOT = path.join(tmpdir(), "scienceswarm-api-lit-review");
const ORIGINAL_SCIENCESWARM_DIR = process.env.SCIENCESWARM_DIR;

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  process.env.SCIENCESWARM_DIR = ROOT;
  summarizeLiteratureReview.mockReset();
  summarizeLiteratureReview.mockImplementation(async ({ papers }: { papers: Array<unknown> }) =>
    `LLM literature review for ${papers.length} papers`,
  );
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
  return await import("@/app/api/lit-review/[projectId]/route");
}

function seedProjectWithPapers(slug: string): string {
  const papersDir = path.join(ROOT, "projects", slug, "papers");
  mkdirSync(papersDir, { recursive: true });

  writeFileSync(path.join(papersDir, "alpha.pdf"), "%PDF-1.4 fake");
  writeFileSync(
    path.join(papersDir, "alpha.md"),
    [
      "---",
      'title: "Alpha paper"',
      "tags:",
      '  - "ml"',
      '  - "vision"',
      "year: 2023",
      "---",
      "",
      "Body.",
    ].join("\n"),
  );

  writeFileSync(path.join(papersDir, "beta.pdf"), "%PDF-1.4 fake");
  writeFileSync(
    path.join(papersDir, "beta.md"),
    [
      "---",
      'title: "Beta paper"',
      "tags:",
      '  - "ml"',
      "year: 2018",
      "---",
    ].join("\n"),
  );

  return papersDir;
}

describe("GET /api/lit-review/[projectId]", () => {
  it("happy path: returns a literature review for a seeded project", async () => {
    const slug = "test-project";
    seedProjectWithPapers(slug);

    const { GET } = await importRoute();
    const res = await GET(
      new Request(`http://localhost/api/lit-review/${slug}`),
      { params: Promise.resolve({ projectId: slug }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.review).toBeDefined();
    expect(body.review.totalPapers).toBe(2);
    expect(body.review.groupBy).toBe("tag");
    const headings = (body.review.groups as Array<{ heading: string }>).map(
      (g) => g.heading,
    );
    expect(headings).toContain("ml");
    expect(headings).toContain("vision");
    expect(body.review.summary).toBe("LLM literature review for 2 papers");
  });

  it("rejects invalid slugs with 400", async () => {
    const { GET } = await importRoute();
    const res = await GET(
      new Request("http://localhost/api/lit-review/..%2Fetc"),
      { params: Promise.resolve({ projectId: "../etc" }) },
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Invalid project slug");
  });

  it("unknown slug returns 200 with empty review", async () => {
    const { GET } = await importRoute();
    const res = await GET(
      new Request("http://localhost/api/lit-review/ghost-project"),
      { params: Promise.resolve({ projectId: "ghost-project" }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.review.totalPapers).toBe(0);
    expect(body.review.groups).toEqual([]);
    expect(body.review.summary).toBe("");
    expect(body.review.groupBy).toBe("tag");
  });

  it("honours ?groupBy=year", async () => {
    const slug = "year-project";
    seedProjectWithPapers(slug);

    const { GET } = await importRoute();
    const res = await GET(
      new Request(`http://localhost/api/lit-review/${slug}?groupBy=year`),
      { params: Promise.resolve({ projectId: slug }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.review.groupBy).toBe("year");
    const headings = (body.review.groups as Array<{ heading: string }>).map(
      (g) => g.heading,
    );
    expect(headings).toEqual(["2015\u20132019", "2020\u20132024"]);
  });

  it("?groupBy=invalid falls back to the default tag grouping (documented)", async () => {
    // Documented choice: invalid groupBy values fall back to the default
    // ("tag") rather than returning 400, because the UI may pass a stored
    // preference that's no longer supported. The alternative (400) would
    // break the dashboard on upgrade.
    const slug = "fallback-project";
    seedProjectWithPapers(slug);

    const { GET } = await importRoute();
    const res = await GET(
      new Request(`http://localhost/api/lit-review/${slug}?groupBy=bogus`),
      { params: Promise.resolve({ projectId: slug }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.review.groupBy).toBe("tag");
    expect(body.review.totalPapers).toBe(2);
  });

  it("honours ?groupBy=none", async () => {
    const slug = "none-project";
    seedProjectWithPapers(slug);

    const { GET } = await importRoute();
    const res = await GET(
      new Request(`http://localhost/api/lit-review/${slug}?groupBy=none`),
      { params: Promise.resolve({ projectId: slug }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.review.groupBy).toBe("none");
    expect(body.review.groups).toHaveLength(1);
    expect(body.review.groups[0].heading).toBe("All papers");
  });

  it("returns 503 when no LLM backend is available for summarization", async () => {
    const slug = "unavailable-project";
    seedProjectWithPapers(slug);
    const { LiteratureReviewSummarizerUnavailableError } = await import("@/lib/lit-review-summarizer");
    summarizeLiteratureReview.mockRejectedValueOnce(
      new LiteratureReviewSummarizerUnavailableError("No summarizer backend"),
    );

    const { GET } = await importRoute();
    const res = await GET(
      new Request(`http://localhost/api/lit-review/${slug}`),
      { params: Promise.resolve({ projectId: slug }) },
    );

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ error: "No summarizer backend" });
  });
});
