import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureBrainStoreReady: vi.fn(),
  filterProjectPages: vi.fn(),
  getBrainConfig: vi.fn(),
  getBrainStore: vi.fn(),
  getCurrentUserHandle: vi.fn(),
  getLLMClient: vi.fn(),
  isLocalRequest: vi.fn(),
  putPage: vi.fn(),
}));

vi.mock("@/app/api/brain/_shared", () => ({
  getBrainConfig: mocks.getBrainConfig,
  getLLMClient: mocks.getLLMClient,
  isErrorResponse: (value: unknown) => value instanceof Response,
}));

vi.mock("@/brain/store", () => ({
  ensureBrainStoreReady: mocks.ensureBrainStoreReady,
  getBrainStore: mocks.getBrainStore,
}));

vi.mock("@/brain/project-organizer", () => ({
  filterProjectPages: mocks.filterProjectPages,
}));

vi.mock("@/brain/in-process-gbrain-client", () => ({
  createInProcessGbrainClient: () => ({
    putPage: mocks.putPage,
  }),
}));

vi.mock("@/lib/local-guard", () => ({
  isLocalRequest: mocks.isLocalRequest,
}));

vi.mock("@/lib/setup/gbrain-installer", () => ({
  getCurrentUserHandle: mocks.getCurrentUserHandle,
}));

function request(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/brain/evidence-map", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const sourcePages = [
  {
    path: "wiki/projects/project-alpha/results/resistance-note",
    title: "Resistance note",
    type: "note",
    content: "EGFR inhibition rebounds unless MEK is co-targeted.",
    frontmatter: {
      project: "project-alpha",
      source_filename: "resistance-note.md",
    },
  },
  {
    path: "wiki/projects/project-alpha/results/organoid-table",
    title: "Organoid table",
    type: "data",
    content: "EGFR plus MEK lowered viability in patient organoids.",
    frontmatter: {
      project: "project-alpha",
      source_filename: "organoid-table.csv",
    },
  },
];

describe("evidence map route", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.ensureBrainStoreReady.mockReset();
    mocks.filterProjectPages.mockReset();
    mocks.getBrainConfig.mockReset();
    mocks.getBrainStore.mockReset();
    mocks.getCurrentUserHandle.mockReset();
    mocks.getLLMClient.mockReset();
    mocks.isLocalRequest.mockReset();
    mocks.putPage.mockReset();

    mocks.getBrainConfig.mockReturnValue({ synthesisModel: "test-model" });
    mocks.getCurrentUserHandle.mockReturnValue("test-scientist");
    mocks.getBrainStore.mockReturnValue({
      listPages: vi.fn(async () => sourcePages),
    });
    mocks.filterProjectPages.mockReturnValue(sourcePages);
    mocks.isLocalRequest.mockResolvedValue(true);
    mocks.putPage.mockResolvedValue({ stdout: "", stderr: "" });
    mocks.getLLMClient.mockReturnValue({
      complete: vi.fn(async () => ({
        content: JSON.stringify({
          focused_question: "Where does EGFR resistance evidence disagree?",
          claims: [
            {
              id: "claim-1",
              statement: "MEK co-targeting reduces rebound viability.",
              qualifiers: ["patient organoid context"],
              confidence: "high",
              sources: [
                {
                  slug: "wiki/projects/project-alpha/results/organoid-table",
                  title: "Organoid table",
                },
              ],
            },
            {
              id: "claim-2",
              statement: "A hallucinated source should not become evidence.",
              qualifiers: [],
              confidence: "high",
              sources: [
                {
                  slug: "wiki/projects/project-alpha/results/not-selected",
                  title: "Injected source",
                },
              ],
            },
          ],
          tensions: [],
          uncertainties: [
            {
              gap: "Dose timing is not fully specified.",
              next_clarification: "Compare time points before ranking follow-up assays.",
            },
          ],
          honesty_note: "Only two project sources were available.",
        }),
      })),
    });
  });

  it("rejects non-local requests before scanning project memory", async () => {
    mocks.isLocalRequest.mockResolvedValue(false);

    const { POST } = await import("@/app/api/brain/evidence-map/route");
    const response = await POST(request({
      projectId: "project-alpha",
      question: "Where does the evidence disagree?",
    }));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Forbidden" });
    expect(mocks.ensureBrainStoreReady).not.toHaveBeenCalled();
    expect(mocks.putPage).not.toHaveBeenCalled();
  });

  it("generates a source-backed evidence-map artifact through the real route boundary", async () => {
    const { POST } = await import("@/app/api/brain/evidence-map/route");
    const response = await POST(request({
      studyId: "project-alpha",
      question: "Where does EGFR resistance evidence disagree?",
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      study_url: expect.stringContaining("/dashboard/study?name=project-alpha"),
      summary: {
        question: "Where does EGFR resistance evidence disagree?",
        claimCount: 1,
        tensionCount: 0,
        sourcePageCount: 2,
        honestyNote: "Only two project sources were available.",
      },
    });

    expect(mocks.filterProjectPages).toHaveBeenCalledWith(sourcePages, "project-alpha");
    expect(mocks.putPage).toHaveBeenCalledTimes(1);
    const [slug, markdown] = mocks.putPage.mock.calls[0] as unknown as [
      string,
      string,
    ];
    expect(slug).toMatch(/^analysis\/evidence-maps\/project-alpha\//);
    expect(markdown).toContain("MEK co-targeting reduces rebound viability.");
    expect(markdown).toContain("Only two project sources were available.");
    expect(markdown).toContain("wiki/projects/project-alpha/results/resistance-note");
    expect(markdown).toContain("organoid-table.csv");
    expect(markdown).not.toContain("A hallucinated source should not become evidence.");
  });

  it("keeps projectId as a compatibility alias for evidence-map generation", async () => {
    const { POST } = await import("@/app/api/brain/evidence-map/route");
    const response = await POST(request({
      projectId: "project-alpha",
      question: "Where does EGFR resistance evidence disagree?",
    }));

    expect(response.status).toBe(200);
    expect(mocks.filterProjectPages).toHaveBeenCalledWith(sourcePages, "project-alpha");
  });
});
