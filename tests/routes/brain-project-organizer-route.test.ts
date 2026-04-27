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

describe("GET /api/brain/study-organizer", () => {
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

  it("returns a read-only organizer summary for a valid study slug", async () => {
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
      suggestedPrompts: ["Organize this study."],
    });

    const { GET } = await import("@/app/api/brain/study-organizer/route");
    const response = await GET(
      new Request("http://localhost/api/brain/study-organizer?study=alpha"),
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

  it("falls back to legacy project when canonical study is blank", async () => {
    mockBuildProjectOrganizerReadout.mockResolvedValue({
      project: "alpha",
      generatedAt: "2026-04-19T12:00:00.000Z",
      pageCount: 0,
      pageScanLimit: 5000,
      pageScanLimitReached: false,
      pageCountsByType: {},
      importSummary: null,
      threads: [],
      duplicatePapers: [],
      importDuplicateGroups: [],
      trackedExportCount: 0,
      staleExports: [],
      nextMove: { recommendation: "Review the imported notes." },
      dueTasks: [],
      frontier: [],
      suggestedPrompts: [],
    });

    const { GET } = await import("@/app/api/brain/study-organizer/route");
    const response = await GET(
      new Request("http://localhost/api/brain/study-organizer?study=&project=alpha"),
    );

    expect(response.status).toBe(200);
    expect(mockBuildProjectOrganizerReadout).toHaveBeenCalledWith(
      expect.objectContaining({ project: "alpha" }),
    );
  });

  it("rejects missing study parameter", async () => {
    const { GET } = await import("@/app/api/brain/study-organizer/route");
    const response = await GET(
      new Request("http://localhost/api/brain/study-organizer"),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Missing study parameter" });
  });

  it("rejects an unsafe study slug", async () => {
    const { GET } = await import("@/app/api/brain/study-organizer/route");
    const response = await GET(
      new Request("http://localhost/api/brain/study-organizer?study=../alpha"),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "study must be a safe bare slug" });
  });
});
