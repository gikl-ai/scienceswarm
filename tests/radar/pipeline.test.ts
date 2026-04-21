// tests/radar/pipeline.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { runRadarPipeline } from "@/lib/radar/pipeline"
import { createRadar } from "@/lib/radar/store"
import type { Signal } from "@/lib/radar/types"
import { mkdtemp, rm } from "fs/promises"
import { join } from "path"
import { tmpdir } from "os"

describe("runRadarPipeline", () => {
  let stateDir: string

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "radar-pipeline-"))
  })

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true })
  })

  it("runs the full pipeline and produces a briefing", async () => {
    const radar = await createRadar(stateDir, {
      topics: [
        {
          name: "mechanistic interpretability",
          description: "Circuit analysis",
          weight: 0.9,
          origin: "user",
        },
      ],
      sources: [
        {
          id: "arxiv-cs-ai",
          type: "arxiv",
          adapter: "semantic-scholar",
          query: "cs.AI",
          enabled: true,
        },
      ],
    })

    const testSignal: Signal = {
      id: "s1",
      title: "New Circuit Paper",
      sourceId: "arxiv-cs-ai",
      url: "https://arxiv.org/abs/1",
      timestamp: "2026-04-10T00:00:00Z",
      content: "Discovering circuits in transformers",
      metadata: { tldr: "Novel circuit discovery" },
    }

    const mockFetchers = {
      "semantic-scholar": vi.fn().mockResolvedValue([testSignal]),
    }

    const mockBrainStore = {
      search: vi.fn().mockResolvedValue([
        {
          score: 0.9,
          title: "Interp Project",
          snippet: "Attention circuits",
          path: "projects/interp.md",
          type: "project",
        },
      ]),
      getPage: vi.fn(),
      importCorpus: vi.fn(),
      listPages: vi.fn().mockResolvedValue([]),
      health: vi.fn(),
      dispose: vi.fn(),
    }

    const mockLLM = {
      generate: vi
        .fn()
        .mockResolvedValueOnce(
          // Ranking response
          JSON.stringify([
            {
              signalId: "s1",
              relevanceScore: 0.9,
              matchedTopics: ["mechanistic interpretability"],
              explanation: "Relevant to your circuit work",
            },
          ])
        )
        .mockResolvedValueOnce(
          // Synthesis response
          JSON.stringify({
            matters: [
              {
                signalId: "s1",
                whyItMatters: "Extends your attention head circuit analysis.",
              },
            ],
            horizon: [],
          })
        ),
    }

    const result = await runRadarPipeline({
      stateDir,
      radarId: radar.id,
      fetchers: mockFetchers,
      brainStore: mockBrainStore as unknown as import("@/brain/store").BrainStore,
      llm: mockLLM,
    })

    expect(result).not.toBeNull()
    expect(result!.briefing.matters).toHaveLength(1)
    expect(result!.briefing.nothingToday).toBe(false)
    expect(result!.telegram).toContain("New Circuit Paper")
    expect(result!.dashboard.matters).toHaveLength(1)
  })

  it("handles pipeline with no radar gracefully", async () => {
    const result = await runRadarPipeline({
      stateDir,
      radarId: "nonexistent",
      fetchers: {},
      brainStore: {} as unknown as import("@/brain/store").BrainStore,
      llm: {} as unknown as { generate: (prompt: string) => Promise<string> },
    })

    expect(result).toBeNull()
  })
})
