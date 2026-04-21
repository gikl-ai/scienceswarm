import { afterEach, describe, expect, it, vi } from "vitest";

async function importRoute() {
  return await import("@/app/api/brain/list/route");
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("@/brain/store");
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
  });
});
