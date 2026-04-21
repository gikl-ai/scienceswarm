/**
 * POST /api/radar/feedback
 *
 * Record user feedback on a radar signal and optionally apply it to tune
 * topic weights for the active radar.
 *
 * Body: {
 *   briefingId: string
 *   signalId:   string
 *   action:     string          // e.g. "save" | "dismiss" | "share"
 *   matchedTopics?: string[]    // topic names to apply weight adjustments to
 * }
 */

import { getActiveRadar } from "@/lib/radar/store"
import { recordFeedback, applyFeedbackToRadar } from "@/lib/radar/learn"

function getStateDir(): string {
  return process.env.RADAR_STATE_DIR || process.env.BRAIN_ROOT || "state"
}

export async function POST(request: Request): Promise<Response> {
  try {
    const body = await request.json()
    const { briefingId, signalId, action, matchedTopics } = body

    if (!briefingId || !signalId || !action) {
      return Response.json(
        { error: "briefingId, signalId, and action are required" },
        { status: 400 }
      )
    }

    const stateDir = getStateDir()
    const radar = await getActiveRadar(stateDir)

    if (!radar) {
      return Response.json({ error: "No radar configured" }, { status: 404 })
    }

    const feedback = {
      briefingId,
      signalId,
      action,
      timestamp: new Date().toISOString(),
    }

    await recordFeedback(stateDir, feedback)

    if (matchedTopics && matchedTopics.length > 0) {
      await applyFeedbackToRadar(
        stateDir,
        radar.id,
        feedback,
        matchedTopics
      )
    }

    return Response.json({ ok: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error"
    return Response.json({ error: message }, { status: 500 })
  }
}
