import { formatOpenClawContextOverflowMessage } from "@/lib/openclaw/error-messages";

export function sanitizeOpenClawUserVisibleResponse(
  response: string,
  options?: { trimEnd?: boolean },
): string {
  const normalized = response.replace(/\r\n/g, "\n");
  if (
    /^Context overflow:/im.test(normalized) ||
    /\bprompt too large for the model\b/i.test(normalized)
  ) {
    return formatOpenClawContextOverflowMessage();
  }

  const sanitized = normalized
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return true;
      }
      if (
        /^\[(?:(?:agent|agents)\/[^\]]+|auth(?:-profiles)?|gateway|session|model|subagent|tool(?:s)?)[^\]]*\].*$/i.test(
          trimmed,
        )
      ) {
        return false;
      }
      if (/\bsynced\b.*\bcredentials\b.*\bexternal cli\b/i.test(trimmed)) {
        return false;
      }
      return true;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\s*\n+/, "");

  return options?.trimEnd === false ? sanitized : sanitized.trimEnd();
}
