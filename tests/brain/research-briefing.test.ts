import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync, appendFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { initBrain } from "@/brain/init";
import {
  buildMorningBrief,
  buildProgramBrief,
  formatTelegramBrief,
} from "@/brain/research-briefing";
import { scanForContradictions } from "@/brain/contradiction-detector";
import type { BrainConfig, MorningBrief } from "@/brain/types";
import type { LLMClient, LLMResponse } from "@/brain/llm";
import { writeProjectManifest } from "@/lib/state/project-manifests";

const TEST_ROOT = join(tmpdir(), "scienceswarm-brain-test-research-briefing");
const BRAIN_ROOT = join(TEST_ROOT, "brain");
const ORIGINAL_SCIENCESWARM_DIR = process.env.SCIENCESWARM_DIR;

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

/** Mock LLM that returns structured JSON responses */
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
                  text: "CRISPR efficiency is 90%",
                  source: "wiki/hypotheses/crispr-efficiency.md",
                  date: "2026-04-01",
                },
                claim2: {
                  text: "Observed efficiency was only 60%",
                  source: "wiki/observations/obs-1.md",
                  date: "2026-04-08",
                },
                implication:
                  "The CRISPR efficiency hypothesis may need revision based on recent observations.",
                suggestedResolution:
                  "Re-run the efficiency assay with fresh reagents.",
              },
            ],
            tensions: [
              {
                description: "Two competing primer designs both show promise",
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
                summary: "New observation contradicts CRISPR efficiency hypothesis",
                whyItMatters:
                  "Your current experiment design assumes 90% efficiency. Recent data shows 60%.",
                evidence: ["wiki/observations/obs-1.md"],
                urgency: "act-now",
              },
              {
                summary: "Frontier paper on improved guide RNA design",
                whyItMatters:
                  "Could improve your efficiency numbers if adopted.",
                evidence: ["wiki/entities/frontier/guide-rna.md"],
                urgency: "this-week",
              },
            ],
            nextMove: {
              recommendation:
                "Re-run the CRISPR efficiency assay with the new guide RNA design.",
              reasoning:
                "The current efficiency data contradicts your hypothesis. A fresh assay with the improved guide RNA could resolve both the contradiction and validate the new approach.",
              assumptions: [
                "Fresh reagents are available.",
                "The guide RNA paper methods are reproducible.",
              ],
              missingEvidence: [
                "Independent replication of the guide RNA results.",
              ],
              experiment: {
                hypothesis:
                  "New guide RNA design will achieve >85% CRISPR efficiency.",
                method:
                  "Run efficiency assay with new guide RNA on same cell line.",
                expectedOutcome:
                  "Efficiency above 85% validates the new design; below 70% suggests deeper issues.",
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
                change: "Efficiency contradiction found",
                impact: "high",
              },
            ],
            scientificRisks: [
              {
                risk: "CRISPR efficiency below threshold",
                project: "alpha",
                severity: "high",
              },
            ],
            bestNextExperiment: {
              hypothesis: "Guide RNA improvement restores efficiency",
              method: "Head-to-head assay",
              expectedOutcome: ">85% efficiency",
              whyThisOne: "Resolves the main blocking contradiction",
              assumptions: ["Reagents available"],
              discriminates:
                "Whether the issue is guide RNA design vs cell line drift",
            },
            standupSummary:
              "Alpha project at risk due to CRISPR efficiency contradiction. Recommended experiment: guide RNA head-to-head assay.",
          }),
          cost,
        };
      }

      // Default fallback
      return {
        content: JSON.stringify({ topMatters: [], nextMove: { recommendation: "Review priorities." } }),
        cost,
      };
    },
  };
}

function seedBrainContent() {
  mkdirSync(join(BRAIN_ROOT, "wiki/projects"), { recursive: true });
  mkdirSync(join(BRAIN_ROOT, "wiki/tasks"), { recursive: true });
  mkdirSync(join(BRAIN_ROOT, "wiki/entities/frontier"), { recursive: true });
  mkdirSync(join(BRAIN_ROOT, "wiki/hypotheses"), { recursive: true });
  mkdirSync(join(BRAIN_ROOT, "wiki/observations"), { recursive: true });
  mkdirSync(join(BRAIN_ROOT, "wiki/experiments"), { recursive: true });

  writeFileSync(
    join(BRAIN_ROOT, "wiki/projects/alpha.md"),
    "---\ntype: project\ntitle: Alpha Project\nstatus: active\n---\n# Alpha Project\n\n## Summary\nCRISPR sequencing project.",
  );

  writeFileSync(
    join(BRAIN_ROOT, "wiki/tasks/alpha-task.md"),
    "---\ntype: task\ntitle: Run efficiency assay\nstatus: open\nproject: alpha\n---\n# Run efficiency assay\nNeed to verify CRISPR efficiency.",
  );

  writeFileSync(
    join(BRAIN_ROOT, "wiki/entities/frontier/guide-rna.md"),
    "---\ntype: frontier_item\ntitle: Improved guide RNA design paper\nstatus: staged\nproject: alpha\n---\n# Improved guide RNA design paper\nNew approach to guide RNA with support for higher efficiency.",
  );

  writeFileSync(
    join(BRAIN_ROOT, "wiki/hypotheses/crispr-efficiency.md"),
    "---\ntype: hypothesis\ntitle: CRISPR efficiency is above 85%\nstatus: active\nproject: alpha\n---\n# CRISPR efficiency is above 85%\nHypothesis that our CRISPR system achieves high efficiency.",
  );

  writeFileSync(
    join(BRAIN_ROOT, "wiki/observations/obs-1.md"),
    "---\ntype: observation\ntitle: Low efficiency observed\nproject: alpha\n---\n# Low efficiency observed\nObserved CRISPR efficiency was only 60%, contradicting our hypothesis.",
  );

  writeFileSync(
    join(BRAIN_ROOT, "wiki/experiments/alpha-assay.md"),
    "---\ntype: experiment\ntitle: Alpha efficiency assay\nstatus: running\nproject: alpha\n---\n# Alpha efficiency assay\nRunning experiment to measure CRISPR efficiency.",
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
}

beforeEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
  process.env.SCIENCESWARM_DIR = TEST_ROOT;
  initBrain({ root: BRAIN_ROOT, name: "Test Researcher" });
  seedBrainContent();
});

afterEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
  vi.unstubAllGlobals();
  if (ORIGINAL_SCIENCESWARM_DIR) {
    process.env.SCIENCESWARM_DIR = ORIGINAL_SCIENCESWARM_DIR;
  } else {
    delete process.env.SCIENCESWARM_DIR;
  }
});

describe("research-briefing", () => {
  describe("buildMorningBrief", () => {
    it("generates a morning brief with all expected sections", async () => {
      const config = makeConfig();
      const llm = mockLLM();

      const brief = await buildMorningBrief(config, llm, {
        project: "alpha",
      });

      expect(brief.generatedAt).toBeTruthy();
      expect(brief.greeting).toContain("research briefing");
      expect(brief.greeting).toContain("alpha");
      expect(brief.topMatters.length).toBeGreaterThan(0);
      expect(brief.nextMove.recommendation).toBeTruthy();
      expect(brief.nextMove.assumptions.length).toBeGreaterThan(0);
      expect(brief.stats.brainPages).toBeGreaterThan(0);
    });

    it("includes contradictions when detected", async () => {
      const config = makeConfig();
      const llm = mockLLM();

      const brief = await buildMorningBrief(config, llm, {
        project: "alpha",
      });

      expect(brief.contradictions.length).toBeGreaterThan(0);
      expect(brief.contradictions[0].claim1.summary).toBeTruthy();
      expect(brief.contradictions[0].claim2.summary).toBeTruthy();
      expect(brief.contradictions[0].implication).toBeTruthy();
    });

    it("includes frontier items scored by relevance", async () => {
      const config = makeConfig();
      const llm = mockLLM();

      const brief = await buildMorningBrief(config, llm, {
        project: "alpha",
      });

      // Frontier items come from search results, which find our seeded pages
      expect(Array.isArray(brief.frontier)).toBe(true);
      for (const item of brief.frontier) {
        expect(item.relevanceScore).toBeGreaterThanOrEqual(0);
        expect(item.relevanceScore).toBeLessThanOrEqual(1);
        expect(["supports", "challenges", "adjacent", "noise"]).toContain(
          item.threatOrOpportunity,
        );
      }
    });

    it("finds stale threads from tasks and experiments not recently touched", async () => {
      const config = makeConfig();
      const llm = mockLLM();

      const brief = await buildMorningBrief(config, llm);

      // Stale threads are tasks/experiments not in recent events
      expect(Array.isArray(brief.staleThreads)).toBe(true);
      for (const thread of brief.staleThreads) {
        expect(thread.name).toBeTruthy();
        expect(thread.daysSinceActivity).toBeGreaterThanOrEqual(0);
        expect(thread.suggestedAction).toBeTruthy();
      }
    });

    it("identifies open questions from hypotheses and tasks", async () => {
      const config = makeConfig();
      const llm = mockLLM();

      const brief = await buildMorningBrief(config, llm, {
        project: "alpha",
      });

      expect(Array.isArray(brief.openQuestions)).toBe(true);
      for (const question of brief.openQuestions) {
        expect(question.question).toBeTruthy();
        expect(question.project).toBeTruthy();
      }
    });

    it("includes stats about brain activity", async () => {
      const config = makeConfig();
      const llm = mockLLM();

      const brief = await buildMorningBrief(config, llm);

      expect(brief.stats.brainPages).toBeGreaterThan(0);
      expect(typeof brief.stats.newPagesYesterday).toBe("number");
      expect(typeof brief.stats.capturesYesterday).toBe("number");
      expect(typeof brief.stats.enrichmentsYesterday).toBe("number");
    });

    it("provides a next move with experiment suggestion", async () => {
      const config = makeConfig();
      const llm = mockLLM();

      const brief = await buildMorningBrief(config, llm, {
        project: "alpha",
      });

      expect(brief.nextMove.recommendation).toBeTruthy();
      expect(brief.nextMove.reasoning).toBeTruthy();
      expect(brief.nextMove.experiment).toBeTruthy();
      if (brief.nextMove.experiment) {
        expect(brief.nextMove.experiment.hypothesis).toBeTruthy();
        expect(brief.nextMove.experiment.method).toBeTruthy();
        expect(brief.nextMove.experiment.expectedOutcome).toBeTruthy();
      }
    });
  });

  describe("contradiction detection", () => {
    it("scans for contradictions and returns structured report", async () => {
      const config = makeConfig();
      const llm = mockLLM();

      const report = await scanForContradictions(config, llm, {
        project: "alpha",
      });

      expect(report.scannedPages).toBeGreaterThan(0);
      expect(report.contradictions.length).toBeGreaterThan(0);
      expect(report.contradictions[0].severity).toBe("notable");
      expect(report.contradictions[0].claim1.text).toBeTruthy();
      expect(report.contradictions[0].suggestedResolution).toBeTruthy();
    });

    it("returns tensions alongside contradictions", async () => {
      const config = makeConfig();
      const llm = mockLLM();

      const report = await scanForContradictions(config, llm);

      expect(report.tensions.length).toBeGreaterThan(0);
      expect(report.tensions[0].description).toBeTruthy();
      expect(report.tensions[0].sources.length).toBeGreaterThan(0);
    });

    it("returns empty report when brain has no relevant pages", async () => {
      // Wipe wiki content
      rmSync(join(BRAIN_ROOT, "wiki/hypotheses"), {
        recursive: true,
        force: true,
      });
      rmSync(join(BRAIN_ROOT, "wiki/observations"), {
        recursive: true,
        force: true,
      });

      const config = makeConfig();
      // LLM that returns no contradictions
      const emptyLlm: LLMClient = {
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

      const report = await scanForContradictions(config, emptyLlm);
      expect(report.contradictions).toHaveLength(0);
      expect(report.tensions).toHaveLength(0);
    });
  });

  describe("formatTelegramBrief", () => {
    it("produces concise telegram output", () => {
      const brief: MorningBrief = {
        generatedAt: "2026-04-09T08:00:00.000Z",
        greeting: "Good morning.",
        topMatters: [
          {
            summary: "New observation contradicts efficiency hypothesis",
            whyItMatters: "Your experiment design assumes 90% efficiency",
            evidence: ["wiki/obs-1.md"],
            urgency: "act-now",
          },
          {
            summary: "Frontier paper on guide RNA",
            whyItMatters: "Could improve efficiency",
            evidence: ["wiki/frontier/guide-rna.md"],
            urgency: "this-week",
          },
        ],
        contradictions: [
          {
            claim1: {
              summary: "90% efficiency",
              source: "wiki/hyp.md",
              date: "2026-04-01",
            },
            claim2: {
              summary: "60% observed",
              source: "wiki/obs.md",
              date: "2026-04-08",
            },
            implication: "Efficiency hypothesis needs revision",
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
          recommendation: "Re-run efficiency assay with new guide RNA",
          reasoning: "Current data contradicts hypothesis",
          assumptions: ["Fresh reagents available"],
          missingEvidence: ["Independent replication"],
        },
        stats: {
          brainPages: 42,
          newPagesYesterday: 3,
          capturesYesterday: 2,
          enrichmentsYesterday: 1,
        },
      };

      const output = formatTelegramBrief(brief);

      expect(output).toContain("Morning Brief");
      expect(output).toContain("Top 3:");
      expect(output).toContain("New observation contradicts efficiency hypothesis");
      expect(output).toContain("Contradictions: 1");
      expect(output).toContain("Frontier: 1 new");
      expect(output).toContain("Next move:");
      // Should be concise — under 1000 chars for phone readability
      expect(output.length).toBeLessThan(1000);
    });

    it("handles empty brief gracefully", () => {
      const brief: MorningBrief = {
        generatedAt: "2026-04-09T08:00:00.000Z",
        greeting: "Good morning.",
        topMatters: [],
        contradictions: [],
        frontier: [],
        staleThreads: [],
        openQuestions: [],
        nextMove: {
          recommendation: "Review priorities.",
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

  describe("buildProgramBrief", () => {
    it("generates a program brief for team projects", async () => {
      const config = makeConfig();
      const llm = mockLLM();

      await writeProjectManifest({
        version: 1,
        projectId: "alpha",
        slug: "alpha",
        title: "Alpha Project",
        privacy: "cloud-ok",
        status: "active",
        projectPagePath: "wiki/projects/alpha.md",
        sourceRefs: [],
        decisionPaths: [],
        taskPaths: ["wiki/tasks/alpha-task.md"],
        artifactPaths: [],
        frontierPaths: [],
        activeThreads: [],
        dedupeKeys: [],
        updatedAt: "2026-04-08T00:00:00.000Z",
      });

      const brief = await buildProgramBrief(config, llm, ["alpha"]);

      expect(brief.generatedAt).toBeTruthy();
      expect(["on-track", "at-risk", "blocked"]).toContain(
        brief.programStatus,
      );
      expect(brief.standupSummary).toBeTruthy();
      expect(brief.bestNextExperiment).toBeTruthy();
      expect(brief.bestNextExperiment.hypothesis).toBeTruthy();
    });
  });
});
