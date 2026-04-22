import { describe, expect, it } from "vitest"
import {
  explainQuietFrontierState,
  matchFrontierSignalToProgram,
} from "@/lib/radar/frontier-program-matcher"
import type { Radar, RankedSignal } from "@/lib/radar/types"

const radar: Radar = {
  id: "radar-1",
  topics: [
    {
      name: "EGFR resistance program",
      description: "Choosing whether to add a MEK combination arm",
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

function rankedSignal(overrides: Partial<RankedSignal> = {}): RankedSignal {
  return {
    id: "s1",
    title: "MEK combination experiment reverses EGFR resistance",
    sourceId: "semantic-scholar",
    url: "https://example.test/paper",
    timestamp: "2026-04-10T00:00:00Z",
    content:
      "A CRISPR screen suggests a MEK combination changes the resistance mechanism.",
    metadata: { tldr: "MEK combination may rescue EGFR inhibitor response." },
    relevanceScore: 0.86,
    matchedTopics: ["EGFR resistance program"],
    explanation: "Directly challenges the current single-agent EGFR plan.",
    ...overrides,
  }
}

describe("frontier program matcher", () => {
  it("turns a ranked frontier signal into a concrete program match", () => {
    const matches = matchFrontierSignalToProgram(rankedSignal(), radar)

    expect(matches).toHaveLength(1)
    expect(matches[0]).toMatchObject({
      area: "experiment",
      reference:
        "EGFR resistance program: Choosing whether to add a MEK combination arm",
      confidence: "high",
    })
    expect(matches[0].whyThisMatters).toContain("single-agent EGFR plan")
    expect(matches[0].recommendedAction).toContain("next planned")
    expect(matches[0].evidence).toContain("matched topic: EGFR resistance program")
  })

  it("does not force a program match for low-signal noise", () => {
    const matches = matchFrontierSignalToProgram(
      rankedSignal({
        title: "Unrelated conference recap",
        relevanceScore: 0.1,
        matchedTopics: [],
      }),
      radar
    )

    expect(matches).toHaveLength(0)
  })

  it("explains quiet states in terms of the active radar", () => {
    expect(explainQuietFrontierState(radar, 12, 30)).toContain(
      "none cleared the threshold"
    )
    expect(explainQuietFrontierState(radar, 0, 0)).toContain(
      "no new external signals"
    )
  })
})
