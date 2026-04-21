import { describe, expect, it } from "vitest";

import { resolveSavedLlmRuntimeEnv } from "@/lib/runtime-saved-env";

describe("resolveSavedLlmRuntimeEnv", () => {
  it("prefers saved .env values over stale process env for mutable llm settings", () => {
    const runtime = resolveSavedLlmRuntimeEnv(
      {
        NODE_ENV: "test",
        LLM_PROVIDER: "local",
        LLM_MODEL: "gpt-4.1",
        OLLAMA_MODEL: "gemma4:latest",
        OPENAI_API_KEY: "sk-process",
      },
      [
        "LLM_PROVIDER=openai",
        "LLM_MODEL=gpt-5.4",
        "OLLAMA_MODEL=gemma4:26b",
        "OPENAI_API_KEY=sk-saved",
      ].join("\n"),
    );

    expect(runtime).toEqual({
      strictLocalOnly: false,
      llmProvider: "openai",
      llmModel: "gpt-5.4",
      ollamaModel: "gemma4:26b",
      openaiApiKey: "sk-saved",
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
});
