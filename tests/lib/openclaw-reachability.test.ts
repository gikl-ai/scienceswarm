import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isLocalOpenClawGatewayUrl,
  resolveOpenClawHealthUrl,
} from "@/lib/openclaw/reachability";

describe("openclaw reachability helpers", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("preserves https for secure OpenClaw gateway URLs", () => {
    vi.stubEnv("OPENCLAW_URL", "https://openclaw.example/ws");

    expect(resolveOpenClawHealthUrl()).toBe("https://openclaw.example/health");
    expect(isLocalOpenClawGatewayUrl()).toBe(false);
  });

  it("converts wss gateways to https health checks", () => {
    vi.stubEnv("OPENCLAW_URL", "wss://openclaw.example/ws");

    expect(resolveOpenClawHealthUrl()).toBe("https://openclaw.example/health");
    expect(isLocalOpenClawGatewayUrl()).toBe(false);
  });

  it("treats loopback OpenClaw gateways as local", () => {
    vi.stubEnv("OPENCLAW_URL", "ws://127.0.0.1:19002/ws");

    expect(resolveOpenClawHealthUrl()).toBe("http://127.0.0.1:19002/health");
    expect(isLocalOpenClawGatewayUrl()).toBe(true);
  });
});
