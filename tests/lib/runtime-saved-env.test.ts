import { describe, expect, it } from "vitest";

import {
  resolveExplicitLlmRuntimeConfig,
  resolveSavedLlmRuntimeEnv,
} from "@/lib/runtime-saved-env";

describe("resolveSavedLlmRuntimeEnv", () => {
  it("prefers saved .env values over stale process env for mutable llm settings", () => {
    const runtime = resolveSavedLlmRuntimeEnv(
      {
        NODE_ENV: "test",
        LLM_PROVIDER: "local",
        LLM_MODEL: "gpt-4.1",
        OLLAMA_MODEL: "gemma4:latest",
        OPENAI_API_KEY: "placeholder-openai-process-key",
      },
      [
        "LLM_PROVIDER=openai",
        "LLM_MODEL=gpt-5.4",
        "OLLAMA_MODEL=gemma4:26b",
        "OPENAI_API_KEY=placeholder-openai-saved-key",
      ].join("\n"),
    );

    expect(runtime).toEqual({
      strictLocalOnly: false,
      llmProvider: "openai",
      llmModel: "gpt-5.4",
      ollamaModel: "gemma4:26b",
      anthropicApiKey: null,
      openaiApiKey: "placeholder-openai-saved-key",
      googleAiApiKey: null,
      googleApiKey: null,
      vertexAiApiKey: null,
      vertexAiProject: null,
      vertexAiLocation: null,
      agentBackend: null,
      agentUrl: null,
      agentApiKey: null,
      openclawInternalApiKey: null,
    });
  });

  it("keeps strict local-only mode forced from process env", () => {
    const runtime = resolveSavedLlmRuntimeEnv(
      {
        NODE_ENV: "test",
        SCIENCESWARM_STRICT_LOCAL_ONLY: "1",
        LLM_PROVIDER: "openai",
      },
      "SCIENCESWARM_STRICT_LOCAL_ONLY=0\nLLM_PROVIDER=openai\n",
    );

    expect(runtime.strictLocalOnly).toBe(true);
    expect(runtime.llmProvider).toBe("local");
  });

  it("falls back to process env when no saved .env exists", () => {
    const runtime = resolveSavedLlmRuntimeEnv(
      {
        NODE_ENV: "test",
        LLM_PROVIDER: "local",
        OLLAMA_MODEL: "gemma4:latest",
      },
      null,
    );

    expect(runtime.llmProvider).toBe("local");
    expect(runtime.ollamaModel).toBe("gemma4:latest");
    expect(runtime.llmModel).toBeNull();
  });

  it("adds API-key fallback keys for Anthropic, Google AI, and Vertex from saved .env", () => {
    const runtime = resolveSavedLlmRuntimeEnv(
      {
        NODE_ENV: "test",
        ANTHROPIC_API_KEY: "placeholder-anthropic-process-key",
        GOOGLE_AI_API_KEY: "google-process",
        VERTEX_AI_PROJECT: "process-project",
      },
      [
        "ANTHROPIC_API_KEY=placeholder-anthropic-saved-key",
        "GOOGLE_AI_API_KEY=google-ai-saved",
        "GOOGLE_API_KEY=google-saved",
        "VERTEX_AI_API_KEY=vertex-saved",
        "VERTEX_AI_PROJECT=project-alpha",
        "VERTEX_AI_LOCATION=us-central1",
      ].join("\n"),
    );

    expect(runtime).toMatchObject({
      anthropicApiKey: "placeholder-anthropic-saved-key",
      googleAiApiKey: "google-ai-saved",
      googleApiKey: "google-saved",
      vertexAiApiKey: "vertex-saved",
      vertexAiProject: "project-alpha",
      vertexAiLocation: "us-central1",
    });
  });

  it("accepts legacy truthy strict-local values from saved or process env", () => {
    const runtime = resolveSavedLlmRuntimeEnv(
      {
        NODE_ENV: "test",
        SCIENCESWARM_STRICT_LOCAL_ONLY: "yes",
        LLM_PROVIDER: "openai",
      },
      "SCIENCESWARM_STRICT_LOCAL_ONLY=true\nLLM_PROVIDER=openai\n",
    );

    expect(runtime.strictLocalOnly).toBe(true);
    expect(runtime.llmProvider).toBe("local");
  });

  it("tracks which runtime controls were explicitly configured", () => {
    const explicit = resolveExplicitLlmRuntimeConfig(
      {
        NODE_ENV: "test",
        LLM_MODEL: "gpt-5.4",
      },
      [
        "LLM_PROVIDER=openai",
        "OPENAI_API_KEY=sk-saved",
      ].join("\n"),
    );

    expect(explicit).toEqual({
      strictLocalOnly: false,
      llmProvider: true,
      llmModel: true,
      ollamaModel: false,
      openaiApiKey: true,
    });
  });
});
