import path from "node:path";

import { detectDuplicatePapers } from "@/lib/paper-dedupe";
import { getScienceSwarmProjectsRoot } from "@/lib/scienceswarm-paths";
import {
  assertSafeProjectSlug,
  InvalidSlugError,
} from "@/lib/state/project-manifests";

type RouteContext = { params: Promise<{ projectId: string }> };

export async function GET(
  _request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const { projectId } = await context.params;
    const slug = assertSafeProjectSlug(projectId);
    const papersRoot = path.join(getScienceSwarmProjectsRoot(), slug, "papers");
    const result = await detectDuplicatePapers(papersRoot);
    return Response.json(result);
  } catch (err) {
    if (err instanceof InvalidSlugError) {
      return Response.json({ error: err.message }, { status: 400 });
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    return Response.json({ error: message }, { status: 500 });
  }
}
