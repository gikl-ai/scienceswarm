import path from "node:path";
import { extractPdfText, isPdfExtractError } from "@/lib/pdf-text-extractor";
import { isLocalRequest } from "@/lib/local-guard";
import { getScienceSwarmProjectsRoot } from "@/lib/scienceswarm-paths";
import { assertSafeProjectSlug, InvalidSlugError } from "@/lib/state/project-manifests";

// ---------------------------------------------------------------------------
// POST /api/pdf-extract
//
// Body: { studyId: string, path: string }
//   - studyId: safe-slug validated study id (lowercase alnum + hyphen).
//   - path: POSIX/relative path inside the study root (e.g. "papers/foo.pdf").
//
// Security: the request-supplied `path` is resolved against the project
// root and checked with a prefix guard so `..` traversal cannot escape.
// This mirrors the pattern used in `/api/workspace`'s handleGetMeta /
// handleUpdateMeta branches.
// ---------------------------------------------------------------------------

interface PdfExtractBody {
  study?: unknown;
  studyId?: unknown;
  studySlug?: unknown;
  projectId?: unknown;
  path?: unknown;
}

function readStudyScopedId(body: PdfExtractBody): string | null {
  const value = body.studyId ?? body.studySlug ?? body.study ?? body.projectId;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export async function POST(request: Request): Promise<Response> {
  if (!(await isLocalRequest(request))) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: PdfExtractBody;
  try {
    body = (await request.json()) as PdfExtractBody;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const projectId = readStudyScopedId(body);
  const { path: relativePath } = body;
  if (!projectId) {
    return Response.json({ error: "studyId is required" }, { status: 400 });
  }
  if (typeof relativePath !== "string" || relativePath.length === 0) {
    return Response.json({ error: "path is required" }, { status: 400 });
  }

  let safeSlug: string;
  try {
    safeSlug = assertSafeProjectSlug(projectId);
  } catch (err) {
    if (err instanceof InvalidSlugError) {
      return Response.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }

  const projectRoot = path.join(getScienceSwarmProjectsRoot(), safeSlug);
  const resolvedPath = path.resolve(projectRoot, relativePath);
  // Prefix check uses `root + path.sep` so a sibling directory whose name
  // starts with the project slug cannot slip through (e.g. "foo-project"
  // must not match against "foo").
  if (
    resolvedPath === projectRoot ||
    !resolvedPath.startsWith(projectRoot + path.sep)
  ) {
    return Response.json({ error: "Invalid file path" }, { status: 400 });
  }

  try {
    const result = await extractPdfText(resolvedPath);
    return Response.json(result);
  } catch (err) {
    if (isPdfExtractError(err)) {
      if (err.code === "not_found") {
        return Response.json({ error: err.message }, { status: 404 });
      }
      if (err.code === "invalid_pdf") {
        return Response.json({ error: err.message }, { status: 400 });
      }
    }
    return Response.json({ error: "PDF extract error" }, { status: 500 });
  }
}
