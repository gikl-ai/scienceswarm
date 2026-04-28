import { getOllamaUrl } from "@/lib/config/ports";
import { OLLAMA_RECOMMENDED_MODEL_ALIASES } from "@/lib/ollama-constants";
import { normalizeOllamaModelName } from "@/lib/ollama-models";
import { OPENHANDS_LOCAL_SENTINEL_API_KEY } from "@/lib/runtime/model-catalog";

const OPENCLAW_OLLAMA_CONTEXT_WINDOW = 131_072;
const OPENCLAW_OLLAMA_MAX_TOKENS = 8_192;

export const OPENCLAW_OLLAMA_PROVIDER_KEY = OPENHANDS_LOCAL_SENTINEL_API_KEY;

function modelIdsForOpenClawProvider(modelId: string): string[] {
  if (OLLAMA_RECOMMENDED_MODEL_ALIASES.includes(modelId)) {
    return OLLAMA_RECOMMENDED_MODEL_ALIASES;
  }
  return [modelId];
}

export function buildOpenClawOllamaProviderConfig(model: string) {
  const modelId = normalizeOllamaModelName(model).trim();
  if (!modelId) {
    throw new Error("Ollama model is required to configure OpenClaw.");
  }

  return {
    baseUrl: getOllamaUrl(),
    api: "ollama",
    apiKey: OPENCLAW_OLLAMA_PROVIDER_KEY,
    models: modelIdsForOpenClawProvider(modelId).map((id) => ({
      id,
      name: id,
      reasoning: true,
      input: ["text", "image"],
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
      contextWindow: OPENCLAW_OLLAMA_CONTEXT_WINDOW,
      maxTokens: OPENCLAW_OLLAMA_MAX_TOKENS,
    })),
  } as const;
}
