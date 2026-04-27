export function inferProgressEntryLabel(rawText: string): string | undefined {
  const normalized = rawText.trim();
  if (!normalized) {
    return undefined;
  }

  const directMatch = normalized.match(/^(Read|Search|Write|Edit|Run|List|Plan)\b/i);
  if (directMatch?.[1]) {
    return directMatch[1][0].toUpperCase() + directMatch[1].slice(1).toLowerCase();
  }
  if (/^Sending request to OpenClaw$/i.test(normalized)) {
    return "Send";
  }
  if (/^Waiting for OpenClaw to respond$/i.test(normalized)) {
    return "Wait";
  }
  if (/^Generate image\b/i.test(normalized)) {
    return "Generate image";
  }
  if (/^Chat failed\b/i.test(normalized)) {
    return "Failed";
  }
  if (/^Chat aborted\b/i.test(normalized)) {
    return "Aborted";
  }
  return undefined;
}
