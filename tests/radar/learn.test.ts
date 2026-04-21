// tests/radar/learn.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { recordFeedback, applyFeedbackToRadar } from "@/lib/radar/learn"
import { createRadar } from "@/lib/radar/store"
import type { RadarFeedback } from "@/lib/radar/types"
import { mkdtemp, rm } from "fs/promises"
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
})
