import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

describe("agent-client", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    // Explicitly clear keys that might be in the local .env
    process.env.AGENT_BACKEND = "";
    process.env.AGENT_URL = "";
    process.env.AGENT_API_KEY = "";
    process.env.OPENCLAW_URL = "";
    process.env.OPENCLAW_PORT = "";
    process.env.OPENCLAW_INTERNAL_API_KEY = "";
    process.env.NANOCLAW_URL = "";
    process.env.NANOCLAW_PORT = "";
    process.env.OPENAI_API_KEY = "";

    fetchMock.mockReset();
    // Clear module cache so resolveAgentConfig reads fresh env
    vi.resetModules();
  });

  async function loadModule() {
    return await import("@/lib/agent-client");
  }

  describe("resolveAgentConfig", () => {
    it("returns null when AGENT_BACKEND is not set", async () => {
      const { resolveAgentConfig } = await loadModule();
      expect(resolveAgentConfig()).toBeNull();
    });

    it('returns null when AGENT_BACKEND is "none"', async () => {
      vi.stubEnv("AGENT_BACKEND", "none");
      const { resolveAgentConfig } = await loadModule();
      expect(resolveAgentConfig()).toBeNull();
    });

    it("uses AGENT_URL when set", async () => {
      vi.stubEnv("AGENT_BACKEND", "openclaw");
      vi.stubEnv("AGENT_URL", "http://remote-server:8080");
      const { resolveAgentConfig } = await loadModule();
      const cfg = resolveAgentConfig();
      expect(cfg).toEqual({
        type: "openclaw",
        url: "http://remote-server:8080",
        apiKey: undefined,
      });
    });

    it("falls back to OPENCLAW_URL with ws→http conversion", async () => {
      vi.stubEnv("AGENT_BACKEND", "openclaw");
      vi.stubEnv("OPENCLAW_URL", "ws://127.0.0.1:19002/ws");
      const { resolveAgentConfig } = await loadModule();
      const cfg = resolveAgentConfig();
      expect(cfg?.type).toBe("openclaw");
      expect(cfg?.url).toBe("http://127.0.0.1:19002");
    });

    it("defaults openclaw to the port-derived localhost gateway", async () => {
      vi.stubEnv("AGENT_BACKEND", "openclaw");
      const { resolveAgentConfig } = await loadModule();
      const cfg = resolveAgentConfig();
      expect(cfg?.type).toBe("openclaw");
      expect(cfg?.url).toBe("http://127.0.0.1:18789");
    });

    it("honors OPENCLAW_PORT when deriving the default openclaw URL", async () => {
      vi.stubEnv("AGENT_BACKEND", "openclaw");
      vi.stubEnv("OPENCLAW_PORT", "19003");
      const { resolveAgentConfig } = await loadModule();
      const cfg = resolveAgentConfig();
      expect(cfg?.url).toBe("http://127.0.0.1:19003");
    });

    it("converts wss:// to https://", async () => {
      vi.stubEnv("AGENT_BACKEND", "openclaw");
      vi.stubEnv("OPENCLAW_URL", "wss://secure.example.com:443/ws");
      const { resolveAgentConfig } = await loadModule();
      const cfg = resolveAgentConfig();
      expect(cfg?.url).toBe("https://secure.example.com");
    });

    it("falls back to NANOCLAW_URL for nanoclaw type", async () => {
      vi.stubEnv("AGENT_BACKEND", "nanoclaw");
      vi.stubEnv("NANOCLAW_URL", "http://192.168.1.50:3002");
      const { resolveAgentConfig } = await loadModule();
      const cfg = resolveAgentConfig();
      expect(cfg).toEqual({
        type: "nanoclaw",
        url: "http://192.168.1.50:3002",
        apiKey: undefined,
      });
    });

    it("falls back to NANOCLAW_PORT for nanoclaw type", async () => {
      vi.stubEnv("AGENT_BACKEND", "nanoclaw");
      vi.stubEnv("NANOCLAW_PORT", "4000");
      const { resolveAgentConfig } = await loadModule();
      const cfg = resolveAgentConfig();
      expect(cfg?.url).toBe("http://localhost:4000");
    });

    it("defaults nanoclaw to localhost:3002 with no URL env", async () => {
      vi.stubEnv("AGENT_BACKEND", "nanoclaw");
      const { resolveAgentConfig } = await loadModule();
      const cfg = resolveAgentConfig();
      expect(cfg?.url).toBe("http://localhost:3002");
    });

    it("reads AGENT_API_KEY", async () => {
      vi.stubEnv("AGENT_BACKEND", "nanoclaw");
      vi.stubEnv("AGENT_API_KEY", "secret-123");
      const { resolveAgentConfig } = await loadModule();
      const cfg = resolveAgentConfig();
      expect(cfg?.apiKey).toBe("secret-123");
    });

    it("falls back to OPENCLAW_INTERNAL_API_KEY for openclaw", async () => {
      vi.stubEnv("AGENT_BACKEND", "openclaw");
      vi.stubEnv("AGENT_URL", "http://localhost:19002");
      vi.stubEnv("OPENCLAW_INTERNAL_API_KEY", "legacy-key");
      const { resolveAgentConfig } = await loadModule();
      const cfg = resolveAgentConfig();
      expect(cfg?.apiKey).toBe("legacy-key");
    });

    it("returns null for unknown type with no AGENT_URL", async () => {
      vi.stubEnv("AGENT_BACKEND", "hermes");
      const { resolveAgentConfig } = await loadModule();
      expect(resolveAgentConfig()).toBeNull();
    });

    it("works for unknown type with AGENT_URL", async () => {
      vi.stubEnv("AGENT_BACKEND", "hermes");
      vi.stubEnv("AGENT_URL", "http://hermes.example.com");
      const { resolveAgentConfig } = await loadModule();
      const cfg = resolveAgentConfig();
      expect(cfg?.type).toBe("hermes");
      expect(cfg?.url).toBe("http://hermes.example.com");
    });

    it("honors an explicit env argument over process.env", async () => {
      vi.stubEnv("AGENT_BACKEND", "none");
      const { resolveAgentConfig } = await loadModule();
      const cfg = resolveAgentConfig({
        AGENT_BACKEND: "openclaw",
        AGENT_URL: "http://ui-updated:19002",
        AGENT_API_KEY: "overlay-key",
      });
      expect(cfg).toEqual({
        type: "openclaw",
        url: "http://ui-updated:19002",
        apiKey: "overlay-key",
      });
    });

    it("picks up runtime-saved env overlay from .env without a restart", async () => {
      // Simulate the real bug: UI persists AGENT_BACKEND=openclaw to .env,
      // but process.env still holds the stale startup snapshot.
      vi.stubEnv("NODE_ENV", "development");
      vi.stubEnv("AGENT_BACKEND", ""); // startup snapshot had nothing
      vi.stubEnv("AGENT_URL", "");

      const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const path = await import("node:path");
      const tempDir = mkdtempSync(path.join(tmpdir(), "agent-client-overlay-"));
      writeFileSync(
        path.join(tempDir, ".env"),
        "AGENT_BACKEND=openclaw\nAGENT_URL=http://saved:19002\nAGENT_API_KEY=from-ui\n",
        "utf8",
      );
      const originalCwd = process.cwd();
      process.chdir(tempDir);
      try {
        const { resolveAgentConfig } = await loadModule();
        const cfg = resolveAgentConfig();
        expect(cfg).toEqual({
          type: "openclaw",
          url: "http://saved:19002",
          apiKey: "from-ui",
        });
      } finally {
        process.chdir(originalCwd);
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe("agentHealthCheck", () => {
    it("returns connected when agent responds with status ok", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ status: "connected" }),
      });

      const { agentHealthCheck } = await loadModule();
      const result = await agentHealthCheck({
        type: "test",
        url: "http://localhost:3002",
      });
      expect(result.status).toBe("connected");
      expect(fetchMock).toHaveBeenCalledWith(
        "http://localhost:3002/health",
        expect.objectContaining({
          headers: {},
        }),
      );
    });

    it("returns connected for OpenClaw live health payloads", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ ok: true, status: "live" }),
      });

      const { agentHealthCheck } = await loadModule();
      const result = await agentHealthCheck({
        type: "openclaw",
        url: "http://localhost:18789",
      });
      expect(result.status).toBe("connected");
    });

    it("includes auth header when apiKey is provided", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ status: "connected" }),
      });

      const { agentHealthCheck } = await loadModule();
      await agentHealthCheck({
        type: "test",
        url: "http://localhost:3002",
        apiKey: "my-secret",
      });
      expect(fetchMock).toHaveBeenCalledWith(
        "http://localhost:3002/health",
        expect.objectContaining({
          headers: { Authorization: "Bearer my-secret" },
        }),
      );
    });

    it("returns disconnected on network error", async () => {
      fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));

      const { agentHealthCheck } = await loadModule();
      const result = await agentHealthCheck({
        type: "test",
        url: "http://unreachable:9999",
      });
      expect(result.status).toBe("disconnected");
    });

    it("returns disconnected when no config is provided or resolved", async () => {
      const { agentHealthCheck } = await loadModule();
      const result = await agentHealthCheck();
      expect(result.status).toBe("disconnected");
    });
  });

  describe("sendAgentMessage", () => {
    it("sends message and returns response", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            response: "Hello from the agent",
            conversationId: "conv-123",
          }),
      });

      const { sendAgentMessage } = await loadModule();
      const result = await sendAgentMessage(
        "Hi",
        { conversationId: "conv-123" },
        { type: "nanoclaw", url: "http://localhost:3002" },
      );
      expect(result.response).toBe("Hello from the agent");
      expect(result.conversationId).toBe("conv-123");
      expect(fetchMock).toHaveBeenCalledWith(
        "http://localhost:3002/message",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ message: "Hi", conversationId: "conv-123" }),
        }),
      );
    });

    it("handles chatId field in response (NanoClaw compat)", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            response: "Hi",
            chatId: "chat-456",
          }),
      });

      const { sendAgentMessage } = await loadModule();
      const result = await sendAgentMessage(
        "Hello",
        {},
        { type: "nanoclaw", url: "http://localhost:3002" },
      );
      expect(result.conversationId).toBe("chat-456");
    });

    it("throws when no agent is configured", async () => {
      const { sendAgentMessage } = await loadModule();
      await expect(sendAgentMessage("Hi")).rejects.toThrow(
        "No agent configured",
      );
    });

    it("throws on non-ok response", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve("Internal error"),
      });

      const { sendAgentMessage } = await loadModule();
      await expect(
        sendAgentMessage("Hi", {}, { type: "test", url: "http://localhost:3002" }),
      ).rejects.toThrow("Agent test error 500");
    });
  });
});
