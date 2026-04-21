/**
 * GET /api/radar/infer-topics
 *
 * Returns up to 5 inferred research topics from the user's second brain.
 * Powers the radar onboarding card's pre-checked topic list.
 *
 * Never returns an error status — degrades to { topics: [] } when:
 * - Brain is not configured
 * - Brain store is unavailable
 * - LLM (OpenAI) key is missing or call fails
 * - inferTopicsFromBrain throws for any reason
 */

import { getBrainStore, ensureBrainStoreReady } from "@/brain/store"
import { getBrainConfig, getLLMClient, isErrorResponse } from "../../brain/_shared"
import { inferTopicsFromBrain } from "@/lib/radar/infer-topics"

const EMPTY_RESPONSE = { topics: [] }
const MAX_TOPICS = 5

export async function GET(_request: Request): Promise<Response> {
  try {
    // 1. Load brain config — returns Response on failure
    const configOrError = getBrainConfig()
    if (isErrorResponse(configOrError)) {
      return Response.json(EMPTY_RESPONSE)
    }
    const config = configOrError

    // 2. Get LLM client — may throw if OPENAI_API_KEY missing
    const brainLLM = getLLMClient(config)

    // 3. Adapt brain LLMClient.complete() to radar's generate() interface
    const radarLLM = {
      async generate(prompt: string): Promise<string> {
        const response = await brainLLM.complete({
          system: "You are a research assistant analyzing a researcher's second brain.",
          user: prompt,
        })
        return response.content
      },
    }

    // 4. Get brain store
    await ensureBrainStoreReady()
    const store = getBrainStore()

    // 5. Infer topics
    const topics = await inferTopicsFromBrain(store, radarLLM)

    return Response.json({ topics: topics.slice(0, MAX_TOPICS) })
  } catch {
    // Any failure degrades to empty topics — never return an error status
    return Response.json(EMPTY_RESPONSE)
  }
}
