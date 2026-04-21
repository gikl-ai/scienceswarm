/**
 * Briefing Action API — Execute quick-reply actions from briefing buttons.
 *
 * POST /api/brain/briefing-action
 *   { action: BriefingAction } -> executes and returns confirmation
 */

import { loadBrainConfig } from "@/brain/config";
import { createLLMClient } from "@/brain/llm";
import { handleBriefingAction } from "@/brain/briefing-actions";
import type { BriefingAction } from "@/brain/briefing-actions";

const VALID_TYPES = new Set([
  "save-paper",
  "create-task",
  "show-evidence",
  "dismiss-item",
  "expand-item",
  "ingest-paper",
]);

function validateAction(action: unknown): action is BriefingAction {
  if (!action || typeof action !== "object") return false;
  const a = action as Record<string, unknown>;
  if (typeof a.type !== "string" || !VALID_TYPES.has(a.type)) return false;
  return true;
}

export async function POST(request: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json(
      { error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const action = body.action;
  if (!validateAction(action)) {
    return Response.json(
      { error: "Invalid or missing action. Expected: { action: { type: '...', ... } }" },
      { status: 400 },
    );
  }

  const config = loadBrainConfig();
  if (!config) {
    return Response.json(
      { error: "Brain is not configured. Run brain setup first." },
      { status: 503 },
    );
  }

  const llm = createLLMClient(config);

  try {
    const message = await handleBriefingAction(config, llm, action);
    return Response.json({ ok: true, message });
  } catch (err) {
    return Response.json(
      {
        error: `Action failed: ${err instanceof Error ? err.message : String(err)}`,
      },
      { status: 500 },
    );
  }
}
