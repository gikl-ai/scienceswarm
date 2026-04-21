import fs from "node:fs";
import { buildBacklinkGraph } from "@/lib/backlinks";
import { assertSafeProjectSlug, InvalidSlugError } from "@/lib/state/project-manifests";
import { getProjectBrainPagePath, getProjectBrainWikiDir, migrateLegacyProjectWiki } from "@/lib/state/project-storage";

// ---------------------------------------------------------------------------
// GET /api/backlinks/[projectId]
//
// Scans <brain-root>/wiki/projects/<slug> for .md files and returns the
// backlink graph ({forward, backward, brokenLinks}).
//
// - Invalid slug → 400 via InvalidSlugError
// - Missing project dir → 200 with empty graph (buildBacklinkGraph tolerates
//   a missing root so fresh projects with no wiki yet still 200).
// ---------------------------------------------------------------------------

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  try {
    const { projectId } = await params;
    const slug = assertSafeProjectSlug(projectId);
    await migrateLegacyProjectWiki(slug);
    const projectWikiDir = getProjectBrainWikiDir(slug);
    const projectWikiRoot = fs.existsSync(projectWikiDir)
      ? projectWikiDir
      : getProjectBrainPagePath(slug);
    const graph = await buildBacklinkGraph(projectWikiRoot);
    return Response.json(graph);
  } catch (err) {
    if (err instanceof InvalidSlugError) {
      return Response.json({ error: err.message }, { status: 400 });
    }
    return Response.json({ error: "Backlinks error" }, { status: 500 });
  }
}
