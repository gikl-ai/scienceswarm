import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  mergeEnvValues,
  parseEnvFile,
  serializeEnvDocument,
  writeEnvFileAtomic,
} from "@/lib/setup/env-writer";

export async function activateOpenClawAgentBackend(
  envPath = resolve(process.cwd(), ".env"),
): Promise<void> {
  let rawEnv = "";
  try {
    rawEnv = await readFile(envPath, "utf-8");
  } catch {
    // Missing .env is acceptable; create the first entry below.
  }

  const doc = parseEnvFile(rawEnv);
  const merged = mergeEnvValues(doc, { AGENT_BACKEND: "openclaw" });
  await writeEnvFileAtomic(envPath, serializeEnvDocument(merged));
}
