import path from "node:path";
import { getScienceSwarmProjectsRoot } from "@/lib/scienceswarm-paths";
import { assertSafeProjectSlug, InvalidSlugError } from "@/lib/state/project-manifests";
import { generateLiteratureReview } from "@/lib/lit-review";
import {
  LiteratureReviewSummarizerUnavailableError,
  summarizeLiteratureReview,
} from "@/lib/lit-review-summarizer";

// ---------------------------------------------------------------------------
// GET /api/lit-review/[projectId]?groupBy=tag|year|none
//
// Reads the project paper metadata, then asks the active LLM backend for a
// concise review summary. Slug validated via assertSafeProjectSlug; unknown
// slugs return an empty review rather than 404 so the UI can render a
// "no papers yet" state.
// ---------------------------------------------------------------------------

type GroupBy = "tag" | "year" | "none";

function parseGroupBy(raw: string | null): GroupBy {
  if (raw === "year" || raw === "none" || raw === "tag") return raw;
  // Unknown / missing → default to "tag". Documented: invalid values fall
  // back to the default rather than returning 400, because the UI may pass
  // a saved preference that's no longer supported.
  return "tag";
}

export async function GET(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    const { projectId } = await context.params;
    const safeSlug = assertSafeProjectSlug(projectId);

    const url = new URL(request.url);
    const groupBy = parseGroupBy(url.searchParams.get("groupBy"));

    const papersRoot = path.join(getScienceSwarmProjectsRoot(), safeSlug, "papers");
    const review = await generateLiteratureReview({
      papersRoot,
      groupBy,
      summarizer: summarizeLiteratureReview,
    });

    return Response.json({ review });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Literature review error";
    const status =
      err instanceof InvalidSlugError
        ? 400
        : err instanceof LiteratureReviewSummarizerUnavailableError
          ? 503
          : 500;
    return Response.json({ error: message }, { status });
  }
}
