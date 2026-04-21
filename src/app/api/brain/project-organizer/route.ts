import { buildProjectOrganizerReadout } from "@/brain/project-organizer";
import {
  assertSafeProjectSlug,
  InvalidSlugError,
} from "@/lib/state/project-manifests";
import { getBrainConfig, isErrorResponse } from "../_shared";

export async function GET(request: Request): Promise<Response> {
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
  } catch (error) {
    if (!(error instanceof InvalidSlugError)) {
      throw error;
    }
    return Response.json({ error: "project must be a safe bare slug" }, { status: 400 });
  }

  try {
    const readout = await buildProjectOrganizerReadout({ config, project });
    return Response.json(readout);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Project organizer failed";
    return Response.json({ error: message }, { status: 500 });
  }
}
