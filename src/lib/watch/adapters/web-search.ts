import type { ProjectManifest } from "@/brain/types";
import { getOpenAIClient, getWebSearchModel, hasOpenAIKey } from "@/lib/openai-client";
import { evaluateStrictLocalDestination } from "@/lib/runtime/strict-local-policy";
import { hashContent } from "@/lib/workspace-manager";
import type { ProjectWatchConfig, ProjectWatchSource, WatchCandidate } from "../types";

interface WebSearchItem {
  title: string;
  summary: string;
  url: string;
  publishedAt?: string;
}

interface WebSearchResult {
  items?: WebSearchItem[];
}

function parseWebSearchItems(raw: string): WebSearchItem[] {
  try {
    const parsed = JSON.parse(raw) as WebSearchResult;
    if (!Array.isArray(parsed.items)) return [];

    return parsed.items
      .filter(
        (item): item is WebSearchItem =>
          Boolean(
            item &&
              typeof item.title === "string" &&
              typeof item.summary === "string" &&
              typeof item.url === "string" &&
              item.title.trim() &&
              item.summary.trim() &&
              item.url.trim(),
          ),
      )
      .map((item) => ({
        title: item.title.trim(),
        summary: item.summary.trim(),
        url: item.url.trim(),
        publishedAt: typeof item.publishedAt === "string" && item.publishedAt.trim()
          ? item.publishedAt.trim()
          : undefined,
      }));
  } catch {
    return [];
  }
}

function buildSearchPrompt(
  manifest: ProjectManifest,
  watchConfig: ProjectWatchConfig,
  source: ProjectWatchSource,
): string {
  const prompt = source.query || watchConfig.compiledPrompt || watchConfig.objective || "";
  const queries = watchConfig.searchQueries?.length
    ? watchConfig.searchQueries.map((query) => `- ${query}`).join("\n")
    : watchConfig.keywords.map((keyword) => `- ${keyword}`).join("\n");

  return [
    prompt,
    "",
    `Project: ${manifest.title} (${manifest.slug})`,
    "Search queries to try:",
    queries || "- current project-relevant research news",
    "",
    "Return only high-signal items that should enter the user's project frontier brief. Prefer primary sources, credible reporting, and source pages with stable URLs.",
  ].join("\n");
}

export async function fetchWebSearchWatchItems(input: {
  manifest: ProjectManifest;
  watchConfig: ProjectWatchConfig;
  source: ProjectWatchSource;
}): Promise<WatchCandidate[]> {
  const decision = evaluateStrictLocalDestination({
    destination: "hosted-search",
    dataClass: "web-search-query",
    feature: "frontier watch hosted web search",
    privacy: "hosted",
  });
  if (!decision.allowed) {
    return [];
  }

  if (!hasOpenAIKey()) {
    return [];
  }

  const limit = Math.max(1, Math.min(10, input.source.limit ?? 6));
  const prompt = buildSearchPrompt(input.manifest, input.watchConfig, input.source).trim();
  if (!prompt) {
    return [];
  }

  const response = await getOpenAIClient().responses.create({
    model: getWebSearchModel(),
    input: prompt,
    instructions: [
      "You are ScienceSwarm's frontier-news researcher.",
      "Use web search to find current, high-signal research/news items and return structured JSON only.",
      "Every item must include a source URL. Do not invent links.",
    ].join("\n"),
    include: ["web_search_call.action.sources"],
    max_output_tokens: 2400,
    tools: [
      {
        type: "web_search_preview",
        search_context_size: "high",
      },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "frontier_web_search_items",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["items"],
          properties: {
            items: {
              type: "array",
              maxItems: limit,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["title", "summary", "url", "publishedAt"],
                properties: {
                  title: { type: "string" },
                  summary: { type: "string" },
                  url: { type: "string" },
                  publishedAt: {
                    type: ["string", "null"],
                    description: "ISO date if visible in sources, otherwise null.",
                  },
                },
              },
            },
          },
        },
      },
    },
  });

  return parseWebSearchItems(response.output_text)
    .slice(0, limit)
    .map((item) => ({
      dedupeKey: `web:${hashContent(`${item.url}:${item.title}`)}`,
      title: item.title,
      summary: item.summary,
      url: item.url,
      sourceLabel: input.source.label || "Web search",
      publishedAt: item.publishedAt,
    }));
}
