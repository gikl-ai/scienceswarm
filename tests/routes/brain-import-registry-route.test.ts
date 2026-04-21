import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockBuildProjectImportRegistry = vi.fn();
const mockGetBrainConfig = vi.fn();
const mockIsErrorResponse = vi.fn();

vi.mock("@/brain/import-registry", () => ({
  buildProjectImportRegistry: mockBuildProjectImportRegistry,
}));

vi.mock("@/app/api/brain/_shared", () => ({
  getBrainConfig: mockGetBrainConfig,
  isErrorResponse: mockIsErrorResponse,
}));

describe("GET /api/brain/import-registry", () => {
  beforeEach(() => {
    mockBuildProjectImportRegistry.mockReset();
    mockGetBrainConfig.mockReset();
    mockIsErrorResponse.mockReset();
    mockGetBrainConfig.mockReturnValue({
      root: "/tmp/test-brain",
      extractionModel: "test-model",
      synthesisModel: "test-model",
      rippleCap: 15,
      paperWatchBudget: 50,
      serendipityRate: 0.2,
    });
    mockIsErrorResponse.mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the authoritative import registry for a valid project slug", async () => {
    mockBuildProjectImportRegistry.mockResolvedValue({
      project: "alpha",
      generatedAt: "2026-04-19T12:00:00.000Z",
      detectedItemCount: 5,
      registeredItemCount: 4,
      duplicateGroupCount: 1,
      entries: [],
      duplicateGroups: [],
      warnings: [],
    });

    const { GET } = await import("@/app/api/brain/import-registry/route");
    const response = await GET(
      new Request("http://localhost/api/brain/import-registry?project=alpha"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        project: "alpha",
        detectedItemCount: 5,
        registeredItemCount: 4,
      }),
    );
    expect(mockBuildProjectImportRegistry).toHaveBeenCalledWith(
      expect.objectContaining({ project: "alpha" }),
    );
  });

  it("rejects missing project parameter", async () => {
    const { GET } = await import("@/app/api/brain/import-registry/route");
    const response = await GET(
      new Request("http://localhost/api/brain/import-registry"),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Missing project parameter" });
  });

  it("hides internal error details on 500 responses", async () => {
    mockBuildProjectImportRegistry.mockRejectedValueOnce(new Error("sensitive detail"));

    const { GET } = await import("@/app/api/brain/import-registry/route");
    const response = await GET(
      new Request("http://localhost/api/brain/import-registry?project=alpha"),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "Import registry failed" });
  });
});
