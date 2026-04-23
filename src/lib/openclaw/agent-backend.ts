import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { OPENCLAW_OLLAMA_PROVIDER_KEY } from "@/lib/openclaw/ollama-provider";
import {
  mergeEnvValues,
  parseEnvFile,
  serializeEnvDocument,
  writeEnvFileAtomic,
} from "@/lib/setup/env-writer";

function isTruthyRuntimeFlag(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "on"
  );
}

export async function activateOpenClawAgentBackend(
  envPath = resolve(process.cwd(), ".env"),
): Promise<void> {
  let rawEnv = "";
  try {
    rawEnv = await readFile(envPath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
    // Missing .env is acceptable; create the first entry below.
  }

  const doc = parseEnvFile(rawEnv);
  const values: Record<string, string | undefined> = {};
  for (const line of doc.lines) {
    if (line.type === "entry") {
      values[line.key] = line.value;
    }
  }
  const updates: Record<string, string> = { AGENT_BACKEND: "openclaw" };
  if (
    values.LLM_PROVIDER?.trim().toLowerCase() === "local" ||
    isTruthyRuntimeFlag(values.SCIENCESWARM_STRICT_LOCAL_ONLY)
  ) {
    updates.OLLAMA_API_KEY =
      values.OLLAMA_API_KEY?.trim() || OPENCLAW_OLLAMA_PROVIDER_KEY;
  }

  const merged = mergeEnvValues(doc, updates);
  await writeEnvFileAtomic(envPath, serializeEnvDocument(merged));
}
