import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync, appendFileSync, utimesSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { initBrain } from "@/brain/init";
import {
  buildMorningBrief,
  formatTelegramBrief,
} from "@/brain/research-briefing";
import { generateHealthReport } from "@/brain/brain-health";
import type { BrainHealthReport } from "@/brain/brain-health";
import { prepMeeting, loadCalendarEvents, buildMeetingPrepFromCalendar } from "@/brain/meeting-prep";
import { loadFrontierWatchItems } from "@/brain/frontier-loader";
import type { BrainConfig, MorningBrief } from "@/brain/types";
import type { LLMClient, LLMResponse } from "@/brain/llm";

let TEST_ROOT = "";
let BRAIN_ROOT = "";
const ORIGINAL_SCIENCESWARM_DIR = process.env.SCIENCESWARM_DIR;
const ORIGINAL_CALENDAR_PATH = process.env.BRAIN_CALENDAR_PATH;

function makeConfig(): BrainConfig {
  return {
    root: BRAIN_ROOT,
    extractionModel: "test-extraction",
    synthesisModel: "test-synthesis",
    rippleCap: 15,
    paperWatchBudget: 50,
    serendipityRate: 0.2,
  };
}

function assignTestRoots(): void {
  TEST_ROOT = mkdtempSync(join(tmpdir(), "scienceswarm-briefing-intelligence-test-"));
  BRAIN_ROOT = join(TEST_ROOT, "brain");
}

function mockLLM(): LLMClient {
  return {
    async complete(call): Promise<LLMResponse> {
      const cost = {
        inputTokens: 100,
        outputTokens: 50,
        estimatedUsd: 0.01,
        model: "test",
      };

      if (call.system.includes("contradiction detector")) {
        return {
          content: JSON.stringify({
            contradictions: [],
            tensions: [],
          }),
          cost,
        };
      }

      if (call.system.includes("morning briefing")) {
        return {
          content: JSON.stringify({
            topMatters: [
              {
                summary: "Frontier watch detected new CRISPR paper",
                whyItMatters: "Directly relevant to your active experiment.",
                evidence: ["wiki/entities/frontier/crispr-update.md"],
                urgency: "this-week",
              },
            ],
            nextMove: {
              recommendation: "Review the new CRISPR frontier paper.",
              reasoning: "It may change your experiment design.",
              assumptions: ["The paper is peer-reviewed."],
              missingEvidence: ["Replication data."],
            },
          }),
          cost,
        };
      }

      if (call.system.includes("meeting prep")) {
        return {
          content: JSON.stringify([
            "Discuss recent CRISPR efficiency results",
            "Review open thread on primer design",
            "Plan next experiment timeline",
          ]),
          cost,
        };
      }

      return {
        content: JSON.stringify({
          topMatters: [],
          nextMove: { recommendation: "Review priorities." },
        }),
        cost,
      };
    },
  };
}

function seedBrainContent() {
  mkdirSync(join(BRAIN_ROOT, "wiki/projects"), { recursive: true });
  mkdirSync(join(BRAIN_ROOT, "wiki/tasks"), { recursive: true });
  mkdirSync(join(BRAIN_ROOT, "wiki/entities/frontier"), { recursive: true });
  mkdirSync(join(BRAIN_ROOT, "wiki/entities/people"), { recursive: true });
  mkdirSync(join(BRAIN_ROOT, "wiki/entities/papers"), { recursive: true });
  mkdirSync(join(BRAIN_ROOT, "wiki/hypotheses"), { recursive: true });
  mkdirSync(join(BRAIN_ROOT, "wiki/observations"), { recursive: true });
  mkdirSync(join(BRAIN_ROOT, "wiki/experiments"), { recursive: true });
  mkdirSync(join(BRAIN_ROOT, "wiki/concepts"), { recursive: true });
  mkdirSync(join(BRAIN_ROOT, "state/projects/alpha"), { recursive: true });

  writeFileSync(
    join(BRAIN_ROOT, "wiki/projects/alpha.md"),
    "---\ntype: project\ntitle: Alpha Project\nstatus: active\n---\n# Alpha Project\n\n## Summary\nCRISPR sequencing project.\n\nRelated: [[Neel Nanda]]",
  );

  writeFileSync(
    join(BRAIN_ROOT, "wiki/tasks/alpha-task.md"),
    "---\ntype: task\ntitle: Run efficiency assay\nstatus: open\nproject: alpha\n---\n# Run efficiency assay\nNeed to verify CRISPR efficiency.",
  );

  writeFileSync(
    join(BRAIN_ROOT, "wiki/entities/frontier/crispr-update.md"),
    "---\ntitle: New CRISPR efficiency paper\ndate: 2026-04-09\ntype: frontier_item\npara: projects\ntags: [alpha, frontier]\nproject: alpha\nstatus: promoted\nconfidence: high\n---\n# New CRISPR efficiency paper\n\nNew approach to CRISPR with higher efficiency.\n\n## Why It Matters\n- matched crispr\n- matched alpha",
  );

  writeFileSync(
    join(BRAIN_ROOT, "wiki/entities/frontier/staged-item.md"),
    "---\ntitle: Adjacent sequencing technique\ndate: 2026-04-08\ntype: frontier_item\npara: projects\ntags: [alpha, frontier]\nproject: alpha\nstatus: staged\nconfidence: medium\n---\n# Adjacent sequencing technique\n\nA related sequencing method worth monitoring.",
  );

  writeFileSync(
    join(BRAIN_ROOT, "wiki/hypotheses/crispr-efficiency.md"),
    "---\ntype: hypothesis\ntitle: CRISPR efficiency is above 85%\nstatus: active\nproject: alpha\n---\n# CRISPR efficiency is above 85%\nHypothesis that our CRISPR system achieves high efficiency.\n\nMentions [[Neel Nanda]]",
  );

  writeFileSync(
    join(BRAIN_ROOT, "wiki/observations/obs-1.md"),
    "---\ntype: observation\ntitle: Low efficiency observed\nproject: alpha\n---\n# Low efficiency observed\nObserved CRISPR efficiency was only 60%.",
  );

  writeFileSync(
    join(BRAIN_ROOT, "wiki/experiments/alpha-assay.md"),
    "---\ntype: experiment\ntitle: Alpha efficiency assay\nstatus: running\nproject: alpha\n---\n# Alpha efficiency assay\nRunning experiment to measure CRISPR efficiency.",
  );

  // Person page for meeting prep tests
  writeFileSync(
    join(BRAIN_ROOT, "wiki/entities/people/neel-nanda.md"),
    "---\ntype: person\nname: Neel Nanda\ntitle: Neel Nanda\naffiliation: DeepMind\nrole: Research Scientist\nlast_interaction: 2026-04-01\n---\n# Neel Nanda\n\nResearch scientist at DeepMind focused on mechanistic interpretability.\n\n## Open Threads\n- [ ] Review Neel's latest paper on feature circuits\n- [ ] Discuss collaboration on CRISPR interpretability\nTODO: Send experiment results from alpha assay\n\n## Notes\nMet at NeurIPS 2025. Discussed 2026-03-15.",
  );

  // Paper page without abstract for health test
  writeFileSync(
    join(BRAIN_ROOT, "wiki/entities/papers/incomplete-paper.md"),
    "---\ntype: paper\ntitle: Incomplete Paper\nauthors: [Unknown]\nyear: 2025\nvenue: TBD\n---\n# Incomplete Paper\n\nThis paper has no abstract or DOI information.",
  );

  // Paper page with full metadata
  writeFileSync(
    join(BRAIN_ROOT, "wiki/entities/papers/complete-paper.md"),
    "---\ntype: paper\ntitle: Complete Paper\nauthors: [Author A, Author B]\nyear: 2026\nvenue: Nature\ndoi: 10.1234/test\n---\n# Complete Paper\n\n## Summary\nAbstract: This is a complete paper about CRISPR techniques.\n\nLink: https://doi.org/10.1234/test",
  );

  // Concept page for health test
  writeFileSync(
    join(BRAIN_ROOT, "wiki/concepts/crispr.md"),
    "---\ntype: concept\ntitle: CRISPR\n---\n# CRISPR\n\nClustered Regularly Interspaced Short Palindromic Repeats.",
  );

  // Seed events
  const eventsPath = join(BRAIN_ROOT, "wiki/events.jsonl");
  const now = new Date();
  const events = [
    {
      ts: now.toISOString(),
      type: "ingest",
      contentType: "observation",
      created: ["wiki/observations/obs-1.md"],
    },
    {
      ts: now.toISOString(),
      type: "observe",
      contentType: "observation",
      created: ["wiki/observations/obs-1.md"],
    },
    {
      ts: now.toISOString(),
      type: "ripple",
      updated: ["wiki/hypotheses/crispr-efficiency.md"],
    },
  ];
  for (const event of events) {
    appendFileSync(eventsPath, JSON.stringify(event) + "\n");
  }

  // Write project manifest for frontier watch
  writeFileSync(
    join(BRAIN_ROOT, "state/projects/alpha/manifest.json"),
    JSON.stringify({
      version: 1,
      projectId: "alpha",
      slug: "alpha",
      title: "Alpha Project",
      privacy: "cloud-ok",
      status: "active",
      projectPagePath: "wiki/projects/alpha.md",
      sourceRefs: [{ kind: "import", ref: "crispr sequencing" }],
      decisionPaths: [],
      taskPaths: ["wiki/tasks/alpha-task.md"],
      artifactPaths: [],
      frontierPaths: [
        "wiki/entities/frontier/crispr-update.md",
        "wiki/entities/frontier/staged-item.md",
      ],
      activeThreads: [],
      dedupeKeys: [],
      updatedAt: "2026-04-08T00:00:00.000Z",
    }),
  );
}

beforeEach(() => {
  vi.resetModules();
  assignTestRoots();
  process.env.SCIENCESWARM_DIR = TEST_ROOT;
  delete process.env.BRAIN_CALENDAR_PATH;
  delete process.env.CALENDAR_EVENTS_PATH;
  initBrain({ root: BRAIN_ROOT, name: "Test Researcher" });
  seedBrainContent();
});

afterEach(() => {
  vi.resetModules();
  if (TEST_ROOT) {
    rmSync(TEST_ROOT, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 50,
    });
  }
  TEST_ROOT = "";
  BRAIN_ROOT = "";
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  if (ORIGINAL_SCIENCESWARM_DIR) {
    process.env.SCIENCESWARM_DIR = ORIGINAL_SCIENCESWARM_DIR;
  } else {
    delete process.env.SCIENCESWARM_DIR;
  }
  if (ORIGINAL_CALENDAR_PATH) {
    process.env.BRAIN_CALENDAR_PATH = ORIGINAL_CALENDAR_PATH;
  } else {
    delete process.env.BRAIN_CALENDAR_PATH;
  }
});

// ── 1. Frontier Watch Integration ───────────────────

describe("frontier watch integration", () => {
  it("morning brief includes frontier items loaded from the watch store", async () => {
    const config = makeConfig();
    const llm = mockLLM();

    const brief = await buildMorningBrief(config, llm, { project: "alpha" });

    const promotedItem = brief.frontier.find(
      (f) => f.title === "New CRISPR efficiency paper",
    );
    expect(promotedItem).toMatchObject({
      title: "New CRISPR efficiency paper",
      source: "wiki/entities/frontier/crispr-update.md",
    });
    expect(promotedItem!.relevanceScore).toBeGreaterThanOrEqual(0.3);
  });

  it("frontier items are scored with supports/challenges/adjacent/noise classification", async () => {
    const config = makeConfig();
    const llm = mockLLM();

    const brief = await buildMorningBrief(config, llm, { project: "alpha" });
    expect(brief.frontier.map((item) => item.title).sort()).toEqual([
      "Adjacent sequencing technique",
      "New CRISPR efficiency paper",
    ]);

    for (const item of brief.frontier) {
      expect(["supports", "challenges", "adjacent", "noise"]).toContain(
        item.threatOrOpportunity,
      );
      expect(item.relevanceScore).toBeGreaterThan(0);
      expect(item.relevanceScore).toBeLessThanOrEqual(1);
      expect(item.whyItMatters.trim().length).toBeGreaterThan(10);
    }
  });

  it("loadFrontierWatchItems returns items from frontier directory for a given project", async () => {
    const config = makeConfig();
    const items = await loadFrontierWatchItems(config, "alpha");

    expect(items).toHaveLength(2);
    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "New CRISPR efficiency paper",
          relevance: 0.85,
        }),
        expect.objectContaining({
          title: "Adjacent sequencing technique",
          relevance: 0.55,
        }),
      ]),
    );
  });

  it("loadFrontierWatchItems returns empty array when no frontier directory exists", async () => {
    const config = makeConfig();
    rmSync(join(BRAIN_ROOT, "wiki/entities/frontier"), { recursive: true, force: true });

    const items = await loadFrontierWatchItems(config, "alpha");
    expect(items).toHaveLength(0);
  });

  it("loadFrontierWatchItems reads canonical project-local frontier pages", async () => {
    const config = makeConfig();
    rmSync(join(BRAIN_ROOT, "wiki"), { recursive: true, force: true });
    rmSync(join(BRAIN_ROOT, "state"), { recursive: true, force: true });

    mkdirSync(join(TEST_ROOT, "projects", "alpha", ".brain", "state"), { recursive: true });
    mkdirSync(join(TEST_ROOT, "projects", "alpha", ".brain", "wiki", "entities", "frontier"), { recursive: true });
    writeFileSync(
      join(TEST_ROOT, "projects", "alpha", ".brain", "state", "manifest.json"),
      JSON.stringify({
        version: 1,
        projectId: "alpha",
        slug: "alpha",
        title: "Alpha Project",
        privacy: "cloud-ok",
        status: "active",
        projectPagePath: "wiki/projects/alpha.md",
        sourceRefs: [],
        decisionPaths: [],
        taskPaths: [],
        artifactPaths: [],
        frontierPaths: [],
        activeThreads: [],
        dedupeKeys: [],
        updatedAt: "2026-04-11T00:00:00.000Z",
      }),
      "utf-8",
    );
    writeFileSync(
      join(TEST_ROOT, "projects", "alpha", ".brain", "wiki", "entities", "frontier", "canonical-item.md"),
      "---\n"
        + "title: Canonical Frontier Item\n"
        + "type: frontier_item\n"
        + "project: alpha\n"
        + "status: promoted\n"
        + "tags: [alpha, frontier]\n"
        + "---\n\nCanonical frontier content.\n",
      "utf-8",
    );

    const items = await loadFrontierWatchItems(config, "alpha");
    expect(items.some((item) => item.title === "Canonical Frontier Item")).toBe(true);
  });
});

// ── 2. Brain Health Dashboard ───────────────────────

describe("brain health dashboard", () => {
  it("generates a report with all expected fields", () => {
    const config = makeConfig();
    const report = generateHealthReport(config);

    expect(Number.isNaN(Date.parse(report.generatedAt))).toBe(false);
    expect(report.score).toBeGreaterThan(0);
    expect(report.score).toBeLessThanOrEqual(100);
    expect(report.coverage.totalPages).toBeGreaterThan(0);
    expect(Array.isArray(report.orphans)).toBe(true);
    expect(Array.isArray(report.stalePages)).toBe(true);
    expect(Array.isArray(report.missingLinks)).toBe(true);
    expect(typeof report.embeddingGaps).toBe("number");
    expect(report.suggestions.length).toBeGreaterThan(0);
  });

  it("detects orphan pages with no incoming wikilinks", () => {
    const config = makeConfig();
    const report = generateHealthReport(config);

    // The incomplete-paper has no incoming links
    const orphanPaths = report.orphans.map((o) => o.path);
    expect(orphanPaths.some((p) => p.includes("incomplete-paper"))).toBe(true);

    // Each orphan has a reason
    for (const orphan of report.orphans) {
      expect(orphan.path.startsWith("wiki/")).toBe(true);
      expect(orphan.title.length).toBeGreaterThan(0);
      expect(orphan.reason).toContain("No incoming wikilinks");
    }
  });

  it("detects stale pages for active page types beyond 14 days", () => {
    const config = makeConfig();

    // Create a stale hypothesis page (with old mtime)
    const stalePath = join(BRAIN_ROOT, "wiki/hypotheses/old-hyp.md");
    writeFileSync(
      stalePath,
      "---\ntype: hypothesis\ntitle: Old Hypothesis\nstatus: active\n---\n# Old Hypothesis\nStale content.",
    );
    // Set mtime to 30 days ago
    const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    utimesSync(stalePath, oldDate, oldDate);

    const report = generateHealthReport(config);

    const staleHyp = report.stalePages.find((s) => s.title === "Old Hypothesis");
    expect(staleHyp).toMatchObject({
      title: "Old Hypothesis",
    });
    expect(staleHyp!.daysSinceUpdate).toBeGreaterThanOrEqual(14);
    expect(staleHyp!.suggestedAction).toContain("Old Hypothesis");
  });

  it("calculates coverage metrics for papers", () => {
    const config = makeConfig();
    const report = generateHealthReport(config);

    expect(report.coverage.papersWithAbstracts).toBe(1);
    expect(report.coverage.papersWithoutAbstracts).toBe(1);
    expect(report.coverage.papersWithCitations).toBe(1);
    expect(report.coverage.coveragePercent).toBeLessThan(100);
  });

  it("computes health score weighted across dimensions", () => {
    const config = makeConfig();
    const report = generateHealthReport(config);

    // Score should be > 0 since we have a populated brain
    expect(report.score).toBeGreaterThan(0);
    // Score should not be perfect since we have orphans and incomplete papers
    expect(report.score).toBeLessThan(100);
  });

  it("returns zero score for empty brain", () => {
    rmSync(join(BRAIN_ROOT, "wiki"), { recursive: true, force: true });

    const config = makeConfig();
    const report = generateHealthReport(config);

    expect(report.score).toBe(0);
    expect(report.coverage.totalPages).toBe(0);
    expect(report.suggestions[0]).toContain("not found");
  });

  it("generates actionable suggestions based on detected issues", () => {
    const config = makeConfig();
    const report = generateHealthReport(config);

    // Should have suggestions about the incomplete paper
    const hasAbstractSuggestion = report.suggestions.some((s) =>
      s.includes("abstract"),
    );
    expect(hasAbstractSuggestion).toBe(true);
  });
});

// ── 3. Meeting Prep ─────────────────────────────────

describe("meeting prep", () => {
  it("looks up attendee brain person pages by name", async () => {
    const config = makeConfig();
    const llm = mockLLM();

    const prep = await prepMeeting(config, llm, ["Neel Nanda"]);

    expect(prep.attendees).toHaveLength(1);
    expect(prep.attendees[0].name).toBe("Neel Nanda");
    expect(prep.attendees[0].brainPagePath).toBe(
      "wiki/entities/people/neel-nanda.md",
    );
    expect(prep.attendees[0].lastInteraction).toBe("2026-04-01");
  });

  it("extracts open threads from person pages", async () => {
    const config = makeConfig();
    const llm = mockLLM();

    const prep = await prepMeeting(config, llm, ["Neel Nanda"]);

    const attendee = prep.attendees[0];
    expect(attendee.openThreads.length).toBeGreaterThan(0);
    // Should find the unchecked todo items and TODO marker
    expect(
      attendee.openThreads.some((t) => t.includes("feature circuits")),
    ).toBe(true);
  });

  it("generates suggested topics from shared research context", async () => {
    const config = makeConfig();
    const llm = mockLLM();

    const prep = await prepMeeting(config, llm, ["Neel Nanda"]);

    expect(prep.suggestedTopics).toEqual([
      "Discuss recent CRISPR efficiency results",
      "Review open thread on primer design",
      "Plan next experiment timeline",
    ]);
  });

  it("handles unknown attendees gracefully", async () => {
    const config = makeConfig();
    const llm = mockLLM();

    const prep = await prepMeeting(config, llm, ["Unknown Person"]);

    expect(prep.attendees).toHaveLength(1);
    expect(prep.attendees[0].name).toBe("Unknown Person");
    expect(prep.attendees[0].brainPagePath).toBeUndefined();
    expect(prep.attendees[0].openThreads).toHaveLength(0);
  });

  it("builds meeting prep from calendar events into morning brief", async () => {
    const calendarPath = join(TEST_ROOT, "calendar.json");
    writeFileSync(
      calendarPath,
      JSON.stringify([
        {
          title: "CRISPR Review Meeting",
          time: "2026-04-09T10:00:00Z",
          attendees: ["Neel Nanda"],
        },
      ]),
    );
    process.env.BRAIN_CALENDAR_PATH = calendarPath;

    const config = makeConfig();
    const llm = mockLLM();

    const brief = await buildMorningBrief(config, llm, { project: "alpha" });

    expect(brief.meetingPrep).toHaveLength(1);
    expect(brief.meetingPrep![0].title).toBe("CRISPR Review Meeting");
    expect(brief.meetingPrep![0].attendees).toHaveLength(1);
    expect(brief.meetingPrep![0].attendees[0].name).toBe("Neel Nanda");
    expect(brief.meetingPrep![0].attendees[0].brainPagePath).toBe(
      "wiki/entities/people/neel-nanda.md",
    );
  });

  it("morning brief omits meetingPrep when no calendar is configured", async () => {
    // No BRAIN_CALENDAR_PATH set
    const config = makeConfig();
    const llm = mockLLM();

    const brief = await buildMorningBrief(config, llm, { project: "alpha" });

    expect(brief.meetingPrep).toBeUndefined();
  });

  it("loadCalendarEvents returns null when no path is configured", async () => {
    delete process.env.BRAIN_CALENDAR_PATH;
    delete process.env.CALENDAR_EVENTS_PATH;

    const events = await loadCalendarEvents();
    expect(events).toBeNull();
  });

  it("loadCalendarEvents parses valid calendar JSON", async () => {
    const calendarPath = join(TEST_ROOT, "cal.json");
    writeFileSync(
      calendarPath,
      JSON.stringify([
        { title: "Standup", time: "09:00", attendees: ["Alice", "Bob"] },
      ]),
    );
    process.env.BRAIN_CALENDAR_PATH = calendarPath;

    const events = await loadCalendarEvents();
    expect(events).not.toBeNull();
    expect(events!).toHaveLength(1);
    expect(events![0].title).toBe("Standup");
    expect(events![0].attendees).toEqual(["Alice", "Bob"]);
  });

  it("loadCalendarEvents uses the Google Calendar adapter when credentials are configured", async () => {
    vi.stubEnv("GOOGLE_CALENDAR_CREDENTIALS", "test-token");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            items: [
              {
                id: "evt-1",
                summary: "Live Calendar Meeting",
                start: { dateTime: "2026-04-09T16:00:00Z" },
                end: { dateTime: "2026-04-09T16:30:00Z" },
                attendees: [{ displayName: "Neel Nanda", email: "neel@example.com" }],
              },
            ],
          }),
          { status: 200 },
        ),
      ),
    );

    const events = await loadCalendarEvents();

    expect(events).toEqual([
      {
        title: "Live Calendar Meeting",
        time: "2026-04-09T16:00:00Z",
        attendees: ["Neel Nanda"],
      },
    ]);
  });

  it("buildMeetingPrepFromCalendar resolves attendees against brain", async () => {
    const config = makeConfig();
    const calendarEvents = [
      {
        title: "Weekly Sync",
        time: "2026-04-09T14:00:00Z",
        attendees: ["Neel Nanda", "Unknown Colleague"],
      },
    ];

    const preps = await buildMeetingPrepFromCalendar(config, calendarEvents);

    expect(preps).toHaveLength(1);
    expect(preps[0].title).toBe("Weekly Sync");
    expect(preps[0].attendees).toHaveLength(2);
    expect(preps[0].attendees).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "Neel Nanda",
          brainPagePath: "wiki/entities/people/neel-nanda.md",
        }),
        expect.objectContaining({
          name: "Unknown Colleague",
          brainPagePath: undefined,
        }),
      ]),
    );
  });
});

// ── 4. API Route ────────────────────────────────────

describe("GET /api/brain/health-report", () => {
  it("returns a valid health report with status 200", async () => {
    vi.resetModules();
    vi.doMock("@/brain/config", () => ({
      loadBrainConfig: () => ({
        root: BRAIN_ROOT,
        extractionModel: "test",
        synthesisModel: "test",
        rippleCap: 15,
        paperWatchBudget: 50,
        serendipityRate: 0.2,
      }),
    }));

    const { GET } = await import(
      "@/app/api/brain/health-report/route"
    );

    const response = await GET();
    expect(response.status).toBe(200);

    const body = (await response.json()) as BrainHealthReport;
    expect(Number.isNaN(Date.parse(body.generatedAt))).toBe(false);
    expect(body.score).toBeGreaterThan(0);
    expect(body.score).toBeLessThanOrEqual(100);
    expect(body.coverage.totalPages).toBeGreaterThan(0);
    expect(Array.isArray(body.orphans)).toBe(true);
    expect(Array.isArray(body.stalePages)).toBe(true);
    expect(Array.isArray(body.suggestions)).toBe(true);
    expect(body.suggestions.length).toBeGreaterThan(0);
  });

  it("returns 503 when no brain is configured", async () => {
    vi.resetModules();
    vi.doMock("@/brain/config", () => ({
      loadBrainConfig: () => null,
    }));

    const { GET } = await import(
      "@/app/api/brain/health-report/route"
    );

    const response = await GET();
    expect(response.status).toBe(503);

    const body = (await response.json()) as { error: string; code: string };
    expect(body.error).toContain("No research brain is initialized yet");
    expect(body.code).toBe("brain_not_initialized");
  });
});

describe("POST /api/brain/morning-brief", () => {
  it("returns Telegram briefing actions when requested", async () => {
    vi.resetModules();
    vi.doMock("@/brain/config", () => ({
      loadBrainConfig: () => ({
        root: BRAIN_ROOT,
        extractionModel: "test",
        synthesisModel: "test",
        rippleCap: 15,
        paperWatchBudget: 50,
        serendipityRate: 0.2,
      }),
    }));
    vi.doMock("@/brain/llm", () => ({
      createLLMClient: () => mockLLM(),
    }));

    const { POST } = await import("@/app/api/brain/morning-brief/route");

    const request = new Request("http://localhost/api/brain/morning-brief", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projects: ["alpha"], format: "telegram-actions" }),
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(typeof body.text).toBe("string");
    expect(Array.isArray(body.actions)).toBe(true);
    expect(body.actions.length).toBeGreaterThan(0);
    expect(body.actions.some((action: { label: string }) => action.label.startsWith("Save:"))).toBe(true);
  });
});

// ── 5. Telegram Format with Meeting Prep ────────────

describe("formatTelegramBrief with meetingPrep", () => {
  it("telegram format still works with the new meetingPrep field", () => {
    const brief: MorningBrief = {
      generatedAt: "2026-04-09T08:00:00.000Z",
      greeting: "Good morning.",
      topMatters: [
        {
          summary: "Frontier watch found relevant paper",
          whyItMatters: "Directly related to your CRISPR work",
          evidence: ["wiki/entities/frontier/crispr-update.md"],
          urgency: "this-week",
        },
      ],
      contradictions: [],
      frontier: [
        {
          title: "New CRISPR paper",
          source: "wiki/entities/frontier/crispr-update.md",
          relevanceScore: 0.85,
          whyItMatters: "High relevance to alpha project",
          threatOrOpportunity: "supports",
        },
      ],
      staleThreads: [],
      openQuestions: [],
      nextMove: {
        recommendation: "Read the new CRISPR paper",
        reasoning: "It supports your hypothesis",
        assumptions: [],
        missingEvidence: [],
      },
      meetingPrep: [
        {
          title: "CRISPR Review",
          time: "10:00",
          attendees: [
            {
              name: "Neel Nanda",
              brainPagePath: "wiki/entities/people/neel-nanda.md",
              openThreads: ["Review feature circuits paper"],
            },
          ],
          suggestedTopics: ["Discuss CRISPR efficiency"],
        },
      ],
      stats: {
        brainPages: 12,
        newPagesYesterday: 2,
        capturesYesterday: 1,
        enrichmentsYesterday: 1,
      },
    };

    const output = formatTelegramBrief(brief);

    expect(output).toContain("Morning Brief");
    expect(output).toContain("Frontier: 1 new");
    expect(output).toContain("Next move:");
    // Telegram format should not crash with meetingPrep present
    expect(output.length).toBeGreaterThan(0);
    expect(output.length).toBeLessThan(1500);
  });
});
