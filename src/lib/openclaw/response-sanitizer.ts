export function sanitizeOpenClawUserVisibleResponse(response: string): string {
  return response
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return true;
      }
      if (
        /^\[(?:agents\/[^\]]+|auth(?:-profiles)?|gateway|session|model|subagent|tool(?:s)?)[^\]]*\].*$/i.test(
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
}
