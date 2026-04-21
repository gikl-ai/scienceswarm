import type { BrainStore } from "@/brain/store"
import type { RadarTopic } from "./types"

const TOPIC_INFERENCE_PROMPT = `You are analyzing a researcher's second brain to identify their active research interests.

Given the following project and paper summaries from the brain, extract the 3-7 most important research topics this person is actively working on.

For each topic, provide:
- name: a concise topic label (2-5 words)
- description: one sentence describing the focus area
- weight: 0.0-1.0 indicating how central this is to their current work (based on recency and volume of related content)

Return ONLY a JSON array of objects with those three fields. No other text.

Brain contents:
{brainContent}`

const USER_TOPIC_PROMPT = `The user also explicitly requested monitoring for: "{userPrompt}"

Extract any additional topics from this request that are NOT already covered by the inferred topics. Return them as a JSON array with the same format (name, description, weight). Use weight 0.8 for user-requested topics. Return an empty array if all requested topics are already covered.`

// The LLMClient interface — we only need generate()
interface LLMClient {
  generate(prompt: string): Promise<string>
}

export async function inferTopicsFromBrain(
  store: BrainStore,
  llm: LLMClient,
  userPrompt?: string
): Promise<RadarTopic[]> {
  const projectResults = await store.search({
    query: "active project research focus",
    mode: "index",
    limit: 20,
  })

  if (projectResults.length === 0 && !userPrompt) {
    return []
  }

  const brainContent = projectResults
    .map((r) => `[${r.type}] ${r.title}: ${r.snippet}`)
    .join("\n")

  let prompt = TOPIC_INFERENCE_PROMPT.replace("{brainContent}", () => brainContent)

  if (userPrompt) {
    prompt += "\n\n" + USER_TOPIC_PROMPT.replace("{userPrompt}", () => userPrompt)
  }

  const response = await llm.generate(prompt)

  let parsed: Array<{ name: string; description: string; weight: number }>
  try {
    const cleaned = response.trim()
    parsed = JSON.parse(cleaned)
    if (!Array.isArray(parsed)) {
      parsed = []
    }
  } catch {
    parsed = []
  }

  const inferredTopics: RadarTopic[] = parsed.map((t) => ({
    name: t.name,
    description: t.description,
    weight: Math.min(1, Math.max(0, t.weight)),
    origin: "inferred" as const,
  }))

  if (userPrompt && projectResults.length > 0) {
    const userTopicPrompt = USER_TOPIC_PROMPT.replace("{userPrompt}", () => userPrompt)
    const userResponse = await llm.generate(
      `Given these already-inferred topics:\n${JSON.stringify(inferredTopics.map((t) => t.name))}\n\n${userTopicPrompt}`
    )

    let addedUserTopics = false
    const existingNames = new Set(inferredTopics.map((t) => t.name.toLowerCase()))
    try {
      const userParsed = JSON.parse(userResponse.trim())
      if (Array.isArray(userParsed)) {
        for (const t of userParsed) {
          if (!existingNames.has(t.name.toLowerCase())) {
            inferredTopics.push({
              name: t.name,
              description: t.description,
              weight: Math.min(1, Math.max(0, t.weight)),
              origin: "user",
            })
            addedUserTopics = true
          }
        }
      }
    } catch {
      // fall through to raw fallback
    }
    if (!addedUserTopics && userPrompt.trim()) {
      inferredTopics.push({
        name: userPrompt.trim().slice(0, 50),
        description: userPrompt.trim(),
        weight: 0.8,
        origin: "user",
      })
    }
  } else if (userPrompt && projectResults.length === 0) {
    inferredTopics.push({
      name: userPrompt.trim().slice(0, 50),
      description: userPrompt.trim(),
      weight: 0.8,
      origin: "user",
    })
  }

  return inferredTopics
}
