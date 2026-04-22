import { isLocalRequest } from "@/lib/local-guard";
import { assertSafeProjectSlug } from "@/lib/state/project-manifests";
import { buildAndPersistNextExperimentPlan } from "@/brain/next-experiment-planner";
import { getBrainConfig, getLLMClient, isErrorResponse } from "../_shared";

export async function POST(request: Request): Promise<Response> {
  if (!(await isLocalRequest(request))) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const configOrError = getBrainConfig();
  if (isErrorResponse(configOrError)) return configOrError;
  const config = configOrError;
  const llm = getLLMClient(config);

  let body: {
    project?: string;
    prompt?: string;
    previousPlanSlug?: string | null;
    focusBrainSlug?: string | null;
  };

  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== "object") {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    body = parsed as typeof body;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const project = body.project?.trim();
  const prompt = body.prompt?.trim();

  if (!project) {
    return Response.json({ error: "project is required" }, { status: 400 });
  }
  if (!prompt) {
    return Response.json({ error: "prompt is required" }, { status: 400 });
  }

  try {
    assertSafeProjectSlug(project);
  } catch {
    return Response.json({ error: "project must be a safe bare slug" }, { status: 400 });
  }

  try {
    const result = await buildAndPersistNextExperimentPlan({
      config,
      llm,
      project,
      prompt,
      previousPlanSlug: body.previousPlanSlug ?? null,
      focusBrainSlug: body.focusBrainSlug ?? null,
    });
    return Response.json(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Next experiment planning failed";
    return Response.json({ error: message }, { status: 500 });
  }
}
