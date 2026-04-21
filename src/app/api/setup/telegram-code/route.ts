/**
 * POST /api/setup/telegram-code
 * Body: { sessionId: string, code: string }
 *
 * Resolves the `pendingCodes` Promise for a paused bootstrap run
 * (see src/lib/setup/install-tasks/telegram-bot.ts). Returns 204 on
 * success, 404 if the session doesn't exist (already expired or never
 * started).
 */

import { isLocalRequest } from "@/lib/local-guard";
import { pendingCodes } from "@/lib/setup/install-tasks/telegram-bot";

export async function POST(request: Request): Promise<Response> {
  if (!(await isLocalRequest(request))) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: { sessionId?: unknown; code?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
  const code = typeof body.code === "string" ? body.code.trim() : "";
  if (!sessionId || !code) {
    return Response.json(
      { error: "sessionId and code are required" },
      { status: 400 },
    );
  }
  const resolver = pendingCodes.get(sessionId);
  if (!resolver) {
    return Response.json({ error: "No pending session" }, { status: 404 });
  }
  resolver(code);
  return new Response(null, { status: 204 });
}
