/**
 * GET/POST /api/radar/briefing
 *
 * GET  — Return the latest cached briefing from disk
 * POST — Run the radar pipeline and return a fresh briefing
 *        Body: { format?: "dashboard" | "telegram" }
 */

import type { BrainStore } from "@/brain/store"
import { ensureBrainStoreReady } from "@/brain/store"

import { isLocalRequest } from "@/lib/local-guard"
import { getActiveRadar } from "@/lib/radar/store"
import { runRadarPipeline } from "@/lib/radar/pipeline"
import { buildProductionFetchers } from "@/lib/radar/fetchers/index"
import { getRadarStateDir } from "@/lib/radar/state-dir"

export async function GET(): Promise<Response> {
  const stateDir = getRadarStateDir()

  try {
    const { readFile } = await import("fs/promises")
    const { join } = await import("path")
    const data = await readFile(
      join(stateDir, "radar", "latest-briefing.json"),
      "utf-8"
    )
    return Response.json(JSON.parse(data))
  } catch (error) {
    if (typeof error === "object" && error && "code" in error && error.code === "ENOENT") {
      return Response.json(null)
    }

    console.error("GET /api/radar/briefing failed", error)
    return Response.json(
      { error: "Failed to load briefing." },
      { status: 500 }
    )
  }
}

export async function POST(request: Request): Promise<Response> {
  if (!(await isLocalRequest(request))) {
    return Response.json({ error: "Forbidden" }, { status: 403 })
  }

  try {
    const stateDir = getRadarStateDir()
    const radar = await getActiveRadar(stateDir)

    if (!radar) {
      return Response.json({ error: "No radar configured" }, { status: 404 })
    }

    // Brain store and LLM are needed for the pipeline.
    // Import dynamically to avoid startup failures when not configured.
    let brainStore: BrainStore
    let radarLLM: { generate(prompt: string): Promise<string> }

    try {
      const shared = await import("../../brain/_shared")
      const configOrError = shared.getBrainConfig()
      if (shared.isErrorResponse(configOrError)) {
        return configOrError
      }
      const config = configOrError
      const brainLLM = shared.getLLMClient(config)
      // Adapt brain LLMClient.complete() to radar's generate() interface
      radarLLM = {
        async generate(prompt: string): Promise<string> {
          const response = await brainLLM.complete({
            system: "You are a research assistant.",
            user: prompt,
          })
          return response.content
        },
      }
      const { getBrainStore } = await import("@/brain/store")
      await ensureBrainStoreReady()
      brainStore = getBrainStore()
    } catch {
      return Response.json(
        { error: "Brain store not configured. Set BRAIN_ROOT and LLM env vars." },
        { status: 503 }
      )
    }

    const fetchers = buildProductionFetchers()

    const result = await runRadarPipeline({
      stateDir,
      radarId: radar.id,
      fetchers,
      brainStore,
      llm: radarLLM,
    })

    if (!result) {
      return Response.json({ error: "Pipeline returned no result" }, { status: 500 })
    }

    // Cache the latest briefing to disk
    const { writeFile, mkdir } = await import("fs/promises")
    const { join } = await import("path")
    const radarDir = join(stateDir, "radar")
    await mkdir(radarDir, { recursive: true })
    await writeFile(
      join(radarDir, "latest-briefing.json"),
      JSON.stringify(result.dashboard, null, 2)
    )

    const body = await request.clone().json().catch(() => ({})) as Record<string, unknown>
    const format = (body.format as string) ?? "dashboard"

    if (format === "telegram") {
      return Response.json({ text: result.telegram })
    }

    return Response.json(result.dashboard)
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error"
    return Response.json({ error: message }, { status: 500 })
  }
}
