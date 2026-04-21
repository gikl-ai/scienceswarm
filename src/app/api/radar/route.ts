/**
 * GET/POST/PATCH /api/radar
 *
 * GET    — Return the active radar configuration
 * POST   — Create a new radar (from prompt or explicit topics/sources)
 * PATCH  — Update an existing radar by radarId
 */

import { getActiveRadar, createRadar, updateRadar } from "@/lib/radar/store"
import { defaultSourcesForTopics } from "@/lib/radar/default-sources"
import { isLocalRequest } from "@/lib/local-guard"

function getStateDir(): string {
  return process.env.RADAR_STATE_DIR || process.env.BRAIN_ROOT || "state"
}

export async function GET(_request: Request): Promise<Response> {
  const stateDir = getStateDir()
  const radar = await getActiveRadar(stateDir)

  if (!radar) {
    return Response.json({ error: "No radar configured" }, { status: 404 })
  }

  return Response.json(radar)
}

export async function POST(request: Request): Promise<Response> {
  if (!(await isLocalRequest(request))) {
    return Response.json({ error: "Forbidden" }, { status: 403 })
  }

  try {
    const body = await request.json()
    const { prompt, topics, sources, schedule, channels } = body

    const stateDir = getStateDir()

    let radarTopics = topics
    let radarSources = sources

    if (prompt && !topics) {
      // For MVP, create a simple topic from the prompt
      // Full brain inference requires BrainStore + LLM which may not be available
      radarTopics = [
        {
          name: prompt.slice(0, 50),
          description: prompt,
          weight: 0.8,
          origin: "user" as const,
        },
      ]
    }

    if (!radarSources) {
      radarSources = defaultSourcesForTopics(radarTopics)
    }

    const radar = await createRadar(stateDir, {
      topics: radarTopics,
      sources: radarSources,
      schedule,
      channels,
    })

    return Response.json(radar, { status: 201 })
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error"
    return Response.json({ error: message }, { status: 500 })
  }
}

export async function PATCH(request: Request): Promise<Response> {
  if (!(await isLocalRequest(request))) {
    return Response.json({ error: "Forbidden" }, { status: 403 })
  }

  try {
    const body = await request.json()
    const { radarId, ...updates } = body

    if (!radarId) {
      return Response.json({ error: "radarId is required" }, { status: 400 })
    }

    const stateDir = getStateDir()
    const updated = await updateRadar(stateDir, radarId, updates)

    return Response.json(updated)
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error"
    return Response.json({ error: message }, { status: 500 })
  }
}
