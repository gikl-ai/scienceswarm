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
      health: vi.fn(async () => ({
        ok: true,
        pageCount: sourcePages.length,
        chunkCount: 0,
        linkCount: 0,
        embedCoverage: 0,
      })),
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

  it("uses corpus context packets before the fallback page-scan prompt", async () => {
    const bibliographyPages = Array.from({ length: 16 }, (_, index) => ({
      path: `wiki/bibliography/doi-10-1000-example-good-pdf-${index}`,
      title: `Good PDF reference ${index}`,
      type: "source",
      content: "A cited paper that is not yet local.",
      frontmatter: {
        entity_type: "bibliography_entry",
        project: "project-alpha",
        local_status: "metadata_only",
        seen_in: [
          {
            paperSlug: "wiki/entities/papers/good-pdf-2024",
            extractionSource: "pdf_references",
            confidence: 0.72,
          },
        ],
      },
    }));
    const corpusPages = [
      ...bibliographyPages,
      {
        path: "wiki/entities/papers/good-pdf-2024",
        title: "Good PDF fixture",
        type: "paper",
        content: "Canonical paper page for EGFR resistance and MEK co-targeting.",
        frontmatter: {
          entity_type: "paper",
          project: "project-alpha",
          scientific_corpus: {
            source_slug: "wiki/sources/papers/good-pdf-2024/source",
          },
        },
      },
      {
        path: "wiki/sources/papers/good-pdf-2024/source",
        title: "Good PDF fixture Source",
        type: "source",
        content: "EGFR inhibition rebounds unless MEK is co-targeted in patient organoids.",
        frontmatter: {
          entity_type: "paper_source",
          source_kind: "paper_source_text",
          project: "project-alpha",
          paper_slug: "wiki/entities/papers/good-pdf-2024",
          section_map: {
            sections: [
              {
                sectionId: "abstract",
                title: "Abstract",
                anchor: "abstract",
                chunkHandles: [
                  {
                    sourceSlug: "wiki/sources/papers/good-pdf-2024/source",
                    chunkId: "chunk-abstract",
                    chunkIndex: 0,
                    sectionId: "abstract",
                  },
                ],
              },
            ],
          },
        },
      },
      {
        path: "wiki/summaries/papers/good-pdf-2024/relevance",
        title: "Good PDF fixture relevance summary",
        type: "note",
        content: "Best for EGFR resistance and MEK co-targeting questions.",
        frontmatter: {
          entity_type: "paper_summary",
          summary_kind: "paper_relevance",
          project: "project-alpha",
          paper_slug: "wiki/entities/papers/good-pdf-2024",
        },
      },
    ];
    const complete = vi.fn(async () => ({
      content: JSON.stringify({
        focused_question: "Does EGFR resistance require MEK co-targeting?",
        claims: [
          {
            id: "claim-1",
            statement: "The local corpus supports MEK co-targeting as resistance evidence.",
            qualifiers: ["patient organoid context"],
            confidence: "medium",
            sources: [
              {
                slug: "wiki/sources/papers/good-pdf-2024/source",
                title: "Good PDF fixture Source",
              },
            ],
          },
        ],
        tensions: [],
        uncertainties: [],
        honesty_note: "The corpus packet selected one local paper.",
      }),
    }));
    mocks.getBrainStore.mockReturnValue({
      listPages: vi.fn(async () => corpusPages),
      health: vi.fn(async () => ({
        ok: true,
        pageCount: corpusPages.length,
        chunkCount: 1,
        linkCount: 3,
        embedCoverage: 0,
      })),
    });
    mocks.filterProjectPages.mockReturnValue(corpusPages);
    mocks.getLLMClient.mockReturnValue({ complete });

    const { POST } = await import("@/app/api/brain/evidence-map/route");
    const response = await POST(request({
      studyId: "project-alpha",
      question: "Does EGFR resistance require MEK co-targeting?",
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      summary: {
        claimCount: 1,
        contextPacketUsed: true,
        contextPaperCount: 1,
        sourcePageCount: 14,
      },
    });
    const [completionInput] = complete.mock.calls[0] as unknown as [{ user: string }];
    expect(completionInput.user).toContain("ResearchContextPacket");
    expect(completionInput.user).toContain("local-literature-first-v1");

    const [, markdown] = mocks.putPage.mock.calls[0] as unknown as [
      string,
      string,
    ];
    expect(markdown).toContain("## Local corpus context");
    expect(markdown).toContain("wiki/entities/papers/good-pdf-2024");
    expect(markdown).toContain("wiki/bibliography/doi-10-1000-example-good-pdf-0");
    expect(markdown).toContain("The corpus packet selected one local paper.");
  });
});
