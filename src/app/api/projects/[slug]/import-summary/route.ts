import { resolveBrainRoot } from "@/brain/config";
import { getScienceSwarmBrainRoot } from "@/lib/scienceswarm-paths";
import {
  InvalidSlugError,
  assertSafeProjectSlug,
} from "@/lib/state/project-manifests";
import { readProjectImportSummary } from "@/lib/state/project-import-summary";
import { getProjectStateRootForBrainRoot } from "@/lib/state/project-storage";

/**
 * GET /api/projects/[slug]/import-summary
 *
 * Returns the latest local-only import summary for the project. Missing
 * summaries intentionally return `200` with `lastImport: null` so the
 * dashboard can render a consistent shape after reload.
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
    const brainRoot = resolveBrainRoot() ?? getScienceSwarmBrainRoot();
    const preferredStateRoot = getProjectStateRootForBrainRoot(slug, brainRoot);
    const legacyStateRoot = `${brainRoot}/state`;
    const summary = await readProjectImportSummary(slug, preferredStateRoot)
      ?? (legacyStateRoot !== preferredStateRoot
        ? await readProjectImportSummary(slug, legacyStateRoot)
        : null);
    return Response.json({
      project: slug,
      lastImport: summary?.lastImport ?? null,
    });
  } catch {
    return Response.json({ error: "Failed to read import summary" }, { status: 500 });
  }
}
