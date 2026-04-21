import {
  assertSafeProjectSlug,
  InvalidSlugError,
} from "@/lib/state/project-manifests";
import { scanProjectTodos } from "@/lib/md-todo-extractor";
import { getProjectBrainWikiDir, migrateLegacyProjectWiki } from "@/lib/state/project-storage";

// GET /api/todos/[projectId]
//
// Recursively scans ~/.scienceswarm/projects/<slug>/.brain/wiki/projects/<slug>/ for markdown
// TODO items ("- [ ]" / "- [x]") and returns them in source order. Missing
// directories return an empty result. Slugs are validated with
// assertSafeProjectSlug to reject path-traversal and malformed inputs.
export async function GET(
  _request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    const { projectId } = await context.params;
    const safeSlug = assertSafeProjectSlug(projectId);
    await migrateLegacyProjectWiki(safeSlug);
    const projectRoot = getProjectBrainWikiDir(safeSlug);
    const result = await scanProjectTodos(projectRoot);
    return Response.json(result);
  } catch (err) {
    // InvalidSlugError is client input (path traversal, uppercase, etc.) —
    // surface it as 400 with its message so callers can correct the request.
    // Any other error is treated as 500 with a generic message so internal
    // details (stack traces, absolute paths, underlying syscall errors) are
    // not leaked to API consumers.
    if (err instanceof InvalidSlugError) {
      return Response.json({ error: err.message }, { status: 400 });
    }
    console.error("[api/todos] scan failed", err);
    return Response.json({ error: "Todo scan failed" }, { status: 500 });
  }
}
