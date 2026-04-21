import type { ProjectManifest } from "@/brain/types";
import type {
  ProjectWatchConfig,
  RankedWatchItem,
  WatchCandidate,
} from "./types";

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3);
}

function uniqueTokens(values: string[]): string[] {
  return Array.from(new Set(values.flatMap(tokenize)));
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function isRecent(publishedAt?: string): boolean {
  if (!publishedAt) return false;
  const published = new Date(publishedAt).getTime();
  if (Number.isNaN(published)) return false;
  return Date.now() - published <= 14 * 24 * 60 * 60 * 1000;
}

export function rankWatchItems(input: {
  manifest: ProjectManifest;
  watchConfig: ProjectWatchConfig;
  items: WatchCandidate[];
}): RankedWatchItem[] {
  const projectTokens = uniqueTokens([
    input.manifest.slug,
    input.manifest.title,
    ...input.watchConfig.keywords,
    ...input.manifest.sourceRefs
      .map((sourceRef) => sourceRef.ref)
      .filter((ref) => !isHttpUrl(ref)),
  ]);

  return input.items
    .map((item) => {
      const haystack = `${item.title}\n${item.summary}`.toLowerCase();
      const matches = projectTokens.filter((token) => haystack.includes(token));
      const reasons = matches.slice(0, 4).map((token) => `matched ${token}`);
      let score = matches.length * 2;

      if (item.title.toLowerCase().includes(input.manifest.slug)) {
        score += 2;
        reasons.push(`matched project slug ${input.manifest.slug}`);
      }

      if (isRecent(item.publishedAt)) {
        score += 1;
        reasons.push("published recently");
      }

      if (input.watchConfig.compiledPrompt && item.sourceLabel.toLowerCase().includes("web search")) {
        score += input.watchConfig.promotionThreshold;
        reasons.push("selected by compiled web-search brief");
      }

      if (score < input.watchConfig.stagingThreshold) {
        return null;
      }

      return {
        ...item,
        score,
        reasons,
        status: score >= input.watchConfig.promotionThreshold ? "promoted" : "staged",
      } satisfies RankedWatchItem;
    })
    .filter((item): item is RankedWatchItem => item !== null)
    .sort((left, right) => right.score - left.score);
}
