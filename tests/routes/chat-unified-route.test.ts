import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/agent-client", () => ({
  resolveAgentConfig: vi.fn().mockReturnValue(null),
  agentHealthCheck: vi.fn().mockResolvedValue({ status: "disconnected" }),
  sendAgentMessage: vi.fn(),
}));

vi.mock("@/lib/openclaw-bridge", () => ({
  processMessage: vi.fn(),
}));

vi.mock("@/lib/message-handler", () => ({
  streamChat: vi.fn(),
}));

import { GET } from "@/app/api/chat/unified/route";

describe("GET /api/chat/unified?action=poll", () => {
  it("returns empty messages when poll is missing projectId", async () => {
    const request = new Request(
      "http://localhost/api/chat/unified?action=poll&since=2026-04-07T00:00:00.000Z",
    );

    const response = await GET(request);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      messages: [],
      backend: "none",
    });
    // Poll returns empty when missing required params
  });
});
