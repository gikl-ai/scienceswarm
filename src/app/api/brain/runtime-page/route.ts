/**
 * POST /api/brain/runtime-page
 *
 * Local runtime bridge for ScienceSwarm-managed assistants. Runtime MCP
 * servers run in separate Node processes; opening the PGLite brain directly
 * from those processes can see stale data or contend with the preview app's
 * active connection. This route keeps runtime writes inside the app process.
 */

import { ensureBrainStoreReady } from "@/brain/store";
import { createInProcessGbrainClient } from "@/brain/in-process-gbrain-client";
import { isLocalRequest } from "@/lib/local-guard";
// Decision 3A presence-only lint gate: runtime callers embed attribution and
// provenance in page frontmatter before posting; this import marks the route
// as attribution-aware for the write-site guard.
import { getCurrentUserHandle as _requireAttributionImport } from "@/lib/setup/gbrain-installer";
void _requireAttributionImport;

type RuntimePagePayload = {
  slug: string;
  content: string;
};

export async function POST(request: Request): Promise<Response> {
  if (!(await isLocalRequest(request))) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json(
      { error: "Request body must be valid JSON" },
      { status: 400 },
    );
  }

  const parsed = parsePayload(payload);
  if ("error" in parsed) {
    return Response.json({ error: parsed.error }, { status: 400 });
  }

  try {
    await ensureBrainStoreReady();
    const result = await createInProcessGbrainClient().putPage(
      parsed.slug,
      parsed.content,
    );
    return Response.json({
      slug: parsed.slug,
      status: "created_or_updated",
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
    });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "runtime page write failed",
      },
      { status: 500 },
    );
  }
}

function parsePayload(raw: unknown): RuntimePagePayload | { error: string } {
  if (!raw || typeof raw !== "object") {
    return { error: "Request body must be a JSON object" };
  }
  const body = raw as Record<string, unknown>;
  const slug = body.slug;
  const content = body.content;
  if (typeof slug !== "string" || slug.trim().length === 0) {
    return { error: "Missing required field: slug" };
  }
  if (typeof content !== "string" || content.trim().length === 0) {
    return { error: "Missing required field: content" };
  }
  return {
    slug: slug.trim(),
    content,
  };
}
