import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const constructedApiKeys = vi.hoisted((): string[] => []);

vi.mock("openai", () => ({
  default: class MockOpenAI {
    apiKey: string;

    constructor({ apiKey }: { apiKey: string }) {
      this.apiKey = apiKey;
      constructedApiKeys.push(apiKey);
    }
  },
}));

function writeEnvFile(dir: string, contents: string): void {
  writeFileSync(path.join(dir, ".env"), contents, "utf8");
}

describe("runtime env live reload", () => {
  let originalCwd = process.cwd();
  let tempDir = "";

  beforeEach(() => {
    originalCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "scienceswarm-runtime-live-"));
    constructedApiKeys.length = 0;
    vi.resetModules();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("prefers saved runtime settings from .env outside test mode", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("OPENAI_API_KEY", "sk-stale");
    vi.stubEnv("LLM_MODEL", "gpt-stale");
    vi.stubEnv("LLM_PROVIDER", "openai");
    vi.stubEnv("OLLAMA_MODEL", "gemma4:e4b");
    vi.stubEnv("SCIENCESWARM_STRICT_LOCAL_ONLY", "0");

    writeEnvFile(
      tempDir,
      [
        "OPENAI_API_KEY=sk-saved",
        "LLM_MODEL=gpt-5.4",
        "LLM_PROVIDER=local",
        "OLLAMA_MODEL=qwen3:14b",
        "SCIENCESWARM_STRICT_LOCAL_ONLY=1",
      ].join("\n"),
    );
    process.chdir(tempDir);

    const { getCurrentLlmRuntimeEnv } = await import("@/lib/runtime-saved-env");
    const { isStrictLocalOnlyEnabled } = await import("@/lib/env-flags");
    const { getLocalModel, isLocalProviderConfigured } = await import("@/lib/local-llm");
    const {
      getOpenAIClient,
      getOpenAIModel,
      hasOpenAIKey,
    } = await import("@/lib/openai-client");

    expect(getCurrentLlmRuntimeEnv()).toEqual({
      strictLocalOnly: true,
      llmProvider: "local",
      llmModel: "gpt-5.4",
      ollamaModel: "qwen3:14b",
      defaultOllamaModel: null,
      anthropicApiKey: null,
      openaiApiKey: "sk-saved",
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
    expect(isStrictLocalOnlyEnabled()).toBe(true);
    expect(isLocalProviderConfigured()).toBe(true);
    expect(getLocalModel()).toBe("qwen3:14b");
    expect(hasOpenAIKey()).toBe(true);
    expect(getOpenAIModel()).toBe("gpt-5.4");
    expect((getOpenAIClient() as { apiKey: string }).apiKey).toBe("sk-saved");
    expect(constructedApiKeys).toEqual(["sk-saved"]);
  });

  it("rebuilds the OpenAI client when the saved API key changes", async () => {
    vi.stubEnv("NODE_ENV", "development");
    process.chdir(tempDir);

    writeEnvFile(tempDir, "OPENAI_API_KEY=sk-first\n");

    const { getOpenAIClient } = await import("@/lib/openai-client");

    const first = getOpenAIClient() as { apiKey: string };

    writeEnvFile(tempDir, "OPENAI_API_KEY=sk-second\n");

    const second = getOpenAIClient() as { apiKey: string };

    expect(first.apiKey).toBe("sk-first");
    expect(second.apiKey).toBe("sk-second");
    expect(second).not.toBe(first);
    expect(constructedApiKeys).toEqual(["sk-first", "sk-second"]);
  });
});
