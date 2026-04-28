import {
  buildOpenClawOllamaProviderConfig,
  OPENCLAW_OLLAMA_PROVIDER_KEY,
} from "@/lib/openclaw/ollama-provider";
import { OLLAMA_RECOMMENDED_MODEL_ALIASES } from "@/lib/ollama-constants";
import { normalizeOllamaModelName } from "@/lib/ollama-models";
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

export function buildLocalOpenClawAllowedModels(
  model: string,
): Record<string, Record<string, never>> {
  const modelId = normalizeOllamaModelName(model).trim();
  const allowedModels = new Set<string>();
  if (modelId) {
    const modelIds = OLLAMA_RECOMMENDED_MODEL_ALIASES.includes(modelId)
      ? OLLAMA_RECOMMENDED_MODEL_ALIASES
      : [modelId];
    for (const id of modelIds) {
      allowedModels.add(`ollama/${id}`);
    }
  }
  return Object.fromEntries(
    Array.from(allowedModels).map((modelRef) => [modelRef, {}]),
  );
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

    const allowedModelsResult = await runOpenClaw(
      [
        "config",
        "set",
        "agents.defaults.models",
        JSON.stringify(buildLocalOpenClawAllowedModels(model)),
        "--strict-json",
      ],
      { timeoutMs },
    );
    if (!allowedModelsResult.ok) {
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
