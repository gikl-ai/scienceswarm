import type { EnvDocument } from "@/lib/setup/env-writer";

export const TELEGRAM_BOT_ENV_KEYS = [
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_BOT_USERNAME",
  "TELEGRAM_BOT_CREATURE",
  "TELEGRAM_USER_ID",
] as const;

export function readTelegramBotEnvValues(
  doc: EnvDocument,
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const key of TELEGRAM_BOT_ENV_KEYS) {
    const line = doc.lines.find(
      (candidate) => candidate.type === "entry" && candidate.key === key,
    );
    if (line?.type === "entry" && line.value.trim()) {
      values[key] = line.value.trim();
    }
  }
  return values;
}
