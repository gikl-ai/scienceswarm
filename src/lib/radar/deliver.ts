import type { RadarBriefing, RankedSignal } from "./types"

const TELEGRAM_LIMIT = 4000

export function formatTelegramBriefing(briefing: RadarBriefing): string {
  if (briefing.nothingToday) {
    const failNote =
      briefing.stats.sourcesFailed.length > 0
        ? `\n(Could not reach: ${briefing.stats.sourcesFailed.join(", ")})`
        : ""
    return `Quiet day in your areas. Nothing worth your time.${failNote}`
  }

  const lines: string[] = []
  lines.push("Your Research Radar\n")

  if (briefing.matters.length > 0) {
    for (let i = 0; i < briefing.matters.length; i++) {
      const item = briefing.matters[i]
      lines.push(
        `${i + 1}. ${item.signal.title}`,
        `   ${item.whyItMatters}`,
        `   ${item.signal.url}`,
        ""
      )
    }
  }

  if (briefing.horizon.length > 0) {
    lines.push("On the horizon:")
    for (const item of briefing.horizon) {
      lines.push(
        `- ${item.signal.title}`,
        `  ${item.whyItMatters}`,
        `  ${item.signal.url}`,
        ""
      )
    }
  }

  if (briefing.stats.sourcesFailed.length > 0) {
    lines.push(
      `(Could not reach: ${briefing.stats.sourcesFailed.join(", ")})`
    )
  }

  lines.push(
    `Reply with a number to learn more, or "save #N" to add to your brain.`
  )

  let text = lines.join("\n")

  if (text.length > TELEGRAM_LIMIT) {
    text = text.slice(0, TELEGRAM_LIMIT - 20) + "\n\n(truncated)"
  }

  return text
}

export interface DashboardBriefingItem {
  signalId: string
  title: string
  url: string
  whyItMatters: string
  relevanceScore: number
  matchedTopics: string[]
  authors?: string[]
  tldr?: string
  source: string
  actions: string[]
}

export interface DashboardBriefing {
  id: string
  generatedAt: string
  nothingToday: boolean
  matters: DashboardBriefingItem[]
  horizon: DashboardBriefingItem[]
  stats: RadarBriefing["stats"]
}

function toDashboardItem(
  signal: RankedSignal,
  whyItMatters: string
): DashboardBriefingItem {
  return {
    signalId: signal.id,
    title: signal.title,
    url: signal.url,
    whyItMatters,
    relevanceScore: signal.relevanceScore,
    matchedTopics: signal.matchedTopics,
    authors: signal.metadata.authors,
    tldr: signal.metadata.tldr,
    source: signal.sourceId,
    actions: ["save-to-brain", "dismiss", "expand", "more-like-this"],
  }
}

export function formatDashboardBriefing(
  briefing: RadarBriefing
): DashboardBriefing {
  return {
    id: briefing.id,
    generatedAt: briefing.generatedAt,
    nothingToday: briefing.nothingToday,
    matters: briefing.matters.map((m) =>
      toDashboardItem(m.signal, m.whyItMatters)
    ),
    horizon: briefing.horizon.map((h) =>
      toDashboardItem(h.signal, h.whyItMatters)
    ),
    stats: briefing.stats,
  }
}
