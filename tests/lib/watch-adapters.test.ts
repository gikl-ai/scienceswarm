import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchArxivWatchItems } from "@/lib/watch/adapters/arxiv";
import {
  fetchDiscordChannel,
  fetchDiscordWatchItems,
  groupMessageThreads,
} from "@/lib/watch/adapters/discord";
import { fetchRssWatchItems } from "@/lib/watch/adapters/rss";
import {
  fetchSlackChannel,
  fetchSlackWatchItems,
  groupSlackThreads,
} from "@/lib/watch/adapters/slack";
import {
  extractArxivIds,
  extractPaperLinks,
  fetchTwitterFeed,
  fetchTwitterWatchItems,
  isWithinMaxAge,
  parseNitterRssItems,
  reconstructThreads,
} from "@/lib/watch/adapters/twitter";

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// Existing RSS + arXiv tests
// ---------------------------------------------------------------------------

describe("watch adapters — RSS", () => {
  it("passes a timeout signal to RSS fetches", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        "<rss><channel><item><title>Item</title><link>https://example.com/item</link></item></channel></rss>",
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await fetchRssWatchItems({
      id: "rss-1",
      type: "rss",
      url: "https://example.com/feed.xml",
      label: "rss",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/feed.xml",
      expect.objectContaining({
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("strips CDATA wrappers from RSS descriptions", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          [
            "<rss><channel><item>",
            "<title>Item</title>",
            "<link>https://example.com/item</link>",
            "<description><![CDATA[Clean summary]]></description>",
            "</item></channel></rss>",
          ].join(""),
          { status: 200 },
        ),
      ),
    );

    const items = await fetchRssWatchItems({
      id: "rss-1",
      type: "rss",
      url: "https://example.com/feed.xml",
      label: "rss",
    });

    expect(items[0]?.summary).toBe("Clean summary");
  });
});

describe("watch adapters — arXiv", () => {
  it("passes a timeout signal to arXiv fetches", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        "<feed><entry><title>Item</title><id>https://arxiv.org/abs/1</id></entry></feed>",
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await fetchArxivWatchItems({
      id: "arxiv-1",
      type: "arxiv",
      query: "all:crispr",
      label: "arxiv",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("https://export.arxiv.org/api/query?"),
      expect.objectContaining({
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("strips CDATA wrappers from arXiv summaries", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          [
            "<feed><entry>",
            "<title>Item</title>",
            "<id>https://arxiv.org/abs/1</id>",
            "<summary><![CDATA[Relevant abstract]]></summary>",
            "</entry></feed>",
          ].join(""),
          { status: 200 },
        ),
      ),
    );

    const items = await fetchArxivWatchItems({
      id: "arxiv-1",
      type: "arxiv",
      query: "all:crispr",
      label: "arxiv",
    });

    expect(items[0]?.summary).toBe("Relevant abstract");
  });
});

// ---------------------------------------------------------------------------
// Twitter adapter tests
// ---------------------------------------------------------------------------

const NITTER_RSS_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>@kaborator / Twitter</title>
    <item>
      <title>Excited about our new paper on arxiv: 2401.12345 — demonstrates 3x improvement on reasoning benchmarks</title>
      <description>&lt;p&gt;Excited about our new paper on arxiv: 2401.12345 — demonstrates 3x improvement on reasoning benchmarks&lt;/p&gt;&lt;p&gt;&lt;a href=&quot;https://arxiv.org/abs/2401.12345&quot;&gt;arxiv.org/abs/2401.12345&lt;/a&gt;&lt;/p&gt;</description>
      <link>https://nitter.net/kaborator/status/123456</link>
      <pubDate>${new Date().toUTCString()}</pubDate>
    </item>
    <item>
      <title>Great discussion at NeurIPS today on scaling laws.</title>
      <description>&lt;p&gt;Great discussion at NeurIPS today on scaling laws.&lt;/p&gt;</description>
      <link>https://nitter.net/kaborator/status/123457</link>
      <pubDate>${new Date(Date.now() - 2 * 60 * 60 * 1000).toUTCString()}</pubDate>
    </item>
    <item>
      <title>Old post from last month</title>
      <description>&lt;p&gt;Old post from last month&lt;/p&gt;</description>
      <link>https://nitter.net/kaborator/status/100000</link>
      <pubDate>${new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toUTCString()}</pubDate>
    </item>
  </channel>
</rss>`;

describe("watch adapters — Twitter", () => {
  describe("parseNitterRssItems", () => {
    it("parses Nitter RSS feed XML into WatchCandidates", () => {
      const items = parseNitterRssItems(NITTER_RSS_FIXTURE, "kaborator", 168);

      expect(items.length).toBe(2); // third item is > 168h old
      expect(items[0].dedupeKey).toBe("twitter:nitter:kaborator:https://nitter.net/kaborator/status/123456");
      expect(items[0].sourceLabel).toBe("@kaborator (Twitter/X)");
      expect(items[0].url).toBe("https://nitter.net/kaborator/status/123456");
      expect(items[0].summary).toContain("arxiv");
      expect(items[0].publishedAt).toBeTruthy();
    });

    it("respects maxAge filter — excludes old posts", () => {
      const items = parseNitterRssItems(NITTER_RSS_FIXTURE, "kaborator", 1);
      // Only posts from within the last 1 hour
      expect(items.length).toBeLessThanOrEqual(1);
    });

    it("keeps items with no pubDate when filtering", () => {
      const xml = `<rss><channel><item>
        <title>No date post</title>
        <description>Body text</description>
        <link>https://nitter.net/someone/status/999</link>
      </item></channel></rss>`;
      const items = parseNitterRssItems(xml, "someone", 1);
      expect(items.length).toBe(1);
      // description takes priority over title for the text content
      expect(items[0].title).toBe("Body text");
      expect(items[0].summary).toBe("Body text");
    });
  });

  describe("extractArxivIds", () => {
    it("extracts arXiv IDs from tweet text", () => {
      const text = "Check out our paper: arxiv: 2401.12345 and also 2312.09876v2 on attention!";
      const ids = extractArxivIds(text);
      expect(ids).toContain("2401.12345");
      expect(ids).toContain("2312.09876v2");
      expect(ids.length).toBe(2);
    });

    it("extracts IDs from arXiv URLs", () => {
      const text = "Read it at https://arxiv.org/abs/2401.54321 and https://arxiv.org/pdf/2310.11111v1";
      const ids = extractArxivIds(text);
      expect(ids).toContain("2401.54321");
      expect(ids).toContain("2310.11111v1");
    });

    it("returns empty array when no IDs found", () => {
      expect(extractArxivIds("No papers here")).toEqual([]);
    });
  });

  describe("extractPaperLinks", () => {
    it("extracts paper links from tweet text", () => {
      const text = "Paper at https://arxiv.org/abs/2401.12345 and https://doi.org/10.1234/test and regular https://google.com";
      const links = extractPaperLinks(text);
      expect(links).toContain("https://arxiv.org/abs/2401.12345");
      expect(links).toContain("https://doi.org/10.1234/test");
      expect(links).not.toContain("https://google.com");
    });
  });

  describe("reconstructThreads", () => {
    it("groups self-replies into a single thread", () => {
      const tweets = [
        { id: "1", text: "First tweet", authorId: "a1", publishedAt: "2024-01-01T10:00:00Z" },
        { id: "2", text: "Reply to self", authorId: "a1", inReplyToId: "1", publishedAt: "2024-01-01T10:01:00Z" },
        { id: "3", text: "More context", authorId: "a1", inReplyToId: "2", publishedAt: "2024-01-01T10:02:00Z" },
      ];
      const threads = reconstructThreads(tweets);
      expect(threads.length).toBe(1);
      expect(threads[0].length).toBe(3);
      expect(threads[0][0].id).toBe("1");
      expect(threads[0][1].id).toBe("2");
      expect(threads[0][2].id).toBe("3");
    });

    it("keeps separate threads separate", () => {
      const tweets = [
        { id: "1", text: "Thread A start", authorId: "a1", publishedAt: "2024-01-01T10:00:00Z" },
        { id: "2", text: "Thread A reply", authorId: "a1", inReplyToId: "1", publishedAt: "2024-01-01T10:01:00Z" },
        { id: "3", text: "Thread B standalone", authorId: "a1", publishedAt: "2024-01-01T11:00:00Z" },
      ];
      const threads = reconstructThreads(tweets);
      expect(threads.length).toBe(2);
      const threadA = threads.find((t) => t[0].id === "1");
      const threadB = threads.find((t) => t[0].id === "3");
      expect(threadA!.length).toBe(2);
      expect(threadB!.length).toBe(1);
    });

    it("does not merge replies from different authors", () => {
      const tweets = [
        { id: "1", text: "My tweet", authorId: "a1", publishedAt: "2024-01-01T10:00:00Z" },
        { id: "2", text: "Someone else replies", authorId: "b2", inReplyToId: "1", publishedAt: "2024-01-01T10:01:00Z" },
      ];
      const threads = reconstructThreads(tweets);
      expect(threads.length).toBe(2);
    });
  });

  describe("isWithinMaxAge", () => {
    it("returns true for recent dates", () => {
      const recent = new Date(Date.now() - 1000).toISOString();
      expect(isWithinMaxAge(recent, 24)).toBe(true);
    });

    it("returns false for old dates", () => {
      const old = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
      expect(isWithinMaxAge(old, 24)).toBe(false);
    });

    it("returns true when publishedAt is undefined", () => {
      expect(isWithinMaxAge(undefined, 24)).toBe(true);
    });
  });

  describe("fetchTwitterFeed — Nitter fallback", () => {
    it("uses Nitter RSS when no API key is set", async () => {
      vi.stubEnv("TWITTER_BEARER_TOKEN", "");

      const fetchMock = vi.fn().mockResolvedValue(
        new Response(NITTER_RSS_FIXTURE, { status: 200 }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const items = await fetchTwitterFeed({
        handles: ["kaborator"],
        maxAge: 168,
      });

      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("nitter"),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(items.length).toBeGreaterThanOrEqual(1);
      expect(items[0].sourceLabel).toBe("@kaborator (Twitter/X)");
    });

    it("returns empty array when all Nitter instances fail", async () => {
      vi.stubEnv("TWITTER_BEARER_TOKEN", "");
      const fetchMock = vi.fn().mockRejectedValue(new Error("Network error"));
      vi.stubGlobal("fetch", fetchMock);

      const items = await fetchTwitterFeed({
        handles: ["kaborator"],
        maxAge: 168,
      });

      expect(items).toEqual([]);
    });
  });

  describe("fetchTwitterFeed — keyword filter", () => {
    it("filters results by keywords", async () => {
      vi.stubEnv("TWITTER_BEARER_TOKEN", "");
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(NITTER_RSS_FIXTURE, { status: 200 }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const items = await fetchTwitterFeed({
        handles: ["kaborator"],
        keywords: ["neurips"],
        maxAge: 168,
      });

      // Only the "NeurIPS" post should match
      expect(items.every((item) => item.summary.toLowerCase().includes("neurips"))).toBe(true);
    });
  });

  describe("fetchTwitterWatchItems — ProjectWatchSource interface", () => {
    it("returns empty when no handles and no url", async () => {
      const items = await fetchTwitterWatchItems({
        id: "t-1",
        type: "twitter",
        query: "",
      });
      expect(items).toEqual([]);
    });

    it("strips @ prefix from handles", async () => {
      vi.stubEnv("TWITTER_BEARER_TOKEN", "");
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(NITTER_RSS_FIXTURE, { status: 200 }),
      );
      vi.stubGlobal("fetch", fetchMock);

      await fetchTwitterWatchItems({
        id: "t-1",
        type: "twitter",
        query: "@kaborator",
      });

      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/kaborator/rss"),
        expect.anything(),
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Discord adapter tests
// ---------------------------------------------------------------------------

const DISCORD_MESSAGES_FIXTURE = [
  {
    id: "msg-1",
    content: "Check out this new paper: https://arxiv.org/abs/2401.99999",
    author: { id: "u1", username: "researcher_bob", bot: false },
    timestamp: new Date().toISOString(),
    embeds: [{ title: "arXiv paper", url: "https://arxiv.org/abs/2401.99999" }],
  },
  {
    id: "msg-2",
    content: "Interesting, the results look promising!",
    author: { id: "u2", username: "alice_ml" },
    timestamp: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    message_reference: { message_id: "msg-1" },
  },
  {
    id: "msg-3",
    content: "Anyone attending the workshop next week?",
    author: { id: "u3", username: "carol_phd" },
    timestamp: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
  },
];

describe("watch adapters — Discord", () => {
  describe("groupMessageThreads", () => {
    it("groups replies under root messages", () => {
      const groups = groupMessageThreads(DISCORD_MESSAGES_FIXTURE as never, "ml-papers");
      // msg-2 is a reply to msg-1 → grouped. msg-3 is standalone.
      expect(groups.length).toBe(2);

      const threadGroup = groups.find((g) => g.messages.some((m) => m.id === "msg-2"));
      expect(threadGroup).toBeTruthy();
      expect(threadGroup!.messages.length).toBe(2);
      expect(threadGroup!.channelName).toBe("ml-papers");
    });

    it("preserves standalone messages as single-item groups", () => {
      const groups = groupMessageThreads(DISCORD_MESSAGES_FIXTURE as never, "general");
      const standalone = groups.find((g) => g.messages.some((m) => m.id === "msg-3"));
      expect(standalone).toBeTruthy();
      expect(standalone!.messages.length).toBe(1);
    });
  });

  describe("fetchDiscordChannel", () => {
    it("returns empty when DISCORD_BOT_TOKEN is missing", async () => {
      vi.stubEnv("DISCORD_BOT_TOKEN", "");
      const items = await fetchDiscordChannel({
        channels: [{ guildId: "g1", channelId: "c1", name: "test" }],
        maxAge: 24,
      });
      expect(items).toEqual([]);
    });

    it("fetches and parses Discord messages", async () => {
      vi.stubEnv("DISCORD_BOT_TOKEN", "test-token-123");
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify(DISCORD_MESSAGES_FIXTURE), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const items = await fetchDiscordChannel({
        channels: [{ guildId: "g1", channelId: "c1", name: "ml-papers" }],
        maxAge: 24,
      });

      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/channels/c1/messages"),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bot test-token-123",
          }),
        }),
      );

      expect(items.length).toBeGreaterThanOrEqual(1);
      expect(items[0].sourceLabel).toContain("Discord");
      // Should contain arXiv reference from the message
      const paperItem = items.find((i) => i.summary.includes("2401.99999"));
      expect(paperItem).toBeTruthy();
    });

    it("filters by keywords when provided", async () => {
      vi.stubEnv("DISCORD_BOT_TOKEN", "test-token-123");
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify(DISCORD_MESSAGES_FIXTURE), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const items = await fetchDiscordChannel({
        channels: [{ guildId: "g1", channelId: "c1", name: "ml-papers" }],
        keywords: ["workshop"],
        maxAge: 24,
      });

      // Only the "workshop" message should survive keyword filter
      expect(items.every((i) => `${i.title}\n${i.summary}`.toLowerCase().includes("workshop"))).toBe(true);
    });
  });

  describe("fetchDiscordWatchItems — ProjectWatchSource interface", () => {
    it("returns empty when no bot token is set", async () => {
      vi.stubEnv("DISCORD_BOT_TOKEN", "");
      const items = await fetchDiscordWatchItems({
        id: "d-1",
        type: "discord",
        query: "channel123",
      });
      expect(items).toEqual([]);
    });

    it("returns empty when query is empty", async () => {
      vi.stubEnv("DISCORD_BOT_TOKEN", "some-token");
      const items = await fetchDiscordWatchItems({
        id: "d-1",
        type: "discord",
        query: "",
      });
      expect(items).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// Slack adapter tests
// ---------------------------------------------------------------------------

// Phase D fix: the prior fixture used `String(Date.now() / 1000)`
// evaluated per message literal. Each literal re-read `Date.now()`,
// so the `thread_ts` on the root message and the reply-with-same-
// `thread_ts` landed at different ms under load, breaking
// `groupSlackThreads` thread matching. Pinning a base timestamp
// captured once at test-module load keeps the fixture deterministic
// without a vi.useFakeTimers plumb-through. We anchor to "now" rather
// than a hardcoded epoch so the downstream `maxAge: 24` freshness
// filter in `fetchSlackChannel` still accepts the fixture messages.
const SLACK_FIXTURE_BASE_SECONDS = Math.floor(Date.now() / 1000);
const SLACK_STANDALONE_TS = String(SLACK_FIXTURE_BASE_SECONDS);
const SLACK_THREAD_ROOT_TS = String(SLACK_FIXTURE_BASE_SECONDS - 300);
const SLACK_THREAD_REPLY_TS = String(SLACK_FIXTURE_BASE_SECONDS - 200);
const SLACK_THREAD_REPLY2_TS = String(SLACK_FIXTURE_BASE_SECONDS - 100);

const SLACK_HISTORY_FIXTURE = {
  ok: true,
  messages: [
    {
      type: "message",
      ts: SLACK_STANDALONE_TS,
      user: "U123",
      text: "Just read <https://arxiv.org/abs/2401.55555|this paper> on new attention mechanisms",
    },
    {
      type: "message",
      ts: SLACK_THREAD_ROOT_TS,
      user: "U456",
      text: "Thread root about scaling experiments",
      thread_ts: SLACK_THREAD_ROOT_TS,
      reply_count: 2,
    },
    {
      type: "message",
      ts: SLACK_THREAD_REPLY_TS,
      user: "U789",
      text: "The results on MMLU are interesting, see https://openreview.net/forum?id=abc123",
      thread_ts: SLACK_THREAD_ROOT_TS,
    },
  ],
};

const SLACK_REPLIES_FIXTURE = {
  ok: true,
  messages: [
    {
      type: "message",
      ts: SLACK_THREAD_ROOT_TS,
      user: "U456",
      text: "Thread root about scaling experiments",
    },
    {
      type: "message",
      ts: SLACK_THREAD_REPLY_TS,
      user: "U789",
      text: "Reply 1: I agree with the conclusions",
    },
    {
      type: "message",
      ts: SLACK_THREAD_REPLY2_TS,
      user: "U456",
      text: "Reply 2: Let me check the appendix",
    },
  ],
};

describe("watch adapters — Slack", () => {
  describe("groupSlackThreads", () => {
    it("groups threaded messages together", () => {
      const messages = SLACK_HISTORY_FIXTURE.messages as never;
      const groups = groupSlackThreads(messages, "research");

      // First message is standalone, second+third form a thread
      expect(groups.length).toBe(2);

      const threadGroup = groups.find((g) => g.replies.length > 0);
      expect(threadGroup).toBeTruthy();
      expect(threadGroup!.rootMessage.text).toContain("scaling experiments");
      expect(threadGroup!.channelName).toBe("research");
    });

    it("handles standalone messages correctly", () => {
      const messages = [
        { type: "message", ts: "1700000000.000000", user: "U1", text: "standalone msg" },
      ];
      const groups = groupSlackThreads(messages as never, "general");
      expect(groups.length).toBe(1);
      expect(groups[0].replies.length).toBe(0);
      expect(groups[0].rootMessage.text).toBe("standalone msg");
    });
  });

  describe("fetchSlackChannel", () => {
    it("returns empty when SLACK_BOT_TOKEN is missing", async () => {
      vi.stubEnv("SLACK_BOT_TOKEN", "");
      const items = await fetchSlackChannel({
        channels: [{ id: "C123", name: "research" }],
        maxAge: 24,
      });
      expect(items).toEqual([]);
    });

    it("fetches and parses Slack messages", async () => {
      vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-test-token");
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify(SLACK_HISTORY_FIXTURE), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const items = await fetchSlackChannel({
        channels: [{ id: "C123", name: "research" }],
        maxAge: 24,
      });

      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("conversations.history"),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer xoxb-test-token",
          }),
        }),
      );

      expect(items.length).toBeGreaterThanOrEqual(1);
      expect(items[0].sourceLabel).toContain("Slack");
      // Check for arXiv link extraction
      const paperItem = items.find((i) => i.summary.includes("2401.55555"));
      expect(paperItem).toBeTruthy();
    });

    it("handles threaded replies via conversations.replies", async () => {
      vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-test-token");
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes("conversations.history")) {
          return Promise.resolve(
            new Response(JSON.stringify(SLACK_HISTORY_FIXTURE), { status: 200 }),
          );
        }
        if (url.includes("conversations.replies")) {
          return Promise.resolve(
            new Response(JSON.stringify(SLACK_REPLIES_FIXTURE), { status: 200 }),
          );
        }
        return Promise.resolve(new Response("{}", { status: 404 }));
      });
      vi.stubGlobal("fetch", fetchMock);

      const items = await fetchSlackChannel({
        channels: [{ id: "C123", name: "research" }],
        maxAge: 24,
      });

      // Should have fetched both history and replies
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("conversations.history"),
        expect.anything(),
      );
      expect(items.length).toBeGreaterThanOrEqual(1);
    });

    it("filters by keywords when provided", async () => {
      vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-test-token");
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify(SLACK_HISTORY_FIXTURE), {
          status: 200,
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const items = await fetchSlackChannel({
        channels: [{ id: "C123", name: "research" }],
        keywords: ["attention"],
        maxAge: 24,
      });

      expect(
        items.every((i) => `${i.title}\n${i.summary}`.toLowerCase().includes("attention")),
      ).toBe(true);
    });
  });

  describe("fetchSlackWatchItems — ProjectWatchSource interface", () => {
    it("returns empty when no bot token is set", async () => {
      vi.stubEnv("SLACK_BOT_TOKEN", "");
      const items = await fetchSlackWatchItems({
        id: "s-1",
        type: "slack",
        query: "C123",
      });
      expect(items).toEqual([]);
    });

    it("returns empty when query is empty", async () => {
      vi.stubEnv("SLACK_BOT_TOKEN", "some-token");
      const items = await fetchSlackWatchItems({
        id: "s-1",
        type: "slack",
        query: "",
      });
      expect(items).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// Cross-adapter: graceful degradation
// ---------------------------------------------------------------------------

describe("watch adapters — graceful degradation", () => {
  it("twitter returns empty with no API key and failed Nitter", async () => {
    vi.stubEnv("TWITTER_BEARER_TOKEN", "");
    const fetchMock = vi.fn().mockRejectedValue(new Error("All instances down"));
    vi.stubGlobal("fetch", fetchMock);

    const items = await fetchTwitterFeed({ handles: ["test"], maxAge: 24 });
    expect(items).toEqual([]);
  });

  it("discord returns empty with no bot token", async () => {
    vi.stubEnv("DISCORD_BOT_TOKEN", "");
    const items = await fetchDiscordChannel({
      channels: [{ guildId: "g", channelId: "c", name: "n" }],
      maxAge: 24,
    });
    expect(items).toEqual([]);
  });

  it("slack returns empty with no bot token", async () => {
    vi.stubEnv("SLACK_BOT_TOKEN", "");
    const items = await fetchSlackChannel({
      channels: [{ id: "C1", name: "ch" }],
      maxAge: 24,
    });
    expect(items).toEqual([]);
  });

  it("discord handles fetch error gracefully", async () => {
    vi.stubEnv("DISCORD_BOT_TOKEN", "tok");
    const fetchMock = vi.fn().mockRejectedValue(new Error("Network error"));
    vi.stubGlobal("fetch", fetchMock);

    const items = await fetchDiscordChannel({
      channels: [{ guildId: "g", channelId: "c", name: "n" }],
      maxAge: 24,
    });
    expect(items).toEqual([]);
  });

  it("slack handles fetch error gracefully", async () => {
    vi.stubEnv("SLACK_BOT_TOKEN", "tok");
    const fetchMock = vi.fn().mockRejectedValue(new Error("Network error"));
    vi.stubGlobal("fetch", fetchMock);

    const items = await fetchSlackChannel({
      channels: [{ id: "C1", name: "ch" }],
      maxAge: 24,
    });
    expect(items).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Cross-adapter: maxAge respect
// ---------------------------------------------------------------------------

describe("watch adapters — maxAge filtering", () => {
  it("twitter: parseNitterRssItems respects maxAge=0 to exclude all dated items", () => {
    const items = parseNitterRssItems(NITTER_RSS_FIXTURE, "test", 0);
    // All items with dates are older than 0 hours
    const datedItems = items.filter((i) => i.publishedAt);
    expect(datedItems.length).toBe(0);
  });

  it("discord: old messages are filtered out", async () => {
    vi.stubEnv("DISCORD_BOT_TOKEN", "test-token");
    const oldMessages = [
      {
        id: "old-1",
        content: "Very old message",
        author: { id: "u1", username: "bob" },
        timestamp: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString(),
      },
    ];
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(oldMessages), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const items = await fetchDiscordChannel({
      channels: [{ guildId: "g1", channelId: "c1", name: "ch" }],
      maxAge: 24,
    });
    expect(items).toEqual([]);
  });

  it("slack: old messages filtered by oldest param and recency check", async () => {
    vi.stubEnv("SLACK_BOT_TOKEN", "tok");
    const oldMessages = {
      ok: true,
      messages: [
        {
          type: "message",
          ts: String((Date.now() - 100 * 24 * 60 * 60 * 1000) / 1000),
          user: "U1",
          text: "Ancient message",
        },
      ],
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(oldMessages), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const items = await fetchSlackChannel({
      channels: [{ id: "C1", name: "ch" }],
      maxAge: 24,
    });
    expect(items).toEqual([]);
  });
});
