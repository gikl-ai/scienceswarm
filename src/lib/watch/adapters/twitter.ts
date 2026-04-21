import type { ProjectWatchSource, WatchCandidate } from "../types";

const WATCH_FETCH_TIMEOUT_MS = 10_000;

/**
 * Twitter/X Watch Adapter
 *
 * Strategy 1 (no API key): Fetch via Nitter RSS proxy.
 * Strategy 2 (with TWITTER_BEARER_TOKEN): Use Twitter API v2.
 */

export interface TwitterWatchConfig {
  handles: string[]; // @handle without @
  lists?: string[]; // list IDs
  keywords?: string[]; // additional filter keywords
  maxAge: number; // hours — only fetch posts newer than this
}

// ---------------------------------------------------------------------------
// XML helpers (shared pattern with rss.ts / arxiv.ts)
// ---------------------------------------------------------------------------

function decodeXml(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

function extractTag(block: string, tag: string): string | undefined {
  const match = block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? decodeXml(match[1].trim()) : undefined;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Entity extraction helpers
// ---------------------------------------------------------------------------

const ARXIV_ID_RE = /(?:arxiv[:\s]*)?(\d{4}\.\d{4,5}(?:v\d+)?)/gi;
const ARXIV_URL_RE = /https?:\/\/arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5}(?:v\d+)?)/gi;
const PAPER_URL_RE = /https?:\/\/(?:arxiv\.org|doi\.org|openreview\.net|proceedings\.mlr\.press|aclanthology\.org)[^\s)>\]"]*/gi;

export function extractArxivIds(text: string): string[] {
  const ids = new Set<string>();
  for (const match of text.matchAll(ARXIV_ID_RE)) {
    ids.add(match[1]);
  }
  for (const match of text.matchAll(ARXIV_URL_RE)) {
    ids.add(match[1]);
  }
  return Array.from(ids);
}

export function extractPaperLinks(text: string): string[] {
  const links = new Set<string>();
  for (const match of text.matchAll(PAPER_URL_RE)) {
    links.add(match[0]);
  }
  return Array.from(links);
}

// ---------------------------------------------------------------------------
// Recency filter
// ---------------------------------------------------------------------------

function isWithinMaxAge(publishedAt: string | undefined, maxAgeHours: number): boolean {
  if (!publishedAt) return true; // keep items with no date
  const published = new Date(publishedAt).getTime();
  if (Number.isNaN(published)) return true;
  return Date.now() - published <= maxAgeHours * 60 * 60 * 1000;
}

// ---------------------------------------------------------------------------
// Thread reconstruction
// ---------------------------------------------------------------------------

interface TweetData {
  id: string;
  text: string;
  authorId: string;
  inReplyToId?: string;
  publishedAt?: string;
  conversationId?: string;
}

export function reconstructThreads(tweets: TweetData[]): TweetData[][] {
  // Group tweets into threads by conversation_id or self-reply chains
  const byId = new Map<string, TweetData>();
  for (const tweet of tweets) {
    byId.set(tweet.id, tweet);
  }

  const visited = new Set<string>();
  const threads: TweetData[][] = [];

  for (const tweet of tweets) {
    if (visited.has(tweet.id)) continue;

    // Walk the chain backward to find root
    let root = tweet;
    while (root.inReplyToId && byId.has(root.inReplyToId)) {
      const parent = byId.get(root.inReplyToId);
      if (!parent || parent.authorId !== root.authorId) break;
      root = parent;
    }

    // Walk forward from root collecting the thread
    const thread: TweetData[] = [];
    const queue = [root];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current.id)) continue;
      visited.add(current.id);
      thread.push(current);

      // Find replies from same author
      for (const t of tweets) {
        if (t.inReplyToId === current.id && t.authorId === current.authorId && !visited.has(t.id)) {
          queue.push(t);
        }
      }
    }

    if (thread.length > 0) {
      threads.push(thread.sort((a, b) => {
        if (a.publishedAt && b.publishedAt) {
          return new Date(a.publishedAt).getTime() - new Date(b.publishedAt).getTime();
        }
        return 0;
      }));
    }
  }

  return threads;
}

// ---------------------------------------------------------------------------
// Strategy 1: Nitter RSS
// ---------------------------------------------------------------------------

const NITTER_INSTANCES = [
  "https://nitter.net",
  "https://nitter.privacydev.net",
];

async function fetchNitterRss(handle: string): Promise<string | null> {
  for (const instance of NITTER_INSTANCES) {
    try {
      const url = `${instance}/${handle}/rss`;
      const response = await fetch(url, {
        signal: AbortSignal.timeout(WATCH_FETCH_TIMEOUT_MS),
      });
      if (response.ok) {
        return await response.text();
      }
    } catch {
      // Try next instance
    }
  }
  return null;
}

function parseNitterRssItems(xml: string, handle: string, maxAgeHours: number): WatchCandidate[] {
  const items = Array.from(xml.matchAll(/<item>([\s\S]*?)<\/item>/gi));
  return items
    .map((match, index) => {
      const block = match[1];
      const link = extractTag(block, "link") ?? `https://x.com/${handle}/status/${index}`;
      const rawTitle = extractTag(block, "title") ?? "";
      const rawDescription = extractTag(block, "description") ?? "";
      const pubDate = extractTag(block, "pubDate");

      const text = stripHtml(rawDescription || rawTitle);
      const title = text.length > 120 ? `${text.slice(0, 117)}...` : text || `@${handle} post`;

      return {
        dedupeKey: `twitter:nitter:${handle}:${link}`,
        title,
        summary: text,
        url: link,
        sourceLabel: `@${handle} (Twitter/X)`,
        publishedAt: pubDate,
      };
    })
    .filter((item) => isWithinMaxAge(item.publishedAt, maxAgeHours));
}

// ---------------------------------------------------------------------------
// Strategy 2: Twitter API v2
// ---------------------------------------------------------------------------

interface TwitterApiTweet {
  id: string;
  text: string;
  created_at?: string;
  author_id?: string;
  in_reply_to_user_id?: string;
  conversation_id?: string;
  referenced_tweets?: Array<{ type: string; id: string }>;
  entities?: {
    urls?: Array<{ expanded_url: string }>;
  };
}

interface TwitterApiResponse {
  data?: TwitterApiTweet[];
  errors?: Array<{ message: string }>;
}

async function fetchTwitterApi(
  handle: string,
  bearerToken: string,
  maxAgeHours: number,
): Promise<WatchCandidate[]> {
  // First resolve handle to user ID
  const userLookup = await fetch(
    `https://api.twitter.com/2/users/by/username/${handle}`,
    {
      headers: { Authorization: `Bearer ${bearerToken}` },
      signal: AbortSignal.timeout(WATCH_FETCH_TIMEOUT_MS),
    },
  );
  if (!userLookup.ok) {
    return [];
  }
  const userData = (await userLookup.json()) as { data?: { id: string } };
  if (!userData.data?.id) {
    return [];
  }

  const userId = userData.data.id;
  const startTime = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000).toISOString();

  const params = new URLSearchParams({
    max_results: "50",
    start_time: startTime,
    "tweet.fields": "created_at,author_id,conversation_id,referenced_tweets,entities",
  });

  const tweetsResponse = await fetch(
    `https://api.twitter.com/2/users/${userId}/tweets?${params.toString()}`,
    {
      headers: { Authorization: `Bearer ${bearerToken}` },
      signal: AbortSignal.timeout(WATCH_FETCH_TIMEOUT_MS),
    },
  );
  if (!tweetsResponse.ok) {
    return [];
  }

  const tweetsData = (await tweetsResponse.json()) as TwitterApiResponse;
  if (!tweetsData.data || tweetsData.data.length === 0) {
    return [];
  }

  const tweetDataList: TweetData[] = tweetsData.data.map((tweet) => {
    const inReplyToId = tweet.referenced_tweets?.find((ref) => ref.type === "replied_to")?.id;
    return {
      id: tweet.id,
      text: tweet.text,
      authorId: tweet.author_id ?? userId,
      inReplyToId,
      publishedAt: tweet.created_at,
      conversationId: tweet.conversation_id,
    };
  });

  const threads = reconstructThreads(tweetDataList);

  return threads.map((thread) => {
    const first = thread[0];
    const fullText = thread.map((t) => t.text).join("\n\n");
    const title = fullText.length > 120 ? `${fullText.slice(0, 117)}...` : fullText;
    const urls = tweetsData.data!
      .filter((t) => thread.some((td) => td.id === t.id))
      .flatMap((t) => t.entities?.urls?.map((u) => u.expanded_url) ?? []);
    const arxivIds = extractArxivIds(fullText);
    const paperLinks = extractPaperLinks(fullText);
    const allLinks = Array.from(new Set([...urls, ...paperLinks]));
    const enrichment = [
      arxivIds.length > 0 ? `arXiv: ${arxivIds.join(", ")}` : "",
      allLinks.length > 0 ? `Links: ${allLinks.join(", ")}` : "",
    ].filter(Boolean).join(" | ");

    return {
      dedupeKey: `twitter:api:${handle}:${first.id}`,
      title,
      summary: enrichment ? `${fullText}\n\n${enrichment}` : fullText,
      url: `https://x.com/${handle}/status/${first.id}`,
      sourceLabel: `@${handle} (Twitter/X)`,
      publishedAt: first.publishedAt,
    };
  }).filter((item) => isWithinMaxAge(item.publishedAt, maxAgeHours));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function fetchTwitterFeed(config: TwitterWatchConfig): Promise<WatchCandidate[]> {
  const bearerToken = process.env.TWITTER_BEARER_TOKEN?.trim();
  const allCandidates: WatchCandidate[] = [];

  for (const handle of config.handles) {
    try {
      if (bearerToken) {
        const items = await fetchTwitterApi(handle, bearerToken, config.maxAge);
        allCandidates.push(...items);
      } else {
        const xml = await fetchNitterRss(handle);
        if (xml) {
          allCandidates.push(...parseNitterRssItems(xml, handle, config.maxAge));
        }
      }
    } catch {
      // Skip handles that fail — return whatever we have
    }
  }

  // Apply keyword filtering if specified
  if (config.keywords && config.keywords.length > 0) {
    const lowerKeywords = config.keywords.map((k) => k.toLowerCase());
    return allCandidates.filter((item) => {
      const haystack = `${item.title}\n${item.summary}`.toLowerCase();
      return lowerKeywords.some((keyword) => haystack.includes(keyword));
    });
  }

  return allCandidates;
}

/**
 * Adapter entry point matching the ProjectWatchSource pattern.
 * The source.query field should contain comma-separated handles.
 * source.url can optionally point to a Nitter RSS feed URL directly.
 */
export async function fetchTwitterWatchItems(source: ProjectWatchSource): Promise<WatchCandidate[]> {
  const handles = (source.query ?? "")
    .split(",")
    .map((h) => h.trim().replace(/^@/, ""))
    .filter(Boolean);

  if (handles.length === 0 && !source.url) {
    return [];
  }

  // If a direct RSS URL is provided, use it as a plain RSS source
  if (source.url && handles.length === 0) {
    try {
      const response = await fetch(source.url, {
        signal: AbortSignal.timeout(WATCH_FETCH_TIMEOUT_MS),
      });
      if (!response.ok) return [];
      const xml = await response.text();
      return parseNitterRssItems(xml, "unknown", 168); // 1 week default
    } catch {
      return [];
    }
  }

  return fetchTwitterFeed({
    handles,
    maxAge: 168, // 1 week default for ProjectWatchSource
    keywords: undefined,
  });
}

// Export internals for testing
export { parseNitterRssItems, isWithinMaxAge };
