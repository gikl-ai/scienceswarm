import {
  normalizeOllamaModelName,
  ollamaModelsMatch,
} from "@/lib/ollama-models";
import {
  OLLAMA_LOW_MEMORY_MODEL,
  OLLAMA_RECOMMENDED_MODEL,
} from "@/lib/ollama-constants";
import { DEFAULT_OPENAI_MODEL } from "@/lib/openai-models";

export interface LocalExecutionModelProfile {
  rank: number;
  servedModel: string;
  openHandsModel: string;
  contextTarget: number;
  minimumContext: number;
  memoryGuidance: string;
  pullCommand: string;
  note: string;
}

export const DEFAULT_LOCAL_CHAT_MODEL = OLLAMA_RECOMMENDED_MODEL;
export const LOW_MEMORY_LOCAL_CHAT_MODEL = OLLAMA_LOW_MEMORY_MODEL;
export const DEFAULT_LOCAL_CHAT_MODEL_FAMILY = "gemma4";
export const OPENHANDS_LOCAL_OLLAMA_BASE_URL =
  "http://host.docker.internal:11434/v1";
export const OPENHANDS_LOCAL_SENTINEL_API_KEY = "ollama-local";
export const OPENHANDS_CONTEXT_TARGET = 32768;
export const OPENHANDS_MINIMUM_CONTEXT = 22000;

export const OPENHANDS_LOCAL_MODEL_CATALOG: LocalExecutionModelProfile[] = [
  {
    rank: 1,
    servedModel: "gemma4:e4b",
    openHandsModel: "openai/gemma4:e4b",
    contextTarget: OPENHANDS_CONTEXT_TARGET,
    minimumContext: OPENHANDS_MINIMUM_CONTEXT,
    memoryGuidance: "Default ScienceSwarm local model.",
    pullCommand: "ollama pull gemma4:e4b",
    note: "First automatic attempt for local chat and OpenHands execution.",
  },
  {
    rank: 2,
    servedModel: "gemma4:e2b",
    openHandsModel: "openai/gemma4:e2b",
    contextTarget: OPENHANDS_CONTEXT_TARGET,
    minimumContext: OPENHANDS_MINIMUM_CONTEXT,
    memoryGuidance: "Low-memory Gemma 4 fallback.",
    pullCommand: "ollama pull gemma4:e2b",
    note: "Use when the default Gemma 4 edge model is too large for the host.",
  },
  {
    rank: 3,
    servedModel: "devstral-small-2",
    openHandsModel: "openai/devstral-small-2",
    contextTarget: OPENHANDS_CONTEXT_TARGET,
    minimumContext: OPENHANDS_MINIMUM_CONTEXT,
    memoryGuidance: "Agentic coding fallback for high-memory laptops.",
    pullCommand: "ollama pull devstral-small-2",
    note: "Fallback when Gemma 4 fails task-grade OpenHands smoke.",
  },
  {
    rank: 4,
    servedModel: "qwen3-coder:30b",
    openHandsModel: "openai/qwen3-coder:30b",
    contextTarget: OPENHANDS_CONTEXT_TARGET,
    minimumContext: OPENHANDS_MINIMUM_CONTEXT,
    memoryGuidance: "Long-context coding fallback for repo-scale tasks.",
    pullCommand: "ollama pull qwen3-coder:30b",
    note: "Use when larger local coding context is available.",
  },
  {
    rank: 5,
    servedModel: "openhands-lm:32b",
    openHandsModel: "openai/openhands-lm:32b",
    contextTarget: OPENHANDS_CONTEXT_TARGET,
    minimumContext: OPENHANDS_MINIMUM_CONTEXT,
    memoryGuidance: "OpenHands-specialized fallback.",
    pullCommand: "ollama pull openhands-lm:32b",
    note: "Accepted only after local quantization passes smoke.",
  },
  {
    rank: 6,
    servedModel: "qwen3:14b",
    openHandsModel: "openai/qwen3:14b",
    contextTarget: OPENHANDS_CONTEXT_TARGET,
    minimumContext: OPENHANDS_MINIMUM_CONTEXT,
    memoryGuidance: "Smaller laptop fallback.",
    pullCommand: "ollama pull qwen3:14b",
    note: "Last ranked default before local execution is blocked.",
  },
];

export function ollamaModelMatches(
  configuredModel: string,
  availableModel: string,
): boolean {
  return ollamaModelsMatch(configuredModel, availableModel);
}

export function resolveDefaultLocalChatModel(
  env: Record<string, string | undefined> | NodeJS.ProcessEnv = process.env,
): string {
  return env.SCIENCESWARM_DEFAULT_OLLAMA_MODEL?.trim() || DEFAULT_LOCAL_CHAT_MODEL;
}

export function resolveConfiguredLocalModel(
  env: Record<string, string | undefined> | NodeJS.ProcessEnv = process.env,
): string {
  return env.OLLAMA_MODEL?.trim() || resolveDefaultLocalChatModel(env);
}

export function toOpenHandsModelId(servedModel: string): string {
  const trimmed = servedModel.trim();
  if (trimmed.startsWith("openai/")) return trimmed;
  const normalized = normalizeOllamaModelName(servedModel);
  return `openai/${normalized}`;
}

export function getRankedLocalExecutionModels(): LocalExecutionModelProfile[] {
  return [...OPENHANDS_LOCAL_MODEL_CATALOG];
}

export function getLocalExecutionModelProfile(
  servedModel: string,
): LocalExecutionModelProfile | null {
  return (
    OPENHANDS_LOCAL_MODEL_CATALOG.find((entry) =>
      ollamaModelMatches(entry.servedModel, servedModel)
      || ollamaModelMatches(servedModel, entry.servedModel),
    ) ?? null
  );
}

export function resolveOpenHandsLocalModel(
  env: Record<string, string | undefined> | NodeJS.ProcessEnv = process.env,
): string {
  const configured = resolveConfiguredLocalModel(env);
  return getLocalExecutionModelProfile(configured)?.openHandsModel
    ?? toOpenHandsModelId(configured);
}

export interface OpenHandsLocalRuntimeConfig {
  model: string;
  baseUrl: string;
  apiKey: string;
  contextLength: number;
  minimumContext: number;
}

export function resolveOpenHandsConversationModel(
  env: Record<string, string | undefined> | NodeJS.ProcessEnv = process.env,
): string {
  if (env.LLM_PROVIDER?.trim().toLowerCase() === "local") {
    return resolveOpenHandsLocalModel(env);
  }
  const explicitModel = env.LLM_MODEL?.trim();
  if (explicitModel) return explicitModel;
  return DEFAULT_OPENAI_MODEL;
}

export function resolveOpenHandsLocalRuntimeConfig(
  env: Record<string, string | undefined> | NodeJS.ProcessEnv = process.env,
): OpenHandsLocalRuntimeConfig {
  const parsedContextLength = Number.parseInt(
    env.OLLAMA_CONTEXT_LENGTH?.trim() || `${OPENHANDS_CONTEXT_TARGET}`,
    10,
  );
  return {
    model: resolveOpenHandsLocalModel(env),
    baseUrl: OPENHANDS_LOCAL_OLLAMA_BASE_URL,
    apiKey: OPENHANDS_LOCAL_SENTINEL_API_KEY,
    contextLength: Number.isFinite(parsedContextLength)
      ? parsedContextLength
      : OPENHANDS_CONTEXT_TARGET,
    minimumContext: OPENHANDS_MINIMUM_CONTEXT,
  };
}

export function isOpenHandsContextLengthReady(contextLength: number): boolean {
  return Number.isFinite(contextLength)
    && contextLength >= OPENHANDS_MINIMUM_CONTEXT;
}
