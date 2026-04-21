/**
 * POST /api/brain/program-brief
 *
 * Program-level briefing for team projects.
 * Body: { projects: string[] }
 */

import { buildProgramBrief } from "@/brain/research-briefing";
import { getBrainConfig, getLLMClient, isErrorResponse } from "../_shared";

export async function POST(request: Request) {
  const configOrError = getBrainConfig();
  if (isErrorResponse(configOrError)) return configOrError;
  const config = configOrError;
  const llm = getLLMClient(config);

  let body: { projects?: string[] };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const projects = body.projects;
  if (!projects || !Array.isArray(projects) || projects.length === 0) {
    return Response.json(
      { error: "Missing or empty projects array" },
      { status: 400 },
    );
  }

  try {
    const brief = await buildProgramBrief(config, llm, projects);
    return Response.json(brief);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Program brief generation failed";
    return Response.json({ error: message }, { status: 500 });
  }
}
