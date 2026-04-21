/**
 * GET /api/brain/guide
 *
 * Daily briefing: recent events, active experiments, suggestions.
 * Query param: ?focus=CRISPR (optional)
 */

import { buildGuideBriefing } from "@/brain/briefing";
import { getBrainConfig, isErrorResponse } from "../_shared";

export async function GET(request: Request) {
  const configOrError = getBrainConfig();
  if (isErrorResponse(configOrError)) return configOrError;
  const config = configOrError;

  const url = new URL(request.url);
  const focus = url.searchParams.get("focus") ?? undefined;

  try {
    return Response.json(await buildGuideBriefing(config, focus));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Guide generation failed";
    return Response.json({ error: message }, { status: 500 });
  }
}
