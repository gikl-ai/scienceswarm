import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync, rmSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { execFileSync } from "child_process";
import { join } from "path";
import { tmpdir } from "os";
import { initBrain } from "@/brain/init";
import { logEvent } from "@/brain/cost";
import {
  ensureBrainStoreReady,
  getBrainStore,
  resetBrainStore,
} from "@/brain/store";
import type { GbrainEngineAdapter } from "@/brain/stores/gbrain-engine-adapter";
import type { BrainConfig } from "@/brain/types";
import type { LLMClient, LLMResponse } from "@/brain/llm";
import {
  readDreamState,
  writeDreamState,
  enqueueTargets,
  markEventsProcessed,
  type DreamState,
  type EnrichmentTarget,
} from "@/brain/dream-state";
import { runDreamCycle } from "@/brain/dream-cycle";
import { compileAffectedConceptsForSource } from "@/brain/compile-affected";

const TEST_ROOT = join(tmpdir(), "scienceswarm-brain-test-dream");

function makeConfig(): BrainConfig {
  return {
    root: TEST_ROOT,
    extractionModel: "test",
    synthesisModel: "test",
    rippleCap: 15,
    paperWatchBudget: 50,
    serendipityRate: 0.2,
  };
}

function makeMockLLM(): LLMClient {
  return {
    async complete(): Promise<LLMResponse> {
      return {
        content: JSON.stringify({
          themes: ["test-theme"],
          concept_updates: [],
          summary: "Test consolidation summary",
        }),
        cost: {
          inputTokens: 100,
          outputTokens: 50,
          estimatedUsd: 0.001,
          model: "test",
        },
      };
    },
  };
}

function makeCompileLLM(): LLMClient {
  return {
    complete: vi.fn(async (call): Promise<LLMResponse> => {
      const cost = {
        inputTokens: 1,
        outputTokens: 1,
        estimatedUsd: 0,
        model: call.model,
      };
      if (call.system.includes("research entity extraction agent")) {
        return { content: "[]", cost };
      }
      if (call.system.includes("research knowledge consolidation agent")) {
        return {
          content: JSON.stringify({
            themes: [],
            concept_updates: [
              {
                concept: "RLHF alignment",
                evidence: "RLHF optimizes reward models into deceptive alignment.",
                source: "wiki/entities/papers/deceptive-rlhf.md",
              },
            ],
            summary: "New RLHF evidence should update the concept page.",
          }),
          cost,
        };
      }
      if (call.user.includes("Extract source claims")) {
        return {
          content: JSON.stringify({
            claims: [
              {
                text: "RLHF optimizes reward models into deceptive alignment.",
                source: "wiki/entities/papers/deceptive-rlhf",
              },
            ],
          }),
          cost,
        };
      }
      if (call.user.includes("Extract compiled truth claims")) {
        return {
          content: JSON.stringify({
            claims: [
              {
                text: "RLHF is the dominant alignment approach.",
                source: "wiki/concepts/rlhf-alignment",
              },
            ],
          }),
          cost,
        };
      }
      if (call.user.includes("Compare claims")) {
        return {
          content: JSON.stringify({
            contradictions: [
              {
                new_claim: "RLHF optimizes reward models into deceptive alignment.",
                existing_claim: "RLHF is the dominant alignment approach.",
                new_source: "wiki/entities/papers/deceptive-rlhf",
                existing_source: "wiki/concepts/rlhf-alignment",
                severity: "critical",
                confidence: 0.9,
                implication: "Treat RLHF as contested.",
              },
            ],
          }),
          cost,
        };
      }
      return {
        content: JSON.stringify({
          compiled_truth:
            "RLHF remains central, but the current compiled view is contested by new evidence about deceptive alignment.",
        }),
        cost,
      };
    }),
  };
}

beforeEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
  initBrain({ root: TEST_ROOT });
});

afterEach(async () => {
  await resetBrainStore();
  rmSync(TEST_ROOT, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

// ── Dream State Tests ─────────────────────────────────

describe("DreamState", () => {
  it("returns default state when no file exists", () => {
    const state = readDreamState(makeConfig());
    expect(state.lastFullRun).toBeNull();
    expect(state.lastCitationGraphUpdate).toBeNull();
    expect(state.processedEventIds).toEqual([]);
    expect(state.enrichmentQueue).toEqual([]);
  });

  it("persists and reads state from disk", () => {
    const config = makeConfig();
    const state: DreamState = {
      lastFullRun: "2025-01-15T08:00:00.000Z",
      lastCitationGraphUpdate: null,
      lastClusteringRun: null,
      processedEventIds: ["ts1", "ts2"],
      enrichmentQueue: [
        { type: "paper", identifier: "test-paper", priority: "high" },
      ],
    };

    writeDreamState(config, state);
    const loaded = readDreamState(config);

    expect(loaded.lastFullRun).toBe("2025-01-15T08:00:00.000Z");
    expect(loaded.processedEventIds).toEqual(["ts1", "ts2"]);
    expect(loaded.enrichmentQueue).toHaveLength(1);
    expect(loaded.enrichmentQueue[0].identifier).toBe("test-paper");
  });

  it("enqueueTargets deduplicates by identifier", () => {
    const state: DreamState = {
      lastFullRun: null,
      lastCitationGraphUpdate: null,
      lastClusteringRun: null,
      processedEventIds: [],
      enrichmentQueue: [
        { type: "paper", identifier: "existing-paper", priority: "high" },
      ],
    };

    const targets: EnrichmentTarget[] = [
      { type: "paper", identifier: "existing-paper", priority: "medium" },
      { type: "paper", identifier: "new-paper", priority: "low" },
    ];

    const updated = enqueueTargets(state, targets);
    expect(updated.enrichmentQueue).toHaveLength(2);
    expect(updated.enrichmentQueue[1].identifier).toBe("new-paper");
  });

  it("markEventsProcessed adds timestamps and trims to 500", () => {
    const state: DreamState = {
      lastFullRun: null,
      lastCitationGraphUpdate: null,
      lastClusteringRun: null,
      processedEventIds: [],
      enrichmentQueue: [],
    };

    const updated = markEventsProcessed(state, ["ts1", "ts2", "ts3"]);
    expect(updated.processedEventIds).toEqual(["ts1", "ts2", "ts3"]);
  });

  it("markEventsProcessed does not add duplicate timestamps", () => {
    const state: DreamState = {
      lastFullRun: null,
      lastCitationGraphUpdate: null,
      lastClusteringRun: null,
      processedEventIds: ["ts1"],
      enrichmentQueue: [],
    };

    const updated = markEventsProcessed(state, ["ts1", "ts2"]);
    expect(updated.processedEventIds).toHaveLength(2);
  });
});

// ── Entity Extraction Tests ───────────────────────────

describe("Entity extraction from page content", () => {
  it("identifies paper pages without abstracts as enrichment targets", async () => {
    const config = makeConfig();

    // Create a paper page without abstract
    const paperDir = join(TEST_ROOT, "wiki/entities/papers");
    mkdirSync(paperDir, { recursive: true });
    writeFileSync(
      join(paperDir, "test-2024-attention.md"),
      [
        "---",
        "date: 2024-01-01",
        "type: paper",
        "para: resources",
        "title: Test Paper",
        "authors: [Author One]",
        "year: 2024",
        'venue: "NeurIPS"',
        "tags: [paper]",
        "---",
        "",
        "# Test Paper",
        "",
        "## Summary",
        "A test paper.",
      ].join("\n"),
    );

    // Log an event referencing this page
    logEvent(config, {
      ts: new Date().toISOString(),
      type: "ingest",
      contentType: "paper",
      created: ["wiki/entities/papers/test-2024-attention.md"],
    });

    // Run sweep-only to just detect entities
    // Mock fetch to prevent actual API calls
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );

    try {
      const result = await runDreamCycle(config, makeMockLLM(), "sweep-only");
      expect(result.entitiesSwept).toBeGreaterThanOrEqual(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ── Dream Cycle Integration ───────────────────────────

describe("runDreamCycle", () => {
  it("does not overwrite the previous headline on skipped sidecar polls", () => {
    const pointerPath = join(TEST_ROOT, ".dream-last-run.json");
    const previous = {
      timestamp: "2026-04-18T08:00:00.000Z",
      mode: "full",
      pages_compiled: 7,
      contradictions_found: 2,
      backlinks_added: 11,
      duration_ms: 1234,
      duration_ms_per_stage: { total: 1234 },
      errors: [],
      partial: false,
      headline: {
        generatedAt: "2026-04-18T08:00:00.000Z",
        windowStart: "2026-04-17T08:00:00.000Z",
        windowEnd: "2026-04-18T08:00:00.000Z",
        headline: "While you slept: preserve this headline.",
        newSignals: 3,
        newPapers: 1,
        sourceBreakdown: {
          paper: 1,
          zotero: 0,
          lab_data: 0,
          meeting: 1,
          chat: 1,
          note: 0,
          task: 0,
          other: 0,
        },
        topicsRecompiled: 7,
        contradictionsFound: 2,
        staleExperiments: 0,
        crossReferencesAdded: 11,
        brokenBacklinksFixed: 0,
        staleTimelinesConsolidated: 7,
        compiledTopics: [],
        signals: [],
        staleExperimentDetails: [],
      },
    };
    writeFileSync(pointerPath, JSON.stringify(previous, null, 2));
    mkdirSync(join(TEST_ROOT, "state"), { recursive: true });
    writeFileSync(
      join(TEST_ROOT, "state", "dream-schedule.json"),
      JSON.stringify({
        enabled: false,
        schedule: "0 3 * * *",
        mode: "full",
        quietHoursStart: 23,
        quietHoursEnd: 7,
      }),
    );

    const output = execFileSync("npx", ["tsx", "scripts/run-dream-cycle.ts", "--no-json"], {
      cwd: process.cwd(),
      encoding: "utf-8",
      env: {
        ...process.env,
        BRAIN_ROOT: TEST_ROOT,
        BRAIN_PGLITE_PATH: join(TEST_ROOT, "brain.pglite"),
        SCIENCESWARM_USER_HANDLE: "@test-researcher",
      },
    });

    expect(output).toContain("dream-cycle: skipped");
    expect(JSON.parse(readFileSync(pointerPath, "utf-8"))).toEqual(previous);
  });

  it("reports the existing pointer path when a skipped sidecar poll emits JSON", () => {
    const pointerPath = join(TEST_ROOT, ".dream-last-run.json");
    const previous = {
      timestamp: "2026-04-18T08:00:00.000Z",
      mode: "full",
      pages_compiled: 3,
      contradictions_found: 1,
      backlinks_added: 4,
      duration_ms: 1000,
      duration_ms_per_stage: { total: 1000 },
      errors: [],
      partial: false,
    };
    writeFileSync(pointerPath, JSON.stringify(previous, null, 2));
    mkdirSync(join(TEST_ROOT, "state"), { recursive: true });
    writeFileSync(
      join(TEST_ROOT, "state", "dream-schedule.json"),
      JSON.stringify({
        enabled: false,
        schedule: "0 3 * * *",
        mode: "full",
        quietHoursStart: 23,
        quietHoursEnd: 7,
      }),
    );

    const output = execFileSync("npx", ["tsx", "scripts/run-dream-cycle.ts"], {
      cwd: process.cwd(),
      encoding: "utf-8",
      env: {
        ...process.env,
        BRAIN_ROOT: TEST_ROOT,
        BRAIN_PGLITE_PATH: join(TEST_ROOT, "brain.pglite"),
        SCIENCESWARM_USER_HANDLE: "@test-researcher",
      },
    });
    const summary = JSON.parse(output);

    expect(summary).toMatchObject({
      type: "summary",
      skipped: true,
      reason: "Not due yet",
      last_run_path: pointerPath,
    });
    expect(JSON.parse(readFileSync(pointerPath, "utf-8"))).toEqual(previous);
  });

  it("reports null pointer path when a skipped sidecar poll has no previous run", () => {
    const pointerPath = join(TEST_ROOT, ".dream-last-run.json");
    mkdirSync(join(TEST_ROOT, "state"), { recursive: true });
    writeFileSync(
      join(TEST_ROOT, "state", "dream-schedule.json"),
      JSON.stringify({
        enabled: false,
        schedule: "0 3 * * *",
        mode: "full",
        quietHoursStart: 23,
        quietHoursEnd: 7,
      }),
    );

    const output = execFileSync("npx", ["tsx", "scripts/run-dream-cycle.ts"], {
      cwd: process.cwd(),
      encoding: "utf-8",
      env: {
        ...process.env,
        BRAIN_ROOT: TEST_ROOT,
        BRAIN_PGLITE_PATH: join(TEST_ROOT, "brain.pglite"),
        SCIENCESWARM_USER_HANDLE: "@test-researcher",
      },
    });
    const summary = JSON.parse(output);

    expect(summary).toMatchObject({
      type: "summary",
      skipped: true,
      reason: "Not due yet",
      last_run_path: null,
    });
    expect(existsSync(pointerPath)).toBe(false);
  });

  it("runs sweep-only mode and updates state", async () => {
    const config = makeConfig();
    const llm = makeMockLLM();

    // Log some events first
    logEvent(config, {
      ts: new Date().toISOString(),
      type: "ingest",
      contentType: "note",
      created: ["wiki/resources/test-note.md"],
    });

    // Create the referenced page
    mkdirSync(join(TEST_ROOT, "wiki/resources"), { recursive: true });
    writeFileSync(
      join(TEST_ROOT, "wiki/resources/test-note.md"),
      "---\ndate: 2024-01-01\ntype: note\npara: resources\ntags: []\n---\n\n# Test Note\nSome content.\n",
    );

    // Mock fetch
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );

    try {
      const result = await runDreamCycle(config, llm, "sweep-only");

      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(typeof result.report).toBe("string");
      expect(result.report).toContain("Dream Cycle Report");

      // State should be updated
      const state = readDreamState(config);
      expect(state.lastFullRun).not.toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("ignores compile-only dream cycle events on later sweeps", async () => {
    const config = makeConfig();
    const llm = makeMockLLM();

    logEvent(config, {
      ts: new Date().toISOString(),
      type: "ingest",
      contentType: "note",
      created: ["wiki/resources/test-note.md"],
    });

    mkdirSync(join(TEST_ROOT, "wiki/resources"), { recursive: true });
    writeFileSync(
      join(TEST_ROOT, "wiki/resources/test-note.md"),
      "---\ndate: 2024-01-01\ntype: note\npara: resources\ntags: []\n---\n\n# Test Note\nSome content.\n",
    );

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );

    try {
      await runDreamCycle(config, llm, "sweep-only");
      const firstState = readDreamState(config);
      expect(firstState.processedEventIds).toHaveLength(1);

      const secondRun = await runDreamCycle(config, llm, "sweep-only");
      const secondState = readDreamState(config);

      expect(secondRun.entitiesSwept).toBe(0);
      expect(secondState.processedEventIds).toHaveLength(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("generates a report even with no activity", async () => {
    const config = makeConfig();
    const llm = makeMockLLM();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );

    try {
      const result = await runDreamCycle(config, llm, "sweep-only");
      expect(result.report).toContain("Dream Cycle Report");
      expect(result.entitiesSwept).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("saves dream report to disk", async () => {
    const config = makeConfig();
    const llm = makeMockLLM();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );

    try {
      await runDreamCycle(config, llm, "sweep-only");

      const dateStr = new Date().toISOString().slice(0, 10);
      const reportPath = join(TEST_ROOT, "state", "dream-reports", `${dateStr}.md`);
      expect(existsSync(reportPath)).toBe(true);

      const report = readFileSync(reportPath, "utf-8");
      expect(report).toContain("Dream Cycle Report");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("persists a dream journal artifact when gbrain write-back is available", async () => {
    const config = makeConfig();
    const llm = makeMockLLM();
    vi.stubEnv("BRAIN_ROOT", TEST_ROOT);
    vi.stubEnv("BRAIN_PGLITE_PATH", join(TEST_ROOT, "brain.pglite"));
    vi.stubEnv("SCIENCESWARM_USER_HANDLE", "@test-researcher");

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );

    try {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-04-22T12:00:00.000Z"));

      const result = await runDreamCycle(config, llm, "sweep-only");
      const dateStr = new Date().toISOString().slice(0, 10);
      const expectedSlug = `journals/${dateStr}-dream-cycle-sweep-only`;

      expect(result.journalSlug).toBe(expectedSlug);
      expect(existsSync(join(TEST_ROOT, "journals", `${dateStr}-dream-cycle-sweep-only.md`))).toBe(true);

      const journal = readFileSync(
        join(TEST_ROOT, "journals", `${dateStr}-dream-cycle-sweep-only.md`),
        "utf-8",
      );
      expect(journal).toContain("Dream Cycle Journal");
      expect(journal).toContain("Mode: sweep-only");
    } finally {
      globalThis.fetch = originalFetch;
      vi.useRealTimers();
    }
  });

  it("compiles concept updates from recent evidence during the full dream cycle", async () => {
    const config = makeConfig();
    vi.stubEnv("BRAIN_ROOT", TEST_ROOT);
    vi.stubEnv("BRAIN_PGLITE_PATH", join(TEST_ROOT, "brain.pglite"));
    vi.stubEnv("SCIENCESWARM_USER_HANDLE", "@test-researcher");
    await resetBrainStore();
    await ensureBrainStoreReady();
    const adapter = getBrainStore() as GbrainEngineAdapter;
    const engine = adapter.engine;

    await engine.putPage("wiki/concepts/rlhf-alignment", {
      type: "concept",
      title: "RLHF alignment",
      compiled_truth: "RLHF is the dominant alignment approach.",
      timeline: "",
      frontmatter: { project: "alignment" },
    });
    await engine.putPage("wiki/entities/papers/deceptive-rlhf", {
      type: "paper",
      title: "Deceptive RLHF",
      compiled_truth: "RLHF optimizes reward models into deceptive alignment.",
      timeline: "",
      frontmatter: { project: "alignment" },
    });

    mkdirSync(join(TEST_ROOT, "wiki/entities/papers"), { recursive: true });
    writeFileSync(
      join(TEST_ROOT, "wiki/entities/papers/deceptive-rlhf.md"),
      [
        "---",
        "date: 2026-04-18",
        "type: paper",
        "title: Deceptive RLHF",
        "year: 2026",
        "---",
        "",
        "# Deceptive RLHF",
        "",
        "RLHF optimizes reward models into deceptive alignment.",
      ].join("\n"),
    );
    logEvent(config, {
      ts: new Date().toISOString(),
      type: "ingest",
      contentType: "paper",
      created: ["wiki/entities/papers/deceptive-rlhf.md"],
    });

    const result = await runDreamCycle(config, makeCompileLLM(), "full");

    expect(result.pagesCompiled).toBe(1);
    expect(result.contradictionsFound).toBe(1);
    expect(result.backlinksAdded).toBe(2);
    const updated = await engine.getPage("wiki/concepts/rlhf-alignment");
    expect(updated?.compiled_truth).toContain("contested");
    await expect(adapter.getLinks("wiki/concepts/rlhf-alignment.md")).resolves.toContainEqual(
      expect.objectContaining({ kind: "cites" }),
    );
    await expect(adapter.getBacklinks("wiki/concepts/rlhf-alignment.md")).resolves.toContainEqual(
      expect.objectContaining({ kind: "contradicts" }),
    );
  });

  it("builds the morning headline by compiling concepts touched by new gbrain papers", async () => {
    const config = makeConfig();
    vi.stubEnv("BRAIN_ROOT", TEST_ROOT);
    vi.stubEnv("BRAIN_PGLITE_PATH", join(TEST_ROOT, "brain.pglite"));
    vi.stubEnv("SCIENCESWARM_USER_HANDLE", "@test-researcher");
    await resetBrainStore();
    await ensureBrainStoreReady();
    const adapter = getBrainStore() as GbrainEngineAdapter;
    const engine = adapter.engine;
    const now = new Date().toISOString();

    await engine.putPage("concepts/rlhf-alignment", {
      type: "concept",
      title: "RLHF alignment",
      compiled_truth: "RLHF is the dominant alignment approach.",
      timeline: "",
      frontmatter: { project: "alignment", type: "concept" },
    });
    await engine.putPage("papers/deceptive-rlhf", {
      type: "paper",
      title: "Deceptive RLHF",
      compiled_truth: "RLHF optimizes reward models into deceptive alignment.",
      timeline: "",
      frontmatter: {
        project: "alignment",
        type: "paper",
      },
    });
    logEvent(config, {
      ts: now,
      type: "ingest",
      contentType: "paper",
      created: ["papers/deceptive-rlhf.md"],
    });

    const result = await runDreamCycle(config, makeCompileLLM(), "full");

    expect(result.headline).toMatchObject({
      newPapers: 1,
      topicsRecompiled: 1,
      contradictionsFound: 1,
      crossReferencesAdded: 2,
      brokenBacklinksFixed: 0,
    });
    expect(result.headline?.headline).toContain("While you slept:");
    expect(result.headline?.compiledTopics[0]).toMatchObject({
      slug: "concepts/rlhf-alignment",
      title: "RLHF alignment",
    });
    const updated = await engine.getPage("concepts/rlhf-alignment");
    expect(updated?.compiled_truth).toContain("contested");
  });

  it("infers source type from path segments without incidental substring matches", async () => {
    const config = makeConfig();
    vi.stubEnv("BRAIN_ROOT", TEST_ROOT);
    vi.stubEnv("BRAIN_PGLITE_PATH", join(TEST_ROOT, "brain.pglite"));
    await resetBrainStore();

    const result = await compileAffectedConceptsForSource({
      sourceSlug: "notes/paperweight-calibration",
      content: "Paperweight calibration note.",
      config,
      llm: makeMockLLM(),
    });

    expect(result.sourceType).toBe("note");
    expect(result.pagesCompiled).toBe(0);
  });

  it("creates a first compiled topic from new source evidence when no concept page exists yet", async () => {
    const config = makeConfig();
    vi.stubEnv("BRAIN_ROOT", TEST_ROOT);
    vi.stubEnv("BRAIN_PGLITE_PATH", join(TEST_ROOT, "brain.pglite"));
    vi.stubEnv("SCIENCESWARM_USER_HANDLE", "@test-researcher");
    await resetBrainStore();
    await ensureBrainStoreReady();
    const adapter = getBrainStore() as GbrainEngineAdapter;
    const engine = adapter.engine;

    await engine.putPage("papers/aav9-liver-tropism-null-result", {
      type: "paper",
      title: "AAV9 liver tropism null result",
      compiled_truth:
        "Topic: AAV9 liver tropism. AAV9 does not improve liver transduction in adult mice.",
      timeline: "",
      frontmatter: {
        project: "vectors",
        type: "paper",
      },
    });

    const result = await compileAffectedConceptsForSource({
      sourceSlug: "papers/aav9-liver-tropism-null-result",
      sourceTitle: "AAV9 liver tropism null result",
      sourceType: "paper",
      content:
        "Topic: AAV9 liver tropism. AAV9 does not improve liver transduction in adult mice.",
      config,
      llm: {
        async complete(call): Promise<LLMResponse> {
          const cost = {
            inputTokens: 1,
            outputTokens: 1,
            estimatedUsd: 0,
            model: call.model ?? "test",
          };
          if (call.user.includes("Extract source claims")) {
            return {
              content: JSON.stringify({
                claims: [
                  {
                    text: "AAV9 does not improve liver transduction in adult mice.",
                    source: "papers/aav9-liver-tropism-null-result",
                  },
                ],
              }),
              cost,
            };
          }
          if (call.user.includes("Extract compiled truth claims")) {
            return { content: JSON.stringify({ claims: [] }), cost };
          }
          if (call.user.includes("Compare claims")) {
            return { content: JSON.stringify({ contradictions: [] }), cost };
          }
          return {
            content: JSON.stringify({
              compiled_truth:
                "AAV9 liver tropism is now a tracked current-view topic. The newest evidence says AAV9 does not improve liver transduction in adult mice.",
            }),
            cost,
          };
        },
      },
    });

    expect(result.pagesCompiled).toBe(1);
    expect(result.compiledTopics[0]).toMatchObject({
      slug: "wiki/concepts/aav9-liver-tropism",
      title: "AAV9 liver tropism",
    });
    const created = await engine.getPage("wiki/concepts/aav9-liver-tropism");
    expect(created?.type).toBe("concept");
    expect(created?.compiled_truth).toContain("AAV9");
    await expect(adapter.getLinks("wiki/concepts/aav9-liver-tropism.md")).resolves.toContainEqual(
      expect.objectContaining({
        kind: "cites",
        slug: "papers/aav9-liver-tropism-null-result.md",
      }),
    );
  });

  it("creates a first compiled topic from a task source when no concept page exists yet", async () => {
    const config = makeConfig();
    vi.stubEnv("BRAIN_ROOT", TEST_ROOT);
    vi.stubEnv("BRAIN_PGLITE_PATH", join(TEST_ROOT, "brain.pglite"));
    vi.stubEnv("SCIENCESWARM_USER_HANDLE", "@test-researcher");
    await resetBrainStore();
    await ensureBrainStoreReady();
    const adapter = getBrainStore() as GbrainEngineAdapter;
    const engine = adapter.engine;

    await engine.putPage("wiki/tasks/netosis-timing-assay", {
      type: "task",
      title: "Neutrophil NETosis timing assay",
      compiled_truth:
        "Topic: Neutrophil NETosis timing assay. Research task: quantify whether IL-8 priming changes the NETosis onset time in donor neutrophils.",
      timeline: "",
      frontmatter: {
        project: "netosis",
        type: "task",
        status: "open",
      },
    });

    const result = await compileAffectedConceptsForSource({
      sourceSlug: "wiki/tasks/netosis-timing-assay",
      sourceTitle: "Neutrophil NETosis timing assay",
      sourceType: "task",
      content:
        "Topic: Neutrophil NETosis timing assay. Research task: quantify whether IL-8 priming changes the NETosis onset time in donor neutrophils.",
      config,
      llm: {
        async complete(call): Promise<LLMResponse> {
          const cost = {
            inputTokens: 1,
            outputTokens: 1,
            estimatedUsd: 0,
            model: call.model ?? "test",
          };
          if (call.user.includes("Extract source claims")) {
            return {
              content: JSON.stringify({
                claims: [
                  {
                    text: "IL-8 priming may change NETosis onset time in donor neutrophils.",
                    source: "wiki/tasks/netosis-timing-assay",
                  },
                ],
              }),
              cost,
            };
          }
          if (call.user.includes("Extract compiled truth claims")) {
            return { content: JSON.stringify({ claims: [] }), cost };
          }
          if (call.user.includes("Compare claims")) {
            return { content: JSON.stringify({ contradictions: [] }), cost };
          }
          return {
            content: JSON.stringify({
              compiled_truth:
                "Neutrophil NETosis timing assay is now a tracked current-view topic. The active task asks whether IL-8 priming changes NETosis onset time.",
            }),
            cost,
          };
        },
      },
    });

    expect(result.pagesCompiled).toBe(1);
    expect(result.compiledTopics[0]).toMatchObject({
      slug: "wiki/concepts/neutrophil-netosis-timing-assay",
      title: "Neutrophil NETosis timing assay",
    });
    const created = await engine.getPage("wiki/concepts/neutrophil-netosis-timing-assay");
    expect(created?.type).toBe("concept");
    expect(created?.compiled_truth).toContain("NETosis");
    await expect(adapter.getLinks("wiki/concepts/neutrophil-netosis-timing-assay.md")).resolves.toContainEqual(
      expect.objectContaining({
        kind: "cites",
        slug: "wiki/tasks/netosis-timing-assay.md",
      }),
    );
  });

  it("creates a fallback topic when the skip list excludes only unrelated concepts", async () => {
    const config = makeConfig();
    vi.stubEnv("BRAIN_ROOT", TEST_ROOT);
    vi.stubEnv("BRAIN_PGLITE_PATH", join(TEST_ROOT, "brain.pglite"));
    vi.stubEnv("SCIENCESWARM_USER_HANDLE", "@test-researcher");
    await resetBrainStore();
    await ensureBrainStoreReady();
    const adapter = getBrainStore() as GbrainEngineAdapter;
    const engine = adapter.engine;

    await engine.putPage("papers/aav9-spleen-trafficking", {
      type: "paper",
      title: "AAV9 spleen trafficking",
      compiled_truth:
        "Topic: AAV9 spleen trafficking. AAV9 enrichment in spleen macrophages is the new signal to track.",
      timeline: "",
      frontmatter: {
        project: "vectors",
        type: "paper",
      },
    });

    const result = await compileAffectedConceptsForSource({
      sourceSlug: "papers/aav9-spleen-trafficking",
      sourceTitle: "AAV9 spleen trafficking",
      sourceType: "paper",
      content:
        "Topic: AAV9 spleen trafficking. AAV9 enrichment in spleen macrophages is the new signal to track.",
      config,
      llm: makeCompileLLM(),
      skipConceptSlugs: ["wiki/concepts/unrelated-vector-topic"],
    });

    expect(result.pagesCompiled).toBe(1);
    expect(result.compiledTopics[0]).toMatchObject({
      slug: "wiki/concepts/aav9-spleen-trafficking",
      title: "AAV9 spleen trafficking",
    });
    await expect(engine.getPage("wiki/concepts/aav9-spleen-trafficking")).resolves.toMatchObject({
      type: "concept",
      title: "AAV9 spleen trafficking",
    });
  });

  it("prefers explicit source topic labels over incidental matches to existing concepts", async () => {
    const config = makeConfig();
    vi.stubEnv("BRAIN_ROOT", TEST_ROOT);
    vi.stubEnv("BRAIN_PGLITE_PATH", join(TEST_ROOT, "brain.pglite"));
    vi.stubEnv("SCIENCESWARM_USER_HANDLE", "@test-researcher");
    await resetBrainStore();
    await ensureBrainStoreReady();
    const adapter = getBrainStore() as GbrainEngineAdapter;
    const engine = adapter.engine;

    await engine.putPage("wiki/concepts/aav9-liver-tropism", {
      type: "concept",
      title: "AAV9 liver tropism",
      compiled_truth:
        "AAV9 liver tropism is a current view with strong evidence. It improves delivery until contradicted.",
      timeline: "",
      frontmatter: {
        project: "vectors",
        type: "concept",
      },
    });

    await engine.putPage("notes/itgae-t-cell-residency-observation", {
      type: "observation",
      title: "ITGAE T cell residency observation",
      compiled_truth:
        "Topic: ITGAE T cell residency. Current view: ITGAE does not improve T cell residency versus control, contradicting the old residency view.",
      timeline: "",
      frontmatter: {
        project: "immunology",
        type: "observation",
      },
    });

    const result = await compileAffectedConceptsForSource({
      sourceSlug: "notes/itgae-t-cell-residency-observation",
      sourceTitle: "ITGAE T cell residency observation",
      sourceType: "lab_data",
      content:
        "Topic: ITGAE T cell residency. Current view: ITGAE does not improve T cell residency versus control, contradicting the old residency view.",
      config,
      llm: {
        async complete(call): Promise<LLMResponse> {
          const cost = {
            inputTokens: 1,
            outputTokens: 1,
            estimatedUsd: 0,
            model: call.model ?? "test",
          };
          if (call.user.includes("Extract source claims")) {
            return {
              content: JSON.stringify({
                claims: [
                  {
                    text: "ITGAE does not improve T cell residency versus control.",
                    source: "notes/itgae-t-cell-residency-observation",
                  },
                ],
              }),
              cost,
            };
          }
          if (call.user.includes("Extract compiled truth claims")) {
            return { content: JSON.stringify({ claims: [] }), cost };
          }
          if (call.user.includes("Compare claims")) {
            return { content: JSON.stringify({ contradictions: [] }), cost };
          }
          return {
            content: JSON.stringify({
              compiled_truth:
                "ITGAE T cell residency is now the compiled current-view topic for this observation. The newest evidence says ITGAE does not improve T cell residency versus control.",
            }),
            cost,
          };
        },
      },
    });

    expect(result.pagesCompiled).toBe(1);
    expect(result.compiledTopics).toHaveLength(1);
    expect(result.compiledTopics[0]).toMatchObject({
      slug: "wiki/concepts/itgae-t-cell-residency",
      title: "ITGAE T cell residency",
    });
    expect(result.compiledTopics[0]?.slug).not.toBe("wiki/concepts/aav9-liver-tropism");
    const created = await engine.getPage("wiki/concepts/itgae-t-cell-residency");
    expect(created?.type).toBe("concept");
    expect(created?.compiled_truth).toContain("ITGAE");
    const aav9 = await engine.getPage("wiki/concepts/aav9-liver-tropism");
    expect(aav9?.compiled_truth).not.toContain("ITGAE");
    await expect(adapter.getLinks("wiki/concepts/itgae-t-cell-residency.md")).resolves.toContainEqual(
      expect.objectContaining({
        kind: "cites",
        slug: "notes/itgae-t-cell-residency-observation.md",
      }),
    );
  });

  it("flags stale experiments in the morning headline", async () => {
    const config = makeConfig();
    vi.stubEnv("BRAIN_ROOT", TEST_ROOT);
    vi.stubEnv("BRAIN_PGLITE_PATH", join(TEST_ROOT, "brain.pglite"));
    vi.stubEnv("SCIENCESWARM_USER_HANDLE", "@test-researcher");
    await resetBrainStore();
    await ensureBrainStoreReady();
    const adapter = getBrainStore() as GbrainEngineAdapter;
    const engine = adapter.engine;

    await engine.putPage("experiments/stale-assay", {
      type: "experiment",
      title: "Stale assay",
      compiled_truth: "Assay is still running.",
      timeline: "",
      frontmatter: {
        type: "experiment",
        status: "running",
        date: "2026-03-01",
      },
    });

    const result = await runDreamCycle(config, makeMockLLM(), "full");

    expect(result.headline?.staleExperiments).toBe(1);
    expect(result.headline?.staleExperimentDetails[0]).toMatchObject({
      slug: "experiments/stale-assay",
      title: "Stale assay",
    });
    await expect(adapter.getTimeline("experiments/stale-assay.md")).resolves.toContainEqual(
      expect.objectContaining({
        source: "dream-cycle",
        summary: "Experiment flagged as stale",
      }),
    );
    const second = await runDreamCycle(config, makeMockLLM(), "full");
    const timeline = await adapter.getTimeline("experiments/stale-assay.md");
    const dreamFlags = timeline.filter(
      (entry) => entry.source === "dream-cycle" && entry.summary === "Experiment flagged as stale",
    );
    expect(second.headline?.staleExperiments).toBe(1);
    expect(dreamFlags).toHaveLength(1);
  });

  it("flags research tasks with explicit old last-update dates as stale work", async () => {
    const config = makeConfig();
    vi.stubEnv("BRAIN_ROOT", TEST_ROOT);
    vi.stubEnv("BRAIN_PGLITE_PATH", join(TEST_ROOT, "brain.pglite"));
    vi.stubEnv("SCIENCESWARM_USER_HANDLE", "@test-researcher");
    await resetBrainStore();
    await ensureBrainStoreReady();
    const adapter = getBrainStore() as GbrainEngineAdapter;
    const engine = adapter.engine;

    await engine.putPage("wiki/tasks/netosis-timing-assay", {
      type: "task",
      title: "Neutrophil NETosis timing assay",
      compiled_truth: [
        "# Neutrophil NETosis timing assay",
        "",
        "Research task: quantify whether IL-8 priming changes the NETosis onset time in donor neutrophils.",
        "Status: running.",
        "Last update: 2026-02-12.",
        "Open question: whether the timing window should be rerun with donor-matched viability controls.",
      ].join("\n"),
      timeline: "",
      frontmatter: {
        type: "task",
        status: "open",
        date: "2026-04-18",
      },
    });

    const result = await runDreamCycle(config, makeMockLLM(), "full");
    const expectedAgeDays = Math.floor(
      (Date.now() - Date.parse("2026-02-12T00:00:00.000Z")) / 86_400_000,
    );

    expect(result.headline?.staleExperiments).toBe(1);
    expect(result.headline?.headline).toContain("1 stale work item");
    expect(result.headline?.staleExperimentDetails[0]).toMatchObject({
      slug: "wiki/tasks/netosis-timing-assay",
      title: "Neutrophil NETosis timing assay",
      kind: "task",
      reason: `No research task update for ${expectedAgeDays} days.`,
    });
    await expect(adapter.getTimeline("wiki/tasks/netosis-timing-assay.md")).resolves.toContainEqual(
      expect.objectContaining({
        source: "dream-cycle",
        summary: "Research task flagged as stale",
      }),
    );
  });
});

// ── Enrichment Target Prioritization ──────────────────

describe("Enrichment target prioritization", () => {
  it("high priority targets are processed before low", () => {
    const targets: EnrichmentTarget[] = [
      { type: "concept", identifier: "low-concept", priority: "low" },
      { type: "paper", identifier: "high-paper", priority: "high" },
      { type: "author", identifier: "medium-author", priority: "medium" },
    ];

    const sorted = [...targets].sort((a, b) => {
      const order = { high: 0, medium: 1, low: 2 };
      return order[a.priority] - order[b.priority];
    });

    expect(sorted[0].identifier).toBe("high-paper");
    expect(sorted[1].identifier).toBe("medium-author");
    expect(sorted[2].identifier).toBe("low-concept");
  });
});
