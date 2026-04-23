function collectBalancedJsonObjects(content: string): string[] {
  const objects: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
      continue;
    }

    if (character === "{") {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }

    if (character === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        objects.push(content.slice(start, index + 1).trim());
        start = -1;
      }
    }
  }

  return objects;
}

function jsonCandidatesFromModelResponse(content: string): string[] {
  const candidates: string[] = [];
  const fencedPattern = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = fencedPattern.exec(content)) !== null) {
    if (match[1]?.trim()) {
      candidates.push(match[1].trim());
    }
  }

  const trimmed = content.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    candidates.push(trimmed);
  }

  candidates.push(...collectBalancedJsonObjects(content));
  return Array.from(new Set(candidates));
}

export function parseEvidenceMapModelJson(content: string): {
  parsed: unknown | null;
  candidateFound: boolean;
} {
  const candidates = jsonCandidatesFromModelResponse(content);
  for (const candidate of candidates) {
    try {
      return { parsed: JSON.parse(candidate), candidateFound: true };
    } catch {
      // Keep looking; local models can wrap valid JSON after a malformed echo.
    }
  }

  return { parsed: null, candidateFound: candidates.length > 0 };
}
