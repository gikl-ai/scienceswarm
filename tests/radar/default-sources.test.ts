import { describe, it, expect } from "vitest"
import { defaultSourcesForTopics } from "@/lib/radar/default-sources"
import type { RadarTopic } from "@/lib/radar/types"

describe("defaultSourcesForTopics", () => {
  it("generates arxiv sources for research topics", () => {
    const topics: RadarTopic[] = [
      {
        name: "mechanistic interpretability",
        description: "Understanding transformer circuits",
        weight: 0.9,
        origin: "user",
      },
    ]

    const sources = defaultSourcesForTopics(topics)

    const arxivSource = sources.find((s) => s.type === "arxiv")
    expect(arxivSource).toBeDefined()
    expect(arxivSource!.adapter).toBe("semantic-scholar")
    expect(arxivSource!.enabled).toBe(true)
  })

  it("generates reddit source for AI topics", () => {
    const topics: RadarTopic[] = [
      {
        name: "large language models",
        description: "LLM research and applications",
        weight: 0.8,
        origin: "user",
      },
    ]

    const sources = defaultSourcesForTopics(topics)

    const redditSource = sources.find((s) => s.type === "reddit")
    expect(redditSource).toBeDefined()
    expect(redditSource!.adapter).toBe("reddit-api")
  })

  it("deduplicates sources across topics", () => {
    const topics: RadarTopic[] = [
      {
        name: "mechanistic interpretability",
        description: "Understanding circuits",
        weight: 0.9,
        origin: "user",
      },
      {
        name: "transformer architecture",
        description: "Attention mechanisms",
        weight: 0.7,
        origin: "user",
      },
    ]

    const sources = defaultSourcesForTopics(topics)

    const arxivIds = sources
      .filter((s) => s.type === "arxiv")
      .map((s) => s.id)
    const uniqueArxivIds = [...new Set(arxivIds)]
    expect(arxivIds.length).toBe(uniqueArxivIds.length)
  })

  it("returns at least one source even for unknown topics", () => {
    const topics: RadarTopic[] = [
      {
        name: "obscure niche topic",
        description: "Something very specific",
        weight: 0.5,
        origin: "user",
      },
    ]

    const sources = defaultSourcesForTopics(topics)
    expect(sources.length).toBeGreaterThan(0)
  })
})
