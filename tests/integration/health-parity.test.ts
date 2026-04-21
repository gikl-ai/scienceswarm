/**
 * Health Parity Test
 *
 * Ensures /api/health and /api/chat/unified?action=health
 * both use the universal agent-client for health checks,
 * so they always agree on agent status.
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";

const healthRouteSrc = fs.readFileSync("src/app/api/health/route.ts", "utf-8");
const unifiedRouteSrc = fs.readFileSync("src/app/api/chat/unified/route.ts", "utf-8");

describe("Health Endpoint Parity", () => {
  it("both endpoints use the universal agent-client", () => {
    // Both endpoints must use @/lib/agent-client for agent health checks
    // so they never disagree on agent status.
    const agentClientPattern =
      /agent-client/;
    expect(agentClientPattern.test(healthRouteSrc)).toBe(true);
    expect(agentClientPattern.test(unifiedRouteSrc)).toBe(true);
  });

  it("both endpoints check OpenHands", () => {
    expect(healthRouteSrc).toMatch(/openhands/i);
    expect(unifiedRouteSrc).toMatch(/openhands/i);
  });

  it("both endpoints check Ollama/local model", () => {
    const unifiedHasOllama = /ollama/i.test(unifiedRouteSrc);
    const healthHasOllama = /ollama/i.test(healthRouteSrc);

    if (unifiedHasOllama || healthHasOllama) {
      expect(unifiedHasOllama).toBe(true);
      expect(healthHasOllama).toBe(true);
    }
  });

  it("health route includes agent status in response", () => {
    expect(healthRouteSrc).toMatch(/agent/);
  });

  it("both endpoints include legacy openclaw/nanoclaw fields for backward compat", () => {
    expect(healthRouteSrc).toMatch(/openclaw/i);
    expect(healthRouteSrc).toMatch(/nanoclaw/i);
    expect(unifiedRouteSrc).toMatch(/openclaw/i);
    expect(unifiedRouteSrc).toMatch(/nanoclaw/i);
  });

  it("health dashboard checks agent status", () => {
    const dashboardSrc = fs.readFileSync("src/components/research/health-dashboard.tsx", "utf-8");
    // Dashboard can check either legacy nanoclaw or new agent field
    expect(dashboardSrc).toMatch(/nanoclaw|agent/i);
  });

  it("useUnifiedChat reads agent status from health response", () => {
    const hookSrc = fs.readFileSync("src/hooks/use-unified-chat.ts", "utf-8");
    // Hook should check either new agent.status or legacy fields
    expect(hookSrc).toMatch(/agent.*status.*connected|nanoclaw.*connected/);
  });
});
