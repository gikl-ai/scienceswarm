import path from "node:path";
import { getScienceSwarmProjectsRoot } from "@/lib/scienceswarm-paths";
import { generateProjectReadme } from "@/lib/project-readme-gen";
import {
  InvalidSlugError,
  assertSafeProjectSlug,
} from "@/lib/state/project-manifests";

/**
 * GET /api/projects/[slug]/readme
 *
 * Returns a rendered markdown README (plus its component sections and raw
 * file counts) for the given project. Optional query params `title` and
 * `description` override the defaults derived from the slug / absent
 * description. Missing project roots intentionally return a 200 with an
 * empty-state README so dashboards can render a consistent shape.
 */
export async function GET(
  request: Request,
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
    const url = new URL(request.url);
    const titleOverride = url.searchParams.get("title") ?? undefined;
    const descriptionOverride = url.searchParams.get("description") ?? undefined;

    const projectRoot = path.join(getScienceSwarmProjectsRoot(), slug);
    const result = await generateProjectReadme({
      slug,
      title: titleOverride,
      description: descriptionOverride,
      projectRoot,
    });

    return Response.json(result);
  } catch (err) {
    console.error("GET /api/projects/[slug]/readme failed", err);
    return Response.json(
      { error: "Failed to generate project README." },
      { status: 500 },
    );
  }
}
