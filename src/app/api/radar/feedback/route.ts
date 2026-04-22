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
import {
  recordFeedback,
  applyFeedbackToRadar,
  saveRadarMatchToBrain,
} from "@/lib/radar/learn"
import { isLocalRequest } from "@/lib/local-guard"
import type { RadarFeedback } from "@/lib/radar/types"

function getStateDir(): string {
  return process.env.RADAR_STATE_DIR || process.env.BRAIN_ROOT || "state"
}

function normalizeAction(action: unknown): RadarFeedback["action"] | null {
  if (action === "save") return "save-to-brain"
  if (
    action === "save-to-brain" ||
    action === "dismiss" ||
    action === "expand" ||
    action === "more-like-this" ||
    action === "less-like-this"
  ) {
    return action
  }
  return null
}

function messageForAction(
  action: RadarFeedback["action"],
  savedPath?: string
): string {
  if (action === "save-to-brain") {
    return savedPath
      ? `Saved this frontier match to brain memory at ${savedPath}.`
      : "Saved this frontier match to brain memory."
  }
  if (action === "dismiss" || action === "less-like-this") {
    return "Feedback recorded. Future radar matches will down-weight signals like this."
  }
  if (action === "more-like-this") {
    return "Feedback recorded. Future radar matches will look for more signals like this."
  }
  return "Feedback recorded for future radar matching."
}

export async function POST(request: Request): Promise<Response> {
  if (!(await isLocalRequest(request))) {
    return Response.json({ error: "Forbidden" }, { status: 403 })
  }

  try {
    const body = await request.json()
    const { briefingId, signalId, action, matchedTopics } = body
    const normalizedAction = normalizeAction(action)

    if (!briefingId || !signalId || !normalizedAction) {
      return Response.json(
        { error: "briefingId, signalId, and a supported action are required" },
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
      action: normalizedAction,
      timestamp: new Date().toISOString(),
    } satisfies RadarFeedback

    await recordFeedback(stateDir, feedback)

    if (matchedTopics && matchedTopics.length > 0) {
      await applyFeedbackToRadar(
        stateDir,
        radar.id,
        feedback,
        matchedTopics
      )
    }

    const saved = normalizedAction === "save-to-brain"
      ? await saveRadarMatchToBrain(stateDir, {
          briefingId,
          signalId,
          savedAt: feedback.timestamp,
        })
      : null

    return Response.json({
      ok: true,
      message: messageForAction(normalizedAction, saved?.savedPath),
      savedPath: saved?.savedPath,
      preferenceApplied: Boolean(matchedTopics && matchedTopics.length > 0),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error"
    return Response.json({ error: message }, { status: 500 })
  }
}
