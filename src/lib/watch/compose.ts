import { getOpenAIClient, getOpenAIModel, hasOpenAIKey } from "@/lib/openai-client";
import { evaluateStrictLocalDestination } from "@/lib/runtime/strict-local-policy";
import {
  buildWatchCompiledPrompt,
  promptPreservesRequestedStructure,
} from "./briefing";

export interface CompiledWatchPlan {
  objective: string;
  compiledPrompt: string;
  keywords: string[];
  searchQueries: string[];
}

interface CompileWatchPlanInput {
  objective: string;
  projectTitle?: string;
  timezone?: string;
  now?: Date;
}

function uniq(values: string[]): string[] {
  return Array.from(
    new Set(
      values
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean),
    ),
  );
}

const FALLBACK_STOP_WORDS = new Set([
  "about",
  "across",
  "after",
  "against",
  "around",
  "brief",
  "current",
  "daily",
  "deliver",
  "find",
  "follow",
  "for",
  "from",
  "important",
  "latest",
  "look",
  "major",
  "monitor",
  "news",
  "papers",
  "project",
  "report",
  "scan",
  "search",
  "surface",
  "this",
  "today",
  "top",
  "track",
  "updates",
  "watch",
  "weekly",
  "with",
]);

const FALLBACK_QUERY_STOP_WORDS = new Set([
  "for",
  "major",
  "track",
  "watch",
  "monitor",
  "follow",
  "surface",
]);

const KNOWN_ENTITY_KEYWORDS = new Set([
  "anthropic",
  "deepmind",
  "google",
  "meta",
  "microsoft",
  "openai",
  "xai",
]);

const HIGH_SIGNAL_PHRASE_ENDINGS = new Set([
  "agents",
  "announcement",
  "announcements",
  "benchmark",
  "benchmarks",
  "breakthrough",
  "breakthroughs",
  "dataset",
  "datasets",
  "model",
  "models",
  "paper",
  "papers",
  "release",
  "releases",
  "results",
]);

function normalizeAliases(input: string): string {
  return input
    .replace(/\bgoogle\s+deepmind\b/gi, "deepmind")
    .replace(/\bgoogle's\s+deepmind\b/gi, "deepmind")
    .replace(/\bopen\s*ai\b/gi, "openai")
    .replace(/\bx\s+ai\b/gi, "xai");
}

function normalizeKeywordPhrase(phrase: string): string {
  const normalized = normalizeAliases(phrase)
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/^(watch|track|monitor|follow|scan|surface|find|search|look)\s+(for\s+)?/i, "")
    .replace(/[^a-z0-9\s-]/gi, " ")
    .toLowerCase();

  return normalized
    .split(/\s+/)
    .filter((token) => token.length > 2 && !FALLBACK_STOP_WORDS.has(token))
    .join(" ");
}

function extractQuotedKeywords(input: string): string[] {
  const matches = Array.from(input.matchAll(/"([^"]+)"/g), (match) => normalizeKeywordPhrase(match[1]));
  return uniq(matches);
}

function extractCapitalizedKeywords(input: string): string[] {
  const matches = Array.from(
    input.matchAll(/\b([A-Z][\w-]*(?:\s+[A-Z][\w-]*)*)\b/g),
    (match) => normalizeKeywordPhrase(match[1]),
  );
  return uniq(matches);
}

function extractSegmentKeywords(input: string): string[] {
  const normalizedInput = normalizeAliases(input);
  const segments = normalizedInput.split(/[\n,;]+|\b(?:and|or)\b/gi);
  const keywords: string[] = [];

  for (const segment of segments) {
    const normalized = normalizeKeywordPhrase(segment);
    if (!normalized) continue;

    const tokens = normalized.split(" ");
    if (tokens.length <= 4) {
      keywords.push(normalized);
      continue;
    }

    if (tokens.includes("model") && tokens.some((token) => token.startsWith("release"))) {
      keywords.push("model releases");
    }
    if (tokens.includes("frontier") && tokens.includes("lab") && tokens.some((token) => token.startsWith("announcement"))) {
      keywords.push("frontier lab announcements");
    }
    if (tokens.includes("research") && tokens.some((token) => token.startsWith("breakthrough"))) {
      keywords.push("research breakthroughs");
    }

    for (let index = 0; index < tokens.length - 1; index += 1) {
      if (!HIGH_SIGNAL_PHRASE_ENDINGS.has(tokens[index + 1])) continue;
      keywords.push(tokens.slice(index, index + 2).join(" "));
    }
  }

  return uniq(keywords);
}

function extractFallbackKeywords(objective: string, projectTitle?: string): string[] {
  const sources = [objective, projectTitle ?? ""].filter(Boolean);
  const keywords = uniq(
    sources.flatMap((source) => [
      ...extractQuotedKeywords(source),
      ...extractCapitalizedKeywords(source),
      ...extractSegmentKeywords(source),
    ]),
  )
    .filter((keyword) => keyword.length <= 48)
    .filter((keyword) => !FALLBACK_STOP_WORDS.has(keyword))
    .slice(0, 10);

  return keywords;
}

function isEntityKeyword(keyword: string): boolean {
  return keyword.split(" ").length === 1 || KNOWN_ENTITY_KEYWORDS.has(keyword);
}

function sanitizeSearchQuery(query: string): string {
  const tokens = normalizeAliases(query)
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/[^a-z0-9\s]/gi, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length > 1 && !FALLBACK_QUERY_STOP_WORDS.has(token));

  return Array.from(new Set(tokens)).join(" ").trim();
}

function formatQueryDate(now: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(now);
}

function buildFallbackQueries(keywords: string[], now: Date): string[] {
  const entities = keywords.filter(isEntityKeyword).slice(0, 3);
  const topics = keywords.filter((keyword) => !entities.includes(keyword)).slice(0, 3);
  const dateLabel = formatQueryDate(now);
  const primaryTerms = [...entities, ...topics].slice(0, 5);

  const queries = [
    [...primaryTerms, dateLabel].join(" "),
    [...entities.slice(0, 2), "model release benchmark", ...topics.slice(0, 2), dateLabel].join(" "),
    ["frontier ai", ...topics.slice(0, 2), ...entities.slice(0, 2), "news", dateLabel].join(" "),
  ]
    .map(sanitizeSearchQuery)
    .filter(Boolean);

  return uniq(queries.length > 0 ? queries : [`research ${dateLabel}`]);
}

export function buildFallbackWatchPlan(input: CompileWatchPlanInput): CompiledWatchPlan {
  const now = input.now ?? new Date();
  const objective = input.objective.trim();
  const keywords = extractFallbackKeywords(objective, input.projectTitle?.trim());
  const searchQueries = buildFallbackQueries(keywords, now);

  return {
    objective,
    keywords,
    searchQueries,
    compiledPrompt: buildWatchCompiledPrompt({
      objective,
      keywords,
      searchQueries,
      projectLabel: input.projectTitle?.trim() || "this study",
    }),
  };
}

function parseCompiledPlan(
  raw: string,
  fallback: CompiledWatchPlan,
  input: CompileWatchPlanInput,
): CompiledWatchPlan {
  try {
    const parsed = JSON.parse(raw) as Partial<CompiledWatchPlan>;
    const normalizedKeywords = Array.isArray(parsed.keywords)
      ? uniq(
          parsed.keywords
            .filter((value): value is string => typeof value === "string")
            .map(normalizeKeywordPhrase),
        ).slice(0, 12)
      : fallback.keywords;
    const normalizedQueries = Array.isArray(parsed.searchQueries)
      ? uniq(
          parsed.searchQueries
            .filter((value): value is string => typeof value === "string")
            .map(sanitizeSearchQuery),
        ).slice(0, 10)
      : fallback.searchQueries;
    const objective = typeof parsed.objective === "string" && parsed.objective.trim()
      ? parsed.objective.trim()
      : fallback.objective;
    const compiledPrompt = typeof parsed.compiledPrompt === "string" && parsed.compiledPrompt.trim()
      ? parsed.compiledPrompt.trim()
      : fallback.compiledPrompt;
    const normalizedPlan: CompiledWatchPlan = {
      objective,
      compiledPrompt,
      keywords: normalizedKeywords.length > 0 ? normalizedKeywords : fallback.keywords,
      searchQueries: normalizedQueries.length > 0 ? normalizedQueries : fallback.searchQueries,
    };

    if (promptPreservesRequestedStructure(normalizedPlan.compiledPrompt, input.objective, normalizedPlan.objective)) {
      return normalizedPlan;
    }

    return {
      ...normalizedPlan,
      compiledPrompt: buildWatchCompiledPrompt({
        objective: normalizedPlan.objective,
        keywords: normalizedPlan.keywords,
        searchQueries: normalizedPlan.searchQueries,
        projectLabel: input.projectTitle?.trim() || "this study",
      }),
    };
  } catch {
    return fallback;
  }
}

export async function compileWatchPlan(input: CompileWatchPlanInput): Promise<CompiledWatchPlan> {
  const fallback = buildFallbackWatchPlan(input);
  const decision = evaluateStrictLocalDestination({
    destination: "openai",
    dataClass: "query-expansion",
    feature: "frontier watch prompt compilation",
    privacy: "hosted",
  });
  if (!decision.allowed) {
    return fallback;
  }

  if (!hasOpenAIKey()) {
    return fallback;
  }

  try {
    const openai = getOpenAIClient();
    const response = await openai.responses.create({
      model: getOpenAIModel(),
      input: [
        "Turn this user's natural-language news/research watch request into a specific recurring web-search briefing prompt.",
        "The output should look like a high-quality Manus-style task prompt: specific categories, concrete query ideas, source-link requirements, and a clear final Markdown deliverable.",
        "Preserve any user-requested output structure or section headings exactly. Only use 'Top Stories' when the user explicitly asks for that format.",
        `Study: ${input.projectTitle || "unspecified"}`,
        `Date: ${(input.now ?? new Date()).toISOString().slice(0, 10)}`,
        `Timezone: ${input.timezone || "local"}`,
        `User request: ${input.objective}`,
      ].join("\n\n"),
      max_output_tokens: 1800,
      text: {
        format: {
          type: "json_schema",
          name: "compiled_watch_plan",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["objective", "compiledPrompt", "keywords", "searchQueries"],
            properties: {
              objective: { type: "string" },
              compiledPrompt: { type: "string" },
              keywords: {
                type: "array",
                items: { type: "string" },
              },
              searchQueries: {
                type: "array",
                items: { type: "string" },
              },
            },
          },
        },
      },
    });

    return parseCompiledPlan(response.output_text, fallback, input);
  } catch {
    return fallback;
  }
}
