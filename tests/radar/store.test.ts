// tests/radar/store.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import {
  createRadar,
  getRadar,
  getActiveRadar,
  updateRadar,
  deleteRadar,
  radarExists,
} from "@/lib/radar/store"
import type { RadarTopic, RadarSource } from "@/lib/radar/types"
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises"
import { join } from "path"
import { tmpdir } from "os"

describe("RadarStore", () => {
  let stateDir: string

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "radar-test-"))
  })

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true })
  })

  const sampleTopics: RadarTopic[] = [
    {
      name: "mechanistic interpretability",
      description: "Circuit-level understanding of transformer internals",
      weight: 0.9,
      origin: "user",
    },
  ]

  const sampleSources: RadarSource[] = [
    {
      id: "arxiv-cs-ai",
      type: "arxiv",
      adapter: "semantic-scholar",
      query: "cs.AI",
      enabled: true,
    },
  ]

  it("creates and retrieves a radar", async () => {
    const radar = await createRadar(stateDir, {
      topics: sampleTopics,
      sources: sampleSources,
    })

    expect(radar.id).toBeDefined()
    expect(radar.topics).toEqual(sampleTopics)
    expect(radar.sources).toEqual(sampleSources)
    expect(radar.schedule.cron).toBe("0 6 * * *")
    expect(radar.channels.telegram).toBe(false)
    expect(radar.channels.dashboard).toBe(true)

    const retrieved = await getRadar(stateDir, radar.id)
    expect(retrieved).toEqual(radar)
  })

  it("returns null for nonexistent radar", async () => {
    const result = await getRadar(stateDir, "nonexistent")
    expect(result).toBeNull()
  })

  it("updates radar topics", async () => {
    const radar = await createRadar(stateDir, {
      topics: sampleTopics,
      sources: sampleSources,
    })

    const newTopic: RadarTopic = {
      name: "agent benchmarks",
      description: "Evaluating autonomous AI agents",
      weight: 0.7,
      origin: "user",
    }

    const updated = await updateRadar(stateDir, radar.id, {
      topics: [...sampleTopics, newTopic],
    })

    expect(updated.topics).toHaveLength(2)
    expect(updated.topics[1].name).toBe("agent benchmarks")
    expect(updated.updatedAt).not.toBe(radar.updatedAt)
  })

  it("deletes a radar", async () => {
    const radar = await createRadar(stateDir, {
      topics: sampleTopics,
      sources: sampleSources,
    })

    await deleteRadar(stateDir, radar.id)
    const result = await getRadar(stateDir, radar.id)
    expect(result).toBeNull()
  })

  it("checks radar existence", async () => {
    expect(await radarExists(stateDir)).toBe(false)

    await createRadar(stateDir, {
      topics: sampleTopics,
      sources: sampleSources,
    })

    expect(await radarExists(stateDir)).toBe(true)
  })

  it("ignores cached briefing JSON when selecting the active radar", async () => {
    await mkdir(join(stateDir, "radar"), { recursive: true })
    await writeFile(
      join(stateDir, "radar", "latest-briefing.json"),
      JSON.stringify({
        id: "briefing-1",
        generatedAt: "2026-04-22T12:00:00Z",
        matters: [],
        horizon: [],
        nothingToday: true,
      }),
      "utf-8"
    )

    const radar = await createRadar(stateDir, {
      topics: sampleTopics,
      sources: sampleSources,
    })

    await expect(getActiveRadar(stateDir)).resolves.toMatchObject({
      id: radar.id,
      topics: sampleTopics,
      sources: sampleSources,
    })
  })
})
