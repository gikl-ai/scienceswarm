/**
 * E2E Tests — Briefing + Dream Cycle Use Cases (Core Use Cases 3 & 4)
 *
 * Tests the morning briefing, program briefing, contradiction detection,
 * Telegram formatting, and the overnight dream cycle that enriches the brain.
 *
 * Mocking strategy:
 *   - LLM client: mocked to return realistic structured responses
 *   - Semantic Scholar / arXiv collectors: mocked via vi.mock
 *   - File system, search, brain state: real (temp directories)
 */

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  appendFileSync,
  existsSync,
  readFileSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { initBrain } from "@/brain/init";
import {
  buildMorningBrief,
  buildProgramBrief,
  formatTelegramBrief,
} from "@/brain/research-briefing";
import { scanForContradictions } from "@/brain/contradiction-detector";
import { runDreamCycle } from "@/brain/dream-cycle";
import {
  readDreamState,
  writeDreamState,
  enqueueTargets,
  type DreamState,
  type EnrichmentTarget,
} from "@/brain/dream-state";
import { logEvent } from "@/brain/cost";
import { writeProjectManifest } from "@/lib/state/project-manifests";
import type { BrainConfig, MorningBrief } from "@/brain/types";
import type { LLMClient, LLMResponse } from "@/brain/llm";

// ── Mock external collectors to prevent real API calls ──

vi.mock("../../scripts/research-enrichment/semantic-scholar", () => ({
  resolvePaper: vi.fn().mockResolvedValue({
    ok: true,
    paper: {
      title: "Improved Guide RNA Design for CRISPR-Cas9",
      authors: [
        { name: "Jane Smith", authorId: "s1" },
        { name: "Bob Johnson", authorId: "s2" },
      ],
      year: 2025,
      venue: "Nature Methods",
      doi: "10.1234/test-doi",
      arxivId: "2501.00001",
      abstract: "We present an improved guide RNA design...",
      citationCount: 42,
      referenceCount: 30,
      citations: [
        {
          title: "CRISPR Applications in Oncology",
          year: 2025,
          authors: [{ name: "Alice Brown" }],
        },
      ],
      references: [
        {
          title: "Original CRISPR-Cas9 System",
          year: 2012,
          authors: [{ name: "Jennifer Doudna" }],
        },
      ],
    },
  }),
}));

vi.mock("../../scripts/research-enrichment/arxiv-collector", () => ({
  fetchById: vi.fn().mockResolvedValue({
    ok: true,
    papers: [
      {
        id: "2501.00001",
        title: "Improved Guide RNA Design for CRISPR-Cas9",
        abstract: "We present an improved guide RNA design...",
        authors: ["Jane Smith", "Bob Johnson"],
        categories: ["q-bio.GN", "cs.AI"],
        published: "2025-01-15",
      },
    ],
  }),
}));

// ── Constants ────────────────────────────────────────────

const TEST_ROOT = join(tmpdir(), "scienceswarm-e2e-briefings-dream");
const BRAIN_ROOT = join(TEST_ROOT, "brain");
const ORIGINAL_SCIENCESWARM_DIR = process.env.SCIENCESWARM_DIR;

// ── Helpers ──────────────────────────────────────────────

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

/** Mock LLM that returns realistic structured JSON responses based on prompt context */
function mockLLM(): LLMClient {
  return {
    async complete(call): Promise<LLMResponse> {
      const cost = {
        inputTokens: 100,
        outputTokens: 50,
        estimatedUsd: 0.01,
        model: "test",
      };

      // Contradiction scan response
      if (call.system.includes("contradiction detector")) {
        return {
          content: JSON.stringify({
            contradictions: [
              {
                id: "test-contradiction-1",
                severity: "notable",
                claim1: {
                  text: "Signal drift is caused by sequence design",
                  source: "wiki/hypotheses/signal-drift.md",
                  date: "2026-04-01",
                },
                claim2: {
                  text: "Fresh batch fixed signal drift — points to storage temperature",
                  source: "wiki/observations/obs-storage.md",
                  date: "2026-04-08",
                },
                implication:
                  "The signal drift hypothesis may be wrong. Storage temperature is the likelier cause.",
                suggestedResolution:
                  "Run a controlled experiment varying storage temperature while keeping sequence design constant.",
              },
            ],
            tensions: [
              {
                description:
                  "Two competing primer designs both show promise but use incompatible protocols",
                sources: [
                  "wiki/tasks/primer-a.md",
                  "wiki/tasks/primer-b.md",
                ],
                resolution: "Run a head-to-head comparison experiment.",
              },
            ],
          }),
          cost,
        };
      }

      // Morning brief synthesis response
      if (call.system.includes("morning briefing")) {
        return {
          content: JSON.stringify({
            topMatters: [
              {
                summary:
                  "New observation contradicts signal drift hypothesis",
                whyItMatters:
                  "Your current experiment design assumes sequence design causes signal drift. New data points to storage temperature instead.",
                evidence: ["wiki/observations/obs-storage.md"],
                urgency: "act-now",
              },
              {
                summary: "Frontier paper on improved guide RNA design",
                whyItMatters:
                  "Could bypass the signal drift issue entirely with a more robust RNA design.",
                evidence: ["wiki/entities/frontier/guide-rna.md"],
                urgency: "this-week",
              },
              {
                summary: "Alpha project tasks need review",
                whyItMatters:
                  "Two open tasks haven't been touched in over a week.",
                evidence: ["wiki/tasks/alpha-primers.md"],
                urgency: "awareness",
              },
            ],
            nextMove: {
              recommendation:
                "Run a storage temperature controlled experiment before continuing the sequence redesign.",
              reasoning:
                "The observation about storage temperature directly challenges your current approach. Confirming or ruling out temperature as the cause will save weeks of wasted work.",
              assumptions: [
                "Fresh reagent batches are available.",
                "Temperature-controlled storage is accessible.",
              ],
              missingEvidence: [
                "Independent replication of the storage temperature finding.",
                "Quantitative data on temperature sensitivity range.",
              ],
              experiment: {
                hypothesis:
                  "Storage temperature above 4C causes signal drift, not sequence design.",
                method:
                  "Split samples into 4C and room-temperature groups, run identical assays.",
                expectedOutcome:
                  "4C samples show no drift; room-temp samples reproduce the drift.",
              },
            },
          }),
          cost,
        };
      }

      // Program brief synthesis response
      if (call.system.includes("program manager")) {
        return {
          content: JSON.stringify({
            programStatus: "at-risk",
            whatChanged: [
              {
                project: "alpha",
                change: "Signal drift contradiction found",
                impact: "high",
              },
              {
                project: "beta",
                change: "New sequencing data arrived",
                impact: "medium",
              },
            ],
            scientificRisks: [
              {
                risk: "Signal drift root cause uncertain",
                project: "alpha",
                severity: "high",
                competingExplanations: [
                  {
                    explanation: "Sequence design flaw",
                    evidence: ["wiki/hypotheses/signal-drift.md"],
                    confidence: "medium",
                  },
                  {
                    explanation: "Storage temperature degradation",
                    evidence: ["wiki/observations/obs-storage.md"],
                    confidence: "high",
                  },
                ],
              },
            ],
            bestNextExperiment: {
              hypothesis:
                "Storage temperature causes signal drift, not sequence design",
              method: "Temperature-controlled split-sample assay",
              expectedOutcome: "4C group shows no drift",
              whyThisOne:
                "Discriminates between the two competing root-cause explanations",
              assumptions: ["Reagents available", "Lab access"],
              discriminates:
                "Whether root cause is storage temperature vs sequence design",
            },
            standupSummary:
              "Alpha project at risk: signal drift root cause uncertain. Beta received new sequencing data. Recommended: temperature-controlled experiment to discriminate competing hypotheses.",
          }),
          cost,
        };
      }

      // Entity extraction for dream cycle
      if (call.system.includes("entity extraction")) {
        return {
          content: JSON.stringify([
            {
              type: "concept",
              identifier: "signal drift",
              priority: "high",
            },
            {
              type: "method",
              identifier: "temperature-controlled assay",
              priority: "medium",
            },
          ]),
          cost,
        };
      }

      // Concept extraction for enrichment
      if (call.system.includes("key scientific concepts")) {
        return {
          content: JSON.stringify([
            {
              name: "Guide RNA Design",
              definition:
                "The process of engineering RNA sequences that direct CRISPR-Cas9 to specific genomic targets.",
            },
            {
              name: "CRISPR Efficiency",
              definition:
                "The rate at which CRISPR-Cas9 successfully edits target DNA sequences.",
            },
          ]),
          cost,
        };
      }

      // Consolidation response for dream cycle
      if (call.system.includes("consolidation agent")) {
        return {
          content: JSON.stringify({
            themes: ["signal-drift-investigation"],
            concept_updates: [],
            summary: "Recurring theme: signal drift root cause investigation",
          }),
          cost,
        };
      }

      // Author page compilation
      if (call.system.includes("person/author page")) {
        return {
          content:
            "## Affiliation\nUnknown\n\n## Key Papers\n- Improved Guide RNA Design\n\n## Research Areas\n- CRISPR\n\n## Timeline\n- 2025: Published guide RNA paper",
          cost,
        };
      }

      // Default fallback
      return {
        content: JSON.stringify({
          topMatters: [],
          nextMove: {
            recommendation: "Review your priorities and get started.",
          },
        }),
        cost,
      };
    },
  };
}

/** Empty LLM that returns no contradictions and minimal data */
function emptyLLM(): LLMClient {
  return {
    async complete(): Promise<LLMResponse> {
      return {
        content: JSON.stringify({
          contradictions: [],
          tensions: [],
          topMatters: [],
          nextMove: {
            recommendation: "Start by adding papers and observations to your brain.",
            reasoning: "Your brain is empty. Begin with a cold start.",
            assumptions: [],
            missingEvidence: [],
          },
          themes: [],
          concept_updates: [],
          summary: "No activity detected.",
        }),
        cost: {
          inputTokens: 10,
          outputTokens: 10,
          estimatedUsd: 0.001,
          model: "test",
        },
      };
    },
  };
}

/**
 * Seed a realistic brain with two projects, papers, tasks, hypotheses,
 * observations, and frontier items.
 */
function seedRealisticBrain() {
  // -- Project pages --
  mkdirSync(join(BRAIN_ROOT, "wiki/projects"), { recursive: true });
  writeFileSync(
    join(BRAIN_ROOT, "wiki/projects/alpha.md"),
    [
      "---",
      "type: project",
      "title: Alpha Sequencing Project",
      "status: active",
      "project: alpha",
      "---",
      "# Alpha Sequencing Project",
      "",
      "## Summary",
      "CRISPR sequencing project investigating signal drift.",
    ].join("\n"),
  );
  writeFileSync(
    join(BRAIN_ROOT, "wiki/projects/beta.md"),
    [
      "---",
      "type: project",
      "title: Beta Genomics Project",
      "status: active",
      "project: beta",
      "---",
      "# Beta Genomics Project",
      "",
      "## Summary",
      "Genomics sequencing pipeline for cancer markers.",
    ].join("\n"),
  );

  // -- Paper pages --
  mkdirSync(join(BRAIN_ROOT, "wiki/entities/papers"), { recursive: true });
  writeFileSync(
    join(BRAIN_ROOT, "wiki/entities/papers/smith-2025-guide-rna.md"),
    [
      "---",
      "date: 2025-01-15",
      "type: paper",
      "para: resources",
      'title: "Improved Guide RNA Design for CRISPR-Cas9"',
      'authors: ["Jane Smith", "Bob Johnson"]',
      "year: 2025",
      'venue: "Nature Methods"',
      'doi: "10.1234/test-doi"',
      "tags: [paper]",
      "---",
      "",
      "# Improved Guide RNA Design for CRISPR-Cas9",
      "",
      "## Summary",
      "New approach to guide RNA with improved efficiency.",
    ].join("\n"),
  );
  writeFileSync(
    join(BRAIN_ROOT, "wiki/entities/papers/jones-2024-crispr-review.md"),
    [
      "---",
      "date: 2024-06-01",
      "type: paper",
      "para: resources",
      'title: "CRISPR-Cas9: A Comprehensive Review"',
      'authors: ["David Jones"]',
      "year: 2024",
      'venue: "Annual Reviews"',
      "tags: [paper]",
      "---",
      "",
      "# CRISPR-Cas9: A Comprehensive Review",
      "",
      "## Summary",
      "Comprehensive review of CRISPR-Cas9 applications.",
    ].join("\n"),
  );
  writeFileSync(
    join(BRAIN_ROOT, "wiki/entities/papers/chen-2026-signal.md"),
    [
      "---",
      "date: 2026-04-05",
      "type: paper",
      "para: resources",
      'title: "Signal Processing in Genomic Sequencing"',
      'authors: ["Wei Chen"]',
      "year: 2026",
      'venue: "Bioinformatics"',
      "tags: [paper]",
      "---",
      "",
      "# Signal Processing in Genomic Sequencing",
      "",
      "## Summary",
      "Recent paper on signal processing techniques relevant to sequencing.",
    ].join("\n"),
  );

  // -- Task pages --
  mkdirSync(join(BRAIN_ROOT, "wiki/tasks"), { recursive: true });
  writeFileSync(
    join(BRAIN_ROOT, "wiki/tasks/alpha-primers.md"),
    [
      "---",
      "type: task",
      "title: Order primers for alpha sequencing",
      "status: open",
      "project: alpha",
      "---",
      "# Order primers for alpha sequencing",
      "Need to order new primer set for the sequencing pass.",
    ].join("\n"),
  );
  writeFileSync(
    join(BRAIN_ROOT, "wiki/tasks/beta-pipeline.md"),
    [
      "---",
      "type: task",
      "title: Set up beta sequencing pipeline",
      "status: done",
      "project: beta",
      "---",
      "# Set up beta sequencing pipeline",
      "Pipeline configuration completed.",
    ].join("\n"),
  );

  // -- Hypothesis page --
  mkdirSync(join(BRAIN_ROOT, "wiki/hypotheses"), { recursive: true });
  writeFileSync(
    join(BRAIN_ROOT, "wiki/hypotheses/signal-drift.md"),
    [
      "---",
      "type: hypothesis",
      "title: Signal drift is caused by sequence design",
      "status: active",
      "project: alpha",
      "---",
      "# Signal drift is caused by sequence design",
      "",
      "## Hypothesis",
      "The observed signal drift in our CRISPR assays is caused by suboptimal sequence design in the guide RNA.",
      "",
      "## Evidence",
      "- Initial observations showed drift correlated with certain sequence motifs.",
      "- Literature supports sequence-dependent off-target effects.",
    ].join("\n"),
  );

  // -- Observation pages --
  mkdirSync(join(BRAIN_ROOT, "wiki/observations"), {
    recursive: true,
  });
  writeFileSync(
    join(BRAIN_ROOT, "wiki/observations/obs-storage.md"),
    [
      "---",
      "type: observation",
      "title: Fresh batch fixed signal drift — points to storage temperature",
      "project: alpha",
      "---",
      "# Fresh batch fixed signal drift — points to storage temperature",
      "",
      "## Observation",
      "When we used a fresh reagent batch stored at 4C instead of the older batch at room temperature, the signal drift disappeared completely.",
      "This contradicts our hypothesis that sequence design is the cause.",
    ].join("\n"),
  );

  // -- Frontier item --
  mkdirSync(join(BRAIN_ROOT, "wiki/entities/frontier"), { recursive: true });
  writeFileSync(
    join(BRAIN_ROOT, "wiki/entities/frontier/guide-rna.md"),
    [
      "---",
      "type: frontier_item",
      "title: Improved guide RNA design paper",
      "status: staged",
      "project: alpha",
      "---",
      "# Improved guide RNA design paper",
      "New approach to guide RNA with support for higher efficiency.",
    ].join("\n"),
  );

  // -- Experiment page --
  mkdirSync(join(BRAIN_ROOT, "wiki/experiments"), { recursive: true });
  writeFileSync(
    join(BRAIN_ROOT, "wiki/experiments/alpha-assay.md"),
    [
      "---",
      "type: experiment",
      "title: Alpha efficiency assay",
      "status: running",
      "project: alpha",
      "---",
      "# Alpha efficiency assay",
      "Running experiment to measure CRISPR efficiency with current guide RNA design.",
    ].join("\n"),
  );

  // -- Seed events.jsonl --
  const eventsPath = join(BRAIN_ROOT, "wiki/events.jsonl");
  const now = new Date();
  const events = [
    {
      ts: now.toISOString(),
      type: "ingest",
      contentType: "observation",
      created: ["wiki/observations/obs-storage.md"],
    },
    {
      ts: new Date(now.getTime() + 1).toISOString(),
      type: "observe",
      contentType: "observation",
      created: ["wiki/observations/obs-storage.md"],
    },
    {
      ts: new Date(now.getTime() + 2).toISOString(),
      type: "ripple",
      updated: ["wiki/hypotheses/signal-drift.md"],
    },
  ];
  for (const event of events) {
    appendFileSync(eventsPath, JSON.stringify(event) + "\n");
  }
}

/**
 * Seed a multi-project brain for program brief testing.
 * Two team projects, each with tasks, decisions, and observations.
 */
function seedMultiProjectBrain() {
  seedRealisticBrain(); // includes alpha + beta projects

  // Add beta-specific content
  writeFileSync(
    join(BRAIN_ROOT, "wiki/tasks/beta-analysis.md"),
    [
      "---",
      "type: task",
      "title: Analyze beta sequencing results",
      "status: open",
      "project: beta",
      "---",
      "# Analyze beta sequencing results",
      "Review the sequencing data from the latest beta run.",
    ].join("\n"),
  );

  mkdirSync(join(BRAIN_ROOT, "wiki/decisions"), { recursive: true });
  writeFileSync(
    join(BRAIN_ROOT, "wiki/decisions/beta-protocol.md"),
    [
      "---",
      "type: decision",
      "title: Use protocol v2 for beta sequencing",
      "project: beta",
      "---",
      "# Use protocol v2 for beta sequencing",
      "Decided to use protocol v2 based on improved accuracy benchmarks.",
    ].join("\n"),
  );

  writeFileSync(
    join(BRAIN_ROOT, "wiki/observations/obs-beta-data.md"),
    [
      "---",
      "type: observation",
      "title: New sequencing data arrived for beta",
      "project: beta",
      "---",
      "# New sequencing data arrived for beta",
      "Received the sequencing results from batch 3. Initial quality looks good.",
    ].join("\n"),
  );

  // Add beta events
  const eventsPath = join(BRAIN_ROOT, "wiki/events.jsonl");
  const now = new Date();
  appendFileSync(
    eventsPath,
    JSON.stringify({
      ts: new Date(now.getTime() + 10).toISOString(),
      type: "ingest",
      contentType: "observation",
      created: ["wiki/observations/obs-beta-data.md"],
    }) + "\n",
  );
}

// ── Setup / Teardown ─────────────────────────────────────

beforeEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
  process.env.SCIENCESWARM_DIR = TEST_ROOT;
  initBrain({ root: BRAIN_ROOT, name: "Test Researcher" });
});

afterEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
  vi.restoreAllMocks();
  if (ORIGINAL_SCIENCESWARM_DIR) {
    process.env.SCIENCESWARM_DIR = ORIGINAL_SCIENCESWARM_DIR;
  } else {
    delete process.env.SCIENCESWARM_DIR;
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// MORNING BRIEF TESTS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("Morning Brief Journey", () => {
  describe("Test 1: Morning brief with realistic brain content", () => {
    it("generates a complete morning brief with all expected sections", async () => {
      seedRealisticBrain();
      const config = makeConfig();
      const llm = mockLLM();

      const brief = await buildMorningBrief(config, llm, {
        project: "alpha",
      });

      // Top matters
      expect(brief.topMatters.length).toBeGreaterThanOrEqual(1);
      expect(brief.topMatters.length).toBeLessThanOrEqual(3);
      expect(brief.topMatters[0]).toEqual(
        expect.objectContaining({
          summary: "New observation contradicts signal drift hypothesis",
          urgency: "act-now",
          evidence: ["wiki/observations/obs-storage.md"],
        }),
      );
      for (const matter of brief.topMatters) {
        expect(matter.summary).toBeTruthy();
        expect(matter.whyItMatters).toBeTruthy();
        expect(
          ["act-now", "this-week", "awareness"] as string[],
        ).toContain(matter.urgency);
      }

      // Contradictions detected between observation and hypothesis
      expect(brief.contradictions.length).toBeGreaterThan(0);
      const contradiction = brief.contradictions[0];
      expect(contradiction.claim1).toEqual(
        expect.objectContaining({
          summary: "Signal drift is caused by sequence design",
          source: "wiki/hypotheses/signal-drift.md",
        }),
      );
      expect(contradiction.claim2).toEqual(
        expect.objectContaining({
          summary:
            "Fresh batch fixed signal drift — points to storage temperature",
          source: "wiki/observations/obs-storage.md",
        }),
      );
      expect(contradiction.implication).toContain("Storage temperature");

      // Frontier items scored
      expect(Array.isArray(brief.frontier)).toBe(true);
      for (const item of brief.frontier) {
        expect(item.relevanceScore).toBeGreaterThanOrEqual(0);
        expect(item.relevanceScore).toBeLessThanOrEqual(1);
        expect(
          ["supports", "challenges", "adjacent", "noise"] as string[],
        ).toContain(item.threatOrOpportunity);
      }

      // Stale threads includes items with no recent activity
      expect(Array.isArray(brief.staleThreads)).toBe(true);
      for (const thread of brief.staleThreads) {
        expect(thread.name).toBeTruthy();
        expect(thread.daysSinceActivity).toBeGreaterThanOrEqual(0);
        expect(thread.suggestedAction).toBeTruthy();
      }

      // Open questions includes the active hypothesis
      expect(Array.isArray(brief.openQuestions)).toBe(true);
      for (const question of brief.openQuestions) {
        expect(question.question).toBeTruthy();
        expect(question.project).toBeTruthy();
      }

      // Next move has recommendation with assumptions and missing evidence
      expect(brief.nextMove.recommendation).toContain(
        "storage temperature controlled experiment",
      );
      expect(brief.nextMove.reasoning).toContain("save weeks of wasted work");
      expect(brief.nextMove.assumptions.length).toBeGreaterThan(0);
      expect(brief.nextMove.missingEvidence.length).toBeGreaterThan(0);

      // Stats are correct
      expect(brief.stats.brainPages).toBeGreaterThan(0);
      expect(typeof brief.stats.newPagesYesterday).toBe("number");
      expect(typeof brief.stats.capturesYesterday).toBe("number");
      expect(typeof brief.stats.enrichmentsYesterday).toBe("number");

      // Greeting mentions the project
      expect(brief.greeting).toContain("alpha");
      expect(brief.generatedAt).toBeTruthy();
    });
  });

  describe("Test 2: Telegram format output", () => {
    it("formats the morning brief for Telegram delivery", async () => {
      seedRealisticBrain();
      const config = makeConfig();
      const llm = mockLLM();

      const brief = await buildMorningBrief(config, llm, {
        project: "alpha",
      });
      const output = formatTelegramBrief(brief);

      // Concise output
      expect(output.length).toBeLessThan(1000);

      // Contains the required structure
      expect(output).toContain("Morning Brief");
      expect(output).toContain("Top 3:");
      expect(output).toContain("Contradictions:");
      expect(output).toContain("Next move:");

      // Top matters are present
      for (const matter of brief.topMatters.slice(0, 3)) {
        expect(output).toContain(matter.summary);
      }

      // Contradiction count is present
      expect(output).toContain(
        `Contradictions: ${brief.contradictions.length}`,
      );
    });

    it("handles a hand-constructed brief with known values", () => {
      const brief: MorningBrief = {
        generatedAt: "2026-04-09T08:00:00.000Z",
        greeting: "Good morning.",
        topMatters: [
          {
            summary: "Storage temperature may cause signal drift",
            whyItMatters: "Contradicts your sequence design hypothesis",
            evidence: ["wiki/obs.md"],
            urgency: "act-now",
          },
        ],
        contradictions: [
          {
            claim1: {
              summary: "Sequence design causes drift",
              source: "wiki/hyp.md",
              date: "2026-04-01",
            },
            claim2: {
              summary: "Fresh batch fixed drift",
              source: "wiki/obs.md",
              date: "2026-04-08",
            },
            implication: "Root cause may be temperature, not sequence",
          },
        ],
        frontier: [
          {
            title: "Guide RNA paper",
            source: "wiki/frontier/guide-rna.md",
            relevanceScore: 0.85,
            whyItMatters: "Could improve efficiency",
            threatOrOpportunity: "supports",
          },
        ],
        staleThreads: [],
        openQuestions: [],
        nextMove: {
          recommendation: "Run temperature-controlled experiment",
          reasoning: "Will discriminate between competing hypotheses",
          assumptions: ["Lab access available"],
          missingEvidence: ["Temperature sensitivity data"],
        },
        stats: {
          brainPages: 15,
          newPagesYesterday: 2,
          capturesYesterday: 1,
          enrichmentsYesterday: 0,
        },
      };

      const output = formatTelegramBrief(brief);

      expect(output).toContain("Morning Brief");
      expect(output).toContain("Top 3:");
      expect(output).toContain("Storage temperature may cause signal drift");
      expect(output).toContain("Contradictions: 1");
      expect(output).toContain("Frontier: 1 new");
      expect(output).toContain("Next move:");
      expect(output).toContain("Run temperature-controlled experiment");
    });
  });

  describe("Test 3: Morning brief with empty brain", () => {
    it("does not crash and returns sensible defaults", async () => {
      // Brain is initialized but no content seeded
      const config = makeConfig();
      const llm = emptyLLM();

      const brief = await buildMorningBrief(config, llm);

      expect(brief).toBeTruthy();
      expect(brief.generatedAt).toBeTruthy();
      expect(brief.greeting).toContain("research briefing");
      expect(Array.isArray(brief.topMatters)).toBe(true);
      expect(Array.isArray(brief.contradictions)).toBe(true);
      expect(Array.isArray(brief.frontier)).toBe(true);
      expect(Array.isArray(brief.staleThreads)).toBe(true);
      expect(Array.isArray(brief.openQuestions)).toBe(true);
      expect(brief.nextMove.recommendation).toBe(
        "Start by adding papers and observations to your brain.",
      );
      expect(brief.stats.brainPages).toBeGreaterThanOrEqual(0);
      expect(Number.isNaN(brief.stats.brainPages)).toBe(false);
      expect(Number.isNaN(brief.stats.newPagesYesterday)).toBe(false);
      expect(Number.isNaN(brief.stats.capturesYesterday)).toBe(false);
      expect(Number.isNaN(brief.stats.enrichmentsYesterday)).toBe(false);
    });

    it("formats empty brief for Telegram without crashing", () => {
      const brief: MorningBrief = {
        generatedAt: "2026-04-09T08:00:00.000Z",
        greeting: "Good morning.",
        topMatters: [],
        contradictions: [],
        frontier: [],
        staleThreads: [],
        openQuestions: [],
        nextMove: {
          recommendation: "Start by adding papers.",
          reasoning: "",
          assumptions: [],
          missingEvidence: [],
        },
        stats: {
          brainPages: 0,
          newPagesYesterday: 0,
          capturesYesterday: 0,
          enrichmentsYesterday: 0,
        },
      };

      const output = formatTelegramBrief(brief);

      expect(output).toContain("Morning Brief");
      expect(output).toContain("No major changes");
      expect(output).toContain("Next move:");
    });
  });

  describe("Test 13: Briefing with only papers, no tasks/experiments", () => {
    it("still works when only paper pages exist", async () => {
      // Only seed paper pages, no tasks, experiments, hypotheses
      mkdirSync(join(BRAIN_ROOT, "wiki/entities/papers"), { recursive: true });
      writeFileSync(
        join(BRAIN_ROOT, "wiki/entities/papers/test-paper.md"),
        [
          "---",
          "type: paper",
          "title: A Test Paper",
          "authors: [Author One]",
          "year: 2025",
          'venue: "Test Journal"',
          "tags: [paper]",
          "---",
          "",
          "# A Test Paper",
          "Some content about the paper.",
        ].join("\n"),
      );

      const config = makeConfig();
      const llm = emptyLLM();

      const brief = await buildMorningBrief(config, llm);

      expect(brief).toBeTruthy();
      expect(brief.generatedAt).toBeTruthy();
      expect(Array.isArray(brief.topMatters)).toBe(true);
      expect(Array.isArray(brief.staleThreads)).toBe(true);
      expect(Array.isArray(brief.openQuestions)).toBe(true);
      expect(brief.nextMove.recommendation).toBe(
        "Start by adding papers and observations to your brain.",
      );
      expect(brief.stats.brainPages).toBeGreaterThan(0);
    });
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PROGRAM BRIEF TESTS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("Program Brief Journey", () => {
  describe("Test 5: Program brief for multi-project team", () => {
    it("generates a program brief covering both projects", async () => {
      seedMultiProjectBrain();
      const config = makeConfig();
      const llm = mockLLM();

      // Write project manifests
      await writeProjectManifest(
        {
          version: 1,
          projectId: "alpha",
          slug: "alpha",
          title: "Alpha Project",
          privacy: "cloud-ok",
          status: "active",
          projectPagePath: "wiki/projects/alpha.md",
          sourceRefs: [],
          decisionPaths: [],
          taskPaths: ["wiki/tasks/alpha-primers.md"],
          artifactPaths: [],
          frontierPaths: [],
          activeThreads: [],
          dedupeKeys: [],
          updatedAt: "2026-04-08T00:00:00.000Z",
        },
        join(BRAIN_ROOT, "state"),
      );
      await writeProjectManifest(
        {
          version: 1,
          projectId: "beta",
          slug: "beta",
          title: "Beta Genomics Project",
          privacy: "cloud-ok",
          status: "active",
          projectPagePath: "wiki/projects/beta.md",
          sourceRefs: [],
          decisionPaths: [],
          taskPaths: [
            "wiki/tasks/beta-pipeline.md",
            "wiki/tasks/beta-analysis.md",
          ],
          artifactPaths: [],
          frontierPaths: [],
          activeThreads: [],
          dedupeKeys: [],
          updatedAt: "2026-04-08T00:00:00.000Z",
        },
        join(BRAIN_ROOT, "state"),
      );

      const brief = await buildProgramBrief(config, llm, ["alpha", "beta"]);

      expect(brief.generatedAt).toBeTruthy();
      expect(brief.programStatus).toBe("at-risk");
      expect(brief.whatChanged.length).toBeGreaterThan(0);
      const projectsInChanges = brief.whatChanged.map((c) => c.project);
      expect(projectsInChanges).toEqual(
        expect.arrayContaining(["alpha", "beta"]),
      );
      // Scientific risks
      expect(brief.scientificRisks.length).toBeGreaterThan(0);
      expect(brief.scientificRisks[0]).toEqual(
        expect.objectContaining({
          risk: "Signal drift root cause uncertain",
          project: "alpha",
          severity: "high",
        }),
      );
      // Best next experiment
      expect(brief.bestNextExperiment).toEqual(
        expect.objectContaining({
          hypothesis:
            "Storage temperature causes signal drift, not sequence design",
          method: "Temperature-controlled split-sample assay",
          whyThisOne:
            "Discriminates between the two competing root-cause explanations",
        }),
      );
      // Standup summary is a readable string
      expect(brief.standupSummary).toContain("Alpha project at risk");
      expect(typeof brief.standupSummary).toBe("string");
      expect(brief.standupSummary.length).toBeGreaterThan(10);
    });

    it("handles a single-project program brief", async () => {
      seedRealisticBrain();
      const config = makeConfig();
      const llm = mockLLM();

      // Should not crash with just one project
      const brief = await buildProgramBrief(config, llm, ["alpha"]);

      expect(brief.generatedAt).toBeTruthy();
      expect(brief.standupSummary).toContain("Alpha project at risk");
      expect(brief.bestNextExperiment.method).toBe(
        "Temperature-controlled split-sample assay",
      );
    });
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CONTRADICTION DETECTION TESTS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("Contradiction Detection", () => {
  describe("Test 7: Contradiction detection with conflicting evidence", () => {
    it("detects contradictions between hypothesis and observation", async () => {
      seedRealisticBrain();
      const config = makeConfig();
      const llm = mockLLM();

      const report = await scanForContradictions(config, llm, {
        project: "alpha",
      });

      expect(report.scannedPages).toBeGreaterThan(0);
      expect(report.contradictions.length).toBeGreaterThan(0);

      const contradiction = report.contradictions[0];
      expect(contradiction.severity).toBe("notable");
      expect(contradiction.claim1.text).toBeTruthy();
      expect(contradiction.claim1.source).toBeTruthy();
      expect(contradiction.claim2.text).toBeTruthy();
      expect(contradiction.claim2.source).toBeTruthy();
      expect(contradiction.implication).toBeTruthy();
      expect(contradiction.suggestedResolution).toBeTruthy();

      // Also returns tensions
      expect(report.tensions.length).toBeGreaterThan(0);
      expect(report.tensions[0].description).toBeTruthy();
      expect(report.tensions[0].sources.length).toBeGreaterThan(0);
      expect(report.tensions[0].resolution).toBeTruthy();
    });
  });

  describe("Test 8: No contradictions in consistent brain", () => {
    it("returns empty contradictions for a consistent brain", async () => {
      // Only seed a hypothesis with supporting observations
      mkdirSync(join(BRAIN_ROOT, "wiki/hypotheses"), { recursive: true });
      writeFileSync(
        join(BRAIN_ROOT, "wiki/hypotheses/consistent.md"),
        [
          "---",
          "type: hypothesis",
          "title: Temperature affects reaction rate",
          "status: supported",
          "---",
          "# Temperature affects reaction rate",
          "Higher temperature increases reaction rate.",
        ].join("\n"),
      );
      mkdirSync(join(BRAIN_ROOT, "wiki/observations"), {
        recursive: true,
      });
      writeFileSync(
        join(BRAIN_ROOT, "wiki/observations/obs-consistent.md"),
        [
          "---",
          "type: observation",
          "title: Higher temperature increased rate by 20%",
          "---",
          "# Higher temperature increased rate by 20%",
          "Observation confirms the temperature hypothesis.",
        ].join("\n"),
      );

      const config = makeConfig();
      const noContradictionsLLM: LLMClient = {
        async complete(): Promise<LLMResponse> {
          return {
            content: JSON.stringify({ contradictions: [], tensions: [] }),
            cost: {
              inputTokens: 10,
              outputTokens: 10,
              estimatedUsd: 0.001,
              model: "test",
            },
          };
        },
      };

      const report = await scanForContradictions(config, noContradictionsLLM);
      expect(report.contradictions).toHaveLength(0);
      expect(report.tensions).toHaveLength(0);
    });
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// DREAM CYCLE TESTS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("Dream Cycle Journey", () => {
  describe("Test 9: Full dream cycle on realistic brain", () => {
    it("runs the dream cycle and produces a report", async () => {
      seedRealisticBrain();
      const config = makeConfig();
      const llm = mockLLM();

      // Add a thin paper page that needs enrichment
      writeFileSync(
        join(BRAIN_ROOT, "wiki/entities/papers/thin-paper.md"),
        [
          "---",
          "date: 2026-04-01",
          "type: paper",
          "para: resources",
          'title: "Thin Paper Needs Enrichment"',
          'authors: ["Unknown Author"]',
          "year: 2026",
          'venue: "Preprint"',
          'arxiv: "2501.00001"',
          "tags: [paper]",
          "---",
          "",
          "# Thin Paper Needs Enrichment",
          "",
          "## Summary",
          "A paper without abstract or citations.",
        ].join("\n"),
      );

      // Log an event referencing the thin paper
      logEvent(config, {
        ts: new Date(Date.now() + 100).toISOString(),
        type: "ingest",
        contentType: "paper",
        created: ["wiki/entities/papers/thin-paper.md"],
      });

      const result = await runDreamCycle(config, llm, "full");

      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(typeof result.report).toBe("string");
      expect(result.report).toContain("Dream Cycle Report");
      expect(result.entitiesSwept).toBeGreaterThan(0);
      expect(result.pagesEnriched).toBeGreaterThan(0);
      expect(result.pagesCreated).toBeGreaterThan(0);

      // Report should be saved to disk
      const dateStr = new Date().toISOString().slice(0, 10);
      const reportPath = join(
        BRAIN_ROOT,
        "state",
        "dream-reports",
        `${dateStr}.md`,
      );
      expect(existsSync(reportPath)).toBe(true);
      const reportContent = readFileSync(reportPath, "utf-8");
      expect(reportContent).toContain("Dream Cycle Report");

      // Dream state should be updated
      const state = readDreamState(config);
      expect(state.lastFullRun).not.toBeNull();
      expect(
        state.enrichmentQueue.some((target) => target.identifier === "2501.00001"),
      ).toBe(false);

      const thinPaperContent = readFileSync(
        join(BRAIN_ROOT, "wiki/entities/papers/thin-paper.md"),
        "utf-8",
      );
      expect(thinPaperContent).toContain("citation_count: 42");
      expect(thinPaperContent).toContain("10.1234/test-doi");
      expect(thinPaperContent).toContain("Updated from Semantic Scholar");

      expect(
        existsSync(join(BRAIN_ROOT, "wiki/entities/people/jane-smith.md")),
      ).toBe(true);
      expect(
        existsSync(join(BRAIN_ROOT, "wiki/entities/people/bob-johnson.md")),
      ).toBe(true);
      expect(
        existsSync(join(BRAIN_ROOT, "wiki/concepts/guide-rna-design.md")),
      ).toBe(true);
      expect(
        existsSync(join(BRAIN_ROOT, "wiki/concepts/crispr-efficiency.md")),
      ).toBe(true);

      // Cost should not be NaN
      expect(Number.isNaN(result.cost.estimatedUsd)).toBe(false);
      expect(Number.isNaN(result.cost.inputTokens)).toBe(false);
      expect(Number.isNaN(result.cost.outputTokens)).toBe(false);
    });
  });

  describe("Test 10: Dream cycle sweep-only mode", () => {
    it("only runs entity sweep, not enrichment", async () => {
      seedRealisticBrain();
      const config = makeConfig();
      const llm = mockLLM();

      const result = await runDreamCycle(config, llm, "sweep-only");

      expect(result.report).toContain("Dream Cycle Report");
      expect(result.entitiesSwept).toBeGreaterThan(0);
      expect(result.pagesEnriched).toBe(0);
      expect(result.pagesCreated).toBe(0);
      expect(result.citationsFixed).toBe(0);
      expect(result.consolidations).toBe(0);

      const state = readDreamState(config);
      expect(state.lastFullRun).not.toBeNull();
      expect(state.enrichmentQueue.length).toBeGreaterThan(0);
    });
  });

  describe("Test 11: Dream cycle state persistence", () => {
    it("persists and respects dream state across runs", async () => {
      seedRealisticBrain();
      const config = makeConfig();
      const llm = mockLLM();

      // First run
      await runDreamCycle(config, llm, "sweep-only");
      const state1 = readDreamState(config);
      expect(state1.lastFullRun).not.toBeNull();

      // Record how many events were processed
      const processedCount1 = state1.processedEventIds.length;
      expect(processedCount1).toBeGreaterThan(0);

      // Second run — should not re-process the same events from the first run
      const result2 = await runDreamCycle(config, llm, "sweep-only");
      const state2 = readDreamState(config);

      // State should still have a lastFullRun
      expect(state2.lastFullRun).not.toBeNull();

      // The second sweep may process the dream event logged by the first run,
      // but should not re-process the original brain events. So entitiesSwept
      // should be less than or equal to 1 (the dream log event itself).
      expect(result2.entitiesSwept).toBeLessThanOrEqual(1);

      // Processed event IDs should grow by at most 1 (the dream log event)
      expect(state2.processedEventIds.length).toBeLessThanOrEqual(processedCount1 + 1);
    });
  });

  describe("Test 12: Dream cycle enrichment queue", () => {
    it("deduplicates targets in the enrichment queue", () => {
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
        {
          type: "paper",
          identifier: "existing-paper",
          priority: "medium",
        },
        { type: "paper", identifier: "new-paper", priority: "low" },
        {
          type: "concept",
          identifier: "signal drift",
          priority: "medium",
        },
      ];

      const updated = enqueueTargets(state, targets);

      // existing-paper should NOT be duplicated
      expect(updated.enrichmentQueue).toHaveLength(3);
      const identifiers = updated.enrichmentQueue.map((t) => t.identifier);
      expect(identifiers).toContain("existing-paper");
      expect(identifiers).toContain("new-paper");
      expect(identifiers).toContain("signal drift");

      // The original priority for existing-paper should be preserved
      const existingTarget = updated.enrichmentQueue.find(
        (t) => t.identifier === "existing-paper",
      );
      expect(existingTarget!.priority).toBe("high");
    });

    it("processes enqueued targets during enrich-only mode", async () => {
      seedRealisticBrain();
      const config = makeConfig();
      const llm = mockLLM();

      // Pre-populate the enrichment queue
      const initialState = readDreamState(config);
      const withTargets = enqueueTargets(initialState, [
        {
          type: "paper",
          identifier: "2501.00001",
          priority: "high",
        },
      ]);
      writeDreamState(config, withTargets);

      const result = await runDreamCycle(config, llm, "enrich-only");

      expect(result.pagesCreated).toBeGreaterThan(0);
      expect(
        existsSync(join(BRAIN_ROOT, "wiki/entities/people/jane-smith.md")),
      ).toBe(true);
      expect(
        existsSync(join(BRAIN_ROOT, "wiki/concepts/guide-rna-design.md")),
      ).toBe(true);

      // Queue should be drained after processing
      const postState = readDreamState(config);
      const remaining = postState.enrichmentQueue.filter(
        (t) => t.identifier === "2501.00001",
      );
      expect(remaining).toHaveLength(0);
    });
  });

  describe("Test 13: Dream cycle with no recent events", () => {
    it("completes gracefully with zero work done", async () => {
      // Brain initialized but no events logged (clear the default events.jsonl)
      writeFileSync(join(BRAIN_ROOT, "wiki/events.jsonl"), "");

      const config = makeConfig();
      const llm = emptyLLM();

      const result = await runDreamCycle(config, llm, "sweep-only");

      expect(result.entitiesSwept).toBe(0);
      expect(result.pagesEnriched).toBe(0);
      expect(result.pagesCreated).toBe(0);
      expect(result.citationsFixed).toBe(0);
      expect(result.consolidations).toBe(0);
      expect(result.report).toContain("Dream Cycle Report");
      expect(result.durationMs).toBeGreaterThanOrEqual(0);

      // Should still update state
      const state = readDreamState(config);
      expect(state.lastFullRun).not.toBeNull();
    });
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// API ENDPOINT TESTS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("API Endpoints", () => {
  // The API routes import getBrainConfig which depends on loadBrainConfig.
  // We need to mock the config module to return our test config.
  const mockLoadBrainConfig = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    vi.doMock("@/brain/config", () => ({
      loadBrainConfig: () => mockLoadBrainConfig(),
      resolveBrainRoot: () => BRAIN_ROOT,
      brainExists: () => true,
    }));
    // Mock LLM creation to return our test LLM
    vi.doMock("@/brain/llm", async (importOriginal) => {
      const original =
        (await importOriginal()) as typeof import("@/brain/llm");
      return {
        ...original,
        createLLMClient: () => mockLLM(),
      };
    });
    mockLoadBrainConfig.mockReturnValue(makeConfig());
  });

  afterEach(() => {
    mockLoadBrainConfig.mockReset();
    vi.doUnmock("@/brain/config");
    vi.doUnmock("@/brain/llm");
    vi.resetModules();
  });

  describe("Test 4: Morning brief API endpoint", () => {
    it("GET /api/brain/morning-brief returns a brief", async () => {
      seedRealisticBrain();
      const { GET } = await import(
        "@/app/api/brain/morning-brief/route"
      );

      const response = await GET(
        new Request("http://localhost/api/brain/morning-brief"),
      );
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.generatedAt).toBeTruthy();
      expect(body.greeting).toBeTruthy();
      expect(Array.isArray(body.topMatters)).toBe(true);
      expect(body.topMatters[0].summary).toBe(
        "New observation contradicts signal drift hypothesis",
      );
      expect(body.nextMove.recommendation).toContain(
        "storage temperature controlled experiment",
      );
      expect(body.stats).toBeTruthy();
    });

    it("GET /api/brain/morning-brief?project=alpha returns project-scoped brief", async () => {
      seedRealisticBrain();
      const { GET } = await import(
        "@/app/api/brain/morning-brief/route"
      );

      const response = await GET(
        new Request(
          "http://localhost/api/brain/morning-brief?project=alpha",
        ),
      );
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.greeting).toContain("alpha");
      expect(body.topMatters[0].summary).toBe(
        "New observation contradicts signal drift hypothesis",
      );
    });

    it("POST with format: telegram returns plain text", async () => {
      seedRealisticBrain();
      const { POST } = await import(
        "@/app/api/brain/morning-brief/route"
      );

      const response = await POST(
        new Request("http://localhost/api/brain/morning-brief", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ format: "telegram" }),
        }),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toContain("text/plain");

      const text = await response.text();
      expect(text).toContain("Morning Brief");
      expect(text).toContain("Top 3:");
      expect(text).toContain("Next move:");
      expect(text).toContain("storage temperature controlled experiment");
    });

    it("POST with format: standup returns the compact route shape", async () => {
      seedRealisticBrain();
      const { POST } = await import(
        "@/app/api/brain/morning-brief/route"
      );

      const response = await POST(
        new Request("http://localhost/api/brain/morning-brief", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ format: "standup", projects: ["alpha"] }),
        }),
      );
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(Object.keys(body).sort()).toEqual(
        [
          "contradictions",
          "frontier",
          "generatedAt",
          "nextMove",
          "stats",
          "topMatters",
        ].sort(),
      );
      expect(body.topMatters[0]).toEqual(
        expect.objectContaining({
          summary: "New observation contradicts signal drift hypothesis",
          urgency: "act-now",
        }),
      );
      expect(typeof body.nextMove).toBe("string");
      expect(body.nextMove).toContain("storage temperature controlled experiment");
    });
  });

  describe("Test 6: Program brief API endpoint", () => {
    it("POST with valid projects array returns ProgramBrief", async () => {
      seedMultiProjectBrain();
      const { POST } = await import(
        "@/app/api/brain/program-brief/route"
      );

      const response = await POST(
        new Request("http://localhost/api/brain/program-brief", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projects: ["alpha", "beta"] }),
        }),
      );
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.generatedAt).toBeTruthy();
      expect(body.programStatus).toBe("at-risk");
      expect(body.standupSummary).toContain("Alpha project at risk");
      expect(body.bestNextExperiment.method).toBe(
        "Temperature-controlled split-sample assay",
      );
    });

    it("POST with empty projects returns 400", async () => {
      const { POST } = await import(
        "@/app/api/brain/program-brief/route"
      );

      const response = await POST(
        new Request("http://localhost/api/brain/program-brief", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projects: [] }),
        }),
      );
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBeTruthy();
    });

    it("POST with missing body returns 400", async () => {
      const { POST } = await import(
        "@/app/api/brain/program-brief/route"
      );

      const response = await POST(
        new Request("http://localhost/api/brain/program-brief", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "not json",
        }),
      );
      expect(response.status).toBe(400);
    });
  });
});
