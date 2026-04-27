/**
 * GET /api/brain/list?study=<slug>
 *
 * Returns an array of gbrain pages scoped to a study. Each entry
 * contains the page slug, title, type, and frontmatter so the FileTree
 * and other dashboard surfaces can render study artifacts without
 * fetching each page individually.
 *
 * The route lists all pages from the brain store and filters by
 * Study-aware frontmatter aliases. This is a read-only
 * endpoint with no auth requirement for user-facing reads.
 */

import {
  getBrainStore,
  ensureBrainStoreReady,
  isBrainBackendUnavailableError,
} from "@/brain/store";
import { displayTitleForBrainPage } from "@/brain/page-title";
import { listProjectPageSummariesFast } from "@/lib/gbrain/project-query-fast-path";
import { frontmatterMatchesStudy } from "@/lib/studies/frontmatter";

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const study = url.searchParams.get("study") || url.searchParams.get("project");
  if (!study || typeof study !== "string" || study.trim().length === 0) {
    return Response.json(
      { error: "Missing required query parameter: study" },
      { status: 400 },
    );
  }

  try {
    const trimmedStudy = study.trim();
    const fastPages = await listProjectPageSummariesFast(trimmedStudy);

    let projectSummaries;
    if (fastPages) {
      // `listProjectPageSummariesFast` already filtered by study in SQL.
      projectSummaries = fastPages;
    } else {
      await ensureBrainStoreReady();
      const allPages = await getBrainStore().listPages({ limit: 5000 });
      projectSummaries = allPages.filter((page) =>
        frontmatterMatchesStudy(page.frontmatter, trimmedStudy),
      );
    }

    const projectPages = projectSummaries
      .map((page) => ({
        slug: page.path,
        title: displayTitleForBrainPage({
          title: page.title,
          path: page.path,
          frontmatter: page.frontmatter ?? {},
        }),
        type: (page.frontmatter?.type as string) ?? page.type,
        frontmatter: page.frontmatter ?? {},
      }));

    return Response.json(projectPages);
  } catch (error) {
    if (isBrainBackendUnavailableError(error)) {
      console.warn(
        "GET /api/brain/list degraded:",
        error instanceof Error ? error.message : String(error),
      );
      return Response.json([], {
        status: 200,
        headers: {
          "x-scienceswarm-degraded": "brain_backend_unavailable",
        },
      });
    }

    console.error(
      "GET /api/brain/list failed:",
      error instanceof Error ? error.message : String(error),
    );
    return Response.json(
      { error: "Failed to list brain pages" },
      { status: 500 },
    );
  }
}
