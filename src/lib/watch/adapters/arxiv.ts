import type { ProjectWatchSource, WatchCandidate } from "../types";

const WATCH_FETCH_TIMEOUT_MS = 10_000;

function decodeXml(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&#39;", "'");
}

function stripCdata(value: string): string {
  const match = value.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  return match ? match[1].trim() : value;
}

function extractTag(block: string, tag: string): string | undefined {
  const match = block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? decodeXml(stripCdata(match[1].trim())) : undefined;
}

export async function fetchArxivWatchItems(source: ProjectWatchSource): Promise<WatchCandidate[]> {
  if (!source.query) {
    return [];
  }

  const params = new URLSearchParams({
    search_query: source.query,
    start: "0",
    max_results: String(source.limit ?? 5),
  });
  const url = `https://export.arxiv.org/api/query?${params.toString()}`;
  const response = await fetch(url, {
    signal: AbortSignal.timeout(WATCH_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`arXiv fetch failed with ${response.status}`);
  }

  const xml = await response.text();
  const entries = Array.from(xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gi));

  return entries.map((match, index) => {
    const block = match[1];
    const itemUrl = extractTag(block, "id") ?? `${url}#${index}`;
    return {
      dedupeKey: `arxiv:${source.id}:${itemUrl}`,
      title: extractTag(block, "title") ?? `arXiv item ${index + 1}`,
      summary: extractTag(block, "summary") ?? "",
      url: itemUrl,
      sourceLabel: source.label ?? source.query ?? "arxiv",
      publishedAt: extractTag(block, "published"),
    };
  });
}
