/**
 * tests/lib/radar/skill-runner.test.ts
 *
 * Unit tests for the research-radar skill runner shared body
 * (src/lib/radar/skill-runner.ts). Phase C Lane 1 of the gbrain pivot.
 *
 * The runner is the body behind both `npm run radar:run` and any future
 * in-process invocation. We test it through its injected
 * `SkillRunnerEnvironment` seam so the happy path, the LLM-retry path,
 * and the missing-handle failure path all exercise the same code that
 * production runs — without spawning a child process, without touching
 * a real PGLite, and without making any HTTP calls.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runResearchRadarSkill } from "@/lib/radar/skill-runner";
import type {
  RadarEngineLike,
  SkillRunnerEnvironment,
  RadarLastRun,
} from "@/lib/radar/skill-runner";
import type { Radar, RadarBriefing } from "@/lib/radar/types";

// ── Fixtures ─────────────────────────────────────────

function makeRadar(overrides: Partial<Radar> = {}): Radar {
  return {
    id: "radar-1",
    topics: [
      {
        name: "mechanistic interpretability",
        description: "Circuit analysis",
        weight: 0.9,
        origin: "user",
      },
    ],
    sources: [],
    schedule: { cron: "*/30 * * * *", timezone: "UTC", fetchLeadMinutes: 120 },
    channels: { telegram: false, dashboard: true, email: false },
    filters: [],
    createdAt: "2026-04-13T00:00:00Z",
    updatedAt: "2026-04-13T00:00:00Z",
    ...overrides,
  };
}

function makeBriefing(overrides: Partial<RadarBriefing> = {}): RadarBriefing {
  return {
    id: "brief-1",
    radarId: "radar-1",
    generatedAt: "2026-04-13T08:00:00.000Z",
    matters: [
      {
        signal: {
          id: "s1",
          title: "Probing Sparse Autoencoders",
          sourceId: "arxiv-cs-ai",
          url: "https://arxiv.org/abs/9999.00001",
          timestamp: "2026-04-13T07:00:00Z",
          content: "...",
          metadata: {},
          relevanceScore: 0.9,
          matchedTopics: ["mechanistic interpretability"],
          explanation: "Direct circuit work.",
        },
        whyItMatters: "Directly extends your interpretability project.",
      },
    ],
    horizon: [],
    nothingToday: false,
    stats: {
      signalsFetched: 1,
      signalsRanked: 1,
      sourcesQueried: 1,
      sourcesFailed: [],
    },
    ...overrides,
  };
}

interface CapturedWrites {
  pages: Array<{ slug: string; title: string }>;
  timelineEntries: Array<{ slug: string; summary: string }>;
  links: Array<{ from: string; to: string; linkType?: string }>;
  disconnected: boolean;
  connected: boolean;
  schemaInitialized: boolean;
}

function makeFakeEngine(captured: CapturedWrites): RadarEngineLike {
  return {
    async connect() {
      captured.connected = true;
    },
    async initSchema() {
      captured.schemaInitialized = true;
    },
    async disconnect() {
      captured.disconnected = true;
    },
    async putPage(slug, page) {
      captured.pages.push({ slug, title: page.title });
      return { id: captured.pages.length, slug };
    },
    async addTimelineEntry(slug, entry) {
      captured.timelineEntries.push({ slug, summary: entry.summary });
    },
    async addLink(from, to, _context, linkType) {
      captured.links.push({ from, to, linkType });
    },
  };
}

interface MakeEnvOptions {
  radar?: Radar | null;
  briefing?: RadarBriefing | null;
  llmShouldFail?: { times: number };
  capturedWrites: CapturedWrites;
  capturedPointer: { value: RadarLastRun | null };
  llmCallCount: { value: number };
}

function makeEnv(opts: MakeEnvOptions): SkillRunnerEnvironment {
  return {
    resolveBrainRoot: () => "/tmp/fake-brain-root",
    async openEngine() {
      return makeFakeEngine(opts.capturedWrites);
    },
    async getBrainStore() {
      return {
        search: vi.fn().mockResolvedValue([]),
        getPage: vi.fn(),
        getTimeline: vi.fn().mockResolvedValue([]),
        getLinks: vi.fn().mockResolvedValue([]),
        getBacklinks: vi.fn().mockResolvedValue([]),
        importCorpus: vi.fn(),
        listPages: vi.fn().mockResolvedValue([]),
        health: vi.fn(),
        dispose: vi.fn(),
      };
    },
    async getRadarLLM() {
      return {
        async generate() {
          opts.llmCallCount.value++;
          if (
            opts.llmShouldFail &&
            opts.llmCallCount.value <= opts.llmShouldFail.times
          ) {
            throw new Error("simulated llm failure");
          }
          return "[]"; // empty ranking — pipeline will downgrade gracefully
        },
      };
    },
    buildFetchers: () => ({}),
    async loadActiveRadar() {
      return opts.radar ?? null;
    },
    async writeLastRunPointer(_filePath, payload) {
      opts.capturedPointer.value = payload;
    },
    now: () => new Date("2026-04-13T08:00:30.000Z"),
    runPipeline: vi.fn(async () => {
      if (!opts.briefing) return null;
      return {
        briefing: opts.briefing,
        telegram: "telegram body",
        dashboard: {
          id: opts.briefing.id,
          generatedAt: opts.briefing.generatedAt,
          nothingToday: opts.briefing.nothingToday,
          matters: [],
          horizon: [],
          stats: opts.briefing.stats,
        },
      };
    }),
  };
}

// ── Tests ────────────────────────────────────────────

beforeEach(() => {
  vi.stubEnv("SCIENCESWARM_USER_HANDLE", "@test-researcher");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("runResearchRadarSkill — happy path", () => {
  it("runs the pipeline, writes a briefing back to gbrain, and emits a fresh last-run pointer", async () => {
    const captured: CapturedWrites = {
      pages: [],
      timelineEntries: [],
      links: [],
      disconnected: false,
      connected: false,
      schemaInitialized: false,
    };
    const pointer = { value: null as RadarLastRun | null };
    const llmCallCount = { value: 0 };

    const env = makeEnv({
      radar: makeRadar(),
      briefing: makeBriefing(),
      capturedWrites: captured,
      capturedPointer: pointer,
      llmCallCount,
    });

    const result = await runResearchRadarSkill(env);

    // The briefing summary page and overnight journal were both written.
    expect(captured.pages.length).toBe(2);
    expect(captured.pages[0].slug).toMatch(/^briefings\/2026-04-13-radar-1$/);
    expect(captured.pages[0].title).toContain("Radar");
    expect(captured.pages[1].slug).toMatch(/^journals\/2026-04-13-research-radar-radar-1$/);
    expect(captured.pages[1].title).toContain("Research Radar Journal");

    // The single matched topic produced exactly one Timeline entry +
    // one back-link from the briefing to the concept page.
    expect(captured.timelineEntries.length).toBe(1);
    expect(captured.timelineEntries[0].slug).toBe(
      "concepts/mechanistic-interpretability",
    );
    expect(captured.links).toEqual(
      expect.arrayContaining([
        {
          from: "briefings/2026-04-13-radar-1",
          to: "concepts/mechanistic-interpretability",
          linkType: "supports",
        },
        {
          from: "journals/2026-04-13-research-radar-radar-1",
          to: "briefings/2026-04-13-radar-1",
          linkType: "supports",
        },
      ]),
    );

    // Lifecycle: connected, schema initialized, disconnected.
    expect(captured.connected).toBe(true);
    expect(captured.schemaInitialized).toBe(true);
    expect(captured.disconnected).toBe(true);

    // Last-run pointer written with the expected shape.
    expect(pointer.value).not.toBeNull();
    expect(pointer.value!.timestamp).toBe("2026-04-13T08:00:30.000Z");
    expect(pointer.value!.concepts_processed).toBe(1);
    expect(pointer.value!.errors_count).toBe(0);
    expect(pointer.value!.schedule_interval_ms).toBeGreaterThan(0);
    expect(pointer.value!.briefing_slug).toBe("briefings/2026-04-13-radar-1");
    expect(pointer.value!.journal_slug).toBe("journals/2026-04-13-research-radar-radar-1");

    expect(result.errors).toEqual([]);
    expect(result.radars_processed).toBe(1);
    expect(result.concepts_processed).toBe(1);
  });

  it("writes a fresh-but-empty pointer when no radar is configured", async () => {
    const captured: CapturedWrites = {
      pages: [],
      timelineEntries: [],
      links: [],
      disconnected: false,
      connected: false,
      schemaInitialized: false,
    };
    const pointer = { value: null as RadarLastRun | null };
    const llmCallCount = { value: 0 };

    const env = makeEnv({
      radar: null,
      briefing: null,
      capturedWrites: captured,
      capturedPointer: pointer,
      llmCallCount,
    });

    const result = await runResearchRadarSkill(env);

    expect(result.radars_processed).toBe(0);
    expect(result.concepts_processed).toBe(0);
    expect(result.errors).toEqual([]);
    expect(captured.pages).toEqual([]);
    expect(pointer.value).not.toBeNull();
    expect(pointer.value!.errors_count).toBe(0);
  });
});

describe("runResearchRadarSkill — LLM retry path", () => {
  it("retries the radar LLM once on transient failure and still completes the run", async () => {
    const captured: CapturedWrites = {
      pages: [],
      timelineEntries: [],
      links: [],
      disconnected: false,
      connected: false,
      schemaInitialized: false,
    };
    const pointer = { value: null as RadarLastRun | null };
    const llmCallCount = { value: 0 };

    const env = makeEnv({
      radar: makeRadar(),
      briefing: makeBriefing(),
      capturedWrites: captured,
      capturedPointer: pointer,
      llmCallCount,
      llmShouldFail: { times: 0 }, // pipeline is mocked, so the LLM is unused
    });

    // Override runPipeline to invoke the wrapped LLM directly so we
    // can observe the retry policy. The runner wraps `env.getRadarLLM()`
    // result with wrapLLMWithRetry before passing it down, and
    // runPipeline receives that wrapped instance via its `llm` arg.
    let observedLLMCalls = 0;
    env.runPipeline = vi.fn(async (input) => {
      // Simulate the pipeline calling the LLM twice (once for ranking,
      // once for synthesis). The wrapper retries on each FAILED call,
      // not on each successful one — so a clean run yields exactly 2
      // calls regardless of llmRetries value.
      try {
        await input.llm.generate("ranking prompt");
        observedLLMCalls++;
      } catch {
        observedLLMCalls++;
      }
      try {
        await input.llm.generate("synthesis prompt");
        observedLLMCalls++;
      } catch {
        observedLLMCalls++;
      }
      return {
        briefing: makeBriefing(),
        telegram: "",
        dashboard: {
          id: "brief-1",
          generatedAt: "2026-04-13T08:00:00.000Z",
          nothingToday: false,
          matters: [],
          horizon: [],
          stats: {
            signalsFetched: 0,
            signalsRanked: 0,
            sourcesQueried: 0,
            sourcesFailed: [],
          },
        },
      };
    });

    // Wire the LLM so the FIRST call fails, the second succeeds. The
    // wrapper should retry once and then return the second result.
    let llmAttempts = 0;
    env.getRadarLLM = async () => ({
      async generate() {
        llmAttempts++;
        if (llmAttempts === 1) {
          throw new Error("simulated transient");
        }
        return "[]";
      },
    });

    const result = await runResearchRadarSkill(env, { llmRetries: 1 });

    // 2 pipeline-level calls, first one had 2 llm attempts (1 fail + 1
    // retry success), second had 1 attempt → 3 total LLM attempts.
    expect(llmAttempts).toBeGreaterThanOrEqual(2);
    expect(observedLLMCalls).toBe(2);
    expect(result.errors).toEqual([]);
    expect(pointer.value).not.toBeNull();
  });
});

describe("runResearchRadarSkill — missing user handle", () => {
  it("throws loudly when SCIENCESWARM_USER_HANDLE is not set", async () => {
    vi.unstubAllEnvs();
    const cwd = vi.spyOn(process, "cwd").mockReturnValue("/tmp/scienceswarm-radar-no-env");
    // setupBrain in tests/setup.ts already strips env between tests,
    // so the handle is unset by default. Re-stub nothing — confirm
    // the throw happens BEFORE any env / engine I/O.
    const captured: CapturedWrites = {
      pages: [],
      timelineEntries: [],
      links: [],
      disconnected: false,
      connected: false,
      schemaInitialized: false,
    };
    const pointer = { value: null as RadarLastRun | null };
    const llmCallCount = { value: 0 };
    const env = makeEnv({
      radar: makeRadar(),
      briefing: makeBriefing(),
      capturedWrites: captured,
      capturedPointer: pointer,
      llmCallCount,
    });

    try {
      await expect(runResearchRadarSkill(env)).rejects.toThrow(
        /SCIENCESWARM_USER_HANDLE/,
      );

      // Critically: nothing was written. Engine never opened, pointer
      // never updated. This is decision 3A in action — the runner
      // must fail BEFORE any side effect.
      expect(captured.connected).toBe(false);
      expect(captured.disconnected).toBe(false);
      expect(captured.pages).toEqual([]);
      expect(pointer.value).toBeNull();
    } finally {
      cwd.mockRestore();
    }
  });
});

describe("runResearchRadarSkill — partial failure path", () => {
  it("records gbrain write errors but keeps going and still emits the pointer", async () => {
    const captured: CapturedWrites = {
      pages: [],
      timelineEntries: [],
      links: [],
      disconnected: false,
      connected: false,
      schemaInitialized: false,
    };
    const pointer = { value: null as RadarLastRun | null };
    const llmCallCount = { value: 0 };

    const env = makeEnv({
      radar: makeRadar(),
      briefing: makeBriefing(),
      capturedWrites: captured,
      capturedPointer: pointer,
      llmCallCount,
    });

    // Inject an engine whose addTimelineEntry always fails so we can
    // assert the runner records the error and still writes the pointer.
    env.openEngine = async () => ({
      async connect() {
        captured.connected = true;
      },
      async initSchema() {
        captured.schemaInitialized = true;
      },
      async disconnect() {
        captured.disconnected = true;
      },
      async putPage(slug, page) {
        captured.pages.push({ slug, title: page.title });
        return { id: 1, slug };
      },
      async addTimelineEntry() {
        throw new Error("simulated gbrain write failure");
      },
      async addLink() {
        // Won't be reached because addTimelineEntry threw first.
      },
    });

    const result = await runResearchRadarSkill(env);

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toMatch(/addTimelineEntry/);
    // The summary page and journal were written before the concept-link failure.
    expect(captured.pages.length).toBe(2);
    // Pointer still written, with errors_count reflecting the failure.
    expect(pointer.value).not.toBeNull();
    expect(pointer.value!.errors_count).toBeGreaterThan(0);
    expect(pointer.value!.journal_slug).toBe("journals/2026-04-13-research-radar-radar-1");
    // Engine still cleaned up.
    expect(captured.disconnected).toBe(true);
  });
});
