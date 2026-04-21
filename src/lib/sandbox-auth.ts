/**
 * Shared-token auth for the sandbox HTTP gateway routes.
 *
 * The ScienceSwarm audit-revise sandbox (scienceswarm/sandbox:latest)
 * needs a way to call back into the host Next.js server to read and
 * write gbrain pages without bind-mounting the PGLite directory.
 * Bind-mounting is a non-starter because PGLite is single-writer and
 * sharing `.gbrain-lock` across processes deadlocks (PR #301). Instead
 * the sandbox ships a tiny gbrain HTTP wrapper that calls
 * `POST /api/brain/{page,link,file-upload}` on `http://host.docker.internal:3001`
 * with a shared token the host validates here.
 *
 * Rules:
 *   - If `SCIENCESWARM_SANDBOX_TOKEN` is unset on the host, every
 *     sandbox-token-gated request is refused with 503. That keeps a
 *     mis-configured host from silently accepting anonymous writes.
 *   - The header is `x-scienceswarm-sandbox-token`. Case-insensitive.
 *   - Token comparison is constant-time to avoid leaking the token
 *     via response timing.
 */

import { timingSafeEqual } from "node:crypto";

const HEADER = "x-scienceswarm-sandbox-token";

function configuredToken(): string | null {
  const raw = process.env.SCIENCESWARM_SANDBOX_TOKEN?.trim();
  if (!raw) return null;
  return raw;
}

function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Returns a Response if the request should be refused, or null if it
 * can continue. Callers `const err = requireSandboxToken(req); if (err)
 * return err;` as the first line of their POST handler.
 */
export function requireSandboxToken(request: Request): Response | null {
  const expected = configuredToken();
  if (!expected) {
    return Response.json(
      {
        error:
          "SCIENCESWARM_SANDBOX_TOKEN is not configured on the host. Sandbox writes are refused until the token is set in .env.",
      },
      { status: 503 },
    );
  }
  const provided = request.headers.get(HEADER);
  if (typeof provided !== "string" || provided.length === 0) {
    return Response.json(
      { error: `Missing ${HEADER} header` },
      { status: 401 },
    );
  }
  if (!constantTimeEqual(provided, expected)) {
    return Response.json(
      { error: "Invalid sandbox token" },
      { status: 403 },
    );
  }
  return null;
}
