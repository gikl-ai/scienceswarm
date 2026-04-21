/**
 * POST /api/brain/detect
 *
 * Entity detection API. Runs science entity detection on a message
 * and returns detected entities, originals, and chat context.
 *
 * Body: { message: string, project?: string }
 * Returns: { detection: EntityDetectionResult, context: ChatEntityContext }
 */

import { detectEntities } from "@/brain/entity-detector";
import { onChatMessage } from "@/brain/chat-entity-hook";
import { getBrainConfig, getLLMClient, isErrorResponse } from "../_shared";

export async function POST(request: Request) {
  const configOrError = getBrainConfig();
  if (isErrorResponse(configOrError)) return configOrError;
  const config = configOrError;

  let body: { message?: string; project?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const { message, project } = body;

  if (!message || typeof message !== "string") {
    return Response.json(
      { error: "Missing required field: message (string)" },
      { status: 400 }
    );
  }

  try {
    // Fast detection (always runs)
    const detection = await detectEntities(message, { fast: true });

    // Chat entity hook (enriches with brain context)
    const llm = getLLMClient(config);
    const context = await onChatMessage(config, llm, message, { project });

    return Response.json({ detection, context });
  } catch (err) {
    const errorMessage =
      err instanceof Error ? err.message : "Entity detection failed";
    return Response.json({ error: errorMessage }, { status: 500 });
  }
}
