import { readFileSync } from "node:fs";
import path from "node:path";

import { parseEnvFile } from "@/lib/setup/env-writer";

const MUTABLE_RUNTIME_KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_AI_API_KEY",
  "GOOGLE_API_KEY",
  "VERTEX_AI_API_KEY",
  "VERTEX_AI_PROJECT",
  "VERTEX_AI_LOCATION",
  "SCIENCESWARM_STRICT_LOCAL_ONLY",
  "LLM_PROVIDER",
  "LLM_MODEL",
  "OLLAMA_MODEL",
  "AGENT_BACKEND",
  "AGENT_URL",
  "AGENT_API_KEY",
  "OPENCLAW_INTERNAL_API_KEY",
] as const;

type MutableRuntimeKey = (typeof MUTABLE_RUNTIME_KEYS)[number];

const MUTABLE_RUNTIME_KEY_SET = new Set<string>(MUTABLE_RUNTIME_KEYS);

type MutableRuntimeValues = Partial<Record<MutableRuntimeKey, string>>;

export interface SavedLlmRuntimeEnv {
  strictLocalOnly: boolean;
  llmProvider: "local" | "openai";
  llmModel: string | null;
  ollamaModel: string | null;
  anthropicApiKey: string | null;
  openaiApiKey: string | null;
  googleAiApiKey: string | null;
  googleApiKey: string | null;
  vertexAiApiKey: string | null;
  vertexAiProject: string | null;
  vertexAiLocation: string | null;
  agentBackend: string | null;
  agentUrl: string | null;
  agentApiKey: string | null;
  openclawInternalApiKey: string | null;
}

function parseMutableRuntimeValues(envFileContents: string | null): MutableRuntimeValues {
  if (!envFileContents) return {};

  const doc = parseEnvFile(envFileContents);
  const values: MutableRuntimeValues = {};
  for (const line of doc.lines) {
    if (line.type !== "entry" || !MUTABLE_RUNTIME_KEY_SET.has(line.key)) {
      continue;
    }
    values[line.key as MutableRuntimeKey] = line.value;
  }
  return values;
}

function coalesceTrimmed(
  primary: string | undefined,
  fallback: string | undefined,
): string | null {
  const first = primary?.trim();
  if (first) return first;
  const second = fallback?.trim();
  return second || null;
}

function isTruthyRuntimeFlag(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function resolveSavedLlmRuntimeEnv(
  processEnv: NodeJS.ProcessEnv = process.env,
  envFileContents: string | null = null,
): SavedLlmRuntimeEnv {
  const savedValues = parseMutableRuntimeValues(envFileContents);
  const strictLocalOnly =
    isTruthyRuntimeFlag(processEnv.SCIENCESWARM_STRICT_LOCAL_ONLY)
    || isTruthyRuntimeFlag(savedValues.SCIENCESWARM_STRICT_LOCAL_ONLY);
  const configuredProvider =
    coalesceTrimmed(savedValues.LLM_PROVIDER, processEnv.LLM_PROVIDER) || "openai";

  return {
    strictLocalOnly,
    llmProvider: strictLocalOnly || configuredProvider === "local" ? "local" : "openai",
    llmModel: coalesceTrimmed(savedValues.LLM_MODEL, processEnv.LLM_MODEL),
    ollamaModel: coalesceTrimmed(savedValues.OLLAMA_MODEL, processEnv.OLLAMA_MODEL),
    anthropicApiKey: coalesceTrimmed(
      savedValues.ANTHROPIC_API_KEY,
      processEnv.ANTHROPIC_API_KEY,
    ),
    openaiApiKey: coalesceTrimmed(savedValues.OPENAI_API_KEY, processEnv.OPENAI_API_KEY),
    googleAiApiKey: coalesceTrimmed(
      savedValues.GOOGLE_AI_API_KEY,
      processEnv.GOOGLE_AI_API_KEY,
    ),
    googleApiKey: coalesceTrimmed(savedValues.GOOGLE_API_KEY, processEnv.GOOGLE_API_KEY),
    vertexAiApiKey: coalesceTrimmed(
      savedValues.VERTEX_AI_API_KEY,
      processEnv.VERTEX_AI_API_KEY,
    ),
    vertexAiProject: coalesceTrimmed(
      savedValues.VERTEX_AI_PROJECT,
      processEnv.VERTEX_AI_PROJECT,
    ),
    vertexAiLocation: coalesceTrimmed(
      savedValues.VERTEX_AI_LOCATION,
      processEnv.VERTEX_AI_LOCATION,
    ),
    agentBackend: coalesceTrimmed(savedValues.AGENT_BACKEND, processEnv.AGENT_BACKEND),
    agentUrl: coalesceTrimmed(savedValues.AGENT_URL, processEnv.AGENT_URL),
    agentApiKey: coalesceTrimmed(savedValues.AGENT_API_KEY, processEnv.AGENT_API_KEY),
    openclawInternalApiKey: coalesceTrimmed(
      savedValues.OPENCLAW_INTERNAL_API_KEY,
      processEnv.OPENCLAW_INTERNAL_API_KEY,
    ),
  };
}

export function readSavedLlmRuntimeEnv(
  processEnv: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): SavedLlmRuntimeEnv {
  let envFileContents: string | null = null;
  try {
    envFileContents = readFileSync(path.join(cwd, ".env"), "utf8");
  } catch {
    envFileContents = null;
  }

  return resolveSavedLlmRuntimeEnv(processEnv, envFileContents);
}

export function getCurrentLlmRuntimeEnv(
  processEnv: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): SavedLlmRuntimeEnv {
  return processEnv.NODE_ENV === "test"
    ? resolveSavedLlmRuntimeEnv(processEnv, null)
    : readSavedLlmRuntimeEnv(processEnv, cwd);
}
