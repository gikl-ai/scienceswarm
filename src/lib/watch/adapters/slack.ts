import type { ProjectWatchSource, WatchCandidate } from "../types";

const WATCH_FETCH_TIMEOUT_MS = 10_000;
const SLACK_API_BASE = "https://slack.com/api";

/**
 * Slack Watch Adapter
 *
 * Fetches messages from Slack channels using the Slack Web API.
 * Requires SLACK_BOT_TOKEN env var.
 */

export interface SlackWatchConfig {
  channels: Array<{ id: string; name: string }>;
  keywords?: string[];
  maxAge: number; // hours
}

// ---------------------------------------------------------------------------
// Slack API types
// ---------------------------------------------------------------------------

interface SlackMessage {
  type: string;
  ts: string;
  user?: string;
  text: string;
  thread_ts?: string;
  reply_count?: number;
  bot_id?: string;
}

interface SlackHistoryResponse {
  ok: boolean;
  messages?: SlackMessage[];
  error?: string;
}

interface SlackRepliesResponse {
  ok: boolean;
  messages?: SlackMessage[];
  error?: string;
}

// ---------------------------------------------------------------------------
// Entity extraction
// ---------------------------------------------------------------------------

const ARXIV_ID_RE = /(?:arxiv[:\s]*)?(\d{4}\.\d{4,5}(?:v\d+)?)/gi;
const URL_RE = /https?:\/\/[^\s)>\]"|]+/gi;

function extractUrls(text: string): string[] {
  // Slack wraps URLs in <url|label> or <url> format
  const slackUrls = Array.from(text.matchAll(/<(https?:\/\/[^|>]+)(?:\|[^>]*)?>/g), (m) => m[1]);
  const plainUrls = Array.from(text.matchAll(URL_RE), (m) => m[0]);
  return Array.from(new Set([...slackUrls, ...plainUrls]));
}

function extractArxivIds(text: string): string[] {
  return Array.from(new Set(
    Array.from(text.matchAll(ARXIV_ID_RE), (m) => m[1]),
  ));
}

// Slack uses epoch timestamps like "1234567890.123456"
function slackTsToIso(ts: string): string {
  const seconds = Number.parseFloat(ts);
  if (Number.isNaN(seconds)) return new Date().toISOString();
  return new Date(seconds * 1000).toISOString();
}

// ---------------------------------------------------------------------------
// Recency filter
// ---------------------------------------------------------------------------

function isWithinMaxAge(ts: string, maxAgeHours: number): boolean {
  const seconds = Number.parseFloat(ts);
  if (Number.isNaN(seconds)) return true;
  const publishedMs = seconds * 1000;
  return Date.now() - publishedMs <= maxAgeHours * 60 * 60 * 1000;
}

// ---------------------------------------------------------------------------
// Thread handling
// ---------------------------------------------------------------------------

interface ThreadGroup {
  rootMessage: SlackMessage;
  replies: SlackMessage[];
  channelName: string;
}

export function groupSlackThreads(messages: SlackMessage[], channelName: string): ThreadGroup[] {
  const threads = new Map<string, SlackMessage[]>();
  const standalone: SlackMessage[] = [];

  for (const msg of messages) {
    if (msg.thread_ts && msg.thread_ts !== msg.ts) {
      // This is a reply in a thread
      if (!threads.has(msg.thread_ts)) {
        threads.set(msg.thread_ts, []);
      }
      threads.get(msg.thread_ts)!.push(msg);
    } else if (msg.thread_ts && msg.thread_ts === msg.ts && msg.reply_count && msg.reply_count > 0) {
      // This is a thread root
      if (!threads.has(msg.ts)) {
        threads.set(msg.ts, []);
      }
      // Put root message at front
      threads.get(msg.ts)!.unshift(msg);
    } else {
      standalone.push(msg);
    }
  }

  const groups: ThreadGroup[] = [];

  // Process threads
  for (const [, msgs] of threads) {
    if (msgs.length === 0) continue;
    const root = msgs[0];
    groups.push({
      rootMessage: root,
      replies: msgs.slice(1).sort((a, b) =>
        Number.parseFloat(a.ts) - Number.parseFloat(b.ts),
      ),
      channelName,
    });
  }

  // Process standalone messages
  for (const msg of standalone) {
    groups.push({
      rootMessage: msg,
      replies: [],
      channelName,
    });
  }

  return groups;
}

// ---------------------------------------------------------------------------
// API fetching
// ---------------------------------------------------------------------------

async function fetchConversationHistory(
  channelId: string,
  botToken: string,
  oldestTs?: string,
  limit = 50,
): Promise<SlackMessage[]> {
  const params = new URLSearchParams({
    channel: channelId,
    limit: String(limit),
  });
  if (oldestTs) {
    params.set("oldest", oldestTs);
  }

  const url = `${SLACK_API_BASE}/conversations.history?${params.toString()}`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${botToken}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    signal: AbortSignal.timeout(WATCH_FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    return [];
  }

  const data = (await response.json()) as SlackHistoryResponse;
  if (!data.ok || !data.messages) {
    return [];
  }

  return data.messages.filter((m) => m.type === "message");
}

async function fetchThreadReplies(
  channelId: string,
  threadTs: string,
  botToken: string,
): Promise<SlackMessage[]> {
  const params = new URLSearchParams({
    channel: channelId,
    ts: threadTs,
  });

  const url = `${SLACK_API_BASE}/conversations.replies?${params.toString()}`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${botToken}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    signal: AbortSignal.timeout(WATCH_FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    return [];
  }

  const data = (await response.json()) as SlackRepliesResponse;
  if (!data.ok || !data.messages) {
    return [];
  }

  return data.messages;
}

function threadToCandidates(group: ThreadGroup): WatchCandidate {
  const allMessages = [group.rootMessage, ...group.replies];
  const fullText = allMessages.map((m) => m.text).join("\n").trim();
  const title = fullText.length > 120 ? `${fullText.slice(0, 117)}...` : fullText || "Slack message";

  const urls = extractUrls(fullText);
  const arxivIds = extractArxivIds(fullText);
  const enrichment = [
    arxivIds.length > 0 ? `arXiv: ${arxivIds.join(", ")}` : "",
    urls.length > 0 ? `Links: ${urls.join(", ")}` : "",
  ].filter(Boolean).join(" | ");

  const replyInfo = group.replies.length > 0 ? ` (${group.replies.length} replies)` : "";

  return {
    dedupeKey: `slack:${group.rootMessage.ts}`,
    title,
    summary: enrichment
      ? `${fullText}\n\n[#${group.channelName}${replyInfo}] ${enrichment}`
      : `${fullText}\n\n[#${group.channelName}${replyInfo}]`,
    url: `https://slack.com/archives/${group.channelName}/p${group.rootMessage.ts.replace(".", "")}`,
    sourceLabel: `#${group.channelName} (Slack)`,
    publishedAt: slackTsToIso(group.rootMessage.ts),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function fetchSlackChannel(config: SlackWatchConfig): Promise<WatchCandidate[]> {
  const botToken = process.env.SLACK_BOT_TOKEN?.trim();
  if (!botToken) {
    return [];
  }

  const allCandidates: WatchCandidate[] = [];
  const oldestTs = String((Date.now() - config.maxAge * 60 * 60 * 1000) / 1000);

  for (const channel of config.channels) {
    try {
      const messages = await fetchConversationHistory(channel.id, botToken, oldestTs);
      const recent = messages.filter((m) => isWithinMaxAge(m.ts, config.maxAge));

      // Fetch thread replies for threaded messages
      const threadRoots = recent.filter((m) => m.thread_ts === m.ts && m.reply_count && m.reply_count > 0);
      for (const root of threadRoots) {
        try {
          const replies = await fetchThreadReplies(channel.id, root.ts, botToken);
          // Add replies (skip first which is the root itself)
          for (const reply of replies.slice(1)) {
            recent.push(reply);
          }
        } catch {
          // Thread fetch failed, continue with what we have
        }
      }

      const groups = groupSlackThreads(recent, channel.name);
      for (const group of groups) {
        allCandidates.push(threadToCandidates(group));
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
 * source.query should contain channel ID (or comma-separated channel IDs).
 * source.label is used as the channel name.
 */
export async function fetchSlackWatchItems(source: ProjectWatchSource): Promise<WatchCandidate[]> {
  const botToken = process.env.SLACK_BOT_TOKEN?.trim();
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

  return fetchSlackChannel({
    channels: channelIds.map((id) => ({
      id,
      name: source.label ?? id,
    })),
    maxAge: 168, // 1 week default
  });
}

// Export for testing
export { isWithinMaxAge, slackTsToIso, extractUrls, extractArxivIds };
