// src/lib/radar/learn.ts
import { appendFile, mkdir, readFile, writeFile } from "fs/promises"
import { join } from "path"
import type { RadarFeedback, Radar } from "./types"
import type { DashboardBriefing, DashboardBriefingItem } from "./deliver"
import { getRadar, updateRadar } from "./store"

const WEIGHT_BOOST = 0.05
const WEIGHT_DECAY = 0.03

export async function recordFeedback(
  stateDir: string,
  feedback: RadarFeedback
): Promise<void> {
  const dir = join(stateDir, "radar")
  await mkdir(dir, { recursive: true })

  const line = JSON.stringify(feedback) + "\n"
  await appendFile(join(dir, "feedback.jsonl"), line)
}

export async function applyFeedbackToRadar(
  stateDir: string,
  radarId: string,
  feedback: RadarFeedback,
  matchedTopics: string[]
): Promise<Radar> {
  const radar = await getRadar(stateDir, radarId)
  if (!radar) {
    throw new Error(`Radar ${radarId} not found`)
  }

  const isPositive =
    feedback.action === "save-to-brain" ||
    feedback.action === "more-like-this"

  const isNegative =
    feedback.action === "dismiss" || feedback.action === "less-like-this"

  if (!isPositive && !isNegative) {
    return radar
  }

  const updatedTopics = radar.topics.map((topic) => {
    const isMatched = matchedTopics.some(
      (t) => t.toLowerCase() === topic.name.toLowerCase()
    )

    if (!isMatched) return topic

    let newWeight = topic.weight
    if (isPositive) {
      newWeight = Math.min(1.0, topic.weight + WEIGHT_BOOST)
    } else {
      newWeight = Math.max(0.0, topic.weight - WEIGHT_DECAY)
    }

    return { ...topic, weight: newWeight }
  })

  return updateRadar(stateDir, radarId, { topics: updatedTopics })
}

export interface SavedRadarMatch {
  savedPath: string
  item: DashboardBriefingItem
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90) || "frontier-match"
}

function yamlList(values: string[]): string {
  if (values.length === 0) return "[]"
  return `[${values.map((value) => JSON.stringify(value)).join(", ")}]`
}

function allBriefingItems(briefing: DashboardBriefing): DashboardBriefingItem[] {
  return [...(briefing.matters ?? []), ...(briefing.horizon ?? [])]
}

function renderSavedMatch(item: DashboardBriefingItem, savedAt: string): string {
  const match = item.programMatches[0]
  const lines = [
    "---",
    "type: frontier_item",
    `title: ${JSON.stringify(item.title)}`,
    `source_url: ${JSON.stringify(item.url)}`,
    `source: ${JSON.stringify(item.source)}`,
    `signal_id: ${JSON.stringify(item.signalId)}`,
    `saved_at: ${JSON.stringify(savedAt)}`,
    `matched_topics: ${yamlList(item.matchedTopics)}`,
    `relevance_score: ${item.relevanceScore}`,
    "status: saved",
    "---",
    "",
    `# ${item.title}`,
    "",
    "## Why This Matters",
    item.whyItMatters,
    "",
  ]

  if (match) {
    lines.push(
      "## Program Match",
      `- Area: ${match.area}`,
      `- Reference: ${match.reference}`,
      `- Why this matters: ${match.whyThisMatters}`,
      `- Recommended action: ${match.recommendedAction}`,
      `- Confidence: ${match.confidence}`,
      "",
      "## Evidence",
      ...match.evidence.map((entry) => `- ${entry}`),
      "",
    )
  }

  if (item.tldr) {
    lines.push("## Source TLDR", item.tldr, "")
  }

  lines.push("## Source", item.url, "")
  return lines.join("\n")
}

export async function saveRadarMatchToBrain(
  stateDir: string,
  input: {
    briefingId: string
    signalId: string
    savedAt?: string
  }
): Promise<SavedRadarMatch> {
  const raw = await readFile(join(stateDir, "radar", "latest-briefing.json"), "utf-8")
  const briefing = JSON.parse(raw) as DashboardBriefing

  if (briefing.id !== input.briefingId) {
    throw new Error("Cached briefing does not match the feedback briefing")
  }

  const item = allBriefingItems(briefing).find(
    (candidate) => candidate.signalId === input.signalId
  )
  if (!item) {
    throw new Error("Signal was not found in the latest briefing")
  }

  const savedAt = input.savedAt ?? new Date().toISOString()
  const date = savedAt.slice(0, 10)
  const filename = `${slugify(`${date}-${item.title}`)}.md`
  const relativePath = `wiki/entities/frontier/${filename}`
  const absolutePath = join(stateDir, "wiki", "entities", "frontier", filename)

  await mkdir(join(stateDir, "wiki", "entities", "frontier"), { recursive: true })
  await writeFile(absolutePath, renderSavedMatch(item, savedAt), "utf-8")

  return {
    savedPath: relativePath,
    item,
  }
}
