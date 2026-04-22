import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildAndPersistNextExperimentPlan: vi.fn(),
  getBrainConfig: vi.fn(),
  getLLMClient: vi.fn(),
  isLocalRequest: vi.fn(),
}));

vi.mock("@/app/api/brain/_shared", () => ({
  getBrainConfig: mocks.getBrainConfig,
  getLLMClient: mocks.getLLMClient,
  isErrorResponse: (value: unknown) => value instanceof Response,
}));

vi.mock("@/brain/next-experiment-planner", () => ({
  buildAndPersistNextExperimentPlan: mocks.buildAndPersistNextExperimentPlan,
}));

vi.mock("@/lib/local-guard", () => ({
  isLocalRequest: mocks.isLocalRequest,
}));

function request(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/brain/next-experiment-plan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("next experiment plan route", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.buildAndPersistNextExperimentPlan.mockReset();
    mocks.getBrainConfig.mockReset();
    mocks.getLLMClient.mockReset();
    mocks.isLocalRequest.mockReset();

    mocks.getBrainConfig.mockReturnValue({ root: "/tmp/brain" });
    mocks.getLLMClient.mockReturnValue({ complete: vi.fn() });
    mocks.isLocalRequest.mockResolvedValue(true);
    mocks.buildAndPersistNextExperimentPlan.mockResolvedValue({
      artifactPage: "wiki/entities/artifacts/plan.md",
      artifactTitle: "Next experiment plan",
      responseMarkdown: "Ranked next experiment plan",
    });
  });

  it("rejects non-local requests before loading config or planning experiments", async () => {
    mocks.isLocalRequest.mockResolvedValue(false);

    const { POST } = await import("@/app/api/brain/next-experiment-plan/route");
    const response = await POST(request({
      project: "project-alpha",
      prompt: "What is the next experiment?",
    }));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Forbidden" });
    expect(mocks.getBrainConfig).not.toHaveBeenCalled();
    expect(mocks.buildAndPersistNextExperimentPlan).not.toHaveBeenCalled();
  });

  it("delegates validated planner input to the durable planner", async () => {
    const llm = { complete: vi.fn() };
    mocks.getLLMClient.mockReturnValue(llm);

    const { POST } = await import("@/app/api/brain/next-experiment-plan/route");
    const response = await POST(request({
      project: "project-alpha",
      prompt: "Update the next experiment after the negative result.",
      previousPlanSlug: "wiki/entities/artifacts/previous-plan",
      focusBrainSlug: "wiki/entities/artifacts/result-note",
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      artifactPage: "wiki/entities/artifacts/plan.md",
      responseMarkdown: "Ranked next experiment plan",
    });
    expect(mocks.buildAndPersistNextExperimentPlan).toHaveBeenCalledWith({
      config: { root: "/tmp/brain" },
      llm,
      project: "project-alpha",
      prompt: "Update the next experiment after the negative result.",
      previousPlanSlug: "wiki/entities/artifacts/previous-plan",
      focusBrainSlug: "wiki/entities/artifacts/result-note",
    });
  });
});
