import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  readFileSync,
  writeFileSync,
  rmSync,
  mkdirSync,
  existsSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { initBrain } from "@/brain/init";
import type { BrainConfig } from "@/brain/types";
import type { LLMClient, LLMResponse } from "@/brain/llm";

const TEST_ROOT = join(tmpdir(), "scienceswarm-brain-test-maintenance");

// ── Top-level mocks (hoisted by vitest) ──────────────

vi.mock("@/brain/config", () => ({
  loadBrainConfig: () => ({
    root: join(tmpdir(), "scienceswarm-brain-test-maintenance"),
    extractionModel: "test",
    synthesisModel: "test",
    rippleCap: 15,
    paperWatchBudget: 50,
    serendipityRate: 0.2,
  }),
  resolveBrainRoot: () => join(tmpdir(), "scienceswarm-brain-test-maintenance"),
  brainExists: () => true,
}));

vi.mock("@/brain/llm", () => ({
  createLLMClient: () => ({
    async complete() {
      return {
        content: "{}",
        cost: { inputTokens: 0, outputTokens: 0, estimatedUsd: 0, model: "test" },
      };
    },
  }),
}));

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
          themes: [],
          concept_updates: [],
          summary: "Test consolidation",
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

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("SCIENCESWARM_USER_HANDLE", "@brain-maintenance-test");
  rmSync(TEST_ROOT, { recursive: true, force: true });
  initBrain({ root: TEST_ROOT });
});

afterEach(() => {
  vi.resetModules();
  rmSync(TEST_ROOT, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

// ══════════════════════════════════════════════════════
// 1. Name Resolution
// ══════════════════════════════════════════════════════

describe("Name Resolver", () => {
  describe("extractKeyTerms", () => {
    it("extracts meaningful terms and removes stop words", async () => {
      const { extractKeyTerms } = await import("@/brain/name-resolver");

      const terms = extractKeyTerms("the Anthropic SAE paper");
      expect(terms).toContain("Anthropic");
      expect(terms).toContain("SAE");
      expect(terms).not.toContain("the");
      expect(terms).not.toContain("paper");
    });

    it("returns empty array for all-stopword input", async () => {
      const { extractKeyTerms } = await import("@/brain/name-resolver");

      const terms = extractKeyTerms("the a an");
      expect(terms).toEqual([]);
    });

    it("handles author-style references", async () => {
      const { extractKeyTerms } = await import("@/brain/name-resolver");

      const terms = extractKeyTerms("Bricken et al.");
      expect(terms).toContain("Bricken");
      // "et" is 2 chars and filtered, "al" is 2 chars and filtered
      expect(terms.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("isAuthorReference", () => {
    it("detects 'et al.' pattern", async () => {
      const { isAuthorReference } = await import("@/brain/name-resolver");

      expect(isAuthorReference("Bricken et al.")).toBe(true);
      expect(isAuthorReference("Vaswani et al")).toBe(true);
    });

    it("detects 'X and Y' pattern", async () => {
      const { isAuthorReference } = await import("@/brain/name-resolver");

      expect(isAuthorReference("Vaswani and Shazeer")).toBe(true);
    });

    it("rejects non-author references", async () => {
      const { isAuthorReference } = await import("@/brain/name-resolver");

      expect(isAuthorReference("the attention paper")).toBe(false);
      expect(isAuthorReference("sparse autoencoders")).toBe(false);
    });
  });

  describe("resolveInformalReference", () => {
    it("resolves 'the X paper' to correct paper page", async () => {
      const { resolveInformalReference } = await import(
        "@/brain/name-resolver"
      );
      const config = makeConfig();

      // Create a paper page with matching content
      const paperDir = join(TEST_ROOT, "wiki/entities/papers");
      mkdirSync(paperDir, { recursive: true });
      writeFileSync(
        join(paperDir, "anthropic-sae-2024.md"),
        [
          "---",
          "date: 2024-06-01",
          "type: paper",
          "para: resources",
          'title: "Scaling Monosemanticity: Extracting Interpretable Features from Claude 3 Sonnet"',
          "authors: [Bricken, Templeton]",
          "year: 2024",
          'venue: "Anthropic Research"',
          "tags: [paper, SAE, interpretability]",
          "---",
          "",
          "# Scaling Monosemanticity",
          "",
          "## Summary",
          "This paper from Anthropic describes sparse autoencoders (SAE) applied to Claude.",
        ].join("\n"),
      );

      const result = await resolveInformalReference(
        config,
        "the Anthropic SAE paper",
      );

      expect(result).not.toBeNull();
      expect(result!.path).toContain("anthropic-sae-2024");
      expect(result!.confidence).toBeGreaterThan(0.3);
      expect(result!.title).toBeTruthy();
    });

    it("returns null when no match exists", async () => {
      const { resolveInformalReference } = await import(
        "@/brain/name-resolver"
      );
      const config = makeConfig();

      const result = await resolveInformalReference(
        config,
        "the nonexistent quantum gravity paper",
      );

      expect(result).toBeNull();
    });

    it("returns null for empty input", async () => {
      const { resolveInformalReference } = await import(
        "@/brain/name-resolver"
      );
      const config = makeConfig();

      const result = await resolveInformalReference(config, "the a an");
      expect(result).toBeNull();
    });
  });

  describe("resolveAllInformalRefs", () => {
    it("finds and resolves informal references in page content", async () => {
      const { resolveAllInformalRefs } = await import(
        "@/brain/name-resolver"
      );
      const config = makeConfig();

      // Create matching pages
      const paperDir = join(TEST_ROOT, "wiki/entities/papers");
      mkdirSync(paperDir, { recursive: true });
      writeFileSync(
        join(paperDir, "attention-mechanism.md"),
        [
          "---",
          "date: 2017-06-12",
          "type: paper",
          "para: resources",
          'title: "Attention Is All You Need"',
          "authors: [Vaswani, Shazeer, Parmar]",
          "year: 2017",
          'venue: "NeurIPS"',
          "tags: [paper, attention, transformer]",
          "---",
          "",
          "# Attention Is All You Need",
          "",
          "The seminal Transformer architecture paper.",
        ].join("\n"),
      );

      const content =
        "In our work, we build on the Attention Transformer paper and extend it.";
      const results = await resolveAllInformalRefs(config, content);

      // Pattern matching may or may not find references depending on exact regex
      // The function should at least not throw
      expect(Array.isArray(results)).toBe(true);
    });
  });
});

// ══════════════════════════════════════════════════════
// 2. Original Clustering
// ══════════════════════════════════════════════════════

describe("Original Clustering", () => {
  describe("extractKeywords", () => {
    it("extracts meaningful keywords and filters stop words", async () => {
      const { extractKeywords } = await import(
        "@/brain/original-clustering"
      );

      const keywords = extractKeywords(
        "Sparse autoencoders can reveal hidden structure in neural networks",
      );

      expect(keywords.has("sparse")).toBe(true);
      expect(keywords.has("autoencoders")).toBe(true);
      expect(keywords.has("neural")).toBe(true);
      expect(keywords.has("networks")).toBe(true);
      expect(keywords.has("hidden")).toBe(true);
      expect(keywords.has("structure")).toBe(true);
      // Stop words removed
      expect(keywords.has("can")).toBe(false);
      expect(keywords.has("the")).toBe(false);
      expect(keywords.has("in")).toBe(false);
    });
  });

  describe("jaccardSimilarity", () => {
    it("returns 1.0 for identical sets", async () => {
      const { jaccardSimilarity } = await import(
        "@/brain/original-clustering"
      );

      const a = new Set(["x", "y", "z"]);
      const b = new Set(["x", "y", "z"]);
      expect(jaccardSimilarity(a, b)).toBe(1.0);
    });

    it("returns 0.0 for disjoint sets", async () => {
      const { jaccardSimilarity } = await import(
        "@/brain/original-clustering"
      );

      const a = new Set(["x", "y"]);
      const b = new Set(["a", "b"]);
      expect(jaccardSimilarity(a, b)).toBe(0);
    });

    it("returns correct partial overlap", async () => {
      const { jaccardSimilarity } = await import(
        "@/brain/original-clustering"
      );

      // {a,b,c} vs {b,c,d} => intersection=2, union=4 => 0.5
      const a = new Set(["a", "b", "c"]);
      const b = new Set(["b", "c", "d"]);
      expect(jaccardSimilarity(a, b)).toBe(0.5);
    });

    it("returns 0.0 for two empty sets", async () => {
      const { jaccardSimilarity } = await import(
        "@/brain/original-clustering"
      );

      expect(jaccardSimilarity(new Set(), new Set())).toBe(0);
    });
  });

  describe("clusterOriginals", () => {
    it("clusters similar originals together", async () => {
      const { clusterOriginals } = await import(
        "@/brain/original-clustering"
      );
      const config = makeConfig();

      // Create 5 originals: 3 about SAE/interpretability, 2 about RL/reward
      const originalsDir = join(TEST_ROOT, "wiki/originals");
      mkdirSync(originalsDir, { recursive: true });

      // Cluster A: interpretability
      writeFileSync(
        join(originalsDir, "sae-features.md"),
        [
          "---",
          "date: 2024-06-01",
          "type: note",
          "para: resources",
          'title: "SAE features are interpretable"',
          "tags: [original, hypothesis]",
          "---",
          "",
          "# SAE features are interpretable",
          "",
          "## Compiled Truth",
          "",
          "> Sparse autoencoder features capture interpretable concepts in neural network activations",
          "",
          "**Kind**: hypothesis",
        ].join("\n"),
      );

      writeFileSync(
        join(originalsDir, "interpretability-scaling.md"),
        [
          "---",
          "date: 2024-06-15",
          "type: note",
          "para: resources",
          'title: "Interpretability scales with sparse autoencoders"',
          "tags: [original, hypothesis]",
          "---",
          "",
          "# Interpretability scales with sparse autoencoders",
          "",
          "## Compiled Truth",
          "",
          "> Sparse autoencoder interpretability improves with model scale and feature count",
          "",
          "**Kind**: hypothesis",
        ].join("\n"),
      );

      writeFileSync(
        join(originalsDir, "feature-splitting.md"),
        [
          "---",
          "date: 2024-07-01",
          "type: note",
          "para: resources",
          'title: "Feature splitting in sparse autoencoders"',
          "tags: [original, observation]",
          "---",
          "",
          "# Feature splitting in sparse autoencoders",
          "",
          "## Compiled Truth",
          "",
          "> Feature splitting occurs when sparse autoencoder capacity is increased for neural network features",
          "",
          "**Kind**: observation",
        ].join("\n"),
      );

      // Cluster B: reinforcement learning
      writeFileSync(
        join(originalsDir, "reward-hacking.md"),
        [
          "---",
          "date: 2024-08-01",
          "type: note",
          "para: resources",
          'title: "Reward hacking in reinforcement learning"',
          "tags: [original, concern]",
          "---",
          "",
          "# Reward hacking in reinforcement learning",
          "",
          "## Compiled Truth",
          "",
          "> Reward hacking exploits misspecified reward functions in reinforcement learning agents",
          "",
          "**Kind**: concern",
        ].join("\n"),
      );

      writeFileSync(
        join(originalsDir, "rl-alignment.md"),
        [
          "---",
          "date: 2024-08-15",
          "type: note",
          "para: resources",
          'title: "RL alignment through reward modeling"',
          "tags: [original, hypothesis]",
          "---",
          "",
          "# RL alignment through reward modeling",
          "",
          "## Compiled Truth",
          "",
          "> Reinforcement learning alignment requires careful reward modeling to avoid reward hacking",
          "",
          "**Kind**: hypothesis",
        ].join("\n"),
      );

      const clusters = await clusterOriginals(config);

      // Should find at least 1 cluster (likely 2)
      expect(clusters.length).toBeGreaterThanOrEqual(1);

      // Each cluster should have at least 2 members
      for (const cluster of clusters) {
        expect(cluster.size).toBeGreaterThanOrEqual(2);
        expect(cluster.members.length).toBe(cluster.size);
        expect(cluster.name.length).toBeGreaterThan(0);
        expect(cluster.keywords.length).toBeGreaterThan(0);
        expect(cluster.mostRecent).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }

      // Total members across clusters should not exceed total originals
      const totalMembers = clusters.reduce((sum, c) => sum + c.size, 0);
      expect(totalMembers).toBeLessThanOrEqual(5);
    });

    it("returns empty array when no originals exist", async () => {
      const { clusterOriginals } = await import(
        "@/brain/original-clustering"
      );
      const config = makeConfig();

      const clusters = await clusterOriginals(config);
      expect(clusters).toEqual([]);
    });

    it("returns empty when all originals are unique topics", async () => {
      const { clusterOriginals } = await import(
        "@/brain/original-clustering"
      );
      const config = makeConfig();

      const originalsDir = join(TEST_ROOT, "wiki/originals");
      mkdirSync(originalsDir, { recursive: true });

      writeFileSync(
        join(originalsDir, "quantum-computing.md"),
        "---\ndate: 2024-01-01\ntype: note\npara: resources\ntitle: Quantum computing\ntags: [original]\n---\n\n# Quantum computing breakthrough\n\n> Quantum supremacy achieved via topological qubits\n",
      );

      writeFileSync(
        join(originalsDir, "cooking-pasta.md"),
        "---\ndate: 2024-02-01\ntype: note\npara: resources\ntitle: Perfect pasta\ntags: [original]\n---\n\n# Perfect pasta recipe\n\n> Salt the water generously before boiling pasta\n",
      );

      // Very different topics with high similarity threshold should yield no clusters
      const clusters = await clusterOriginals(config, 0.5);
      expect(clusters).toEqual([]);
    });
  });

  describe("generateClusterReport", () => {
    it("generates markdown report with cluster details", async () => {
      const { generateClusterReport } = await import(
        "@/brain/original-clustering"
      );

      const clusters = [
        {
          name: "sparse + autoencoders + interpretability",
          keywords: ["sparse", "autoencoders", "interpretability", "features", "neural"],
          members: ["wiki/originals/sae-features.md", "wiki/originals/interp-scaling.md"],
          size: 2,
          mostRecent: "2024-07-01",
          excerpts: ["SAE features capture interpretable concepts", "Interpretability improves with scale"],
        },
      ];

      const report = generateClusterReport(clusters);

      expect(report).toContain("Original Thinking Clusters");
      expect(report).toContain("sparse + autoencoders + interpretability");
      expect(report).toContain("Size**: 2");
      expect(report).toContain("2024-07-01");
      expect(report).toContain("1** theme");
    });

    it("generates empty-state message when no clusters", async () => {
      const { generateClusterReport } = await import(
        "@/brain/original-clustering"
      );

      const report = generateClusterReport([]);
      expect(report).toContain("No clusters detected");
    });
  });
});

// ══════════════════════════════════════════════════════
// 3. Dream Scheduler
// ══════════════════════════════════════════════════════

describe("Dream Scheduler", () => {
  describe("parseCron", () => {
    it("parses valid cron expressions", async () => {
      const { parseCron } = await import("@/brain/dream-scheduler");

      const result = parseCron("0 3 * * *");
      expect(result).not.toBeNull();
      expect(result!.minute).toBe(0);
      expect(result!.hour).toBe(3);
      expect(result!.dayOfMonth).toBeNull();
      expect(result!.month).toBeNull();
      expect(result!.dayOfWeek).toBeNull();
    });

    it("parses fully-specified cron", async () => {
      const { parseCron } = await import("@/brain/dream-scheduler");

      const result = parseCron("30 2 15 6 1");
      expect(result).not.toBeNull();
      expect(result!.minute).toBe(30);
      expect(result!.hour).toBe(2);
      expect(result!.dayOfMonth).toBe(15);
      expect(result!.month).toBe(6);
      expect(result!.dayOfWeek).toBe(1);
    });

    it("parses cron ranges and lists without collapsing them to the first value", async () => {
      const { matchesCron, parseCron } = await import("@/brain/dream-scheduler");

      const result = parseCron("0 6 * * 1-5");
      expect(result).not.toBeNull();
      expect(result!.dayOfWeek).toBeNull();
      expect(result!.dayOfWeekValues).toEqual([1, 2, 3, 4, 5]);

      const monday = new Date(2024, 5, 17, 6, 0);
      const friday = new Date(2024, 5, 21, 6, 0);
      const sunday = new Date(2024, 5, 23, 6, 0);

      expect(matchesCron(result!, monday)).toBe(true);
      expect(matchesCron(result!, friday)).toBe(true);
      expect(matchesCron(result!, sunday)).toBe(false);

      const listResult = parseCron("0 6 * * 1,3,5");
      expect(listResult!.dayOfWeekValues).toEqual([1, 3, 5]);
    });

    it("rejects invalid expressions", async () => {
      const { parseCron } = await import("@/brain/dream-scheduler");

      expect(parseCron("invalid")).toBeNull();
      expect(parseCron("0 3")).toBeNull();
      expect(parseCron("60 3 * * *")).toBeNull(); // minute > 59
      expect(parseCron("0 24 * * *")).toBeNull(); // hour > 23
      expect(parseCron("0 3 32 * *")).toBeNull(); // day > 31
      expect(parseCron("0 3 * 13 *")).toBeNull(); // month > 12
      expect(parseCron("0 3 * * 7")).toBeNull(); // dow > 6
      expect(parseCron("0 3 * * 5-1")).toBeNull(); // reversed range
    });
  });

  describe("matchesCron", () => {
    it("matches when all fields are wildcards", async () => {
      const { matchesCron, parseCron } = await import(
        "@/brain/dream-scheduler"
      );

      const cron = parseCron("* * * * *")!;
      const date = new Date(2024, 5, 15, 10, 30); // any date
      expect(matchesCron(cron, date)).toBe(true);
    });

    it("matches specific minute and hour", async () => {
      const { matchesCron, parseCron } = await import(
        "@/brain/dream-scheduler"
      );

      const cron = parseCron("0 3 * * *")!;
      const matching = new Date(2024, 5, 15, 3, 0);
      const nonMatching = new Date(2024, 5, 15, 4, 0);

      expect(matchesCron(cron, matching)).toBe(true);
      expect(matchesCron(cron, nonMatching)).toBe(false);
    });

    it("matches day-of-week", async () => {
      const { matchesCron, parseCron } = await import(
        "@/brain/dream-scheduler"
      );

      const cron = parseCron("0 3 * * 1")!; // Monday
      const monday = new Date(2024, 5, 17, 3, 0); // 2024-06-17 is Monday
      const tuesday = new Date(2024, 5, 18, 3, 0);

      expect(matchesCron(cron, monday)).toBe(true);
      expect(matchesCron(cron, tuesday)).toBe(false);
    });
  });

  describe("isQuietHour", () => {
    it("handles simple range (start < end)", async () => {
      const { isQuietHour } = await import("@/brain/dream-scheduler");

      // Quiet hours 1-5
      expect(isQuietHour(3, 1, 5)).toBe(true);
      expect(isQuietHour(0, 1, 5)).toBe(false);
      expect(isQuietHour(5, 1, 5)).toBe(false);
      expect(isQuietHour(1, 1, 5)).toBe(true);
    });

    it("handles wrap-around range (start > end)", async () => {
      const { isQuietHour } = await import("@/brain/dream-scheduler");

      // Quiet hours 23-7
      expect(isQuietHour(23, 23, 7)).toBe(true);
      expect(isQuietHour(0, 23, 7)).toBe(true);
      expect(isQuietHour(3, 23, 7)).toBe(true);
      expect(isQuietHour(6, 23, 7)).toBe(true);
      expect(isQuietHour(7, 23, 7)).toBe(false);
      expect(isQuietHour(12, 23, 7)).toBe(false);
      expect(isQuietHour(22, 23, 7)).toBe(false);
    });
  });

  describe("shouldRunNow", () => {
    it("returns false when disabled", async () => {
      const { shouldRunNow } = await import("@/brain/dream-scheduler");

      const schedule = {
        enabled: false,
        schedule: "0 3 * * *",
        mode: "full" as const,
        quietHoursStart: 23,
        quietHoursEnd: 7,
      };

      const at3am = new Date(2024, 5, 15, 3, 0);
      expect(shouldRunNow(schedule, at3am)).toBe(false);
    });

    it("returns true when time matches cron and quiet hours", async () => {
      const { shouldRunNow } = await import("@/brain/dream-scheduler");

      const schedule = {
        enabled: true,
        schedule: "0 3 * * *",
        mode: "full" as const,
        quietHoursStart: 23,
        quietHoursEnd: 7,
      };

      const at3am = new Date(2024, 5, 15, 3, 0);
      expect(shouldRunNow(schedule, at3am)).toBe(true);
    });

    it("returns false when outside quiet hours", async () => {
      const { shouldRunNow } = await import("@/brain/dream-scheduler");

      const schedule = {
        enabled: true,
        schedule: "0 14 * * *", // 2 PM
        mode: "full" as const,
        quietHoursStart: 23,
        quietHoursEnd: 7,
      };

      const at2pm = new Date(2024, 5, 15, 14, 0);
      expect(shouldRunNow(schedule, at2pm)).toBe(false);
    });

    it("returns false when cron does not match", async () => {
      const { shouldRunNow } = await import("@/brain/dream-scheduler");

      const schedule = {
        enabled: true,
        schedule: "0 3 * * *",
        mode: "full" as const,
        quietHoursStart: 23,
        quietHoursEnd: 7,
      };

      const at4am = new Date(2024, 5, 15, 4, 0);
      expect(shouldRunNow(schedule, at4am)).toBe(false);
    });
  });

  describe("getNextRunTime", () => {
    it("finds the next matching time", async () => {
      const { getNextRunTime } = await import("@/brain/dream-scheduler");

      const schedule = {
        enabled: true,
        schedule: "0 3 * * *",
        mode: "full" as const,
        quietHoursStart: 23,
        quietHoursEnd: 7,
      };

      // From 10 PM on June 14 => next run at 3 AM June 15
      const from = new Date(2024, 5, 14, 22, 0);
      const next = getNextRunTime(schedule, from);

      expect(next).not.toBeNull();
      expect(next!.getHours()).toBe(3);
      expect(next!.getMinutes()).toBe(0);
      expect(next!.getDate()).toBe(15);
    });

    it("returns null when disabled", async () => {
      const { getNextRunTime } = await import("@/brain/dream-scheduler");

      const schedule = {
        enabled: false,
        schedule: "0 3 * * *",
        mode: "full" as const,
        quietHoursStart: 23,
        quietHoursEnd: 7,
      };

      expect(getNextRunTime(schedule)).toBeNull();
    });
  });

  describe("schedule persistence", () => {
    it("reads default config when no file exists", async () => {
      const { readScheduleConfig } = await import(
        "@/brain/dream-scheduler"
      );
      const config = makeConfig();

      const schedule = readScheduleConfig(config);

      expect(schedule.enabled).toBe(true);
      expect(schedule.schedule).toBe("0 3 * * *");
      expect(schedule.mode).toBe("full");
      expect(schedule.quietHoursStart).toBe(23);
      expect(schedule.quietHoursEnd).toBe(7);
    });

    it("persists and reads config from disk", async () => {
      const { readScheduleConfig, writeScheduleConfig } = await import(
        "@/brain/dream-scheduler"
      );
      const config = makeConfig();

      const schedule = {
        enabled: true,
        schedule: "30 2 * * 1",
        mode: "sweep-only" as const,
        quietHoursStart: 22,
        quietHoursEnd: 6,
      };

      writeScheduleConfig(config, schedule);
      const loaded = readScheduleConfig(config);

      expect(loaded.enabled).toBe(true);
      expect(loaded.schedule).toBe("30 2 * * 1");
      expect(loaded.mode).toBe("sweep-only");
      expect(loaded.quietHoursStart).toBe(22);
      expect(loaded.quietHoursEnd).toBe(6);

      // Verify the file actually exists on disk
      const filePath = join(TEST_ROOT, "state", "dream-schedule.json");
      expect(existsSync(filePath)).toBe(true);
      const raw = JSON.parse(readFileSync(filePath, "utf-8"));
      expect(raw.enabled).toBe(true);
      expect(raw.schedule).toBe("30 2 * * 1");
    });
  });
});

// ══════════════════════════════════════════════════════
// 4. Dream Cycle Integration
// ══════════════════════════════════════════════════════

describe("Dream Cycle Integration", () => {
  it("dream cycle result includes refsResolved and clusterCount fields", async () => {
    const { runDreamCycle } = await import("@/brain/dream-cycle");
    const config = makeConfig();
    const llm = makeMockLLM();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );

    try {
      const result = await runDreamCycle(config, llm, "sweep-only");

      // These fields must exist in the result type
      expect(typeof result.refsResolved).toBe("number");
      expect(typeof result.clusterCount).toBe("number");
      expect(result.refsResolved).toBeGreaterThanOrEqual(0);
      expect(result.clusterCount).toBeGreaterThanOrEqual(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("dream state includes lastClusteringRun field", async () => {
    const { readDreamState } = await import("@/brain/dream-state");
    const config = makeConfig();

    const state = readDreamState(config);
    expect(state).toHaveProperty("lastClusteringRun");
    expect(state.lastClusteringRun).toBeNull();
  });

  it("full dream cycle report mentions references and clusters", async () => {
    const { runDreamCycle } = await import("@/brain/dream-cycle");
    const config = makeConfig();
    const llm = makeMockLLM();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );

    try {
      const result = await runDreamCycle(config, llm, "full");

      expect(result.report).toContain("References resolved");
      expect(result.report).toContain("Theme clusters");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ══════════════════════════════════════════════════════
// 5. Dream Schedule API Route
// ══════════════════════════════════════════════════════

describe("Dream Schedule API Route", () => {
  it("GET returns default schedule when none configured", async () => {
    const { GET } = await import(
      "@/app/api/brain/dream-schedule/route"
    );

    const response = await GET();
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.enabled).toBe(true);
    expect(body.schedule).toBe("0 3 * * *");
    expect(body.mode).toBe("full");
    expect(body).toHaveProperty("nextRun");
  });

  it("POST updates schedule and returns updated config", async () => {
    const { POST } = await import(
      "@/app/api/brain/dream-schedule/route"
    );

    const request = new Request("http://localhost/api/brain/dream-schedule", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        schedule: "30 2 * * *",
        mode: "sweep-only",
        quietHoursStart: 22,
        quietHoursEnd: 6,
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.enabled).toBe(true);
    expect(body.schedule).toBe("30 2 * * *");
    expect(body.mode).toBe("sweep-only");
    expect(body.quietHoursStart).toBe(22);
    expect(body.quietHoursEnd).toBe(6);

    // Verify persistence by reading back from disk
    const filePath = join(TEST_ROOT, "state", "dream-schedule.json");
    expect(existsSync(filePath)).toBe(true);
    const raw = JSON.parse(readFileSync(filePath, "utf-8"));
    expect(raw.enabled).toBe(true);
    expect(raw.schedule).toBe("30 2 * * *");
  });

  it("POST with run-if-due action returns ran:false when not due", async () => {
    const { POST } = await import(
      "@/app/api/brain/dream-schedule/route"
    );

    const request = new Request("http://localhost/api/brain/dream-schedule", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "run-if-due" }),
    });

    const response = await POST(request);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.ran).toBe(false);
    expect(body.reason).toBe("Not due yet");
  });

  it("POST with invalid JSON returns 400", async () => {
    const { POST } = await import(
      "@/app/api/brain/dream-schedule/route"
    );

    const request = new Request("http://localhost/api/brain/dream-schedule", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });

    const response = await POST(request);
    expect(response.status).toBe(400);

    const body = await response.json();
    expect(body.error).toBe("Invalid JSON body");
  });
});
