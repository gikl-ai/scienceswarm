// src/lib/radar/store.ts
import { readFile, writeFile, mkdir, rm, readdir } from "fs/promises"
import { join } from "path"
import { randomUUID } from "crypto"
import type {
  Radar,
  RadarTopic,
  RadarSource,
  RadarSchedule,
  RadarChannels,
  RadarFilter,
} from "./types"
import {
  DEFAULT_SCHEDULE,
  DEFAULT_CHANNELS,
} from "./types"

const RADAR_DIR = "radar"

function radarDir(stateDir: string): string {
  return join(stateDir, RADAR_DIR)
}

function radarPath(stateDir: string, id: string): string {
  return join(radarDir(stateDir), `${id}.json`)
}

export interface CreateRadarInput {
  topics: RadarTopic[]
  sources: RadarSource[]
  schedule?: Partial<RadarSchedule>
  channels?: Partial<RadarChannels>
  filters?: RadarFilter[]
}

export async function createRadar(
  stateDir: string,
  input: CreateRadarInput
): Promise<Radar> {
  const dir = radarDir(stateDir)
  await mkdir(dir, { recursive: true })

  const now = new Date().toISOString()
  const radar: Radar = {
    id: randomUUID(),
    topics: input.topics,
    sources: input.sources,
    schedule: { ...DEFAULT_SCHEDULE, ...input.schedule },
    channels: { ...DEFAULT_CHANNELS, ...input.channels },
    filters: input.filters ?? [],
    createdAt: now,
    updatedAt: now,
  }

  await writeFile(radarPath(stateDir, radar.id), JSON.stringify(radar, null, 2))
  return radar
}

export async function getRadar(
  stateDir: string,
  id: string
): Promise<Radar | null> {
  try {
    const data = await readFile(radarPath(stateDir, id), "utf-8")
    return JSON.parse(data) as Radar
  } catch {
    return null
  }
}

export async function updateRadar(
  stateDir: string,
  id: string,
  updates: Partial<Pick<Radar, "topics" | "sources" | "schedule" | "channels" | "filters">>
): Promise<Radar> {
  const existing = await getRadar(stateDir, id)
  if (!existing) {
    throw new Error(`Radar ${id} not found`)
  }

  const now = new Date().toISOString()
  const updated: Radar = {
    ...existing,
    ...updates,
    // Guarantee updatedAt is strictly later than the existing value
    updatedAt: now > existing.updatedAt ? now : new Date(new Date(existing.updatedAt).getTime() + 1).toISOString(),
  }

  await writeFile(radarPath(stateDir, id), JSON.stringify(updated, null, 2))
  return updated
}

export async function deleteRadar(
  stateDir: string,
  id: string
): Promise<void> {
  try {
    await rm(radarPath(stateDir, id))
  } catch {
    // Already deleted or never existed — idempotent
  }
}

export async function radarExists(stateDir: string): Promise<boolean> {
  try {
    const files = await readdir(radarDir(stateDir))
    return files.some((f) => f.endsWith(".json"))
  } catch {
    return false
  }
}

export async function getActiveRadar(stateDir: string): Promise<Radar | null> {
  try {
    const files = await readdir(radarDir(stateDir))
    const jsonFiles = files
      .filter((f) => f.endsWith(".json"))
      .filter((f) => f !== "latest-briefing.json")
      .sort()

    for (const file of jsonFiles) {
      const radar = await getRadar(stateDir, file.replace(".json", ""))
      if (
        radar &&
        Array.isArray(radar.topics) &&
        Array.isArray(radar.sources)
      ) {
        return radar
      }
    }

    return null
  } catch {
    return null
  }
}
