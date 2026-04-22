import { describe, it, expect } from "vitest"
import {
  formatTelegramBriefing,
  formatDashboardBriefing,
} from "@/lib/radar/deliver"
import type { RadarBriefing, RankedSignal } from "@/lib/radar/types"

function makeBriefing(overrides?: Partial<RadarBriefing>): RadarBriefing {
  const signal: RankedSignal = {
    id: "s1",
    title: "Circuit Discovery in GPT-4",
    sourceId: "arxiv-cs-ai",
    url: "https://arxiv.org/abs/2401.00001",
    timestamp: "2026-04-10T00:00:00Z",
    content: "We discover novel circuits",
    metadata: { authors: ["Alice", "Bob"], tldr: "Found new circuits" },
    relevanceScore: 0.95,
    matchedTopics: ["mechanistic interpretability"],
    explanation: "Directly relevant",
  }

  return {
    id: "b1",
    radarId: "radar-1",
    generatedAt: "2026-04-10T08:00:00Z",
    matters: [{ signal, whyItMatters: "Extends your circuit work on attention heads." }],
    horizon: [],
    nothingToday: false,
    stats: {
      signalsFetched: 50,
      signalsRanked: 50,
      sourcesQueried: 5,
      sourcesFailed: [],
    },
    ...overrides,
  }
}

describe("formatTelegramBriefing", () => {
  it("formats a briefing with matters items", () => {
    const text = formatTelegramBriefing(makeBriefing())
    expect(text).toContain("Circuit Discovery in GPT-4")
    expect(text).toContain("Extends your circuit work")
    expect(text).toContain("arxiv.org")
  })

  it("formats nothingToday briefing", () => {
    const text = formatTelegramBriefing(
      makeBriefing({
        nothingToday: true,
        matters: [],
        horizon: [],
        quietReason: "Checked 12 signals; none changed the plan.",
      })
    )
    expect(text).toContain("Quiet day")
    expect(text).toContain("none changed the plan")
    expect(text.length).toBeLessThan(200)
  })

  it("stays under Telegram's 4000 char limit", () => {
    const manyMatters = Array.from({ length: 5 }, (_, i) => ({
      signal: {
        id: `s${i}`,
        title: `Paper ${i} with a very long title that goes on and on`,
        sourceId: "arxiv",
        url: `https://arxiv.org/abs/${i}`,
        timestamp: "2026-04-10T00:00:00Z",
        content: "Long content ".repeat(50),
        metadata: {},
        relevanceScore: 0.9 - i * 0.1,
        matchedTopics: ["topic"],
        explanation: "Relevant",
      } as RankedSignal,
      whyItMatters: "This is why it matters to your work. ".repeat(3),
    }))

    const text = formatTelegramBriefing(makeBriefing({ matters: manyMatters }))
    expect(text.length).toBeLessThanOrEqual(4000)
  })

  it("notes failed sources", () => {
    const text = formatTelegramBriefing(
      makeBriefing({
        stats: {
          signalsFetched: 30,
          signalsRanked: 30,
          sourcesQueried: 5,
          sourcesFailed: ["arxiv-cs-ai"],
        },
      })
    )
    expect(text).toContain("arxiv-cs-ai")
  })
})

describe("formatDashboardBriefing", () => {
  it("returns structured data for dashboard rendering", () => {
    const result = formatDashboardBriefing(
      makeBriefing({
        matters: [
          {
            signal: makeBriefing().matters[0].signal,
            whyItMatters: "Extends your circuit work on attention heads.",
            programMatches: [
              {
                area: "hypothesis",
                reference: "mechanistic interpretability: Circuit analysis",
                whyThisMatters: "Affects the current circuit hypothesis.",
                recommendedAction: "Re-check the active hypothesis.",
                evidence: ["matched topic: mechanistic interpretability"],
                confidence: "high",
              },
            ],
          },
        ],
      })
    )
    expect(result.matters).toHaveLength(1)
    expect(result.matters[0].title).toBe("Circuit Discovery in GPT-4")
    expect(result.matters[0].url).toBe("https://arxiv.org/abs/2401.00001")
    expect(result.matters[0].whyItMatters).toBeDefined()
    expect(result.matters[0].programMatches[0].reference).toContain(
      "mechanistic interpretability"
    )
    expect(result.matters[0].actions).toContain("save-to-brain")
    expect(result.matters[0].actions).toContain("dismiss")
  })
})
