import { beforeEach, describe, expect, it, vi } from "vitest";

const { ensureBrainStoreReady, getBrainStore } = vi.hoisted(() => ({
  ensureBrainStoreReady: vi.fn(),
  getBrainStore: vi.fn(),
}));

vi.mock("@/brain/store", () => ({
  ensureBrainStoreReady,
  getBrainStore,
}));

describe("listProjectWorkspaceFileEntriesFast", () => {
  beforeEach(() => {
    vi.resetModules();
    ensureBrainStoreReady.mockReset();
    getBrainStore.mockReset();
    ensureBrainStoreReady.mockResolvedValue(undefined);
  });

  it("caches embedded gbrain installs that do not expose a files table", async () => {
    const query = vi.fn().mockRejectedValue({
      code: "42P01",
      message: 'relation "files" does not exist',
    });
    getBrainStore.mockReturnValue({ engine: { db: { query } } });

    const { listProjectWorkspaceFileEntriesFast } = await import(
      "@/lib/gbrain/project-query-fast-path"
    );

    await expect(
      listProjectWorkspaceFileEntriesFast("alpha-project"),
    ).resolves.toBeNull();
    await expect(
      listProjectWorkspaceFileEntriesFast("alpha-project"),
    ).resolves.toBeNull();

    expect(query).toHaveBeenCalledTimes(1);
  });
});
