/**
 * Local LLM client — talks to Ollama for Gemma 4 and other local models.
 *
 * Ollama API: https://github.com/ollama/ollama/blob/main/docs/api.md
 * No API key required. Runs on the researcher's own machine.
 */

import { getOllamaUrl as getOllamaUrlFromConfig } from "@/lib/config/ports";
import { resolveConfiguredLocalModel } from "@/lib/runtime/model-catalog";
import { getCurrentLlmRuntimeEnv } from "@/lib/runtime-saved-env";

export interface LocalModelConfig {
  model: string; // "gemma4", "gemma4:27b", "llama3", etc.
  url: string;
}

interface OllamaModel {
  name: string;
  modified_at: string;
  size: number;
}

interface OllamaChatResponse {
  message?: { role: string; content?: string; thinking?: string };
  done: boolean;
}

export interface LocalStreamChunk {
  text?: string;
  thinking?: string;
}

function getOllamaUrl(): string {
  return getOllamaUrlFromConfig();
}

export function getLocalModel(
  env?: Record<string, string | undefined> | NodeJS.ProcessEnv,
): string {
  if (env) {
    return resolveConfiguredLocalModel(env);
  }

  const runtime = getCurrentLlmRuntimeEnv(process.env);
  return runtime.ollamaModel ?? resolveConfiguredLocalModel(process.env);
}

/** Check if Ollama is running and which models are available. */
export async function healthCheck(): Promise<{
  running: boolean;
  models: string[];
  url: string;
}> {
  const url = getOllamaUrl();
  try {
    const res = await fetch(`${url}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) {
      return { running: false, models: [], url };
    }
    const data = (await res.json()) as { models?: OllamaModel[] };
    const models = (data.models ?? []).map((m) => m.name);
    return { running: true, models, url };
  } catch {
    return { running: false, models: [], url };
  }
}

/** List available models from Ollama. */
export async function listModels(): Promise<string[]> {
  const status = await healthCheck();
  return status.models;
}

/** Generate a chat completion (non-streaming). */
export async function completeLocal(
  messages: Array<{ role: string; content: string }>,
  model?: string,
): Promise<string> {
  const url = getOllamaUrl();
  const modelName = model || getLocalModel();

  const res = await fetch(`${url}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: modelName,
      messages,
      stream: false,
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Ollama chat failed (${res.status}): ${text || res.statusText}`,
    );
  }

  const data = (await res.json()) as OllamaChatResponse;
  return data.message?.content ?? "";
}

/** Generate a streaming chat completion. Yields text chunks. */
export async function* streamLocal(
  messages: Array<{ role: string; content: string }>,
  model?: string,
): AsyncGenerator<LocalStreamChunk> {
  const url = getOllamaUrl();
  const modelName = model || getLocalModel();

  const res = await fetch(`${url}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: modelName,
      messages,
      stream: true,
    }),
    signal: AbortSignal.timeout(300_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Ollama stream failed (${res.status}): ${text || res.statusText}`,
    );
  }

  if (!res.body) {
    throw new Error("Ollama returned no response body");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Ollama streams newline-delimited JSON
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const chunk = JSON.parse(trimmed) as OllamaChatResponse;
          const text = chunk.message?.content;
          const thinking = chunk.message?.thinking;
          if (thinking) {
            yield { thinking };
          }
          if (text) {
            yield { text };
          }
        } catch {
          // skip malformed lines
        }
      }
    }

    // Process any remaining buffer
    if (buffer.trim()) {
      try {
        const chunk = JSON.parse(buffer.trim()) as OllamaChatResponse;
        const text = chunk.message?.content;
        const thinking = chunk.message?.thinking;
        if (thinking) {
          yield { thinking };
        }
        if (text) {
          yield { text };
        }
      } catch {
        // skip
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Pull (download) a model into Ollama. */
export async function pullModel(model: string): Promise<void> {
  const url = getOllamaUrl();

  const res = await fetch(`${url}/api/pull`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: model, stream: false }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Ollama pull failed (${res.status}): ${text || res.statusText}`,
    );
  }

  // Consume the response body so the connection is properly closed
  await res.json().catch(() => res.text());
}

/** Check if a specific model is available locally. */
export async function hasModel(model: string): Promise<boolean> {
  const models = await listModels();
  return models.some(
    (m) => m === model || m.startsWith(`${model}:`),
  );
}

/** Check if LLM_PROVIDER is set to "local". */
export function isLocalProviderConfigured(
  env?: Record<string, string | undefined> | NodeJS.ProcessEnv,
): boolean {
  if (env) {
    return env.LLM_PROVIDER?.trim().toLowerCase() === "local";
  }

  return getCurrentLlmRuntimeEnv(process.env).llmProvider === "local";
}
