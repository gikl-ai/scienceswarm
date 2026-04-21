// src/lib/radar/schedule.ts
import { getActiveRadar } from "./store"
import { runRadarPipeline, type PipelineResult } from "./pipeline"
import { buildProductionFetchers } from "./fetchers/index"
import type { BrainStore } from "@/brain/store"

interface LLMClient {
  generate(prompt: string): Promise<string>
}

export interface RadarScheduleContext {
  stateDir: string
  brainStore: BrainStore
  llm: LLMClient
}

export async function executeScheduledRadar(
  ctx: RadarScheduleContext
): Promise<PipelineResult | null> {
  const radar = await getActiveRadar(ctx.stateDir)
  if (!radar) return null

  const fetchers = buildProductionFetchers()

  return runRadarPipeline({
    stateDir: ctx.stateDir,
    radarId: radar.id,
    fetchers,
    brainStore: ctx.brainStore,
    llm: ctx.llm,
  })
}

export function shouldRunNow(cron: string, timezone: string): boolean {
  // Simple hour-based check for MVP
  const now = new Date()
  const formatter = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    hour12: false,
    timeZone: timezone,
  })
  const currentHour = parseInt(formatter.format(now), 10)

  // Parse hour from cron "0 H * * *"
  const match = cron.match(/^\d+\s+(\d+)\s+/)
  if (!match) return false

  const targetHour = parseInt(match[1], 10)
  return currentHour === targetHour
}

/**
 * Send a text message to a Telegram chat via the Bot API.
 * Uses TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID from env.
 * Silently no-ops if either env var is missing.
 */
export async function sendTelegramBriefing(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN
  const chatId = process.env.TELEGRAM_CHAT_ID
  if (!token || !chatId) return

  // Telegram messages are capped at 4096 chars
  const truncated = text.length > 4096 ? text.slice(0, 4093) + "…" : text

  const res = await fetch(
    `https://api.telegram.org/bot${token}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: truncated,
        parse_mode: "Markdown",
      }),
    }
  )

  if (!res.ok) {
    const body = await res.text().catch(() => "")
    console.error(`[radar] Telegram send failed ${res.status}: ${body}`)
  }
}
