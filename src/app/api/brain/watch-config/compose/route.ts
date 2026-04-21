import { getBrainConfig, isErrorResponse } from "../../_shared";
import { ensureProjectManifest, assertSafeProjectSlug } from "@/lib/state/project-manifests";
import { getProjectStateRootForBrainRoot } from "@/lib/state/project-storage";
import { compileWatchPlan } from "@/lib/watch/compose";

interface ComposeBody {
  project?: string;
  objective?: string;
  timezone?: string;
}

export async function POST(request: Request): Promise<Response> {
  const configOrError = getBrainConfig();
  if (isErrorResponse(configOrError)) return configOrError;

  let body: ComposeBody;
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== "object") {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    body = parsed as ComposeBody;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof body.objective !== "string" || !body.objective.trim()) {
    return Response.json({ error: "Missing objective field" }, { status: 400 });
  }

  if (body.timezone !== undefined && typeof body.timezone !== "string") {
    return Response.json({ error: "timezone must be a string" }, { status: 400 });
  }

  let projectTitle: string | undefined;
  if (typeof body.project === "string" && body.project.trim()) {
    let project: string;
    try {
      project = assertSafeProjectSlug(body.project.trim());
    } catch {
      return Response.json({ error: "project must be a safe bare slug" }, { status: 400 });
    }

    const manifest = await ensureProjectManifest(
      project,
      getProjectStateRootForBrainRoot(project, configOrError.root),
    );
    if (!manifest) {
      return Response.json({ error: `Project ${project} was not found in brain state.` }, { status: 404 });
    }
    projectTitle = manifest.title;
  }

  const plan = await compileWatchPlan({
    objective: body.objective,
    projectTitle,
    timezone: body.timezone?.trim() || undefined,
  });

  return Response.json({ plan });
}
