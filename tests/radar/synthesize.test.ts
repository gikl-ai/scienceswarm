import { describe, it, expect, vi } from "vitest"
import { synthesizeBriefing } from "@/lib/radar/synthesize"
import type { RankedSignal, Radar } from "@/lib/radar/types"

describe("synthesizeBriefing", () => {
  const mockRadar: Radar = {
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
    schedule: { cron: "0 8 * * *", timezone: "UTC", fetchLeadMinutes: 120 },
    channels: { telegram: true, dashboard: true, email: false },
    filters: [],
    createdAt: "2026-04-10T00:00:00Z",
    updatedAt: "2026-04-10T00:00:00Z",
  }

  it("produces a briefing with matters and horizon sections", async () => {
    const ranked: RankedSignal[] = [
      {
        id: "s1",
        title: "Circuit Discovery",
        sourceId: "arxiv",
        url: "https://arxiv.org/1",
        timestamp: "2026-04-10T00:00:00Z",
        content: "New circuits found",
        metadata: {},
        relevanceScore: 0.95,
        matchedTopics: ["mechanistic interpretability"],
        explanation: "Directly relevant",
      },
      {
        id: "s2",
        title: "New Benchmark Suite",
        sourceId: "arxiv",
        url: "https://arxiv.org/2",
        timestamp: "2026-04-10T00:00:00Z",
        content: "Agent benchmark",
        metadata: {},
        relevanceScore: 0.6,
        matchedTopics: [],
        explanation: "Tangentially related",
      },
      {
        id: "s3",
        title: "Irrelevant Paper",
        sourceId: "rss",
        url: "https://example.com/3",
        timestamp: "2026-04-10T00:00:00Z",
        content: "Something unrelated",
        metadata: {},
        relevanceScore: 0.1,
        matchedTopics: [],
        explanation: "Not relevant",
      },
    ]

    const mockLLM = {
      generate: vi.fn().mockResolvedValue(
        JSON.stringify({
          matters: [
            {
              signalId: "s1",
              whyItMatters: "This directly extends your circuit discovery work on attention heads.",
            },
          ],
          horizon: [
            {
              signalId: "s2",
              whyItMatters: "New benchmark suite could be useful for validating your interpretability claims.",
            },
          ],
        })
      ),
    }

    const briefing = await synthesizeBriefing(
      ranked,
      mockRadar,
      mockLLM,
      { signalsFetched: 50, sourcesFailed: [] }
    )

    expect(briefing.matters).toHaveLength(1)
    expect(briefing.matters[0].signal.id).toBe("s1")
    expect(briefing.matters[0].programMatches?.[0]?.reference).toContain(
      "mechanistic interpretability"
    )
    expect(briefing.horizon).toHaveLength(1)
    expect(briefing.nothingToday).toBe(false)
    expect(briefing.radarId).toBe("radar-1")
  })

  it("produces nothingToday when no signals score high enough", async () => {
    const ranked: RankedSignal[] = [
      {
        id: "s1",
        title: "Low relevance",
        sourceId: "rss",
        url: "https://example.com/1",
        timestamp: "2026-04-10T00:00:00Z",
        content: "Meh",
        metadata: {},
        relevanceScore: 0.1,
        matchedTopics: [],
        explanation: "Not relevant",
      },
    ]

    const mockLLM = { generate: vi.fn() }

    const briefing = await synthesizeBriefing(
      ranked,
      mockRadar,
      mockLLM,
      { signalsFetched: 10, sourcesFailed: [] }
    )

    expect(briefing.nothingToday).toBe(true)
    expect(briefing.quietReason).toContain("none cleared the threshold")
    expect(briefing.matters).toHaveLength(0)
    expect(mockLLM.generate).not.toHaveBeenCalled()
  })

  it("handles empty ranked signals", async () => {
    const mockLLM = { generate: vi.fn() }

    const briefing = await synthesizeBriefing(
      [],
      mockRadar,
      mockLLM,
      { signalsFetched: 0, sourcesFailed: ["arxiv-cs-ai"] }
    )

    expect(briefing.nothingToday).toBe(true)
    expect(briefing.quietReason).toContain("no new external signals")
    expect(briefing.stats.sourcesFailed).toContain("arxiv-cs-ai")
  })
})
