import type { ProjectWatchConfig, ProjectWatchSource, WatchSourceType } from "@/lib/watch/types";
import { buildWatchCompiledPrompt } from "@/lib/watch/briefing";

const COMMON_WORDS = new Set([
  "a",
  "an",
  "and",
  "any",
  "around",
  "at",
  "brief",
  "current",
  "daily",
  "feed",
  "feeds",
  "for",
  "from",
  "important",
  "in",
  "latest",
  "lab",
  "labs",
  "major",
  "monitor",
  "new",
  "news",
  "of",
  "on",
  "papers",
  "posts",
  "project",
  "related",
  "research",
  "scan",
  "surface",
  "task",
  "the",
  "to",
  "top",
  "track",
  "update",
  "updates",
  "watch",
  "weekly",
]);

function normalizeKeyword(keyword: string): string {
  return keyword.trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizePhrase(phrase: string): string {
  return normalizeKeyword(
    phrase
      .replace(/\bgoogle\s+deepmind\b/gi, "deepmind")
      .replace(/\bgoogle's\s+deepmind\b/gi, "deepmind")
      .replace(/\bopen\s*ai\b/gi, "openai")
      .replace(/https?:\/\/\S+/gi, " ")
      .replace(/^(track|watch|monitor|follow|scan|surface|find)\s+/i, "")
      .replace(/\b(arxiv|rss|feed|feeds|blog|blogs|journal|journals|news|updates|papers|paper|research)\b/gi, " ")
      .replace(/[^a-z0-9\s-]/gi, " ")
      .replace(/\s+/g, " "),
  );
}

export function createWatchSource(type: WatchSourceType): ProjectWatchSource {
  return {
    id: `${type}-${Math.random().toString(36).slice(2, 8)}`,
    type,
    enabled: true,
    label: "",
    limit: 10,
    url: type === "rss" ? "" : undefined,
    query: type === "arxiv" || type === "web_search" ? "" : undefined,
  };
}

export function mergeKeywords(existing: string[], additions: string[]): string[] {
  return Array.from(
    new Set(
      [...existing, ...additions]
        .map(normalizeKeyword)
        .filter(Boolean),
    ),
  );
}

export function extractUrls(input: string): string[] {
  return Array.from(
    new Set(
      (input.match(/https?:\/\/[^\s,]+/gi) ?? [])
        .map((url) => url.replace(/[)\].,;:!?]+$/g, ""))
        .filter(Boolean),
    ),
  );
}

export function extractKeywordsFromObjective(objective: string): string[] {
  const normalizedObjective = objective.trim();
  if (!normalizedObjective) return [];

  const segments = normalizedObjective
    .split(/[\n,;]+|\band\b/gi)
    .map((segment) =>
      normalizePhrase(segment)
        .split(" ")
        .filter((token) => token.length > 2 && !COMMON_WORDS.has(token))
        .join(" "),
    )
    .filter(Boolean);

  const multiWordSegments = segments
    .filter((segment) => segment.split(" ").length <= 4)
    .filter((segment) => !COMMON_WORDS.has(segment))
    .slice(0, 6);

  if (multiWordSegments.length > 0) {
    return Array.from(new Set(multiWordSegments));
  }

  const tokens = normalizePhrase(normalizedObjective)
    .split(" ")
    .filter((token) => token.length > 2 && !COMMON_WORDS.has(token));

  return Array.from(new Set(tokens.slice(0, 6)));
}

export function buildArxivQuery(keywords: string[]): string {
  const filtered = keywords
    .map(normalizeKeyword)
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)
    .slice(0, 3);

  if (filtered.length === 0) {
    return "";
  }

  return filtered
    .map((keyword) => (keyword.includes(" ") ? `all:"${keyword}"` : `all:${keyword}`))
    .join(" AND ");
}

export function summarizeWatchConfig(
  config: ProjectWatchConfig,
  projectLabel?: string,
): string {
  const label = projectLabel || "this study";
  const sourceCount = config.sources.filter((source) => source.enabled !== false).length;
  const keywordPreview = config.keywords.slice(0, 3).join(", ");

  if (sourceCount === 0 && config.keywords.length === 0) {
    return `Watch ${label} for the next papers, feeds, and external signals that change what matters.`;
  }

  if (keywordPreview) {
    return `Watch ${label} for ${keywordPreview}${config.keywords.length > 3 ? ", and related signals" : ""}.`;
  }

  return `Watch ${label} across ${sourceCount} configured source${sourceCount === 1 ? "" : "s"}.`;
}

export function buildCompiledPrompt(input: {
  objective: string;
  keywords: string[];
  searchQueries: string[];
  projectLabel?: string;
}): string {
  return buildWatchCompiledPrompt(input);
}

function buildRssLabel(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return host || "External feed";
  } catch {
    return "External feed";
  }
}

function upsertSource(
  sources: ProjectWatchSource[],
  nextSource: ProjectWatchSource,
  matcher: (source: ProjectWatchSource) => boolean,
  updateSource: (source: ProjectWatchSource) => ProjectWatchSource,
): ProjectWatchSource[] {
  let matched = false;
  const updatedSources = sources.map((source) => {
    if (matched || !matcher(source)) {
      return source;
    }
    matched = true;
    return updateSource(source);
  });

  if (matched) {
    return updatedSources;
  }
  return [...sources, nextSource];
}

export function applyObjectiveToWatchConfig(
  config: ProjectWatchConfig,
  objective: string,
  projectLabel?: string,
): ProjectWatchConfig {
  const objectiveKeywords = extractKeywordsFromObjective(objective);
  const projectKeywords = projectLabel ? extractKeywordsFromObjective(projectLabel) : [];
  const keywords = mergeKeywords(config.keywords, objectiveKeywords.length > 0 ? objectiveKeywords : projectKeywords);
  const searchQueries = [
    `${keywords.slice(0, 5).join(" ")} news today`,
    `${keywords.slice(0, 4).join(" ")} research breakthrough today`,
    `${keywords.slice(0, 4).join(" ")} release announcement funding`,
  ].map((query) => query.trim()).filter(Boolean);
  const compiledPrompt = buildCompiledPrompt({
    objective,
    keywords,
    searchQueries,
    projectLabel,
  });

  let sources = [...config.sources];
  const urls = extractUrls(objective);

  sources = upsertSource(
    sources,
    {
      ...createWatchSource("web_search"),
      label: "Current web search",
      query: compiledPrompt,
      limit: 8,
    },
    (source) => source.type === "web_search",
    (source) => ({
      ...source,
      label: source.label || "Current web search",
      query: compiledPrompt,
      limit: source.limit ?? 8,
    }),
  );

  for (const url of urls) {
    sources = upsertSource(
      sources,
      {
        ...createWatchSource("rss"),
        label: buildRssLabel(url),
        url,
      },
      (source) => source.type === "rss" && normalizeKeyword(source.url ?? "") === normalizeKeyword(url),
      (source) => ({
        ...source,
        label: source.label || buildRssLabel(url),
        url,
      }),
    );
  }

  const arxivQuery = buildArxivQuery(keywords.length > 0 ? keywords : projectKeywords);
  if (arxivQuery) {
    sources = upsertSource(
      sources,
      {
        ...createWatchSource("arxiv"),
        label: "Research papers",
        query: arxivQuery,
      },
      (source) => source.type === "arxiv",
      (source) => ({
        ...source,
        label: source.label || "Research papers",
        query: arxivQuery,
      }),
    );
  }

  return {
    ...config,
    objective: objective.trim(),
    compiledPrompt,
    searchQueries,
    keywords,
    sources,
  };
}
