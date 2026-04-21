import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { join } from "path";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "fs";

// ── Fixture Paths ────────────────────────────────────────

const FIXTURE_DIR = join(process.cwd(), "state", "test-integrations");
const CAL_FIXTURE = join(FIXTURE_DIR, "calendar-events.json");
const EMAIL_FIXTURE = join(FIXTURE_DIR, "email-threads.json");
const ZOTERO_FIXTURE = join(FIXTURE_DIR, "zotero-items.json");
const FIXED_NOW = new Date("2026-04-10T08:00:00Z");

// ── Fixture Data ─────────────────────────────────────────

function buildCalendarFixture() {
  const today = FIXED_NOW.toISOString().slice(0, 10);
  const tomorrow = new Date(FIXED_NOW.getTime() + 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  return [
    {
      id: "cal-today-1",
      title: "Morning Standup",
      start: `${today}T23:00:00Z`,
      end: `${today}T23:30:00Z`,
      attendees: [
        { name: "Alice", email: "alice@example.com" },
        { name: "Bob", email: "bob@example.com" },
      ],
      location: "Room 101",
      description: "Daily sync",
    },
    {
      id: "cal-tomorrow-1",
      title: "Planning Meeting",
      start: `${tomorrow}T14:00:00Z`,
      end: `${tomorrow}T15:00:00Z`,
      attendees: [{ name: "Charlie", email: "charlie@example.com" }],
    },
    {
      id: "cal-past-1",
      title: "Old Event",
      start: "2025-01-01T10:00:00Z",
      end: "2025-01-01T11:00:00Z",
      attendees: [],
    },
  ];
}

function buildEmailFixture() {
  return [
    {
      id: "thread-recent-1",
      subject: "Protein folding results",
      participants: [{ name: "Dr. Wei", email: "wei@lab.edu" }],
      messages: [
        {
          from: "wei@lab.edu",
          date: new Date(FIXED_NOW.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString(),
          body: "The RMSD values look promising for the alpha helix.",
          snippet: "The RMSD values look promising",
        },
      ],
      labels: ["INBOX", "research"],
    },
    {
      id: "thread-recent-2",
      subject: "Conference deadline reminder",
      participants: [{ name: "Prof. Smith", email: "smith@uni.edu" }],
      messages: [
        {
          from: "smith@uni.edu",
          date: new Date(FIXED_NOW.getTime() - 1 * 24 * 60 * 60 * 1000).toISOString(),
          body: "ICML submission deadline is next Friday.",
          snippet: "ICML submission deadline",
        },
      ],
      labels: ["INBOX"],
    },
    {
      id: "thread-old-1",
      subject: "Equipment maintenance",
      participants: [{ name: "Lab Mgr", email: "labmgr@uni.edu" }],
      messages: [
        {
          from: "labmgr@uni.edu",
          date: "2025-01-01T10:00:00Z",
          body: "Centrifuge repaired.",
          snippet: "Centrifuge repaired.",
        },
      ],
      labels: ["equipment"],
    },
  ];
}

const zoteroFixture = [
  {
    key: "ZOT001",
    title: "Attention Is All You Need",
    authors: ["Vaswani", "Shazeer"],
    year: 2017,
    doi: "10.48550/arXiv.1706.03762",
    abstract: "Dominant sequence transduction models use complex RNNs.",
    tags: ["transformers", "attention"],
    collections: ["neural-arch"],
    dateAdded: "2026-03-15T10:00:00Z",
    dateModified: "2026-04-01T12:00:00Z",
  },
  {
    key: "ZOT002",
    title: "AlphaFold2",
    authors: ["Jumper", "Evans"],
    year: 2021,
    doi: "10.1038/s41586-021-03819-2",
    abstract: "Protein structure prediction.",
    tags: ["protein-folding"],
    collections: ["protein-research"],
    dateAdded: "2026-02-10T08:00:00Z",
    dateModified: "2026-03-20T14:00:00Z",
  },
];

// ── Setup / Teardown ─────────────────────────────────────

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
  mkdirSync(FIXTURE_DIR, { recursive: true });
  writeFileSync(CAL_FIXTURE, JSON.stringify(buildCalendarFixture()));
  writeFileSync(EMAIL_FIXTURE, JSON.stringify(buildEmailFixture()));
  writeFileSync(ZOTERO_FIXTURE, JSON.stringify(zoteroFixture));
});

afterEach(() => {
  vi.resetModules();
  vi.useRealTimers();
  if (existsSync(FIXTURE_DIR)) {
    rmSync(FIXTURE_DIR, { recursive: true, force: true });
  }
});

// ── Calendar Tests ───────────────────────────────────────

describe("MockCalendarAdapter", () => {
  it("reads events from fixture file and getTodayEvents filters correctly", async () => {
    const { MockCalendarAdapter } = await import(
      "@/lib/integrations/calendar"
    );
    const adapter = new MockCalendarAdapter(CAL_FIXTURE);

    const todayEvents = await adapter.getTodayEvents();

    // Only the event whose start date matches today
    expect(todayEvents).toHaveLength(1);
    expect(todayEvents[0].id).toBe("cal-today-1");
    expect(todayEvents[0].title).toBe("Morning Standup");
    expect(todayEvents[0].attendees).toHaveLength(2);
    expect(todayEvents[0].attendees[0].name).toBe("Alice");
    expect(todayEvents[0].attendees[0].email).toBe("alice@example.com");
  });

  it("getUpcomingEvents returns only future events within range", async () => {
    const { MockCalendarAdapter } = await import(
      "@/lib/integrations/calendar"
    );
    const adapter = new MockCalendarAdapter(CAL_FIXTURE);

    const upcoming = await adapter.getUpcomingEvents(3);

    // Today and tomorrow events, not the past one
    const ids = upcoming.map((e) => e.id);
    expect(ids).toContain("cal-today-1");
    expect(ids).toContain("cal-tomorrow-1");
    expect(ids).not.toContain("cal-past-1");
  });

  it("getEventAttendees returns attendees for a specific event", async () => {
    const { MockCalendarAdapter } = await import(
      "@/lib/integrations/calendar"
    );
    const adapter = new MockCalendarAdapter(CAL_FIXTURE);

    const attendees = await adapter.getEventAttendees("cal-today-1");

    expect(attendees).toHaveLength(2);
    expect(attendees[0]).toEqual({
      name: "Alice",
      email: "alice@example.com",
    });
    expect(attendees[1]).toEqual({
      name: "Bob",
      email: "bob@example.com",
    });
  });

  it("getEventAttendees returns empty array for unknown event", async () => {
    const { MockCalendarAdapter } = await import(
      "@/lib/integrations/calendar"
    );
    const adapter = new MockCalendarAdapter(CAL_FIXTURE);

    const attendees = await adapter.getEventAttendees("nonexistent");

    expect(attendees).toEqual([]);
  });

  it("returns empty array when fixture file does not exist", async () => {
    const { MockCalendarAdapter } = await import(
      "@/lib/integrations/calendar"
    );
    const adapter = new MockCalendarAdapter("/nonexistent/path.json");

    const events = await adapter.getTodayEvents();

    expect(events).toEqual([]);
  });
});

describe("createCalendarAdapter", () => {
  it("returns MockCalendarAdapter when no credentials are set", async () => {
    vi.stubEnv("GOOGLE_CALENDAR_CREDENTIALS", "");
    const { createCalendarAdapter, MockCalendarAdapter } = await import(
      "@/lib/integrations/calendar"
    );

    const adapter = createCalendarAdapter();

    expect(adapter).toBeInstanceOf(MockCalendarAdapter);
  });

  it("returns GoogleCalendarAdapter when credentials are set", async () => {
    vi.stubEnv("GOOGLE_CALENDAR_CREDENTIALS", "fake-token-123");
    const { createCalendarAdapter, GoogleCalendarAdapter } = await import(
      "@/lib/integrations/calendar"
    );

    const adapter = createCalendarAdapter();

    expect(adapter).toBeInstanceOf(GoogleCalendarAdapter);
  });
});

// ── Email Tests ──────────────────────────────────────────

describe("MockEmailAdapter", () => {
  it("reads threads from fixture and search filters by query", async () => {
    const { MockEmailAdapter } = await import("@/lib/integrations/email");
    const adapter = new MockEmailAdapter(EMAIL_FIXTURE);

    const results = await adapter.searchThreads("protein");

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("thread-recent-1");
    expect(results[0].subject).toBe("Protein folding results");
    expect(results[0].participants[0].email).toBe("wei@lab.edu");
  });

  it("getRecentThreads filters by maxAge", async () => {
    const { MockEmailAdapter } = await import("@/lib/integrations/email");
    const adapter = new MockEmailAdapter(EMAIL_FIXTURE);

    const recent = await adapter.getRecentThreads(30);

    // Only the two recent threads, not the year-old one
    expect(recent).toHaveLength(2);
    const ids = recent.map((t) => t.id);
    expect(ids).toContain("thread-recent-1");
    expect(ids).toContain("thread-recent-2");
    expect(ids).not.toContain("thread-old-1");
  });

  it("getThread returns a specific thread by ID", async () => {
    const { MockEmailAdapter } = await import("@/lib/integrations/email");
    const adapter = new MockEmailAdapter(EMAIL_FIXTURE);

    const thread = await adapter.getThread("thread-recent-2");

    expect(thread).not.toBeNull();
    expect(thread!.subject).toBe("Conference deadline reminder");
    expect(thread!.messages).toHaveLength(1);
    expect(thread!.messages[0].from).toBe("smith@uni.edu");
  });

  it("getThread returns null for unknown thread ID", async () => {
    const { MockEmailAdapter } = await import("@/lib/integrations/email");
    const adapter = new MockEmailAdapter(EMAIL_FIXTURE);

    const thread = await adapter.getThread("nonexistent");

    expect(thread).toBeNull();
  });

  it("searchThreads matches on body content", async () => {
    const { MockEmailAdapter } = await import("@/lib/integrations/email");
    const adapter = new MockEmailAdapter(EMAIL_FIXTURE);

    const results = await adapter.searchThreads("ICML");

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("thread-recent-2");
  });

  it("returns empty array when fixture file does not exist", async () => {
    const { MockEmailAdapter } = await import("@/lib/integrations/email");
    const adapter = new MockEmailAdapter("/nonexistent/path.json");

    const threads = await adapter.getRecentThreads(7);

    expect(threads).toEqual([]);
  });
});

describe("createEmailAdapter", () => {
  it("returns MockEmailAdapter when no credentials are set", async () => {
    vi.stubEnv("GMAIL_CREDENTIALS", "");
    const { createEmailAdapter, MockEmailAdapter } = await import(
      "@/lib/integrations/email"
    );

    const adapter = createEmailAdapter();

    expect(adapter).toBeInstanceOf(MockEmailAdapter);
  });

  it("returns GmailAdapter when credentials are set", async () => {
    vi.stubEnv("GMAIL_CREDENTIALS", "fake-token");
    const { createEmailAdapter, GmailAdapter } = await import(
      "@/lib/integrations/email"
    );

    const adapter = createEmailAdapter();

    expect(adapter).toBeInstanceOf(GmailAdapter);
  });
});

// ── Zotero Tests ─────────────────────────────────────────

describe("MockZoteroAdapter", () => {
  it("reads items from fixture file", async () => {
    const { MockZoteroAdapter } = await import("@/lib/integrations/zotero");
    const adapter = new MockZoteroAdapter(ZOTERO_FIXTURE);

    const items = await adapter.getItems();

    expect(items).toHaveLength(2);
    expect(items[0].key).toBe("ZOT001");
    expect(items[0].title).toBe("Attention Is All You Need");
    expect(items[0].authors).toEqual(["Vaswani", "Shazeer"]);
    expect(items[0].year).toBe(2017);
    expect(items[0].doi).toBe("10.48550/arXiv.1706.03762");
    expect(items[0].tags).toEqual(["transformers", "attention"]);
  });

  it("incremental sync uses since parameter", async () => {
    const { MockZoteroAdapter } = await import("@/lib/integrations/zotero");
    const adapter = new MockZoteroAdapter(ZOTERO_FIXTURE);

    // Only items modified after March 25 should return the first item
    const items = await adapter.getItems("2026-03-25T00:00:00Z");

    expect(items).toHaveLength(1);
    expect(items[0].key).toBe("ZOT001");
    expect(items[0].dateModified).toBe("2026-04-01T12:00:00Z");
  });

  it("getItem returns a specific item by key", async () => {
    const { MockZoteroAdapter } = await import("@/lib/integrations/zotero");
    const adapter = new MockZoteroAdapter(ZOTERO_FIXTURE);

    const item = await adapter.getItem("ZOT002");

    expect(item).not.toBeNull();
    expect(item!.title).toBe("AlphaFold2");
    expect(item!.year).toBe(2021);
  });

  it("getItem returns null for unknown key", async () => {
    const { MockZoteroAdapter } = await import("@/lib/integrations/zotero");
    const adapter = new MockZoteroAdapter(ZOTERO_FIXTURE);

    const item = await adapter.getItem("UNKNOWN");

    expect(item).toBeNull();
  });

  it("getCollections returns collections derived from items", async () => {
    const { MockZoteroAdapter } = await import("@/lib/integrations/zotero");
    const adapter = new MockZoteroAdapter(ZOTERO_FIXTURE);

    const collections = await adapter.getCollections();

    expect(collections).toHaveLength(2);
    const names = collections.map((c) => c.name);
    expect(names).toContain("neural-arch");
    expect(names).toContain("protein-research");
  });

  it("converts items to ParsedReference format", async () => {
    const { zoteroItemsToReferences } = await import(
      "@/lib/integrations/zotero"
    );

    const refs = zoteroItemsToReferences(zoteroFixture);

    expect(refs).toHaveLength(2);

    // First reference
    expect(refs[0].bibtexKey).toBe("zotero:ZOT001");
    expect(refs[0].title).toBe("Attention Is All You Need");
    expect(refs[0].authors).toEqual(["Vaswani", "Shazeer"]);
    expect(refs[0].year).toBe(2017);
    expect(refs[0].doi).toBe("10.48550/arXiv.1706.03762");
    expect(refs[0].keywords).toEqual(["transformers", "attention"]);
    expect(refs[0].entryType).toBe("article");
    expect(refs[0].rawEntry).toContain("ZOT001");

    // Second reference
    expect(refs[1].bibtexKey).toBe("zotero:ZOT002");
    expect(refs[1].title).toBe("AlphaFold2");
    expect(refs[1].year).toBe(2021);
  });
});

describe("createZoteroAdapter", () => {
  it("returns MockZoteroAdapter when no credentials are set", async () => {
    vi.stubEnv("ZOTERO_API_KEY", "");
    vi.stubEnv("ZOTERO_USER_ID", "");
    const { createZoteroAdapter, MockZoteroAdapter } = await import(
      "@/lib/integrations/zotero"
    );

    const adapter = createZoteroAdapter();

    expect(adapter).toBeInstanceOf(MockZoteroAdapter);
  });

  it("returns ZoteroApiAdapter when both credentials are set", async () => {
    vi.stubEnv("ZOTERO_API_KEY", "fake-key");
    vi.stubEnv("ZOTERO_USER_ID", "12345");
    const { createZoteroAdapter, ZoteroApiAdapter } = await import(
      "@/lib/integrations/zotero"
    );

    const adapter = createZoteroAdapter();

    expect(adapter).toBeInstanceOf(ZoteroApiAdapter);
  });

  it("returns MockZoteroAdapter when only API key is set", async () => {
    vi.stubEnv("ZOTERO_API_KEY", "fake-key");
    vi.stubEnv("ZOTERO_USER_ID", "");
    const { createZoteroAdapter, MockZoteroAdapter } = await import(
      "@/lib/integrations/zotero"
    );

    const adapter = createZoteroAdapter();

    expect(adapter).toBeInstanceOf(MockZoteroAdapter);
  });
});

// ── Integration Manager Tests ────────────────────────────

describe("Integration Manager", () => {
  it("getIntegrationStatus returns status for all providers", async () => {
    // No credentials set — all disabled
    vi.stubEnv("GOOGLE_CALENDAR_CREDENTIALS", "");
    vi.stubEnv("GMAIL_CREDENTIALS", "");
    vi.stubEnv("ZOTERO_API_KEY", "");
    vi.stubEnv("ZOTERO_USER_ID", "");

    const { getIntegrationStatus } = await import("@/lib/integrations");

    const status = await getIntegrationStatus();

    expect(Object.keys(status)).toEqual(
      expect.arrayContaining(["google-calendar", "gmail", "zotero"]),
    );
    expect(status["google-calendar"].enabled).toBe(false);
    expect(status.gmail.enabled).toBe(false);
    expect(status.zotero.enabled).toBe(false);
  });

  it("syncAll runs only enabled adapters and skips disabled ones", async () => {
    // All disabled
    vi.stubEnv("GOOGLE_CALENDAR_CREDENTIALS", "");
    vi.stubEnv("GMAIL_CREDENTIALS", "");
    vi.stubEnv("ZOTERO_API_KEY", "");
    vi.stubEnv("ZOTERO_USER_ID", "");

    const { syncAll } = await import("@/lib/integrations");

    const report = await syncAll({
      root: "/tmp/test-brain",
      extractionModel: "test",
      synthesisModel: "test",
      rippleCap: 5,
      paperWatchBudget: 10,
      serendipityRate: 0.1,
    });

    // No providers should have run
    expect(report.results).toHaveLength(0);
    expect(report.timestamp).toBeTruthy();
    // Verify ISO timestamp format
    expect(new Date(report.timestamp).toISOString()).toBe(report.timestamp);
  });

  it("syncAll runs enabled calendar adapter and reports count", async () => {
    vi.stubEnv("GOOGLE_CALENDAR_CREDENTIALS", "fake-token");
    vi.stubEnv("GMAIL_CREDENTIALS", "");
    vi.stubEnv("ZOTERO_API_KEY", "");
    vi.stubEnv("ZOTERO_USER_ID", "");

    // Mock fetch for the Google Calendar API call
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ items: [
        {
          id: "gcal-1",
          summary: "Test Event",
          start: { dateTime: new Date().toISOString() },
          end: { dateTime: new Date().toISOString() },
        },
      ] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { syncAll } = await import("@/lib/integrations");

    const report = await syncAll({
      root: "/tmp/test-brain",
      extractionModel: "test",
      synthesisModel: "test",
      rippleCap: 5,
      paperWatchBudget: 10,
      serendipityRate: 0.1,
    });

    // Only calendar should have synced
    expect(report.results).toHaveLength(1);
    expect(report.results[0].provider).toBe("google-calendar");
    expect(report.results[0].success).toBe(true);
    expect(report.results[0].itemsSynced).toBe(1);
  });

  it("syncAll imports Zotero items into paper pages instead of only counting them", async () => {
    vi.stubEnv("GOOGLE_CALENDAR_CREDENTIALS", "");
    vi.stubEnv("GMAIL_CREDENTIALS", "");
    vi.stubEnv("ZOTERO_API_KEY", "fake-key");
    vi.stubEnv("ZOTERO_USER_ID", "12345");

    const brainRoot = join(FIXTURE_DIR, "brain");
    mkdirSync(brainRoot, { recursive: true });

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            key: "ZOT001",
            data: {
              title: "Attention Is All You Need",
              creators: [
                { firstName: "Ashish", lastName: "Vaswani" },
                { firstName: "Noam", lastName: "Shazeer" },
              ],
              date: "2017",
              DOI: "10.48550/arXiv.1706.03762",
              abstractNote: "Dominant sequence transduction models use complex RNNs.",
              tags: [{ tag: "transformers" }, { tag: "attention" }],
              collections: ["neural-arch"],
              dateAdded: "2026-03-15T10:00:00Z",
              dateModified: "2026-04-01T12:00:00Z",
            },
          },
        ]),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { syncAll } = await import("@/lib/integrations");

    const report = await syncAll({
      root: brainRoot,
      extractionModel: "test",
      synthesisModel: "test",
      rippleCap: 5,
      paperWatchBudget: 10,
      serendipityRate: 0.1,
    });

    expect(report.results).toHaveLength(1);
    expect(report.results[0].provider).toBe("zotero");
    expect(report.results[0].success).toBe(true);
    expect(report.results[0].itemsSynced).toBe(1);
    expect(report.results[0].pagesCreated).toBe(1);
    expect(
      existsSync(join(brainRoot, "wiki/entities/papers/vaswani-2017-attention-is-all.md")),
    ).toBe(true);
  });
});

// ── API Route Tests ──────────────────────────────────────

describe("GET /api/brain/integrations", () => {
  it("returns integration status for all providers", async () => {
    vi.stubEnv("GOOGLE_CALENDAR_CREDENTIALS", "");
    vi.stubEnv("GMAIL_CREDENTIALS", "");
    vi.stubEnv("ZOTERO_API_KEY", "");
    vi.stubEnv("ZOTERO_USER_ID", "");

    const { GET } = await import("@/app/api/brain/integrations/route");

    const response = await GET();

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.integrations).toBeDefined();
    expect(body.integrations["google-calendar"].enabled).toBe(false);
    expect(body.integrations.gmail.enabled).toBe(false);
    expect(body.integrations.zotero.enabled).toBe(false);
  });
});

describe("POST /api/brain/integrations", () => {
  it("rejects missing fields", async () => {
    const { POST } = await import("@/app/api/brain/integrations/route");

    const request = new Request("http://localhost/api/brain/integrations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    const response = await POST(request);

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("Missing required fields");
  });

  it("rejects invalid provider", async () => {
    const { POST } = await import("@/app/api/brain/integrations/route");

    const request = new Request("http://localhost/api/brain/integrations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "invalid", action: "sync" }),
    });

    const response = await POST(request);

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("Invalid provider");
  });

  it("rejects invalid action", async () => {
    const { POST } = await import("@/app/api/brain/integrations/route");

    const request = new Request("http://localhost/api/brain/integrations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "gmail", action: "delete" }),
    });

    const response = await POST(request);

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("Invalid action");
  });

  it("sync returns 422 when provider is not configured", async () => {
    vi.stubEnv("GOOGLE_CALENDAR_CREDENTIALS", "");
    vi.stubEnv("GMAIL_CREDENTIALS", "");
    vi.stubEnv("ZOTERO_API_KEY", "");
    vi.stubEnv("ZOTERO_USER_ID", "");

    // Mock brain config
    vi.doMock("@/brain/config", () => ({
      loadBrainConfig: () => ({
        root: "/tmp/test-brain",
        extractionModel: "test",
        synthesisModel: "test",
        rippleCap: 5,
        paperWatchBudget: 10,
        serendipityRate: 0.1,
      }),
    }));

    const { POST } = await import("@/app/api/brain/integrations/route");

    const request = new Request("http://localhost/api/brain/integrations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "gmail", action: "sync" }),
    });

    const response = await POST(request);

    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.error).toContain("not configured");
  });

  it("configure action returns acknowledgement", async () => {
    const { POST } = await import("@/app/api/brain/integrations/route");

    const request = new Request("http://localhost/api/brain/integrations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "zotero", action: "configure" }),
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.message).toContain("zotero");
    expect(body.provider).toBe("zotero");
  });

  it("sync returns Zotero import details when the provider is configured", async () => {
    vi.stubEnv("GOOGLE_CALENDAR_CREDENTIALS", "");
    vi.stubEnv("GMAIL_CREDENTIALS", "");
    vi.stubEnv("ZOTERO_API_KEY", "fake-key");
    vi.stubEnv("ZOTERO_USER_ID", "12345");

    const brainRoot = join(FIXTURE_DIR, "route-brain");
    mkdirSync(brainRoot, { recursive: true });

    vi.doMock("@/brain/config", () => ({
      loadBrainConfig: () => ({
        root: brainRoot,
        extractionModel: "test",
        synthesisModel: "test",
        rippleCap: 5,
        paperWatchBudget: 10,
        serendipityRate: 0.1,
      }),
    }));

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            key: "ZOT002",
            data: {
              title: "AlphaFold2",
              creators: [{ firstName: "John", lastName: "Jumper" }],
              date: "2021",
              DOI: "10.1038/s41586-021-03819-2",
              abstractNote: "Protein structure prediction.",
              tags: [{ tag: "protein-folding" }],
              collections: ["protein-research"],
              dateAdded: "2026-02-10T08:00:00Z",
              dateModified: "2026-03-20T14:00:00Z",
            },
          },
        ]),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { POST } = await import("@/app/api/brain/integrations/route");

    const request = new Request("http://localhost/api/brain/integrations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "zotero", action: "sync" }),
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.sync.provider).toBe("zotero");
    expect(body.sync.itemsSynced).toBe(1);
    expect(body.sync.pagesCreated).toBe(1);
  });

  it("rejects invalid JSON body", async () => {
    const { POST } = await import("@/app/api/brain/integrations/route");

    const request = new Request("http://localhost/api/brain/integrations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });

    const response = await POST(request);

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("Invalid JSON");
  });
});
