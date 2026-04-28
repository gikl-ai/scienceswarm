import { describe, expect, it } from "vitest";

import { DEFAULT_OPENAI_MODEL } from "@/lib/openai-models";
import {
  DEFAULT_LOCAL_CHAT_MODEL,
  getRankedLocalExecutionModels,
  OPENHANDS_CONTEXT_TARGET,
  OPENHANDS_LOCAL_OLLAMA_BASE_URL,
  OPENHANDS_LOCAL_SENTINEL_API_KEY,
  OPENHANDS_MINIMUM_CONTEXT,
  ollamaModelMatches,
  resolveConfiguredLocalModel,
  resolveDefaultLocalChatModel,
  resolveOpenHandsConversationModel,
  resolveOpenHandsLocalRuntimeConfig,
  resolveOpenHandsLocalModel,
  toOpenHandsModelId,
} from "@/lib/runtime";

describe("runtime model catalog", () => {
  it("defines the local OpenHands execution profile defaults", () => {
    expect(DEFAULT_LOCAL_CHAT_MODEL).toBe("gemma4:e4b");
    expect(OPENHANDS_LOCAL_OLLAMA_BASE_URL).toBe(
      "http://host.docker.internal:11434/v1",
    );
    expect(OPENHANDS_LOCAL_SENTINEL_API_KEY).toBe("ollama-local");
    expect(OPENHANDS_CONTEXT_TARGET).toBe(32768);
    expect(OPENHANDS_MINIMUM_CONTEXT).toBe(22000);
  });

  it("keeps Gemma 4 first and records the planned fallback models", () => {
    const models = getRankedLocalExecutionModels();

    expect(models.map((model) => model.servedModel)).toEqual([
      "gemma4:e4b",
      "gemma4:e2b",
      "devstral-small-2",
      "qwen3-coder:30b",
      "openhands-lm:32b",
      "qwen3:14b",
    ]);
    expect(models[0]).toMatchObject({
      openHandsModel: "openai/gemma4:e4b",
      pullCommand: "ollama pull gemma4:e4b",
    });
  });

  it("matches only the recommended Gemma 4 aliases across saved model names", () => {
    expect(ollamaModelMatches("gemma4", "gemma4:e4b")).toBe(true);
    expect(ollamaModelMatches("gemma4:e4b", "gemma4")).toBe(true);
    expect(ollamaModelMatches("gemma4:latest", "gemma4:e4b")).toBe(true);
    expect(ollamaModelMatches("gemma4", "gemma4")).toBe(true);
    expect(ollamaModelMatches("gemma4", "gemma4:26b")).toBe(false);
    expect(ollamaModelMatches("gemma4:e2b", "gemma4:e4b")).toBe(false);
    expect(ollamaModelMatches("gemma4", "gemma4o-distilled")).toBe(false);
    expect(ollamaModelMatches("gemma4:e4b", "gemma4:e4b")).toBe(true);
    expect(ollamaModelMatches("gemma4:e4b", "gemma4:26b")).toBe(false);
  });

  it("derives OpenHands LiteLLM model ids from the same local model", () => {
    expect(resolveConfiguredLocalModel({})).toBe("gemma4:e4b");
    expect(
      resolveDefaultLocalChatModel({
        SCIENCESWARM_DEFAULT_OLLAMA_MODEL: "gemma4:e2b",
      }),
    ).toBe("gemma4:e2b");
    expect(
      resolveConfiguredLocalModel({
        SCIENCESWARM_DEFAULT_OLLAMA_MODEL: "gemma4:e2b",
      }),
    ).toBe("gemma4:e2b");
    expect(resolveConfiguredLocalModel({ OLLAMA_MODEL: "qwen3:14b" })).toBe(
      "qwen3:14b",
    );
    expect(resolveOpenHandsLocalModel({ OLLAMA_MODEL: "qwen3:14b" })).toBe(
      "openai/qwen3:14b",
    );
    expect(toOpenHandsModelId("ollama/gemma4:e4b")).toBe(
      "openai/gemma4:e4b",
    );
    expect(toOpenHandsModelId("openai/gemma4:e4b")).toBe(
      "openai/gemma4:e4b",
    );
  });

  it("resolves the OpenHands conversation model from the provider mode", () => {
    expect(resolveOpenHandsConversationModel({ LLM_PROVIDER: "local" })).toBe(
      "openai/gemma4:e4b",
    );
    expect(
      resolveOpenHandsConversationModel({
        LLM_PROVIDER: "local",
        OLLAMA_MODEL: "gemma4:e4b",
        LLM_MODEL: "gpt-5.4",
      }),
    ).toBe("openai/gemma4:e4b");
    expect(
      resolveOpenHandsConversationModel({
        LLM_PROVIDER: "local",
        OLLAMA_MODEL: "qwen3:14b",
      }),
    ).toBe("openai/qwen3:14b");
    expect(
      resolveOpenHandsConversationModel({
        LLM_PROVIDER: "openai",
        LLM_MODEL: "gpt-5.4-mini",
      }),
    ).toBe("gpt-5.4-mini");
    expect(resolveOpenHandsConversationModel({})).toBe(DEFAULT_OPENAI_MODEL);
  });

  it("exposes the local OpenHands runtime config contract", () => {
    expect(resolveOpenHandsLocalRuntimeConfig({})).toEqual({
      model: "openai/gemma4:e4b",
      baseUrl: "http://host.docker.internal:11434/v1",
      apiKey: "ollama-local",
      contextLength: 32768,
      minimumContext: 22000,
    });
  });
});
