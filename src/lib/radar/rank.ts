import type { BrainStore } from "@/brain/store"
import type { Signal, RadarTopic, RankedSignal } from "./types"

interface LLMClient {
  generate(prompt: string): Promise<string>
}

const RANKING_PROMPT = `You are ranking research signals for relevance to a specific researcher.

## Researcher's active topics (with weights):
{topics}

## Researcher's brain context:
{brainContext}

## Signals to rank:
{signals}

For each signal, evaluate how relevant it is to this researcher's active work.

Return a JSON array with one entry per signal:
[
  {
    "signalId": "the signal id",
    "relevanceScore": 0.0-1.0,
    "matchedTopics": ["topic names that match"],
    "explanation": "one sentence on why this matters or doesn't"
  }
]

Score 0.0 = completely irrelevant, 1.0 = directly impacts their current work.
Be selective — most items from a general feed will score below 0.3.
Return ONLY the JSON array.`

const BATCH_SIZE = 20

export async function rankSignals(
  signals: Signal[],
  topics: RadarTopic[],
  store: BrainStore,
  llm: LLMClient
): Promise<RankedSignal[]> {
  if (signals.length === 0) return []

  const brainResults = await store.search({
    query: topics.map((t) => t.name).join(", "),
    mode: "index",
    limit: 15,
  })

  const brainContext = brainResults
    .map((r) => `[${r.type}] ${r.title}: ${r.snippet}`)
    .join("\n")

  const topicSummary = topics
    .map((t) => `- ${t.name} (weight: ${t.weight}): ${t.description}`)
    .join("\n")

  const allRanked: RankedSignal[] = []

  for (let i = 0; i < signals.length; i += BATCH_SIZE) {
    const batch = signals.slice(i, i + BATCH_SIZE)
    const signalSummary = batch
      .map(
        (s) =>
          `[${s.id}] "${s.title}" — ${s.content.slice(0, 200)}${s.metadata.tldr ? ` (TLDR: ${s.metadata.tldr})` : ""}`
      )
      .join("\n")

    const prompt = RANKING_PROMPT.replace("{topics}", () => topicSummary)
      .replace("{brainContext}", () => brainContext || "(empty brain)")
      .replace("{signals}", () => signalSummary)

    const response = await llm.generate(prompt)

    let rankings: Array<{
      signalId: string
      relevanceScore: number
      matchedTopics: string[]
      explanation: string
    }>

    try {
      rankings = JSON.parse(response.trim())
      if (!Array.isArray(rankings)) rankings = []
    } catch {
      rankings = batch.map((s) => ({
        signalId: s.id,
        relevanceScore: 0.5,
        matchedTopics: [],
        explanation: "Could not rank — included with neutral score",
      }))
    }

    const rankMap = new Map(rankings.map((r) => [r.signalId, r]))

    for (const signal of batch) {
      const ranking = rankMap.get(signal.id)
      const baseScore = ranking?.relevanceScore ?? 0.5

      const matchedTopicWeights = (ranking?.matchedTopics ?? [])
        .map((name) => {
          const topic = topics.find(
            (t) => t.name.toLowerCase() === name.toLowerCase()
          )
          return topic?.weight ?? 1.0
        })

      const topicWeight =
        matchedTopicWeights.length > 0
          ? Math.max(...matchedTopicWeights)
          : 1.0

      allRanked.push({
        ...signal,
        relevanceScore: baseScore * topicWeight,
        matchedTopics: ranking?.matchedTopics ?? [],
        explanation: ranking?.explanation ?? "",
      })
    }
  }

  allRanked.sort((a, b) => b.relevanceScore - a.relevanceScore)

  return allRanked
}
