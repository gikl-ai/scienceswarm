import { describe, expect, it } from "vitest";

import {
  mintRuntimeMcpAccessToken,
  verifyRuntimeMcpAccessToken,
} from "@/lib/runtime-hosts/mcp/tokens";

const SECRET = "runtime-mcp-test-secret";
const NOW = new Date("2026-04-22T10:00:00.000Z");

function token(overrides: {
  projectId?: string;
  runtimeSessionId?: string;
  hostId?: string;
  ttlMs?: number;
  allowedTools?: Parameters<typeof mintRuntimeMcpAccessToken>[0]["allowedTools"];
} = {}): string {
  return mintRuntimeMcpAccessToken({
    projectId: overrides.projectId ?? "project-alpha",
    runtimeSessionId: overrides.runtimeSessionId ?? "session-1",
    hostId: overrides.hostId ?? "codex",
    allowedTools: overrides.allowedTools ?? ["gbrain_search", "gbrain_read"],
    ttlMs: overrides.ttlMs,
    now: () => NOW,
    secret: SECRET,
    tokenId: "token-1",
  });
}

describe("RuntimeMcpAccessToken", () => {
  it("mints and verifies a short-lived session-scoped token", () => {
    const result = verifyRuntimeMcpAccessToken({
      token: token(),
      projectId: "project-alpha",
      runtimeSessionId: "session-1",
      hostId: "codex",
      toolName: "gbrain_search",
      now: () => new Date("2026-04-22T10:01:00.000Z"),
      secret: SECRET,
    });

    expect(result).toMatchObject({
      ok: true,
      claims: {
        projectId: "project-alpha",
        runtimeSessionId: "session-1",
        hostId: "codex",
        allowedTools: ["gbrain_search", "gbrain_read"],
      },
    });
  });

  it("rejects missing or tampered tokens before claims are trusted", () => {
    expect(
      verifyRuntimeMcpAccessToken({
        token: null,
        toolName: "gbrain_search",
        secret: SECRET,
      }),
    ).toMatchObject({ ok: false, reason: "missing-token" });

    const tampered = token().replace(/\.[^.]+$/, ".bad-signature");
    expect(
      verifyRuntimeMcpAccessToken({
        token: tampered,
        toolName: "gbrain_search",
        secret: SECRET,
      }),
    ).toMatchObject({ ok: false, reason: "invalid-signature" });
  });

  it("accepts the exact trusted env token without serializing the signing secret", () => {
    const trustedToken = token();

    expect(
      verifyRuntimeMcpAccessToken({
        token: trustedToken,
        trustedToken,
        projectId: "project-alpha",
        runtimeSessionId: "session-1",
        hostId: "codex",
        toolName: "gbrain_read",
        now: () => NOW,
      }),
    ).toMatchObject({ ok: true });

    expect(
      verifyRuntimeMcpAccessToken({
        token: trustedToken.replace(/\.[^.]+$/, ".bad-signature"),
        trustedToken,
        toolName: "gbrain_read",
        now: () => NOW,
      }),
    ).toMatchObject({ ok: false, reason: "invalid-signature" });
  });

  it("rejects expired tokens", () => {
    expect(
      verifyRuntimeMcpAccessToken({
        token: token({ ttlMs: 1_000 }),
        projectId: "project-alpha",
        runtimeSessionId: "session-1",
        hostId: "codex",
        toolName: "gbrain_search",
        now: () => new Date("2026-04-22T10:00:01.000Z"),
        secret: SECRET,
      }),
    ).toMatchObject({ ok: false, reason: "expired-token" });
  });

  it("rejects wrong project, session, host, or tool scopes", () => {
    expect(
      verifyRuntimeMcpAccessToken({
        token: token(),
        projectId: "project-beta",
        now: () => NOW,
        secret: SECRET,
      }),
    ).toMatchObject({ ok: false, reason: "wrong-project" });

    expect(
      verifyRuntimeMcpAccessToken({
        token: token(),
        runtimeSessionId: "session-2",
        now: () => NOW,
        secret: SECRET,
      }),
    ).toMatchObject({ ok: false, reason: "wrong-session" });

    expect(
      verifyRuntimeMcpAccessToken({
        token: token(),
        hostId: "claude-code",
        now: () => NOW,
        secret: SECRET,
      }),
    ).toMatchObject({ ok: false, reason: "wrong-host" });

    expect(
      verifyRuntimeMcpAccessToken({
        token: token({ allowedTools: ["gbrain_read"] }),
        toolName: "gbrain_search",
        now: () => NOW,
        secret: SECRET,
      }),
    ).toMatchObject({ ok: false, reason: "tool-not-allowed" });
  });
});
