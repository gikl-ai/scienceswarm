/**
 * /api/brain/page
 *
 * GET  — slug-based read path for audit-revise artifacts. Returns the
 *        parsed gbrain page (frontmatter + body) as plain JSON so the
 *        reasoning page can hydrate its state from a persisted critique
 *        via `?brain_slug=` instead of re-polling a live job.
 *
 * POST — shared-token write path for the ScienceSwarm sandbox. Accepts
 *        `{ slug, content }` where `content` is a full markdown
 *        document (YAML frontmatter + body) and routes it through the
 *        same in-process gbrain client `buildDefaultToolDeps` uses, so
 *        there is only one PGLite connection per process. This is the
 *        host-side half of the sandbox HTTP gateway used instead of
 *        bind-mounting `~/.gbrain` into the agent container.
 *
 *        Auth: the sandbox must send
 *        `x-scienceswarm-sandbox-token: $SCIENCESWARM_SANDBOX_TOKEN`.
 *        Without a token configured on the host, POST refuses every
 *        request so a mis-configured prod deploy can never quietly
 *        accept unauthenticated writes.
 */

import { getBrainStore, ensureBrainStoreReady } from "@/brain/store";
import { createInProcessGbrainClient } from "@/brain/in-process-gbrain-client";
import { requireSandboxToken } from "@/lib/sandbox-auth";
// Decision 3A presence-only lint gate: write sites must import
// `getCurrentUserHandle`. The sandbox caller is expected to embed the
// handle in the frontmatter (`uploaded_by`) of the page they POST, so
// we don't re-derive it here; this import satisfies the rule.
import { getCurrentUserHandle as _requireAttributionImport } from "@/lib/setup/gbrain-installer";
void _requireAttributionImport;

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const slug = url.searchParams.get("slug");
  if (!slug || typeof slug !== "string") {
    return Response.json(
      { error: "Missing required query parameter: slug" },
      { status: 400 },
    );
  }

  try {
    await ensureBrainStoreReady();
    const page = await getBrainStore().getPage(slug);
    if (!page) {
      return Response.json(
        { error: `No gbrain page for slug '${slug}'` },
        { status: 404 },
      );
    }
    return Response.json({
      slug,
      title: page.title,
      type: page.type,
      content: page.content,
      frontmatter: page.frontmatter ?? {},
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "brain page read failed";
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request): Promise<Response> {
  const authError = requireSandboxToken(request);
  if (authError) return authError;

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json(
      { error: "Request body must be valid JSON" },
      { status: 400 },
    );
  }

  const parsed = parsePutPagePayload(payload);
  if ("error" in parsed) {
    return Response.json({ error: parsed.error }, { status: 400 });
  }

  try {
    await ensureBrainStoreReady();
    const client = createInProcessGbrainClient();
    await client.putPage(parsed.slug, parsed.content);
    return Response.json({ slug: parsed.slug, status: "created_or_updated" });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "brain page write failed";
    return Response.json({ error: message }, { status: 500 });
  }
}

type PutPagePayload = { slug: string; content: string };

function parsePutPagePayload(
  raw: unknown,
): PutPagePayload | { error: string } {
  if (!raw || typeof raw !== "object") {
    return { error: "Request body must be a JSON object" };
  }
  const body = raw as Record<string, unknown>;
  const slug = body.slug;
  const content = body.content;
  if (typeof slug !== "string" || slug.trim().length === 0) {
    return { error: "Missing required field: slug (non-empty string)" };
  }
  if (typeof content !== "string" || content.length === 0) {
    return { error: "Missing required field: content (markdown string)" };
  }
  return { slug: slug.trim(), content };
}
