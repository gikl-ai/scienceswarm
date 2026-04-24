/**
 * GET /api/brain/list?project=<slug>
 *
 * Returns an array of gbrain pages scoped to a project. Each entry
 * contains the page slug, title, type, and frontmatter so the FileTree
 * and other dashboard surfaces can render project artifacts without
 * fetching each page individually.
 *
 * The route lists all pages from the brain store and filters by the
 * `project` field in each page's frontmatter. This is a read-only
 * endpoint with no auth requirement for user-facing reads.
 */

import {
  getBrainStore,
  ensureBrainStoreReady,
  isBrainBackendUnavailableError,
} from "@/brain/store";
import { displayTitleForBrainPage } from "@/brain/page-title";
import { listProjectPageSummariesFast } from "@/lib/gbrain/project-query-fast-path";

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const project = url.searchParams.get("project");
  if (!project || typeof project !== "string" || project.trim().length === 0) {
    return Response.json(
      { error: "Missing required query parameter: project" },
      { status: 400 },
    );
  }

  try {
    const trimmedProject = project.trim();
    const fastPages = await listProjectPageSummariesFast(trimmedProject);

    let projectSummaries;
    if (fastPages) {
      // `listProjectPageSummariesFast` already filtered by project in SQL.
      projectSummaries = fastPages;
    } else {
      await ensureBrainStoreReady();
      const allPages = await getBrainStore().listPages({ limit: 5000 });
      projectSummaries = allPages.filter((page) => {
        const fm = page.frontmatter ?? {};
        return fm.project === trimmedProject
          || (Array.isArray(fm.projects) && fm.projects.includes(trimmedProject));
      });
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
