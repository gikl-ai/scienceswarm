// tests/radar/fetch.test.ts
import { describe, it, expect, vi } from "vitest"
import { fetchSignals } from "@/lib/radar/fetch"
import type { RadarSource, Signal } from "@/lib/radar/types"

describe("fetchSignals", () => {
  it("fetches from Semantic Scholar adapter", async () => {
    const sources: RadarSource[] = [
      {
        id: "arxiv-cs-ai",
        type: "arxiv",
        adapter: "semantic-scholar",
        query: "cs.AI",
        enabled: true,
      },
    ]

    const mockFetchers = {
      "semantic-scholar": vi.fn().mockResolvedValue([
        {
          id: "ss-1",
          title: "Test Paper on Transformers",
          sourceId: "arxiv-cs-ai",
          url: "https://arxiv.org/abs/2401.00001",
          timestamp: "2026-04-10T00:00:00Z",
          content: "A paper about transformer architectures",
          metadata: {
            authors: ["Alice", "Bob"],
            citations: 42,
            tldr: "Novel transformer architecture",
          },
        },
      ] satisfies Signal[]),
    }

    const result = await fetchSignals(sources, mockFetchers)

    expect(result.signals).toHaveLength(1)
    expect(result.signals[0].title).toBe("Test Paper on Transformers")
    expect(result.failed).toHaveLength(0)
  })

  it("skips disabled sources", async () => {
    const sources: RadarSource[] = [
      {
        id: "arxiv-cs-ai",
        type: "arxiv",
        adapter: "semantic-scholar",
        query: "cs.AI",
        enabled: false,
      },
    ]

    const mockFetchers = {
      "semantic-scholar": vi.fn(),
    }

    const result = await fetchSignals(sources, mockFetchers)

    expect(result.signals).toHaveLength(0)
    expect(mockFetchers["semantic-scholar"]).not.toHaveBeenCalled()
  })

  it("collects failures without crashing", async () => {
    const sources: RadarSource[] = [
      {
        id: "arxiv-cs-ai",
        type: "arxiv",
        adapter: "semantic-scholar",
        query: "cs.AI",
        enabled: true,
      },
      {
        id: "reddit-ml",
        type: "reddit",
        adapter: "reddit-api",
        url: "r/MachineLearning",
        enabled: true,
      },
    ]

    const mockFetchers = {
      "semantic-scholar": vi.fn().mockRejectedValue(new Error("API timeout")),
      "reddit-api": vi.fn().mockResolvedValue([
        {
          id: "r-1",
          title: "Reddit Post",
          sourceId: "reddit-ml",
          url: "https://reddit.com/r/ML/1",
          timestamp: "2026-04-10T00:00:00Z",
          content: "Discussion about new paper",
          metadata: { socialScore: 150 },
        },
      ] satisfies Signal[]),
    }

    const result = await fetchSignals(sources, mockFetchers)

    expect(result.signals).toHaveLength(1)
    expect(result.signals[0].title).toBe("Reddit Post")
    expect(result.failed).toEqual(["arxiv-cs-ai"])
  })

  it("deduplicates signals by URL", async () => {
    const sources: RadarSource[] = [
      { id: "src-1", type: "arxiv", adapter: "semantic-scholar", query: "cs.AI", enabled: true },
      { id: "src-2", type: "rss", adapter: "rss-direct", url: "https://example.com/feed", enabled: true },
    ]

    const duplicateSignal: Signal = {
      id: "dup-1",
      title: "Same Paper",
      sourceId: "src-1",
      url: "https://arxiv.org/abs/2401.00001",
      timestamp: "2026-04-10T00:00:00Z",
      content: "A paper",
      metadata: {},
    }

    const mockFetchers = {
      "semantic-scholar": vi.fn().mockResolvedValue([duplicateSignal]),
      "rss-direct": vi.fn().mockResolvedValue([
        { ...duplicateSignal, id: "dup-2", sourceId: "src-2" },
      ]),
    }

    const result = await fetchSignals(sources, mockFetchers)
    expect(result.signals).toHaveLength(1)
  })
})
