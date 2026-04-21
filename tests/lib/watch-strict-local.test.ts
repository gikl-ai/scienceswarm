import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectManifest } from "@/brain/types";
import type { ProjectWatchConfig, ProjectWatchSource } from "@/lib/watch/types";

const mockResponsesCreate = vi.hoisted(() => vi.fn());

vi.mock("@/lib/openai-client", () => ({
  getOpenAIClient: vi.fn(() => ({
    responses: {
      create: mockResponsesCreate,
    },
  })),
  getOpenAIModel: vi.fn(() => "gpt-4.1"),
  getWebSearchModel: vi.fn(() => "gpt-4.1-search"),
  hasOpenAIKey: vi.fn(() => true),
}));

function makeManifest(): ProjectManifest {
  return {
    version: 1,
    projectId: "project-alpha",
    slug: "project-alpha",
    title: "Project Alpha",
    privacy: "cloud-ok",
    status: "active",
    projectPagePath: "wiki/projects/project-alpha.md",
    sourceRefs: [],
    decisionPaths: [],
    taskPaths: [],
    artifactPaths: [],
    frontierPaths: [],
    activeThreads: [],
    dedupeKeys: [],
    updatedAt: "2026-04-17T19:00:00.000Z",
  };
}

function makeWatchConfig(): ProjectWatchConfig {
  return {
    version: 1,
    objective: "Track local model research",
    keywords: ["local models"],
    promotionThreshold: 5,
    stagingThreshold: 2,
    sources: [],
  };
}

describe("frontier watch strict-local policy", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    mockResponsesCreate.mockReset();
  });

  it("uses deterministic watch prompt compilation without hosted query expansion", async () => {
    vi.stubEnv("SCIENCESWARM_STRICT_LOCAL_ONLY", "1");
    const { compileWatchPlan } = await import("@/lib/watch/compose");

    const plan = await compileWatchPlan({
      objective: "Track local model research",
      projectTitle: "Project Alpha",
      now: new Date("2026-04-17T19:00:00.000Z"),
    });

    expect(plan.objective).toBe("Track local model research");
    expect(plan.compiledPrompt).toContain("Track local model research");
    expect(mockResponsesCreate).not.toHaveBeenCalled();
  });

  it("returns no hosted web-search items in strict local-only mode", async () => {
    vi.stubEnv("SCIENCESWARM_STRICT_LOCAL_ONLY", "1");
    const { fetchWebSearchWatchItems } = await import("@/lib/watch/adapters/web-search");
    const source: ProjectWatchSource = {
      id: "web",
      type: "web_search",
      query: "local model research",
    };

    const items = await fetchWebSearchWatchItems({
      manifest: makeManifest(),
      watchConfig: makeWatchConfig(),
      source,
    });

    expect(items).toEqual([]);
    expect(mockResponsesCreate).not.toHaveBeenCalled();
  });
});
