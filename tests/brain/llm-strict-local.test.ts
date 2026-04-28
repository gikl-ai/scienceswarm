import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrainConfig } from "@/brain/types";

const mockCreateCompletion = vi.hoisted(() => vi.fn());
const {
  mockCompleteLocal,
  mockGetLocalModel,
  mockIsLocalProviderConfigured,
} = vi.hoisted(() => ({
  mockCompleteLocal: vi.fn(),
  mockGetLocalModel: vi.fn(() => "gemma4:e4b"),
  mockIsLocalProviderConfigured: vi.fn(() => false),
}));

vi.mock("openai", () => ({
  default: class MockOpenAI {
    chat = {
      completions: {
        create: mockCreateCompletion,
      },
    };
  },
}));

vi.mock("@/lib/local-llm", () => ({
  completeLocal: mockCompleteLocal,
  getLocalModel: mockGetLocalModel,
  isLocalProviderConfigured: mockIsLocalProviderConfigured,
}));

function makeConfig(): BrainConfig {
  return {
    root: "/tmp/scienceswarm-test-brain",
    extractionModel: "gpt-4.1-mini",
    synthesisModel: "gpt-4.1",
    rippleCap: 15,
    paperWatchBudget: 50,
    serendipityRate: 0.2,
  };
}

describe("brain LLM strict-local policy", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    mockCreateCompletion.mockReset();
    mockCompleteLocal.mockReset();
    mockGetLocalModel.mockReset();
    mockGetLocalModel.mockReturnValue("gemma4:e4b");
    mockIsLocalProviderConfigured.mockReset();
    mockIsLocalProviderConfigured.mockReturnValue(false);
  });

  it("throws before hosted OpenAI calls when strict local-only mode is enabled", async () => {
    vi.stubEnv("SCIENCESWARM_STRICT_LOCAL_ONLY", "1");
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    const { createLLMClient } = await import("@/brain/llm");
    const client = createLLMClient(makeConfig());

    await expect(
      client.complete({
        system: "Summarize local notes.",
        user: "Private research notes",
      }),
    ).rejects.toThrow("Strict local-only mode blocks brain LLM completion");
    expect(mockCreateCompletion).not.toHaveBeenCalled();
  });

  it("uses the configured local Ollama model when LLM_PROVIDER is local", async () => {
    mockIsLocalProviderConfigured.mockReturnValue(true);
    mockCompleteLocal.mockResolvedValueOnce("local synthesis");
    const { createLLMClient } = await import("@/brain/llm");
    const client = createLLMClient(makeConfig());

    const result = await client.complete({
      system: "Summarize local notes.",
      user: "Private research notes",
      model: "gpt-4.1-mini",
    });

    expect(result.content).toBe("local synthesis");
    expect(result.cost).toMatchObject({
      estimatedUsd: 0,
      model: "gemma4:e4b",
    });
    expect(mockCompleteLocal).toHaveBeenCalledWith(
      [
        { role: "system", content: "Summarize local notes." },
        { role: "user", content: "Private research notes" },
      ],
      "gemma4:e4b",
    );
    expect(mockCreateCompletion).not.toHaveBeenCalled();
  });
});
