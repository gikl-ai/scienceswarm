import { afterEach, describe, expect, it, vi } from "vitest";

async function importRoute() {
  return await import("@/app/api/brain/list/route");
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("@/brain/store");
  vi.doUnmock("@/lib/gbrain/project-query-fast-path");
});

describe("GET /api/brain/list", () => {
  it("uses the fast metadata query when the gbrain db is available", async () => {
    const dbQuery = vi.fn(async () => ({
      rows: [
        {
          slug: "papers/attention-is-all-you-need",
          type: "paper",
          title: "",
          frontmatter: {
            project: "alpha-project",
            source_filename: "attention_is_all_you_need.pdf",
          },
        },
      ],
    }));

    vi.doMock("@/brain/store", () => ({
      ensureBrainStoreReady: vi.fn(async () => {}),
      getBrainStore: vi.fn(() => ({
        engine: {
          db: {
            query: dbQuery,
          },
        },
      })),
      isBrainBackendUnavailableError: vi.fn(() => false),
    }));

    const { GET } = await importRoute();
    const response = await GET(
      new Request("http://localhost/api/brain/list?project=alpha-project"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([
      {
        slug: "papers/attention-is-all-you-need",
        title: "attention is all you need",
        type: "paper",
        frontmatter: {
          project: "alpha-project",
          source_filename: "attention_is_all_you_need.pdf",
        },
      },
    ]);
    expect(dbQuery).toHaveBeenCalledTimes(1);
    const [sql] = dbQuery.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("study_slugs");
    expect(sql).toContain("legacy_project_slugs");
  });

  it("falls back to legacy project when canonical study is blank", async () => {
    const dbQuery = vi.fn(async () => ({
      rows: [
        {
          slug: "papers/fallback",
          type: "paper",
          title: "Fallback",
          frontmatter: {
            project: "alpha-project",
          },
        },
      ],
    }));

    vi.doMock("@/brain/store", () => ({
      ensureBrainStoreReady: vi.fn(async () => {}),
      getBrainStore: vi.fn(() => ({
        engine: {
          db: {
            query: dbQuery,
          },
        },
      })),
      isBrainBackendUnavailableError: vi.fn(() => false),
    }));

    const { GET } = await importRoute();
    const response = await GET(
      new Request("http://localhost/api/brain/list?study=&project=alpha-project"),
    );

    expect(response.status).toBe(200);
    expect(dbQuery).toHaveBeenCalledWith(
      expect.any(String),
      ["alpha-project", expect.any(Number)],
    );
  });

  it("returns an empty degraded list when the brain backend is unavailable", async () => {
    class MockBrainBackendUnavailableError extends Error {
      constructor() {
        super("Brain backend unavailable");
        this.name = "BrainBackendUnavailableError";
      }
    }

    vi.doMock("@/lib/gbrain/project-query-fast-path", () => ({
      listProjectPageSummariesFast: vi.fn(async () => null),
    }));

    vi.doMock("@/brain/store", () => ({
      ensureBrainStoreReady: vi.fn(async () => {
        throw new MockBrainBackendUnavailableError();
      }),
      getBrainStore: vi.fn(),
      isBrainBackendUnavailableError: (error: unknown) => error instanceof MockBrainBackendUnavailableError,
    }));

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { GET } = await importRoute();
    const response = await GET(
      new Request("http://localhost/api/brain/list?project=alpha-project"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-scienceswarm-degraded")).toBe("brain_backend_unavailable");
    await expect(response.json()).resolves.toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      "GET /api/brain/list degraded:",
      "Brain backend unavailable",
    );
  });
});
