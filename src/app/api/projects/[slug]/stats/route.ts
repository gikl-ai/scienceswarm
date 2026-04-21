import path from "node:path";
import { getScienceSwarmProjectsRoot } from "@/lib/scienceswarm-paths";
import { computeProjectStats } from "@/lib/project-stats";
import {
  InvalidSlugError,
  assertSafeProjectSlug,
} from "@/lib/state/project-manifests";

/**
 * GET /api/projects/[slug]/stats
 *
 * Returns a {@link import("@/lib/project-stats").ProjectStats} snapshot for
 * the given project. Missing projects intentionally return 200 with zeroed
 * stats so dashboards can render a consistent shape.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ slug: string }> },
) {
  const { slug: rawSlug } = await context.params;

  let slug: string;
  try {
    slug = assertSafeProjectSlug(rawSlug);
  } catch (err) {
    if (err instanceof InvalidSlugError) {
      return Response.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }

  try {
    const projectRoot = path.join(getScienceSwarmProjectsRoot(), slug);
    const stats = await computeProjectStats(projectRoot, slug);
    return Response.json(stats);
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}
