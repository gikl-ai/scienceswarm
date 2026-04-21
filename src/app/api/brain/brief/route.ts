/**
 * GET /api/brain/brief
 *
 * Project-aware briefing route.
 * Query param: ?project=<slug>
 */

import { buildProjectBrief } from "@/brain/briefing";
import { getBrainConfig, isErrorResponse } from "../_shared";
import { assertSafeProjectSlug } from "@/lib/state/project-manifests";

export async function GET(request: Request) {
  const configOrError = getBrainConfig();
  if (isErrorResponse(configOrError)) return configOrError;
  const config = configOrError;

  const url = new URL(request.url);
  const project = url.searchParams.get("project");
  if (!project) {
    return Response.json({ error: "Missing project parameter" }, { status: 400 });
  }

  try {
    assertSafeProjectSlug(project);
  } catch {
    return Response.json({ error: "project must be a safe bare slug" }, { status: 400 });
  }

  try {
    const brief = await buildProjectBrief({ config, project });
    return Response.json(brief);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Brief generation failed";
    return Response.json({ error: message }, { status: 500 });
  }
}
