import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { GET as getStatus } from "@/app/api/scienceswarm-auth/status/route";
import {
  GET as getSession,
  POST as postSession,
} from "@/app/api/scienceswarm-auth/session/route";
import { POST as postSignOut } from "@/app/api/scienceswarm-auth/sign-out/route";
import { POST as postStart } from "@/app/api/scienceswarm-auth/start/route";
import {
  SCIENCESWARM_LOCAL_AUTH_COOKIE,
  SCIENCESWARM_LOCAL_AUTH_TXN_COOKIE,
} from "@/lib/scienceswarm-local-auth";

function makeJwt(exp: number): string {
  return [
    Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify({ exp })).toString("base64url"),
    "signature",
  ].join(".");
}

function extractCookieValue(setCookieHeader: string, name: string): string {
  const match = setCookieHeader.match(new RegExp(`${name}=([^;]+)`));
  if (!match?.[1]) {
    throw new Error(`Missing cookie ${name}`);
  }
  return match[1];
}

describe("/api/scienceswarm-auth/*", () => {
  beforeEach(() => {
    vi.stubEnv(
      "SCIENCESWARM_DIR",
      mkdtempSync(path.join(os.tmpdir(), "scienceswarm-auth-routes-")),
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("starts a hosted ScienceSwarm bridge flow with a signed state token", async () => {
    const response = await postStart(
      new Request("http://127.0.0.1:3022/api/scienceswarm-auth/start", {
        method: "POST",
      }),
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { authUrl: string; state: string };
    const authUrl = new URL(payload.authUrl);
    const redirectUrl = new URL(authUrl.searchParams.get("redirect_url") || "");
    expect(payload.state).toEqual(expect.any(String));
    expect(authUrl.origin).toBe("https://scienceswarm.ai");
    expect(authUrl.pathname).toBe("/sign-in");
    expect(redirectUrl.origin).toBe("https://scienceswarm.ai");
    expect(redirectUrl.pathname).toBe("/auth/local-bridge");
    expect(redirectUrl.searchParams.get("origin")).toBe("http://127.0.0.1:3022");
    expect(redirectUrl.searchParams.get("state")).toBe(payload.state);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("preserves the browser-visible localhost origin in the handoff URL", async () => {
    const response = await postStart(
      new Request("http://localhost:3022/api/scienceswarm-auth/start", {
        method: "POST",
        headers: {
          origin: "http://127.0.0.1:3022",
        },
      }),
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { authUrl: string };
    const authUrl = new URL(payload.authUrl);
    const redirectUrl = new URL(authUrl.searchParams.get("redirect_url") || "");
    expect(authUrl.origin).toBe("https://scienceswarm.ai");
    expect(authUrl.pathname).toBe("/sign-in");
    expect(redirectUrl.searchParams.get("origin")).toBe("http://127.0.0.1:3022");
  });

  it("preserves the local return path for same-tab sign-in fallback", async () => {
    const startResponse = await postStart(
      new Request("http://127.0.0.1:3022/api/scienceswarm-auth/start", {
        method: "POST",
        headers: {
          referer: "http://127.0.0.1:3022/dashboard/reasoning?brain_slug=paper-critique",
        },
      }),
    );
    const startPayload = (await startResponse.json()) as { state: string };

    const token = makeJwt(Math.floor(Date.now() / 1000) + 3600);
    const formData = new FormData();
    formData.set("state", startPayload.state);
    formData.set("token", token);
    const sessionResponse = await postSession(
      new Request("http://127.0.0.1:3022/api/scienceswarm-auth/session", {
        method: "POST",
        headers: {
          "sec-fetch-dest": "document",
        },
        body: formData,
      }),
    );

    expect(sessionResponse.status).toBe(200);
    const html = await sessionResponse.text();
    expect(html).toContain("/dashboard/reasoning?brain_slug=paper-critique");
    expect(html).toContain("Return to ScienceSwarm");
  });

  it("serves a same-tab token relay document for hosted sign-in handoffs", async () => {
    const response = await getSession(
      new Request("http://127.0.0.1:3022/api/scienceswarm-auth/session"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain("Completing ScienceSwarm sign-in");
    expect(html).toContain("window.name");
    expect(html).toContain("/api/scienceswarm-auth/session");
  });

  it("rejects same-tab token relay documents on non-localhost origins", async () => {
    const response = await getSession(
      new Request("https://scienceswarm.ai/api/scienceswarm-auth/session"),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Forbidden" });
  });

  it("returns the local return path after JSON token handoff", async () => {
    const startResponse = await postStart(
      new Request("http://127.0.0.1:3022/api/scienceswarm-auth/start", {
        method: "POST",
        headers: {
          referer: "http://127.0.0.1:3022/dashboard/reasoning?brain_slug=paper-critique",
        },
      }),
    );
    const startPayload = (await startResponse.json()) as { state: string };

    const token = makeJwt(Math.floor(Date.now() / 1000) + 3600);
    const sessionResponse = await postSession(
      new Request("http://127.0.0.1:3022/api/scienceswarm-auth/session", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          state: startPayload.state,
          token,
        }),
      }),
    );

    expect(sessionResponse.status).toBe(200);
    await expect(sessionResponse.json()).resolves.toMatchObject({
      returnPath: "/dashboard/reasoning?brain_slug=paper-critique",
      signedIn: true,
    });
  });

  it("stores a local auth cookie from a valid hosted token handoff", async () => {
    const startResponse = await postStart(
      new Request("http://127.0.0.1:3022/api/scienceswarm-auth/start", {
        method: "POST",
      }),
    );
    const startPayload = (await startResponse.json()) as { state: string };

    const token = makeJwt(Math.floor(Date.now() / 1000) + 3600);
    const formData = new FormData();
    formData.set("state", startPayload.state);
    formData.set("token", token);
    const sessionResponse = await postSession(
      new Request("http://127.0.0.1:3022/api/scienceswarm-auth/session", {
        method: "POST",
        body: formData,
      }),
    );

    expect(sessionResponse.status).toBe(200);
    expect(sessionResponse.headers.get("set-cookie")).toContain(
      `${SCIENCESWARM_LOCAL_AUTH_COOKIE}=`,
    );
  });

  it("accepts a hosted token handoff using the browser-visible localhost origin", async () => {
    const startResponse = await postStart(
      new Request("http://localhost:3022/api/scienceswarm-auth/start", {
        method: "POST",
        headers: {
          origin: "http://127.0.0.1:3022",
        },
      }),
    );
    const startPayload = (await startResponse.json()) as { state: string };

    const token = makeJwt(Math.floor(Date.now() / 1000) + 3600);
    const sessionResponse = await postSession(
      new Request("http://localhost:3022/api/scienceswarm-auth/session", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://127.0.0.1:3022",
        },
        body: JSON.stringify({
          state: startPayload.state,
          token,
        }),
      }),
    );

    expect(sessionResponse.status).toBe(200);
    expect(sessionResponse.headers.get("set-cookie")).toContain(
      `${SCIENCESWARM_LOCAL_AUTH_COOKIE}=`,
    );
  });

  it("returns a completion document for the popup handoff path", async () => {
    const startResponse = await postStart(
      new Request("http://127.0.0.1:3022/api/scienceswarm-auth/start", {
        method: "POST",
      }),
    );
    const startPayload = (await startResponse.json()) as { state: string };

    const token = makeJwt(Math.floor(Date.now() / 1000) + 3600);
    const formData = new FormData();
    formData.set("state", startPayload.state);
    formData.set("token", token);
    const sessionResponse = await postSession(
      new Request("http://127.0.0.1:3022/api/scienceswarm-auth/session", {
        method: "POST",
        headers: {
          "sec-fetch-dest": "document",
        },
        body: formData,
      }),
    );

    expect(sessionResponse.status).toBe(200);
    expect(sessionResponse.headers.get("content-type")).toContain("text/html");
    expect(sessionResponse.headers.get("set-cookie")).toContain(
      `${SCIENCESWARM_LOCAL_AUTH_COOKIE}=`,
    );
    await expect(sessionResponse.text()).resolves.toContain(
      "ScienceSwarm account connected. You can return to the app.",
    );
  });

  it("reports signed-in status when a valid auth cookie is present", async () => {
    const startResponse = await postStart(
      new Request("http://127.0.0.1:3022/api/scienceswarm-auth/start", {
        method: "POST",
      }),
    );
    const startPayload = (await startResponse.json()) as { state: string };

    const token = makeJwt(Math.floor(Date.now() / 1000) + 3600);
    const formData = new FormData();
    formData.set("state", startPayload.state);
    formData.set("token", token);
    const sessionResponse = await postSession(
      new Request("http://127.0.0.1:3022/api/scienceswarm-auth/session", {
        method: "POST",
        body: formData,
      }),
    );
    const authCookie = extractCookieValue(
      sessionResponse.headers.get("set-cookie") || "",
      SCIENCESWARM_LOCAL_AUTH_COOKIE,
    );

    const statusResponse = await getStatus(
      new Request("http://127.0.0.1:3022/api/scienceswarm-auth/status", {
        headers: {
          cookie: `${SCIENCESWARM_LOCAL_AUTH_COOKIE}=${authCookie}`,
        },
      }),
    );

    expect(statusResponse.status).toBe(200);
    await expect(statusResponse.json()).resolves.toMatchObject({
      signedIn: true,
    });
  });

  it("clears the local auth cookies on sign out", async () => {
    const response = await postSignOut(
      new Request("http://127.0.0.1:3022/api/scienceswarm-auth/sign-out", {
        method: "POST",
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain(
      `${SCIENCESWARM_LOCAL_AUTH_COOKIE}=;`,
    );
    expect(response.headers.get("set-cookie")).toContain(
      `${SCIENCESWARM_LOCAL_AUTH_TXN_COOKIE}=;`,
    );
  });
});
