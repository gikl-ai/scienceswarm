import type { ProjectWatchSource, WatchCandidate } from "../types";

const WATCH_FETCH_TIMEOUT_MS = 10_000;
const DISCORD_API_BASE = "https://discord.com/api/v10";

/**
 * Discord Watch Adapter
 *
 * Fetches messages from Discord channels using the Discord REST API.
 * Requires DISCORD_BOT_TOKEN env var.
 */

export interface DiscordWatchConfig {
  channels: Array<{ guildId: string; channelId: string; name: string }>;
  keywords?: string[];
  maxAge: number; // hours
}

// ---------------------------------------------------------------------------
// Discord API types
// ---------------------------------------------------------------------------

interface DiscordMessage {
  id: string;
  content: string;
  author: {
    id: string;
    username: string;
    bot?: boolean;
  };
  timestamp: string;
  message_reference?: {
    message_id?: string;
    channel_id?: string;
    guild_id?: string;
  };
  thread?: {
    id: string;
    name: string;
  };
  embeds?: Array<{
    title?: string;
    description?: string;
    url?: string;
  }>;
  referenced_message?: DiscordMessage | null;
}

// ---------------------------------------------------------------------------
// Entity extraction
// ---------------------------------------------------------------------------

const ARXIV_ID_RE = /(?:arxiv[:\s]*)?(\d{4}\.\d{4,5}(?:v\d+)?)/gi;
const URL_RE = /https?:\/\/[^\s)>\]"]+/gi;

function extractUrls(text: string): string[] {
  return Array.from(text.matchAll(URL_RE), (m) => m[0]);
}

function extractArxivIds(text: string): string[] {
  return Array.from(new Set(
    Array.from(text.matchAll(ARXIV_ID_RE), (m) => m[1]),
  ));
}

// ---------------------------------------------------------------------------
// Recency filter
// ---------------------------------------------------------------------------

function isWithinMaxAge(timestamp: string, maxAgeHours: number): boolean {
  const published = new Date(timestamp).getTime();
  if (Number.isNaN(published)) return true;
  return Date.now() - published <= maxAgeHours * 60 * 60 * 1000;
}

// ---------------------------------------------------------------------------
// Thread grouping
// ---------------------------------------------------------------------------

interface MessageGroup {
  rootId: string;
  channelName: string;
  messages: DiscordMessage[];
}

export function groupMessageThreads(messages: DiscordMessage[], channelName: string): MessageGroup[] {
  const byId = new Map<string, DiscordMessage>();
  for (const msg of messages) {
    byId.set(msg.id, msg);
  }

  const rootMap = new Map<string, DiscordMessage[]>();

  for (const msg of messages) {
    const rootId = msg.message_reference?.message_id ?? msg.id;
    if (!rootMap.has(rootId)) {
      rootMap.set(rootId, []);
    }
    rootMap.get(rootId)!.push(msg);
  }

  return Array.from(rootMap.entries()).map(([rootId, msgs]) => ({
    rootId,
    channelName,
    messages: msgs.sort((a, b) =>
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    ),
  }));
}

// ---------------------------------------------------------------------------
// API fetching
// ---------------------------------------------------------------------------

async function fetchChannelMessages(
  channelId: string,
  botToken: string,
  limit = 50,
): Promise<DiscordMessage[]> {
  const url = `${DISCORD_API_BASE}/channels/${channelId}/messages?limit=${limit}`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bot ${botToken}`,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(WATCH_FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    return [];
  }

  const data = await response.json();
  return Array.isArray(data) ? (data as DiscordMessage[]) : [];
}

function messageToCandidates(group: MessageGroup): WatchCandidate {
  const allText = group.messages.map((m) => m.content).join("\n");
  const embedTexts = group.messages
    .flatMap((m) => m.embeds ?? [])
    .map((e) => [e.title, e.description].filter(Boolean).join(": "))
    .filter(Boolean);

  const fullText = [allText, ...embedTexts].join("\n").trim();
  const title = fullText.length > 120 ? `${fullText.slice(0, 117)}...` : fullText || "Discord message";

  const urls = extractUrls(fullText);
  const arxivIds = extractArxivIds(fullText);
  const embedUrls = group.messages
    .flatMap((m) => m.embeds ?? [])
    .map((e) => e.url)
    .filter((u): u is string => Boolean(u));
  const allLinks = Array.from(new Set([...urls, ...embedUrls]));

  const enrichment = [
    arxivIds.length > 0 ? `arXiv: ${arxivIds.join(", ")}` : "",
    allLinks.length > 0 ? `Links: ${allLinks.join(", ")}` : "",
  ].filter(Boolean).join(" | ");

  const firstMsg = group.messages[0];
  const author = firstMsg.author.username;

  return {
    dedupeKey: `discord:${firstMsg.id}`,
    title,
    summary: enrichment ? `${fullText}\n\n[${author} in #${group.channelName}] ${enrichment}` : `${fullText}\n\n[${author} in #${group.channelName}]`,
    url: `https://discord.com/channels/-/${firstMsg.id}`,
    sourceLabel: `#${group.channelName} (Discord)`,
    publishedAt: firstMsg.timestamp,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function fetchDiscordChannel(config: DiscordWatchConfig): Promise<WatchCandidate[]> {
  const botToken = process.env.DISCORD_BOT_TOKEN?.trim();
  if (!botToken) {
    return [];
  }

  const allCandidates: WatchCandidate[] = [];

  for (const channel of config.channels) {
    try {
      const messages = await fetchChannelMessages(channel.channelId, botToken);
      const recent = messages.filter((m) => isWithinMaxAge(m.timestamp, config.maxAge));
      const groups = groupMessageThreads(recent, channel.name);

      for (const group of groups) {
        allCandidates.push(messageToCandidates(group));
      }
    } catch {
      // Skip channels that fail
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
 * source.query should contain channelId (or comma-separated channelIds).
 * source.label is used as the channel name.
 */
export async function fetchDiscordWatchItems(source: ProjectWatchSource): Promise<WatchCandidate[]> {
  const botToken = process.env.DISCORD_BOT_TOKEN?.trim();
  if (!botToken) {
    return [];
  }

  const channelIds = (source.query ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

  if (channelIds.length === 0) {
    return [];
  }

  return fetchDiscordChannel({
    channels: channelIds.map((channelId) => ({
      guildId: "",
      channelId,
      name: source.label ?? channelId,
    })),
    maxAge: 168, // 1 week default
  });
}

// Export for testing
export { isWithinMaxAge, extractUrls, extractArxivIds };
