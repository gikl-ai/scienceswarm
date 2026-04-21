import OpenAI from "openai";
import { resolveOpenAIModel } from "@/lib/openai-models";
import { getCurrentLlmRuntimeEnv } from "@/lib/runtime-saved-env";

let openaiClientCache: { apiKey: string; client: OpenAI } | null = null;

export function hasOpenAIKey(): boolean {
  return Boolean(getCurrentLlmRuntimeEnv(process.env).openaiApiKey);
}

export function getOpenAIClient(): OpenAI {
  const apiKey = getCurrentLlmRuntimeEnv(process.env).openaiApiKey;
  if (!apiKey) {
    throw new Error("Missing OPENAI_API_KEY environment variable.");
  }

  if (openaiClientCache?.apiKey === apiKey) {
    return openaiClientCache.client;
  }

  const client = new OpenAI({ apiKey });
  openaiClientCache = { apiKey, client };
  return client;
}

export function getOpenAIModel(): string {
  return resolveOpenAIModel(getCurrentLlmRuntimeEnv(process.env).llmModel);
}

export function getWebSearchModel(): string {
  return process.env.OPENAI_WEB_SEARCH_MODEL || getOpenAIModel();
}
