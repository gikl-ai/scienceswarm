import { NextResponse } from "next/server";

import {
  getScienceSwarmLocalRequestOrigin,
  SCIENCESWARM_LOCAL_AUTH_ERROR_MESSAGE_TYPE,
  SCIENCESWARM_LOCAL_AUTH_TOKEN_MESSAGE_TYPE,
} from "@/lib/scienceswarm-auth";
import {
  buildScienceSwarmCookieClearOptions,
  buildScienceSwarmLocalAuthCookieOptions,
  createScienceSwarmLocalAuthCookieValue,
  readScienceSwarmJwtExpiry,
  readScienceSwarmLocalAuthState,
  SCIENCESWARM_LOCAL_AUTH_COOKIE,
  SCIENCESWARM_LOCAL_AUTH_TXN_COOKIE,
} from "@/lib/scienceswarm-local-auth";

type SessionRequest = {
  expiresAt?: unknown;
  state?: unknown;
  token?: unknown;
};

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function buildCompletionHtml(input: {
  message: string;
  returnPath?: string;
  state: string;
  success: boolean;
}): string {
  const returnPath = input.returnPath || "/dashboard/reasoning";
  const payload = input.success
    ? {
        state: input.state,
        type: SCIENCESWARM_LOCAL_AUTH_TOKEN_MESSAGE_TYPE,
      }
    : {
        error: input.message,
        state: input.state,
        type: SCIENCESWARM_LOCAL_AUTH_ERROR_MESSAGE_TYPE,
      };

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>ScienceSwarm Sign-In</title>
    <style>
      body { margin: 0; background: rgb(249 250 251); color: rgb(17 24 39); font-family: ui-sans-serif, system-ui, sans-serif; }
      main { min-height: 100vh; display: grid; place-items: center; padding: 24px; }
      section { max-width: 420px; border: 1px solid rgb(229 231 235); border-radius: 20px; background: white; padding: 24px; box-shadow: 0 10px 30px rgba(15, 23, 42, 0.08); }
      p { margin: 0; font-size: 14px; line-height: 1.6; }
      a { display: inline-block; margin-top: 16px; color: rgb(37 99 235); font-size: 14px; font-weight: 600; text-decoration: none; }
    </style>
  </head>
  <body>
    <main>
      <section>
        <p>${escapeHtml(input.message)}</p>
        ${
          input.success
            ? `<a href="${escapeHtml(returnPath)}">Return to ScienceSwarm</a>`
            : ""
        }
      </section>
    </main>
    <script>
      (() => {
        const payload = ${JSON.stringify(payload)};
        const returnPath = ${JSON.stringify(returnPath)};
        if (window.opener) {
          window.opener.postMessage(payload, window.location.origin);
          window.setTimeout(() => window.close(), 50);
        } else if (${JSON.stringify(input.success)}) {
          window.setTimeout(() => window.location.replace(returnPath), 800);
        }
      })();
    </script>
  </body>
</html>`;
}

function buildHtmlResponse(
  body: string,
  status: number,
): NextResponse<string> {
  return new NextResponse(body, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
    },
    status,
  });
}

function isNavigationSessionRequest(request: Request): boolean {
  const destination = request.headers.get("sec-fetch-dest");
  if (destination === "document" || destination === "iframe") {
    return true;
  }

  const accept = request.headers.get("accept") || "";
  const contentType = request.headers.get("content-type") || "";
  return (
    !contentType.includes("application/json") &&
    accept.includes("text/html")
  );
}

function respondSessionError(
  request: Request,
  state: string,
  message: string,
  status: number,
): Response {
  if (isNavigationSessionRequest(request)) {
    return buildHtmlResponse(
      buildCompletionHtml({ message, state, success: false }),
      status,
    );
  }

  return NextResponse.json({ error: message }, { status });
}

async function readSessionRequest(request: Request): Promise<SessionRequest | null> {
  const contentType = request.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    try {
      return (await request.json()) as SessionRequest;
    } catch {
      return null;
    }
  }

  if (
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data")
  ) {
    try {
      const formData = await request.formData();
      return {
        expiresAt: formData.get("expiresAt"),
        state: formData.get("state"),
        token: formData.get("token"),
      };
    } catch {
      return null;
    }
  }

  return null;
}

export async function POST(request: Request) {
  const body = await readSessionRequest(request);
  if (!body) {
    return respondSessionError(
      request,
      "",
      "Invalid auth session payload.",
      400,
    );
  }

  const state = typeof body.state === "string" ? body.state.trim() : "";
  const token = typeof body.token === "string" ? body.token.trim() : "";
  const suppliedExpiresAt =
    typeof body.expiresAt === "string" ? body.expiresAt.trim() : "";

  if (!state || !token) {
    return respondSessionError(
      request,
      state,
      "state and token are required.",
      400,
    );
  }

  const localOrigin = getScienceSwarmLocalRequestOrigin(request);
  const authState = await readScienceSwarmLocalAuthState(state);
  if (!authState || authState.localOrigin !== localOrigin) {
    return respondSessionError(
      request,
      state,
      "ScienceSwarm sign-in session is invalid or expired.",
      400,
    );
  }

  const expiresAt = readScienceSwarmJwtExpiry(token) || suppliedExpiresAt;
  if (!expiresAt) {
    return respondSessionError(
      request,
      state,
      "ScienceSwarm token expiry could not be determined.",
      400,
    );
  }

  const cookieValue = await createScienceSwarmLocalAuthCookieValue({
    expiresAt,
    token,
  });

  if (isNavigationSessionRequest(request)) {
    const response = buildHtmlResponse(
      buildCompletionHtml({
        message: "ScienceSwarm account connected. You can return to the app.",
        returnPath: authState.returnPath,
        state,
        success: true,
      }),
      200,
    );
    response.cookies.set(
      SCIENCESWARM_LOCAL_AUTH_COOKIE,
      cookieValue,
      buildScienceSwarmLocalAuthCookieOptions(expiresAt),
    );
    response.cookies.set(
      SCIENCESWARM_LOCAL_AUTH_TXN_COOKIE,
      "",
      buildScienceSwarmCookieClearOptions(),
    );
    return response;
  }

  const response = NextResponse.json({ expiresAt, signedIn: true });
  response.cookies.set(
    SCIENCESWARM_LOCAL_AUTH_COOKIE,
    cookieValue,
    buildScienceSwarmLocalAuthCookieOptions(expiresAt),
  );
  response.cookies.set(
    SCIENCESWARM_LOCAL_AUTH_TXN_COOKIE,
    "",
    buildScienceSwarmCookieClearOptions(),
  );
  return response;
}
