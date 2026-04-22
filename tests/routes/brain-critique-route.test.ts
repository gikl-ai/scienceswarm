import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrainPage } from "@/brain/store";

const mocks = vi.hoisted(() => {
  const pages = new Map<string, BrainPage>();
  return {
    pages,
    ensureBrainStoreReady: vi.fn(),
    getPage: vi.fn(async (slug: string) => pages.get(slug) ?? null),
    listPages: vi.fn(async () => Array.from(pages.values())),
    putPage: vi.fn(async () => ({ stdout: "", stderr: "" })),
    linkPages: vi.fn(async () => ({ stdout: "", stderr: "" })),
    getCurrentUserHandle: vi.fn(() => "alice"),
    ensureProjectShellForProjectSlug: vi.fn(async () => null),
  };
});

vi.mock("@/brain/store", () => ({
  ensureBrainStoreReady: mocks.ensureBrainStoreReady,
  getBrainStore: () => ({
    getPage: mocks.getPage,
    listPages: mocks.listPages,
  }),
}));

vi.mock("@/brain/in-process-gbrain-client", () => ({
  createInProcessGbrainClient: () => ({
    putPage: mocks.putPage,
    linkPages: mocks.linkPages,
  }),
}));

vi.mock("@/lib/setup/gbrain-installer", () => ({
  getCurrentUserHandle: mocks.getCurrentUserHandle,
}));

vi.mock("@/lib/projects/ensure-project-shell", () => ({
  ensureProjectShellForProjectSlug: mocks.ensureProjectShellForProjectSlug,
}));

import { GET, POST } from "@/app/api/brain/critique/route";

function completedJob() {
  return {
    id: "job-123",
    trace_id: "trace-abc",
    status: "COMPLETED",
    pdf_filename: "hubble-1929.pdf",
    style_profile: "professional",
    result: {
      title: "Hubble critique",
      report_markdown: "# Report\n\nDistance calibration is fragile.",
      author_feedback: {
        overall_summary: "Distance calibration is the main weakness.",
        top_issues: [],
      },
      findings: [
        {
          finding_id: "F001",
          severity: "error",
          description: "Distance calibration fragility undermines conclusions.",
          finding_kind: "critique",
        },
      ],
    },
  };
}

describe("/api/brain/critique", () => {
  beforeEach(() => {
    mocks.pages.clear();
    mocks.ensureBrainStoreReady.mockClear();
    mocks.getPage.mockClear();
    mocks.listPages.mockClear();
    mocks.putPage.mockReset();
    mocks.putPage.mockResolvedValue({ stdout: "", stderr: "" });
    mocks.linkPages.mockReset();
    mocks.linkPages.mockResolvedValue({ stdout: "", stderr: "" });
    mocks.getCurrentUserHandle.mockClear();
    mocks.ensureProjectShellForProjectSlug.mockReset();
    mocks.ensureProjectShellForProjectSlug.mockResolvedValue(null);
  });

  it("rejects non-completed jobs", async () => {
    const response = await POST(
      new Request("http://localhost/api/brain/critique", {
        method: "POST",
        body: JSON.stringify({
          job: { ...completedJob(), status: "RUNNING", result: null },
        }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Only completed structured critique jobs can be saved to gbrain",
    });
    expect(mocks.putPage).not.toHaveBeenCalled();
  });

  it("writes a completed critique job to gbrain and links an existing paper parent", async () => {
    mocks.pages.set("hubble-1929", {
      path: "hubble-1929",
      title: "Hubble 1929",
      type: "paper",
      content: "# Hubble",
      frontmatter: {
        type: "paper",
        project: "hubble-1929",
        source_filename: "hubble-1929.pdf",
      },
    });

    const response = await POST(
      new Request("http://localhost/api/brain/critique", {
        method: "POST",
        body: JSON.stringify({ job: completedJob() }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      brain_slug: "hubble-1929-critique",
      parent_slug: "hubble-1929",
      project_slug: "hubble-1929",
      project_url: "/dashboard/project?name=hubble-1929&brain_slug=hubble-1929-critique",
      linked_parent: true,
      finding_count: 1,
    });

    expect(mocks.putPage).toHaveBeenCalledTimes(1);
    const [slug, markdown] = mocks.putPage.mock.calls[0] as unknown as [
      string,
      string,
    ];
    expect(slug).toBe("hubble-1929-critique");
    expect(markdown).toContain("type: critique");
    expect(markdown).toContain("parent: hubble-1929");
    expect(markdown).toContain("descartes_job_id: job-123");
    expect(markdown).toContain("## Raw Descartes response");
    expect(mocks.linkPages).toHaveBeenCalledWith(
      "hubble-1929",
      "hubble-1929-critique",
      { linkType: "audited_by" },
    );
    expect(mocks.ensureProjectShellForProjectSlug).toHaveBeenCalledWith({
      projectSlug: "hubble-1929",
      sourceFilename: "hubble-1929.pdf",
    });
  });

  it("allocates a numbered critique slug when another job already used the default slug", async () => {
    mocks.pages.set("hubble-1929-critique", {
      path: "hubble-1929-critique",
      title: "Prior critique",
      type: "note",
      content: "",
      frontmatter: { type: "critique", descartes_job_id: "other-job" },
    });

    const response = await POST(
      new Request("http://localhost/api/brain/critique", {
        method: "POST",
        body: JSON.stringify({ job: completedJob() }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      brain_slug: "hubble-1929-critique-2",
      linked_parent: false,
    });
    expect(mocks.putPage).toHaveBeenCalledWith(
      "hubble-1929-critique-2",
      expect.any(String),
    );
    expect(mocks.linkPages).not.toHaveBeenCalled();
    expect(mocks.ensureProjectShellForProjectSlug).toHaveBeenCalledWith({
      projectSlug: "hubble-1929",
      sourceFilename: "hubble-1929.pdf",
    });
  });

  it("serializes slug allocation for concurrent different-job saves", async () => {
    mocks.putPage.mockImplementation(async (...args: unknown[]) => {
      const [slug, markdown] = args as [string, string];
      const jobId = markdown.match(/^descartes_job_id:\s*(.+)$/m)?.[1]?.trim();
      mocks.pages.set(slug, {
        path: slug,
        title: slug,
        type: "note",
        content: markdown,
        frontmatter: {
          type: "critique",
          descartes_job_id: jobId,
        },
      });
      return { stdout: "", stderr: "" };
    });

    const [first, second] = await Promise.all([
      POST(
        new Request("http://localhost/api/brain/critique", {
          method: "POST",
          body: JSON.stringify({ job: { ...completedJob(), id: "job-a" } }),
        }),
      ),
      POST(
        new Request("http://localhost/api/brain/critique", {
          method: "POST",
          body: JSON.stringify({ job: { ...completedJob(), id: "job-b" } }),
        }),
      ),
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const slugs = [
      ((await first.json()) as { brain_slug: string }).brain_slug,
      ((await second.json()) as { brain_slug: string }).brain_slug,
    ].sort();
    expect(slugs).toEqual(["hubble-1929-critique", "hubble-1929-critique-2"]);
  });

  it("does not leak raw gbrain write errors in 500 responses", async () => {
    mocks.putPage.mockRejectedValueOnce(new Error("secret local path /Users/alice/.gbrain"));

    const response = await POST(
      new Request("http://localhost/api/brain/critique", {
        method: "POST",
        body: JSON.stringify({ job: completedJob() }),
      }),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "Failed to save critique to gbrain",
    });
  });

  it("still succeeds when project-shell materialization fails after the critique page is saved", async () => {
    mocks.ensureProjectShellForProjectSlug.mockRejectedValueOnce(
      new Error("disk permissions exploded"),
    );

    const response = await POST(
      new Request("http://localhost/api/brain/critique", {
        method: "POST",
        body: JSON.stringify({ job: completedJob() }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      brain_slug: "hubble-1929-critique",
      project_slug: "hubble-1929",
    });
  });

  it("lists saved critique pages from gbrain by recency", async () => {
    mocks.pages.set("hubble-1929-critique", {
      path: "hubble-1929-critique.md",
      title: "Hubble critique",
      type: "note",
      content: "",
      frontmatter: {
        type: "critique",
        parent: "hubble-1929",
        project: "hubble-1929",
        source_filename: "hubble-1929.pdf",
        uploaded_at: "2026-04-18T07:00:22.000Z",
        descartes_job_id: "job-old",
        finding_count: 3,
      },
    });
    mocks.pages.set("hubble-1929-critique-2", {
      path: "hubble-1929-critique-2.md",
      title: "Hubble critique 2",
      type: "note",
      content: "",
      frontmatter: {
        type: "critique",
        parent: "hubble-1929",
        project: "hubble-1929",
        source_filename: "hubble-1929.pdf",
        uploaded_at: "2026-04-18T07:02:34.000Z",
        descartes_job_id: "job-new",
        finding_count: 4,
      },
    });
    mocks.pages.set("hubble-1929", {
      path: "hubble-1929.md",
      title: "Hubble paper",
      type: "paper",
      content: "",
      frontmatter: { type: "paper", project: "hubble-1929" },
    });

    const response = await GET(
      new Request("http://localhost/api/brain/critique?limit=1"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      audits: [
        {
          brain_slug: "hubble-1929-critique-2",
          parent_slug: "hubble-1929",
          project_slug: "hubble-1929",
          title: "Hubble critique 2",
          uploaded_at: "2026-04-18T07:02:34.000Z",
          source_filename: "hubble-1929.pdf",
          descartes_job_id: "job-new",
          finding_count: 4,
          url: "/dashboard/reasoning?brain_slug=hubble-1929-critique-2",
          project_url:
            "/dashboard/project?name=hubble-1929&brain_slug=hubble-1929-critique-2",
        },
      ],
    });
    expect(mocks.listPages).toHaveBeenCalledWith({ limit: 5000 });
  });

  it("rejects non-local critique list requests before reading gbrain", async () => {
    const response = await GET(
      new Request("http://localhost/api/brain/critique?limit=1", {
        headers: { "x-forwarded-for": "203.0.113.10" },
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Forbidden" });
    expect(mocks.listPages).not.toHaveBeenCalled();
  });
});
