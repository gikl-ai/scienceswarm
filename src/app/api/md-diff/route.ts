// POST /api/md-diff
//
// Wraps `diffMarkdown` from @/lib/md-diff. Input validation rejects
// missing or non-string `old` / `new` fields with a 400. Unexpected
// throws surface as a 500 with `{ error }`. Follows the project's
// api-routes rule: always return `Response.json()` or `new Response()`,
// never `NextResponse`.

import { diffMarkdown } from "@/lib/md-diff";
import { isLocalRequest } from "@/lib/local-guard";

// Upper bound on per-field input size. `diffMarkdown` uses a classic LCS
// dynamic-program with O(n*m) time and memory (allocated as a single
// Int32Array of size (n+1)*(m+1)). Two fully-disjoint 500 000-char
// documents at ~50 chars/line (~10k lines each) produce a ~400 MB table,
// so we cap input length here before it ever reaches the library.
const MAX_CHARS = 500_000;
const MAX_LINES = 10_000;
const MAX_LCS_CELLS = 4_000_000;

interface DiffRequest {
  old: unknown;
  new: unknown;
}

export async function POST(req: Request): Promise<Response> {
  if (!(await isLocalRequest(req))) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: DiffRequest;
  try {
    body = (await req.json()) as DiffRequest;
  } catch {
    return Response.json(
      { error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  if (typeof body?.old !== "string") {
    return Response.json(
      { error: "Field 'old' is required and must be a string" },
      { status: 400 },
    );
  }
  if (typeof body?.new !== "string") {
    return Response.json(
      { error: "Field 'new' is required and must be a string" },
      { status: 400 },
    );
  }

  const oldLines = body.old === "" ? 0 : body.old.split("\n").length;
  const newLines = body.new === "" ? 0 : body.new.split("\n").length;

  if (
    body.old.length > MAX_CHARS ||
    body.new.length > MAX_CHARS ||
    oldLines > MAX_LINES ||
    newLines > MAX_LINES ||
    (oldLines + 1) * (newLines + 1) > MAX_LCS_CELLS
  ) {
    return Response.json(
      {
        error: `Input too large (max ${MAX_CHARS} characters, ${MAX_LINES} lines, and ${MAX_LCS_CELLS} LCS cells per request)`,
      },
      { status: 413 },
    );
  }

  try {
    const result = diffMarkdown(body.old, body.new);
    return Response.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return Response.json({ error: message }, { status: 500 });
  }
}
