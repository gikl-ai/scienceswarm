import {
  buildOpenClawOllamaProviderConfig,
  OPENCLAW_OLLAMA_PROVIDER_KEY,
} from "@/lib/openclaw/ollama-provider";
import { runOpenClaw } from "@/lib/openclaw/runner";

export type OpenClawLlmProvider = "openai" | "local";

export function normalizeOpenClawModel(
  model: string,
  llmProvider: OpenClawLlmProvider,
): string {
  if (llmProvider === "local") {
    if (model.startsWith("ollama/")) return model;
    return `ollama/${model.replace(/^openai\//, "").trim()}`;
  }
  if (model.startsWith("openai/")) return model;
  return `openai/${model.replace(/^ollama\//, "").trim()}`;
}

export async function configureOpenClawModel(
  model: string,
  llmProvider: OpenClawLlmProvider,
  options: { timeoutMs?: number } = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 5_000;

  if (llmProvider === "local") {
    const providerConfigResult = await runOpenClaw(
      [
        "config",
        "set",
        "models.providers.ollama",
        JSON.stringify(buildOpenClawOllamaProviderConfig(model)),
        "--strict-json",
      ],
      { timeoutMs },
    );
    if (!providerConfigResult.ok) {
      return false;
    }
  }

  const modelResult = await runOpenClaw(["models", "set", model], {
    timeoutMs,
    extraEnv:
      llmProvider === "local"
        ? { OLLAMA_API_KEY: OPENCLAW_OLLAMA_PROVIDER_KEY }
        : undefined,
  });
  return modelResult.ok;
}
