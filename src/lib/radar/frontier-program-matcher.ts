import type {
  FrontierProgramArea,
  FrontierProgramMatch,
  Radar,
  RadarTopic,
  RankedSignal,
} from "./types"

const AREA_KEYWORDS: Array<{
  area: FrontierProgramArea
  words: string[]
}> = [
  {
    area: "experiment",
    words: ["experiment", "assay", "protocol", "screen", "trial", "validation"],
  },
  {
    area: "hypothesis",
    words: ["hypothesis", "mechanism", "driver", "causal", "pathway", "model"],
  },
  {
    area: "decision",
    words: ["prioritize", "selection", "choose", "decision", "tradeoff", "go/no-go"],
  },
  {
    area: "question",
    words: ["unknown", "open question", "uncertain", "why", "whether"],
  },
  {
    area: "method",
    words: ["method", "tool", "benchmark", "dataset", "pipeline", "technique"],
  },
]

function firstSentence(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim()
  if (!normalized) return ""
  const match = normalized.match(/^(.{1,220}?[.!?])(?:\s|$)/)
  return match?.[1] ?? normalized.slice(0, 220)
}

function inferProgramArea(signal: RankedSignal): FrontierProgramArea {
  const haystack = `${signal.title}\n${signal.content}\n${signal.explanation}`.toLowerCase()
  for (const candidate of AREA_KEYWORDS) {
    if (candidate.words.some((word) => haystack.includes(word))) {
      return candidate.area
    }
  }
  return "topic"
}

function findBestTopic(signal: RankedSignal, radar: Radar): RadarTopic | null {
  for (const name of signal.matchedTopics) {
    const topic = radar.topics.find(
      (candidate) => candidate.name.toLowerCase() === name.toLowerCase()
    )
    if (topic) return topic
  }

  return [...radar.topics].sort((left, right) => right.weight - left.weight)[0] ?? null
}

function confidenceFor(signal: RankedSignal): FrontierProgramMatch["confidence"] {
  if (signal.relevanceScore >= 0.75 && signal.matchedTopics.length > 0) return "high"
  if (signal.relevanceScore >= 0.4) return "medium"
  return "low"
}

function actionFor(area: FrontierProgramArea, topicName: string): string {
  switch (area) {
    case "hypothesis":
      return `Re-check the active ${topicName} hypothesis before committing more wet-lab effort.`
    case "decision":
      return `Use this as decision evidence when prioritizing the next ${topicName} branch.`
    case "experiment":
      return `Compare the next planned ${topicName} experiment against this signal before running it.`
    case "question":
      return `Turn this into a tracked question so the team can decide whether it changes ${topicName}.`
    case "method":
      return `Evaluate whether this method should be added to the ${topicName} toolkit.`
    case "topic":
      return `Keep this attached to ${topicName} and revisit it during the next planning pass.`
  }
}

export function matchFrontierSignalToProgram(
  signal: RankedSignal,
  radar: Radar
): FrontierProgramMatch[] {
  const topic = findBestTopic(signal, radar)
  if (!topic || signal.relevanceScore < 0.2) return []

  const area = inferProgramArea(signal)
  const signalReason = firstSentence(signal.explanation) || firstSentence(signal.content)
  const tldr = firstSentence(signal.metadata.tldr ?? "")
  const evidence = [
    ...signal.matchedTopics.map((name) => `matched topic: ${name}`),
    signalReason ? `ranking rationale: ${signalReason}` : "",
    tldr ? `source TLDR: ${tldr}` : "",
  ].filter(Boolean)

  const whyThisMatters = signalReason
    ? `Affects ${topic.name} because ${signalReason}`
    : `Affects ${topic.name} because it cleared the radar relevance threshold for this program.`

  return [
    {
      area,
      reference: `${topic.name}: ${topic.description}`,
      whyThisMatters,
      recommendedAction: actionFor(area, topic.name),
      evidence,
      confidence: confidenceFor(signal),
    },
  ]
}

export function explainQuietFrontierState(
  radar: Radar,
  rankedCount: number,
  signalsFetched: number
): string {
  const topicNames = radar.topics.map((topic) => topic.name).join(", ") || "the active radar"
  if (signalsFetched === 0) {
    return `Checked ${topicNames}, but no new external signals were available from the enabled sources.`
  }
  if (rankedCount === 0) {
    return `Checked ${signalsFetched} external signals for ${topicNames}, but none could be ranked against the active program.`
  }
  return `Checked ${rankedCount} ranked external signals for ${topicNames}; none cleared the threshold for interrupting the current program today.`
}
