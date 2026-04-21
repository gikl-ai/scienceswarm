// src/lib/radar/learn.ts
import { appendFile, mkdir } from "fs/promises"
import { join } from "path"
import type { RadarFeedback, Radar } from "./types"
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
