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

export async function fetchRssWatchItems(source: ProjectWatchSource): Promise<WatchCandidate[]> {
  if (!source.url) {
    return [];
  }

  const response = await fetch(source.url, {
    signal: AbortSignal.timeout(WATCH_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`RSS fetch failed with ${response.status}`);
  }

  const xml = await response.text();
  const items = Array.from(xml.matchAll(/<item>([\s\S]*?)<\/item>/gi));

  return items.slice(0, source.limit ?? 5).map((match, index) => {
    const block = match[1];
    const url = extractTag(block, "link") ?? `${source.url}#${index}`;
    return {
      dedupeKey: `rss:${source.id}:${url}`,
      title: extractTag(block, "title") ?? `RSS item ${index + 1}`,
      summary: extractTag(block, "description") ?? "",
      url,
      sourceLabel: source.label ?? source.url ?? "rss",
      publishedAt: extractTag(block, "pubDate"),
    };
  });
}
