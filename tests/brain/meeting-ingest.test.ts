import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { initBrain } from "@/brain/init";
import { resetBrainStore } from "@/brain/store";

const TEST_ROOT = join(tmpdir(), "scienceswarm-brain-test-meeting");

// ── Mocks ─────────────────────────────────────────────

const mockLoadBrainConfig = vi.fn();
vi.mock("@/brain/config", () => ({
  loadBrainConfig: () => mockLoadBrainConfig(),
  resolveBrainRoot: () => TEST_ROOT,
  brainExists: () => true,
}));

// Track LLM calls for assertion
const llmCalls: Array<{ system: string; user: string }> = [];

vi.mock("@/brain/llm", () => ({
  createLLMClient: () => ({
    async complete(call: { system: string; user: string }) {
      llmCalls.push(call);
      return {
        content: JSON.stringify({
          summary: "Team discussed project priorities and next steps.",
          decisions: [
            {
              title: "Switch to PostgreSQL",
              description: "Alice proposed switching from SQLite to PostgreSQL for production.",
            },
          ],
          tasks: [
            {
              assignee: "Bob Smith",
              title: "Benchmark PostgreSQL",
              description: "Run performance benchmarks comparing SQLite vs PostgreSQL.",
            },
          ],
          openThreads: [
            {
              topic: "Migration timeline",
              context: "Need to decide on a migration date — blocked on benchmarks.",
            },
          ],
          keyTopics: ["database migration", "performance benchmarks"],
        }),
        cost: {
          inputTokens: 200,
          outputTokens: 100,
          estimatedUsd: 0.02,
          model: "test",
        },
      };
    },
  }),
}));

// ── Helpers ───────────────────────────────────────────

function makeTestConfig() {
  return {
    root: TEST_ROOT,
    extractionModel: "test-model",
    synthesisModel: "test-model",
    rippleCap: 15,
    paperWatchBudget: 50,
    serendipityRate: 0.2,
  };
}

async function setupBrain() {
  await resetBrainStore();
  rmSync(TEST_ROOT, { recursive: true, force: true });
  initBrain({ root: TEST_ROOT, name: "Test Researcher" });
  // Create meetings directory
  mkdirSync(join(TEST_ROOT, "wiki/meetings"), { recursive: true });
  mockLoadBrainConfig.mockReturnValue(makeTestConfig());
  llmCalls.length = 0;
}

async function teardownBrain() {
  await resetBrainStore();
  rmSync(TEST_ROOT, { recursive: true, force: true });
  mockLoadBrainConfig.mockReset();
  llmCalls.length = 0;
  vi.restoreAllMocks();
}

const DIARIZED_TRANSCRIPT = `Alice Johnson (00:00): Welcome everyone. Let's discuss the database migration.
Bob Smith (00:15): I've been looking at PostgreSQL performance numbers.
Alice Johnson (01:02): That's great. I think we should switch to PostgreSQL for production.
Bob Smith (01:30): I can run benchmarks this week. Should have results by Friday.
Alice Johnson (02:00): Perfect. Let's revisit the migration timeline once we have those numbers.`;

const PLAIN_TRANSCRIPT = `Meeting about database migration.

We discussed the possibility of switching from SQLite to PostgreSQL.
Bob mentioned he could run benchmarks.
Alice suggested we revisit the timeline after results are in.`;

const CIRCLEBACK_JSON = JSON.stringify({
  title: "Database Strategy Meeting",
  date: "2026-04-09",
  attendees: ["Alice Johnson", "Bob Smith"],
  transcript: [
    { speaker: "Alice Johnson", timestamp: "00:00", text: "Welcome everyone." },
    { speaker: "Bob Smith", timestamp: "00:15", text: "Let me share the PostgreSQL numbers." },
  ],
  notes: "Discussion about database migration strategy.",
  action_items: [
    { text: "Run PostgreSQL benchmarks", assignee: "Bob Smith" },
    { text: "Draft migration plan", assignee: "Alice Johnson" },
  ],
});

// ── Tests ─────────────────────────────────────────────

describe("parseMeetingTranscript", () => {
  let parseMeetingTranscript: typeof import("@/brain/meeting-ingest").parseMeetingTranscript;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import("@/brain/meeting-ingest");
    parseMeetingTranscript = mod.parseMeetingTranscript;
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("parses diarized transcript with timestamps", () => {
    const result = parseMeetingTranscript(DIARIZED_TRANSCRIPT);

    expect(result.segments.length).toBeGreaterThanOrEqual(2);
    expect(result.attendees).toContain("Alice Johnson");
    expect(result.attendees).toContain("Bob Smith");
    expect(result.segments[0].speaker).toBe("Alice Johnson");
    expect(result.segments[0].timestamp).toBe("00:00");
    expect(result.segments[0].text).toContain("Welcome everyone");
    expect(result.segments[1].speaker).toBe("Bob Smith");
    expect(result.segments[1].timestamp).toBe("00:15");
  });

  it("parses plain text transcript as fallback", () => {
    const result = parseMeetingTranscript(PLAIN_TRANSCRIPT);

    // Plain text has no segments (no diarization)
    expect(result.segments).toHaveLength(0);
    expect(result.rawText).toBe(PLAIN_TRANSCRIPT);
    expect(result.attendees).toHaveLength(0);
    expect(result.title).toBe("Meeting about database migration");
  });

  it("parses Circleback JSON format", () => {
    const result = parseMeetingTranscript(CIRCLEBACK_JSON);

    expect(result.title).toBe("Database Strategy Meeting");
    expect(result.date).toBe("2026-04-09");
    expect(result.attendees).toContain("Alice Johnson");
    expect(result.attendees).toContain("Bob Smith");
    expect(result.segments.length).toBe(2);
    expect(result.segments[0].speaker).toBe("Alice Johnson");
    expect(result.rawText).toContain("Discussion about database migration");
    expect(result.rawText).toContain("Run PostgreSQL benchmarks");
  });

  it("extracts attendee names from diarized format", () => {
    const transcript = `Dr. Jane Doe (10:00): First point.
Prof. John Smith (10:05): Second point.
Dr. Jane Doe (10:10): Follow up.`;

    const result = parseMeetingTranscript(transcript);
    expect(result.attendees).toHaveLength(2);
    expect(result.attendees).toContain("Dr. Jane Doe");
    expect(result.attendees).toContain("Prof. John Smith");
  });
});

describe("ingestMeeting", () => {
  let ingestMeeting: typeof import("@/brain/meeting-ingest").ingestMeeting;
  let parseMeetingTranscript: typeof import("@/brain/meeting-ingest").parseMeetingTranscript;

  beforeEach(async () => {
    vi.resetModules();
    setupBrain();
    const mod = await import("@/brain/meeting-ingest");
    ingestMeeting = mod.ingestMeeting;
    parseMeetingTranscript = mod.parseMeetingTranscript;
  });

  afterEach(() => {
    teardownBrain();
    vi.resetModules();
  });

  it("creates meeting page with summary and transcript", async () => {
    const transcript = parseMeetingTranscript(DIARIZED_TRANSCRIPT);
    transcript.title = "DB Migration Standup";
    transcript.date = "2026-04-09";

    const config = makeTestConfig();
    const llm = (await import("@/brain/llm")).createLLMClient(config);

    const result = await ingestMeeting(config, llm, transcript);

    // Meeting page was created
    expect(result.meetingPagePath).toMatch(/^wiki\/meetings\/2026-04-09-.+\.md$/);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    // Read back and verify content
    const meetingContent = readFileSync(
      join(TEST_ROOT, result.meetingPagePath),
      "utf-8"
    );
    expect(meetingContent).toContain("# DB Migration Standup");
    expect(meetingContent).toContain("## Summary");
    expect(meetingContent).toContain("Team discussed project priorities");
    expect(meetingContent).toContain("## Full Transcript");
    expect(meetingContent).toContain("Alice Johnson");
    expect(meetingContent).toContain("Bob Smith");
    // Verify frontmatter
    expect(meetingContent).toContain("date: 2026-04-09");
    expect(meetingContent).toContain("tags: [meeting]");
  });

  it("creates attendee pages for new people", async () => {
    const transcript = parseMeetingTranscript(DIARIZED_TRANSCRIPT);
    transcript.title = "Team Sync";
    transcript.date = "2026-04-09";

    const config = makeTestConfig();
    const llm = (await import("@/brain/llm")).createLLMClient(config);

    const result = await ingestMeeting(config, llm, transcript);

    // New person pages should be created
    expect(result.attendeePagesCreated.length).toBeGreaterThanOrEqual(2);

    // Verify Alice's page exists with expected content
    const alicePath = result.attendeePagesCreated.find((p) =>
      p.includes("alice")
    );
    expect(alicePath).toBeDefined();

    const aliceContent = readFileSync(
      join(TEST_ROOT, alicePath!),
      "utf-8"
    );
    expect(aliceContent).toContain("# Alice Johnson");
    expect(aliceContent).toContain("type: person");
    expect(aliceContent).toContain("## Executive Summary");
    expect(aliceContent).toContain("## Open Threads");
    expect(aliceContent).toContain("## Recent Meetings");
    expect(aliceContent).toContain("## Timeline");
  });

  it("updates existing attendee pages", async () => {
    const config = makeTestConfig();

    // Pre-create Alice's person page
    const peopleDir = join(TEST_ROOT, "wiki/entities/people");
    mkdirSync(peopleDir, { recursive: true });
    const alicePath = join(peopleDir, "alice-johnson.md");
    writeFileSync(
      alicePath,
      [
        "---",
        'title: "Alice Johnson"',
        "date: 2026-04-01",
        "type: person",
        "para: resources",
        "tags: [person]",
        'name: "Alice Johnson"',
        "relationship: team-member",
        "meetingCount: 2",
        "---",
        "",
        "# Alice Johnson",
        "",
        "## Executive Summary",
        "",
        "Alice is a database engineer.",
        "",
        "## Recent Meetings",
        "",
        "- **2026-04-01** | [[wiki/meetings/2026-04-01-kickoff.md]]",
        "",
        "## Open Threads",
        "",
        "None yet.",
        "",
        "## Key Topics",
        "",
        "None yet.",
        "",
        "## Timeline",
        "",
        "- **2026-04-01** | Meeting — Kickoff",
        "",
      ].join("\n")
    );

    const transcript = parseMeetingTranscript(DIARIZED_TRANSCRIPT);
    transcript.title = "Follow-up";
    transcript.date = "2026-04-09";

    const llm = (await import("@/brain/llm")).createLLMClient(config);
    const result = await ingestMeeting(config, llm, transcript);

    // Alice should be in updated, not created
    expect(result.attendeePagesUpdated).toContain(
      "wiki/entities/people/alice-johnson.md"
    );
    expect(
      result.attendeePagesCreated.find((p) => p.includes("alice"))
    ).toBeUndefined();

    // Read back Alice's page and verify updates
    const updatedContent = readFileSync(alicePath, "utf-8");
    // Meeting count incremented from 2 to 3
    expect(updatedContent).toContain("meetingCount: 3");
    // New meeting added to Recent Meetings
    expect(updatedContent).toContain("2026-04-09");
    // Timeline updated
    expect(updatedContent).toContain("## Timeline");
  });

  it("extracts decisions and creates decision pages", async () => {
    const transcript = parseMeetingTranscript(DIARIZED_TRANSCRIPT);
    transcript.title = "DB Decision Meeting";
    transcript.date = "2026-04-09";

    const config = makeTestConfig();
    const llm = (await import("@/brain/llm")).createLLMClient(config);

    const result = await ingestMeeting(config, llm, transcript);

    // LLM mock returns one decision
    expect(result.decisionsExtracted).toHaveLength(1);
    const decisionPath = result.decisionsExtracted[0];
    expect(decisionPath).toMatch(/^wiki\/decisions\/2026-04-09-.+\.md$/);

    // Read back decision page
    const decisionContent = readFileSync(
      join(TEST_ROOT, decisionPath),
      "utf-8"
    );
    expect(decisionContent).toContain("# Switch to PostgreSQL");
    expect(decisionContent).toContain("type: decision");
    expect(decisionContent).toContain("Alice proposed switching");
    expect(decisionContent).toContain(result.meetingPagePath);
  });

  it("extracts tasks and creates task pages", async () => {
    const transcript = parseMeetingTranscript(DIARIZED_TRANSCRIPT);
    transcript.title = "Task Meeting";
    transcript.date = "2026-04-09";

    const config = makeTestConfig();
    const llm = (await import("@/brain/llm")).createLLMClient(config);

    const result = await ingestMeeting(config, llm, transcript);

    // LLM mock returns one task
    expect(result.tasksExtracted).toHaveLength(1);
    const taskPath = result.tasksExtracted[0];
    expect(taskPath).toMatch(/^wiki\/tasks\/2026-04-09-.+\.md$/);

    // Read back task page
    const taskContent = readFileSync(
      join(TEST_ROOT, taskPath),
      "utf-8"
    );
    expect(taskContent).toContain("# Benchmark PostgreSQL");
    expect(taskContent).toContain("type: task");
    expect(taskContent).toContain("Bob Smith");
    expect(taskContent).toContain("status: open");
    expect(taskContent).toContain(result.meetingPagePath);
  });

  it("reuses legacy decision and task pages when they already exist", async () => {
    const transcript = parseMeetingTranscript(DIARIZED_TRANSCRIPT);
    transcript.title = "Legacy Taxonomy Meeting";
    transcript.date = "2026-04-09";

    const legacyDecisionPath = "wiki/entities/decisions/2026-04-09-switch-to-postgresql.md";
    const legacyTaskPath = "wiki/entities/tasks/2026-04-09-benchmark-postgresql.md";

    mkdirSync(join(TEST_ROOT, "wiki/entities/decisions"), { recursive: true });
    mkdirSync(join(TEST_ROOT, "wiki/entities/tasks"), { recursive: true });
    writeFileSync(join(TEST_ROOT, legacyDecisionPath), "# Existing decision");
    writeFileSync(join(TEST_ROOT, legacyTaskPath), "# Existing task");

    const config = makeTestConfig();
    const llm = (await import("@/brain/llm")).createLLMClient(config);

    const result = await ingestMeeting(config, llm, transcript);

    expect(result.decisionsExtracted).toContain(legacyDecisionPath);
    expect(result.tasksExtracted).toContain(legacyTaskPath);
    expect(
      existsSync(join(TEST_ROOT, "wiki/decisions/2026-04-09-switch-to-postgresql.md")),
    ).toBe(false);
    expect(
      existsSync(join(TEST_ROOT, "wiki/tasks/2026-04-09-benchmark-postgresql.md")),
    ).toBe(false);
  });

  it("creates bidirectional back-links between meeting and attendees", async () => {
    const transcript = parseMeetingTranscript(DIARIZED_TRANSCRIPT);
    transcript.title = "Backlink Test";
    transcript.date = "2026-04-09";

    const config = makeTestConfig();
    const llm = (await import("@/brain/llm")).createLLMClient(config);

    const result = await ingestMeeting(config, llm, transcript);

    // Meeting page should link to attendee pages
    const meetingContent = readFileSync(
      join(TEST_ROOT, result.meetingPagePath),
      "utf-8"
    );
    expect(meetingContent).toContain("wiki/entities/people/alice-johnson.md");
    expect(meetingContent).toContain("wiki/entities/people/bob-smith.md");

    // Attendee pages should link back to meeting page
    const alicePage = result.attendeePagesCreated.find((p) =>
      p.includes("alice")
    )!;
    const aliceContent = readFileSync(
      join(TEST_ROOT, alicePage),
      "utf-8"
    );
    expect(aliceContent).toContain(result.meetingPagePath);
  });

  it("identifies open threads from LLM analysis", async () => {
    const transcript = parseMeetingTranscript(DIARIZED_TRANSCRIPT);
    transcript.title = "Thread Test";
    transcript.date = "2026-04-09";

    const config = makeTestConfig();
    const llm = (await import("@/brain/llm")).createLLMClient(config);

    const result = await ingestMeeting(config, llm, transcript);

    expect(result.openThreads).toHaveLength(1);
    expect(result.openThreads[0]).toBe("Migration timeline");
  });

  it("does not duplicate person updates when the same meeting is re-ingested", async () => {
    const transcript = parseMeetingTranscript(DIARIZED_TRANSCRIPT);
    transcript.title = "Repeatable Meeting";
    transcript.date = "2026-04-09";

    const config = makeTestConfig();
    const llm = (await import("@/brain/llm")).createLLMClient(config);

    const first = await ingestMeeting(config, llm, transcript);
    const second = await ingestMeeting(config, llm, transcript);

    expect(second.meetingPagePath).toBe(first.meetingPagePath);

    const alicePath = join(TEST_ROOT, "wiki/entities/people/alice-johnson.md");
    const aliceContent = readFileSync(alicePath, "utf-8");

    expect(aliceContent).toContain("meetingCount: 1");
    expect(
      aliceContent.match(/- \*\*2026-04-09\*\* \| \[\[wiki\/meetings\/2026-04-09-repeatable-meeting\.md\]\]/g),
    ).toHaveLength(1);
    expect(
      aliceContent.match(/\*\*2026-04-09\*\* \| Meeting \[\[wiki\/meetings\/2026-04-09-repeatable-meeting\.md\]\]/g),
    ).toHaveLength(1);
    expect(
      aliceContent.match(/- database migration/g),
    ).toHaveLength(1);
  });
});

describe("getPersonBrief", () => {
  let getPersonBrief: typeof import("@/brain/person-manager").getPersonBrief;

  beforeEach(async () => {
    vi.resetModules();
    setupBrain();
    const mod = await import("@/brain/person-manager");
    getPersonBrief = mod.getPersonBrief;
  });

  afterEach(() => {
    teardownBrain();
    vi.resetModules();
  });

  it("returns null for non-existent person", () => {
    const config = makeTestConfig();
    const result = getPersonBrief(config, "Nobody");
    expect(result).toBeNull();
  });

  it("returns correct profile data for existing person", () => {
    const config = makeTestConfig();

    // Create a person page with data
    const peopleDir = join(TEST_ROOT, "wiki/entities/people");
    mkdirSync(peopleDir, { recursive: true });
    writeFileSync(
      join(peopleDir, "alice-johnson.md"),
      [
        "---",
        'title: "Alice Johnson"',
        "date: 2026-04-01",
        "type: person",
        "para: resources",
        "tags: [person]",
        'name: "Alice Johnson"',
        'role: "Database Engineer"',
        'affiliation: "ScienceSwarm Labs"',
        "relationship: team-member",
        "meetingCount: 3",
        "---",
        "",
        "# Alice Johnson",
        "",
        "## Open Threads",
        "",
        "- [ ] Finish migration plan (from [[wiki/meetings/2026-04-09-db.md]])",
        "- [ ] Review benchmarks (from [[wiki/meetings/2026-04-09-db.md]])",
        "",
        "## Key Topics",
        "",
        "- database migration",
        "- PostgreSQL",
        "",
        "## Timeline",
        "",
        "- **2026-04-01** | Meeting — Kickoff",
        "- **2026-04-09** | Meeting — Discussed migration",
        "",
      ].join("\n")
    );

    const result = getPersonBrief(config, "Alice Johnson");

    expect(result).not.toBeNull();
    expect(result!.name).toBe("Alice Johnson");
    expect(result!.role).toBe("Database Engineer");
    expect(result!.affiliation).toBe("ScienceSwarm Labs");
    expect(result!.relationship).toBe("team-member");
    expect(result!.meetingCount).toBe(3);
    expect(result!.openThreads).toHaveLength(2);
    expect(result!.openThreads[0]).toContain("Finish migration plan");
    expect(result!.keyTopics).toContain("database migration");
    expect(result!.keyTopics).toContain("PostgreSQL");
    expect(result!.lastInteraction).toBe("2026-04-09");
  });
});

describe("POST /api/brain/meeting", () => {
  beforeEach(async () => {
    vi.resetModules();
    setupBrain();
  });

  afterEach(() => {
    teardownBrain();
    vi.resetModules();
  });

  it("returns 400 when content is missing", async () => {
    const { POST } = await import("@/app/api/brain/meeting/route");

    const request = new Request("http://localhost/api/brain/meeting", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    const response = await POST(request);
    expect(response.status).toBe(400);

    const body = await response.json();
    expect(body.error).toBe("Missing required field: content");
  });

  it("returns 400 when attendees is not an array of strings", async () => {
    const { POST } = await import("@/app/api/brain/meeting/route");

    const request = new Request("http://localhost/api/brain/meeting", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hello", attendees: [123] }),
    });

    const response = await POST(request);
    expect(response.status).toBe(400);

    const body = await response.json();
    expect(body.error).toBe("attendees must be an array of strings");
  });

  it("ingests a valid transcript and returns MeetingIngestResult", async () => {
    const { POST } = await import("@/app/api/brain/meeting/route");

    const request = new Request("http://localhost/api/brain/meeting", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: DIARIZED_TRANSCRIPT,
        title: "API Test Meeting",
        date: "2026-04-09",
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.meetingPagePath).toMatch(/^wiki\/meetings\/2026-04-09-.+\.md$/);
    expect(body.attendeePagesCreated).toBeInstanceOf(Array);
    expect(body.attendeePagesCreated.length).toBeGreaterThanOrEqual(1);
    expect(body.decisionsExtracted).toBeInstanceOf(Array);
    expect(body.tasksExtracted).toBeInstanceOf(Array);
    expect(body.openThreads).toBeInstanceOf(Array);
    expect(typeof body.durationMs).toBe("number");

    // Verify meeting page was actually created on disk
    const meetingExists = existsSync(join(TEST_ROOT, body.meetingPagePath));
    expect(meetingExists).toBe(true);
  });

  it("uses explicit attendees when provided", async () => {
    const { POST } = await import("@/app/api/brain/meeting/route");

    const request = new Request("http://localhost/api/brain/meeting", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: PLAIN_TRANSCRIPT,
        title: "Explicit Attendees",
        date: "2026-04-09",
        attendees: ["Carol Davis", "Dave Wilson"],
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(200);

    const body = await response.json();

    // Should use the explicit attendees, not parsed ones (plain text has none)
    const createdPaths = body.attendeePagesCreated as string[];
    expect(
      createdPaths.some((p: string) => p.includes("carol"))
    ).toBe(true);
    expect(
      createdPaths.some((p: string) => p.includes("dave"))
    ).toBe(true);
  });
});
