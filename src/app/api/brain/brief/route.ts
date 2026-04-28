/**
 * GET /api/brain/brief
 *
 * Study-aware briefing route.
 * Query param: ?study=<slug>
 */

import { buildProjectBrief } from "@/brain/briefing";
import { getBrainConfig, isErrorResponse } from "../_shared";
import { assertSafeProjectSlug } from "@/lib/state/project-manifests";

export async function GET(request: Request) {
  const configOrError = getBrainConfig();
  if (isErrorResponse(configOrError)) return configOrError;
  const config = configOrError;

  const url = new URL(request.url);
  const study = url.searchParams.get("study") || url.searchParams.get("project");
  if (!study) {
    return Response.json({ error: "Missing study parameter" }, { status: 400 });
  }

  try {
    assertSafeProjectSlug(study);
  } catch {
    return Response.json({ error: "study must be a safe bare slug" }, { status: 400 });
  }

  try {
    const brief = await buildProjectBrief({ config, project: study });
    return Response.json(brief);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Brief generation failed";
    return Response.json({ error: message }, { status: 500 });
  }
}
