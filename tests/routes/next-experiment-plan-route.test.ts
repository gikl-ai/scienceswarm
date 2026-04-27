import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildAndPersistNextExperimentPlan: vi.fn(),
  getBrainConfig: vi.fn(),
  getLLMClient: vi.fn(),
  isLocalRequest: vi.fn(),
}));

vi.mock("@/brain/next-experiment-planner", () => ({
  buildAndPersistNextExperimentPlan: mocks.buildAndPersistNextExperimentPlan,
}));

vi.mock("@/app/api/brain/_shared", () => ({
  getBrainConfig: mocks.getBrainConfig,
  getLLMClient: mocks.getLLMClient,
  isErrorResponse: (value: unknown) => value instanceof Response,
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
    mocks.isLocalRequest.mockResolvedValue(true);
    mocks.getBrainConfig.mockReturnValue({ synthesisModel: "test-model" });
    mocks.getLLMClient.mockReturnValue({ complete: vi.fn() });
    mocks.buildAndPersistNextExperimentPlan.mockResolvedValue({
      brain_slug: "plans/alpha-next",
    });
  });

  it("falls back to legacy project when canonical study is blank", async () => {
    const { POST } = await import("@/app/api/brain/next-experiment-plan/route");
    const response = await POST(request({
      study: " ",
      project: "alpha",
      prompt: "What should we run next?",
    }));

    expect(response.status).toBe(200);
    expect(mocks.buildAndPersistNextExperimentPlan).toHaveBeenCalledWith(
      expect.objectContaining({ project: "alpha" }),
    );
  });
});
