import type {
  ResearchLandscapeRetainedCandidate,
  ResearchLandscapeTitleResolution,
} from "./contract";

import { normalizeTitle } from "@/lib/paper-dedupe";

export function normalizeResearchLandscapeTitle(value: string): string {
  return normalizeTitle(value);
}

export function resolveExactTitleMatches(
  retained: ResearchLandscapeRetainedCandidate[],
  target: string | undefined,
): ResearchLandscapeTitleResolution | undefined {
  const trimmed = target?.trim();
  if (!trimmed) return undefined;

  const normalizedTarget = normalizeResearchLandscapeTitle(trimmed);
  const matches = retained.filter((candidate) => candidate.normalizedTitle === normalizedTarget);
  const status = matches.length === 0
    ? "unresolved"
    : matches.length === 1
      ? "resolved"
      : "ambiguous";

  return {
    target: trimmed,
    status,
    matchedCount: matches.length,
    matches: matches.map((candidate) => ({
      title: candidate.entity.payload.title,
      sources: candidate.sources,
    })),
  };
}
