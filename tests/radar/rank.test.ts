import { describe, it, expect, vi } from "vitest"
import { rankSignals } from "@/lib/radar/rank"
import type { Signal, RadarTopic } from "@/lib/radar/types"
import type { BrainStore } from "@/brain/store"
import type { SearchResult } from "@/brain/types"

function mockBrainStore(searchResults: SearchResult[]): BrainStore {
  return {
    search: vi.fn().mockResolvedValue(searchResults),
    getPage: vi.fn(),
    importCorpus: vi.fn(),
    listPages: vi.fn().mockResolvedValue([]),
    health: vi.fn(),
    dispose: vi.fn(),
  } as unknown as BrainStore
}

describe("rankSignals", () => {
  const topics: RadarTopic[] = [
    {
      name: "mechanistic interpretability",
      description: "Understanding transformer circuits",
      weight: 0.9,
      origin: "user",
    },
    {
      name: "agent benchmarks",
      description: "Evaluating AI agents",
      weight: 0.7,
      origin: "user",
    },
  ]

  it("ranks signals by relevance to brain content", async () => {
    const signals: Signal[] = [
      {
        id: "s1",
        title: "New Circuit Discovery in GPT-4",
        sourceId: "arxiv-cs-ai",
        url: "https://arxiv.org/abs/1",
        timestamp: "2026-04-10T00:00:00Z",
        content: "We discover novel circuits in transformer attention heads that explain in-context learning",
        metadata: {},
      },
      {
        id: "s2",
        title: "Cryptocurrency Market Analysis",
        sourceId: "rss-1",
        url: "https://example.com/crypto",
        timestamp: "2026-04-10T00:00:00Z",
        content: "Bitcoin prices rose 5% this week",
        metadata: {},
      },
    ]

    const store = mockBrainStore([
      {
        score: 0.95,
        title: "Mech Interp Project",
        snippet: "Investigating attention head circuits in transformers",
        path: "projects/mech-interp.md",
        type: "project",
      } as unknown as SearchResult,
    ])

    const mockLLM = {
      generate: vi.fn().mockResolvedValue(
        JSON.stringify([
          {
            signalId: "s1",
            relevanceScore: 0.95,
            matchedTopics: ["mechanistic interpretability"],
            explanation: "Directly relevant to your circuit discovery work",
          },
          {
            signalId: "s2",
            relevanceScore: 0.05,
            matchedTopics: [],
            explanation: "Not related to your research",
          },
        ])
      ),
    }

    const ranked = await rankSignals(signals, topics, store, mockLLM)

    expect(ranked).toHaveLength(2)
    expect(ranked[0].id).toBe("s1")
    expect(ranked[0].relevanceScore).toBeGreaterThan(ranked[1].relevanceScore)
    expect(ranked[0].matchedTopics).toContain("mechanistic interpretability")
  })

  it("applies topic weights to scores", async () => {
    const signals: Signal[] = [
      {
        id: "s1",
        title: "Interp Paper",
        sourceId: "src",
        url: "https://example.com/1",
        timestamp: "2026-04-10T00:00:00Z",
        content: "Interpretability research",
        metadata: {},
      },
    ]

    const store = mockBrainStore([])

    const mockLLM = {
      generate: vi.fn().mockResolvedValue(
        JSON.stringify([
          {
            signalId: "s1",
            relevanceScore: 0.8,
            matchedTopics: ["mechanistic interpretability"],
            explanation: "Relevant",
          },
        ])
      ),
    }

    const ranked = await rankSignals(signals, topics, store, mockLLM)

    // Score should be weighted: 0.8 * 0.9 (topic weight) = 0.72
    expect(ranked[0].relevanceScore).toBeCloseTo(0.72, 1)
  })

  it("returns empty array for empty signals", async () => {
    const store = mockBrainStore([])
    const mockLLM = { generate: vi.fn() }

    const ranked = await rankSignals([], topics, store, mockLLM)
    expect(ranked).toEqual([])
  })
})
