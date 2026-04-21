import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildScienceSwarmLocalBridgeUrl,
  buildScienceSwarmLocalSignInUrl,
  createScienceSwarmLocalAuthState,
  createScienceSwarmLocalAuthCookieValue,
  readScienceSwarmJwtExpiry,
  readScienceSwarmLocalAuthState,
  readScienceSwarmLocalAuthFromRequest,
  SCIENCESWARM_LOCAL_AUTH_COOKIE,
} from "@/lib/scienceswarm-local-auth";

function makeJwt(exp: number): string {
  return [
    Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify({ exp })).toString("base64url"),
    "signature",
  ].join(".");
}

describe("scienceswarm-local-auth", () => {
  beforeEach(() => {
    vi.stubEnv(
      "SCIENCESWARM_DIR",
      mkdtempSync(path.join(os.tmpdir(), "scienceswarm-local-auth-")),
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("round-trips the signed local auth state", async () => {
    const value = await createScienceSwarmLocalAuthState({
      localOrigin: "http://127.0.0.1:3022",
    });

    await expect(readScienceSwarmLocalAuthState(value)).resolves.toEqual({
      expiresAt: expect.any(String),
      issuedAt: expect.any(String),
      localOrigin: "http://127.0.0.1:3022",
      nonce: expect.any(String),
    });
  });

  it("round-trips a valid local auth cookie", async () => {
    const token = makeJwt(Math.floor(Date.now() / 1000) + 3600);
    const cookieValue = await createScienceSwarmLocalAuthCookieValue({
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      token,
    });
    const request = new Request("http://127.0.0.1:3022/api/test", {
      headers: {
        cookie: `${SCIENCESWARM_LOCAL_AUTH_COOKIE}=${cookieValue}`,
      },
    });

    await expect(readScienceSwarmLocalAuthFromRequest(request)).resolves.toEqual({
      expiresAt: expect.any(String),
      issuedAt: expect.any(String),
      token,
    });
  });

  it("rejects expired local auth cookies", async () => {
    const token = makeJwt(Math.floor(Date.now() / 1000) - 60);
    const cookieValue = await createScienceSwarmLocalAuthCookieValue({
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      token,
    });
    const request = new Request("http://127.0.0.1:3022/api/test", {
      headers: {
        cookie: `${SCIENCESWARM_LOCAL_AUTH_COOKIE}=${cookieValue}`,
      },
    });

    await expect(readScienceSwarmLocalAuthFromRequest(request)).resolves.toBeNull();
  });

  it("builds the hosted bridge URL for localhost origins only", () => {
    expect(
      buildScienceSwarmLocalBridgeUrl({
        localOrigin: "http://127.0.0.1:3022",
        state: "state-123",
      }),
    ).toBe(
      "https://scienceswarm.ai/auth/local-bridge?origin=http%3A%2F%2F127.0.0.1%3A3022&state=state-123",
    );
    expect(() =>
      buildScienceSwarmLocalBridgeUrl({
        localOrigin: "https://evil.example",
        state: "state-123",
      }),
    ).toThrow("ScienceSwarm local sign-in only supports localhost origins.");
  });

  it("builds the hosted sign-in URL with a bridge redirect", () => {
    expect(
      buildScienceSwarmLocalSignInUrl({
        localOrigin: "http://127.0.0.1:3022",
        state: "state-123",
      }),
    ).toBe(
      "https://scienceswarm.ai/sign-in?redirect_url=https%3A%2F%2Fscienceswarm.ai%2Fauth%2Flocal-bridge%3Forigin%3Dhttp%253A%252F%252F127.0.0.1%253A3022%26state%3Dstate-123",
    );
  });

  it("reads the exp claim from JWTs", () => {
    const iso = readScienceSwarmJwtExpiry(makeJwt(1_800_000_000));
    expect(iso).toBe("2027-01-15T08:00:00.000Z");
  });
});
