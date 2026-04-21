import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockBuildProjectOrganizerReadout = vi.fn();
const mockGetBrainConfig = vi.fn();
const mockIsErrorResponse = vi.fn();

vi.mock("@/brain/project-organizer", () => ({
  buildProjectOrganizerReadout: mockBuildProjectOrganizerReadout,
}));

vi.mock("@/app/api/brain/_shared", () => ({
  getBrainConfig: mockGetBrainConfig,
  isErrorResponse: mockIsErrorResponse,
}));

describe("GET /api/brain/project-organizer", () => {
  beforeEach(() => {
    mockBuildProjectOrganizerReadout.mockReset();
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

  it("returns a read-only organizer summary for a valid project slug", async () => {
    mockBuildProjectOrganizerReadout.mockResolvedValue({
      project: "alpha",
      generatedAt: "2026-04-19T12:00:00.000Z",
      pageCount: 3,
      pageScanLimit: 5000,
      pageScanLimitReached: false,
      pageCountsByType: { paper: 2, task: 1 },
      importSummary: null,
      threads: [],
      duplicatePapers: [],
      importDuplicateGroups: [],
      trackedExportCount: 0,
      staleExports: [],
      nextMove: { recommendation: "Review the imported notes." },
      dueTasks: [],
      frontier: [],
      suggestedPrompts: ["Organize this project."],
    });

    const { GET } = await import("@/app/api/brain/project-organizer/route");
    const response = await GET(
      new Request("http://localhost/api/brain/project-organizer?project=alpha"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        project: "alpha",
        nextMove: { recommendation: "Review the imported notes." },
      }),
    );
    expect(mockBuildProjectOrganizerReadout).toHaveBeenCalledWith(
      expect.objectContaining({ project: "alpha" }),
    );
  });

  it("rejects missing project parameter", async () => {
    const { GET } = await import("@/app/api/brain/project-organizer/route");
    const response = await GET(
      new Request("http://localhost/api/brain/project-organizer"),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Missing project parameter" });
  });

  it("rejects an unsafe project slug", async () => {
    const { GET } = await import("@/app/api/brain/project-organizer/route");
    const response = await GET(
      new Request("http://localhost/api/brain/project-organizer?project=../alpha"),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "project must be a safe bare slug" });
  });
});
