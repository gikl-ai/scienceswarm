// src/lib/radar/pipeline.ts
import type { BrainStore } from "@/brain/store"
import type { RadarBriefing, SourceAdapter } from "./types"
import type { SourceFetcher } from "./fetch"
import type { DashboardBriefing } from "./deliver"
import { getRadar } from "./store"
import { fetchSignals } from "./fetch"
import { rankSignals } from "./rank"
import { synthesizeBriefing } from "./synthesize"
import {
  formatTelegramBriefing,
  formatDashboardBriefing,
} from "./deliver"

interface LLMClient {
  generate(prompt: string): Promise<string>
}

export interface PipelineInput {
  stateDir: string
  radarId: string
  fetchers: Partial<Record<SourceAdapter, SourceFetcher>>
  brainStore: BrainStore
  llm: LLMClient
}

export interface PipelineResult {
  briefing: RadarBriefing
  telegram: string
  dashboard: DashboardBriefing
}

export async function runRadarPipeline(
  input: PipelineInput
): Promise<PipelineResult | null> {
  const { stateDir, radarId, fetchers, brainStore, llm } = input

  const radar = await getRadar(stateDir, radarId)
  if (!radar) return null

  // Stage 1: Fetch
  const { signals, failed } = await fetchSignals(radar.sources, fetchers)

  // Stage 2: Rank
  const ranked = await rankSignals(signals, radar.topics, brainStore, llm)

  // Stage 3: Synthesize
  const briefing = await synthesizeBriefing(ranked, radar, llm, {
    signalsFetched: signals.length,
    sourcesFailed: failed,
  })

  // Stage 4: Format for delivery
  const telegram = formatTelegramBriefing(briefing)
  const dashboard = formatDashboardBriefing(briefing)

  return { briefing, telegram, dashboard }
}
