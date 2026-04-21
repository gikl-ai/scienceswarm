import * as fs from "node:fs/promises";
import {
  assertSafeProjectSlug,
  InvalidSlugError,
} from "@/lib/state/project-manifests";
import { scanProjectResearchQuestions } from "@/lib/research-questions";
import {
  getProjectBrainPagePath,
  getProjectBrainWikiDir,
  migrateLegacyProjectWiki,
} from "@/lib/state/project-storage";

interface RouteContext {
  params: Promise<{ projectId: string }>;
}

export async function GET(
  _request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const { projectId } = await context.params;
    const slug = assertSafeProjectSlug(projectId);
    await migrateLegacyProjectWiki(slug);
    const projectWikiDir = getProjectBrainWikiDir(slug);
    const projectWikiPage = getProjectBrainPagePath(slug);

    let scanRoot = projectWikiDir;
    try {
      const stat = await fs.stat(projectWikiDir);
      if (!stat.isDirectory()) {
        scanRoot = projectWikiPage;
      }
    } catch {
      scanRoot = projectWikiPage;
    }

    const scan = await scanProjectResearchQuestions(scanRoot);
    return Response.json(scan);
  } catch (error) {
    if (error instanceof InvalidSlugError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    const message =
      error instanceof Error
        ? error.message
        : "Failed to scan research questions";
    return Response.json({ error: message }, { status: 500 });
  }
}
