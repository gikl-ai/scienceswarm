// tests/radar/learn.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import {
  recordFeedback,
  applyFeedbackToRadar,
  saveRadarMatchToBrain,
} from "@/lib/radar/learn"
import { createRadar } from "@/lib/radar/store"
import type { RadarFeedback } from "@/lib/radar/types"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises"
import { join } from "path"
import { tmpdir } from "os"

describe("feedback loop", () => {
  let stateDir: string

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "radar-feedback-"))
  })

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true })
  })

  it("records feedback to JSONL file", async () => {
    const feedback: RadarFeedback = {
      briefingId: "b1",
      signalId: "s1",
      action: "save-to-brain",
      timestamp: "2026-04-10T08:30:00Z",
    }

    await recordFeedback(stateDir, feedback)
    await recordFeedback(stateDir, {
      ...feedback,
      signalId: "s2",
      action: "dismiss",
    })

    const { readFile } = await import("fs/promises")
    const data = await readFile(
      join(stateDir, "radar", "feedback.jsonl"),
      "utf-8"
    )
    const lines = data.trim().split("\n")
    expect(lines).toHaveLength(2)
  })

  it("strengthens topic weight on save-to-brain", async () => {
    const radar = await createRadar(stateDir, {
      topics: [
        {
          name: "mechanistic interpretability",
          description: "Circuits",
          weight: 0.7,
          origin: "user",
        },
      ],
      sources: [],
    })

    const feedback: RadarFeedback = {
      briefingId: "b1",
      signalId: "s1",
      action: "save-to-brain",
      timestamp: "2026-04-10T08:30:00Z",
    }

    const updated = await applyFeedbackToRadar(stateDir, radar.id, feedback, [
      "mechanistic interpretability",
    ])

    expect(updated.topics[0].weight).toBeGreaterThan(0.7)
    expect(updated.topics[0].weight).toBeLessThanOrEqual(1.0)
  })

  it("weakens topic weight on dismiss", async () => {
    const radar = await createRadar(stateDir, {
      topics: [
        {
          name: "vision models",
          description: "Computer vision",
          weight: 0.6,
          origin: "inferred",
        },
      ],
      sources: [],
    })

    const feedback: RadarFeedback = {
      briefingId: "b1",
      signalId: "s1",
      action: "dismiss",
      timestamp: "2026-04-10T08:30:00Z",
    }

    const updated = await applyFeedbackToRadar(stateDir, radar.id, feedback, [
      "vision models",
    ])

    expect(updated.topics[0].weight).toBeLessThan(0.6)
    expect(updated.topics[0].weight).toBeGreaterThanOrEqual(0)
  })

  it("saves a radar match with its program context into brain memory", async () => {
    await mkdir(join(stateDir, "radar"), { recursive: true })
    await writeFile(
      join(stateDir, "radar", "latest-briefing.json"),
      JSON.stringify({
        id: "b1",
        generatedAt: "2026-04-10T08:00:00Z",
        nothingToday: false,
        matters: [
          {
            signalId: "s1",
            title: "MEK combination reverses EGFR resistance",
            url: "https://example.test/mek",
            whyItMatters: "Challenges the current single-agent EGFR plan.",
            relevanceScore: 0.92,
            matchedTopics: ["EGFR resistance program"],
            source: "semantic-scholar",
            actions: ["save-to-brain"],
            programMatches: [
              {
                area: "experiment",
                reference:
                  "EGFR resistance program: Choosing whether to add a MEK arm",
                whyThisMatters:
                  "Affects EGFR resistance because the source reports a rescue combination.",
                recommendedAction:
                  "Compare the next planned experiment against this signal.",
                evidence: ["matched topic: EGFR resistance program"],
                confidence: "high",
              },
            ],
          },
        ],
        horizon: [],
        stats: { signalsFetched: 1, signalsRanked: 1, sourcesQueried: 1, sourcesFailed: [] },
      }),
      "utf-8"
    )

    const saved = await saveRadarMatchToBrain(stateDir, {
      briefingId: "b1",
      signalId: "s1",
      savedAt: "2026-04-10T08:30:00Z",
    })

    expect(saved.savedPath).toMatch(/^wiki\/entities\/frontier\//)
    const content = await readFile(join(stateDir, saved.savedPath), "utf-8")
    expect(content).toContain("## Program Match")
    expect(content).toContain("EGFR resistance program")
    expect(content).toContain("Compare the next planned experiment")
  })
})
