import type { Radar, RankedSignal, RadarBriefing } from "./types"
import { randomUUID } from "crypto"

interface LLMClient {
  generate(prompt: string): Promise<string>
}

const MATTERS_THRESHOLD = 0.4
const HORIZON_THRESHOLD = 0.2
const MAX_MATTERS = 5
const MAX_HORIZON = 2

const SYNTHESIS_PROMPT = `You are writing a personalized research briefing for a scientist.

## Their research topics:
{topics}

## Top signals to include in the briefing:

### "What matters today" candidates (high relevance):
{mattersSignals}

### "Horizon" candidates (adjacent but interesting):
{horizonSignals}

Write a personalized "why it matters" explanation for each signal. The explanation should:
- Reference the researcher's specific projects or topics by name
- Be one sentence, conversational, specific
- Say WHY it matters, not just THAT it's relevant

Return a JSON object:
{
  "matters": [{ "signalId": "...", "whyItMatters": "..." }],
  "horizon": [{ "signalId": "...", "whyItMatters": "..." }]
}

Return ONLY the JSON object.`

export async function synthesizeBriefing(
  ranked: RankedSignal[],
  radar: Radar,
  llm: LLMClient,
  fetchStats: { signalsFetched: number; sourcesFailed: string[] }
): Promise<RadarBriefing> {
  const mattersCandidates = ranked
    .filter((s) => s.relevanceScore >= MATTERS_THRESHOLD)
    .slice(0, MAX_MATTERS)

  const horizonCandidates = ranked
    .filter(
      (s) =>
        s.relevanceScore >= HORIZON_THRESHOLD &&
        s.relevanceScore < MATTERS_THRESHOLD
    )
    .slice(0, MAX_HORIZON)

  if (mattersCandidates.length === 0) {
    return {
      id: randomUUID(),
      radarId: radar.id,
      generatedAt: new Date().toISOString(),
      matters: [],
      horizon: [],
      nothingToday: true,
      stats: {
        signalsFetched: fetchStats.signalsFetched,
        signalsRanked: ranked.length,
        sourcesQueried: radar.sources.filter((s) => s.enabled).length,
        sourcesFailed: fetchStats.sourcesFailed,
      },
    }
  }

  const topicSummary = radar.topics
    .map((t) => `- ${t.name}: ${t.description}`)
    .join("\n")

  const mattersText = mattersCandidates
    .map(
      (s) =>
        `[${s.id}] "${s.title}" (score: ${s.relevanceScore.toFixed(2)}, topics: ${s.matchedTopics.join(", ") || "none"}) — ${s.content.slice(0, 200)}`
    )
    .join("\n")

  const horizonText =
    horizonCandidates.length > 0
      ? horizonCandidates
          .map(
            (s) =>
              `[${s.id}] "${s.title}" (score: ${s.relevanceScore.toFixed(2)}) — ${s.content.slice(0, 200)}`
          )
          .join("\n")
      : "(none)"

  const prompt = SYNTHESIS_PROMPT.replace("{topics}", () => topicSummary)
    .replace("{mattersSignals}", () => mattersText)
    .replace("{horizonSignals}", () => horizonText)

  const response = await llm.generate(prompt)

  let synthesis: {
    matters: Array<{ signalId: string; whyItMatters: string }>
    horizon: Array<{ signalId: string; whyItMatters: string }>
  }

  try {
    synthesis = JSON.parse(response.trim())
  } catch {
    synthesis = {
      matters: mattersCandidates.map((s) => ({
        signalId: s.id,
        whyItMatters: s.explanation,
      })),
      horizon: horizonCandidates.map((s) => ({
        signalId: s.id,
        whyItMatters: s.explanation,
      })),
    }
  }

  const signalMap = new Map(ranked.map((s) => [s.id, s]))

  return {
    id: randomUUID(),
    radarId: radar.id,
    generatedAt: new Date().toISOString(),
    matters: (synthesis.matters ?? [])
      .filter((m) => signalMap.has(m.signalId))
      .map((m) => ({
        signal: signalMap.get(m.signalId)!,
        whyItMatters: m.whyItMatters,
      })),
    horizon: (synthesis.horizon ?? [])
      .filter((h) => signalMap.has(h.signalId))
      .map((h) => ({
        signal: signalMap.get(h.signalId)!,
        whyItMatters: h.whyItMatters,
      })),
    nothingToday: false,
    stats: {
      signalsFetched: fetchStats.signalsFetched,
      signalsRanked: ranked.length,
      sourcesQueried: radar.sources.filter((s) => s.enabled).length,
      sourcesFailed: fetchStats.sourcesFailed,
    },
  }
}
