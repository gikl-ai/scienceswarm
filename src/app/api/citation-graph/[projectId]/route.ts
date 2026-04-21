/**
 * GET /api/citation-graph/[projectId]
 *
 * Builds a citation graph for the project's papers/ folder. The slug is
 * validated through assertSafeProjectSlug — bad slugs return 400.
 *
 * Missing project directory or missing papers/ subdirectory both return a
 * 200 with an empty graph (same shape as a real response, just empty). The
 * underlying lib walks the filesystem directly; see
 * `src/lib/citation-graph.ts` for the reference-extraction behaviour.
 */

import path from "node:path";
import { buildCitationGraph, type CitationGraph } from "@/lib/citation-graph";
import { getScienceSwarmProjectsRoot } from "@/lib/scienceswarm-paths";
import {
  assertSafeProjectSlug,
  InvalidSlugError,
} from "@/lib/state/project-manifests";

export async function GET(
  _request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    const { projectId } = await context.params;
    const slug = assertSafeProjectSlug(projectId);
    const papersRoot = path.join(
      getScienceSwarmProjectsRoot(),
      slug,
      "papers",
    );
    // buildCitationGraph already returns an empty graph when the root is
    // missing, so we don't need to stat() ahead of time.
    const graph: CitationGraph = await buildCitationGraph(papersRoot);
    return Response.json(graph);
  } catch (err) {
    if (err instanceof InvalidSlugError) {
      return Response.json(
        { error: "Invalid project slug" },
        { status: 400 },
      );
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    return Response.json({ error: message }, { status: 500 });
  }
}
