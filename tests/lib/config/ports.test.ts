import { afterEach, describe, expect, it, vi } from "vitest";

async function loadModule() {
  vi.resetModules();
  return import("@/lib/config/ports");
}

describe("src/lib/config/ports.ts", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("defaults when no env is set", () => {
    it("returns default values for every accessor", async () => {
      // Clear every env var the module reads so the defaults actually apply.
      vi.stubEnv("PORT", "");
      vi.stubEnv("FRONTEND_PORT", "");
      vi.stubEnv("APP_ORIGIN", "");
      vi.stubEnv("OPENHANDS_PORT", "");
      vi.stubEnv("OPENHANDS_URL", "");
      vi.stubEnv("OPENCLAW_URL", "");
      vi.stubEnv("NANOCLAW_URL", "");
      vi.stubEnv("NANOCLAW_PORT", "");
      vi.stubEnv("OLLAMA_URL", "");

      const mod = await loadModule();

      expect(mod.DEFAULT_PORTS).toEqual({
        frontend: 3001,
        openhands: 3000,
        openclaw: 18789,
        nanoclaw: 3002,
        ollama: 11434,
      });

      expect(mod.getFrontendPort()).toBe(3001);
      expect(mod.getFrontendUrl()).toBe("http://localhost:3001");
      expect(mod.getOpenHandsPort()).toBe(3000);
      expect(mod.getOpenHandsUrl()).toBe("http://localhost:3000");
      expect(mod.getOpenClawGatewayUrl()).toBe("ws://127.0.0.1:18789/ws");
      expect(mod.getNanoClawUrl()).toBe("http://localhost:3002");
      expect(mod.getOllamaUrl()).toBe("http://localhost:11434");
    });
  });

  describe("port-var overrides", () => {
    it("honors FRONTEND_PORT", async () => {
      vi.stubEnv("APP_ORIGIN", "");
      vi.stubEnv("PORT", "");
      vi.stubEnv("FRONTEND_PORT", "4321");
      const { getFrontendPort, getFrontendUrl } = await loadModule();
      expect(getFrontendPort()).toBe(4321);
      expect(getFrontendUrl()).toBe("http://localhost:4321");
    });

    it("honors FRONTEND_PORT over PORT when both are set", async () => {
      // The project-specific var wins over the generic Node.js convention
      // so a user with a pre-existing PORT env can still override just the
      // ScienceSwarm frontend via FRONTEND_PORT.
      vi.stubEnv("APP_ORIGIN", "");
      vi.stubEnv("PORT", "5555");
      vi.stubEnv("FRONTEND_PORT", "4321");
      const { getFrontendPort, getFrontendUrl } = await loadModule();
      expect(getFrontendPort()).toBe(4321);
      expect(getFrontendUrl()).toBe("http://localhost:4321");
    });

    it("falls back to PORT when FRONTEND_PORT is unset", async () => {
      vi.stubEnv("APP_ORIGIN", "");
      vi.stubEnv("PORT", "5555");
      vi.stubEnv("FRONTEND_PORT", "");
      const { getFrontendPort, getFrontendUrl } = await loadModule();
      expect(getFrontendPort()).toBe(5555);
      expect(getFrontendUrl()).toBe("http://localhost:5555");
    });

    it("falls through invalid FRONTEND_PORT to PORT", async () => {
      // An invalid earlier-precedence var should NOT short-circuit to the
      // default — the next var in the chain still gets its chance.
      vi.stubEnv("APP_ORIGIN", "");
      vi.stubEnv("FRONTEND_PORT", "garbage");
      vi.stubEnv("PORT", "5555");
      const { getFrontendPort } = await loadModule();
      expect(getFrontendPort()).toBe(5555);
    });

    it("uses default when both FRONTEND_PORT and PORT are invalid", async () => {
      vi.stubEnv("APP_ORIGIN", "");
      vi.stubEnv("FRONTEND_PORT", "garbage");
      vi.stubEnv("PORT", "also-bad");
      const { getFrontendPort } = await loadModule();
      expect(getFrontendPort()).toBe(3001);
    });

    it("honors OPENHANDS_PORT", async () => {
      vi.stubEnv("OPENHANDS_URL", "");
      vi.stubEnv("OPENHANDS_PORT", "3100");
      const { getOpenHandsPort, getOpenHandsUrl } = await loadModule();
      expect(getOpenHandsPort()).toBe(3100);
      expect(getOpenHandsUrl()).toBe("http://localhost:3100");
    });

    it("honors NANOCLAW_PORT", async () => {
      vi.stubEnv("NANOCLAW_URL", "");
      vi.stubEnv("NANOCLAW_PORT", "3210");
      const { getNanoClawUrl } = await loadModule();
      expect(getNanoClawUrl()).toBe("http://localhost:3210");
    });

    it("honors OPENCLAW_PORT", async () => {
      vi.stubEnv("OPENCLAW_URL", "");
      vi.stubEnv("OPENCLAW_PORT", "19000");
      const { getOpenClawGatewayUrl, getOpenClawPort } = await loadModule();
      expect(getOpenClawPort()).toBe(19000);
      expect(getOpenClawGatewayUrl()).toBe("ws://127.0.0.1:19000/ws");
    });

    it("honors OLLAMA_PORT", async () => {
      vi.stubEnv("OLLAMA_URL", "");
      vi.stubEnv("OLLAMA_PORT", "12000");
      const { getOllamaPort, getOllamaUrl } = await loadModule();
      expect(getOllamaPort()).toBe(12000);
      expect(getOllamaUrl()).toBe("http://localhost:12000");
    });
  });

  describe("URL-var precedence (URL beats port)", () => {
    it("OPENHANDS_URL wins over OPENHANDS_PORT", async () => {
      vi.stubEnv("OPENHANDS_PORT", "3100");
      vi.stubEnv("OPENHANDS_URL", "http://openhands.test:9999");
      const { getOpenHandsUrl, getOpenHandsPort } = await loadModule();
      expect(getOpenHandsUrl()).toBe("http://openhands.test:9999");
      // Port accessor still reports the port-var; URL accessor takes URL override.
      expect(getOpenHandsPort()).toBe(3100);
    });

    it("OPENCLAW_URL wins over the literal default", async () => {
      vi.stubEnv("OPENCLAW_URL", "wss://openclaw.test/ws");
      const { getOpenClawGatewayUrl } = await loadModule();
      expect(getOpenClawGatewayUrl()).toBe("wss://openclaw.test/ws");
    });

    it("NANOCLAW_URL wins over NANOCLAW_PORT", async () => {
      vi.stubEnv("NANOCLAW_PORT", "3210");
      vi.stubEnv("NANOCLAW_URL", "http://nanoclaw.test:4000");
      const { getNanoClawUrl } = await loadModule();
      expect(getNanoClawUrl()).toBe("http://nanoclaw.test:4000");
    });

    it("OLLAMA_URL wins over the literal default", async () => {
      vi.stubEnv("OLLAMA_URL", "http://ollama.test:11434");
      const { getOllamaUrl } = await loadModule();
      expect(getOllamaUrl()).toBe("http://ollama.test:11434");
    });
  });

  describe("malformed env values", () => {
    it("non-numeric OPENHANDS_PORT falls back to default without throwing", async () => {
      vi.stubEnv("OPENHANDS_URL", "");
      vi.stubEnv("OPENHANDS_PORT", "abc");
      const { getOpenHandsPort, getOpenHandsUrl } = await loadModule();
      expect(() => getOpenHandsPort()).not.toThrow();
      expect(getOpenHandsPort()).toBe(3000);
      expect(getOpenHandsUrl()).toBe("http://localhost:3000");
    });

    it("non-numeric FRONTEND_PORT falls back to default", async () => {
      vi.stubEnv("APP_ORIGIN", "");
      vi.stubEnv("PORT", "");
      vi.stubEnv("FRONTEND_PORT", "not-a-port");
      const { getFrontendPort } = await loadModule();
      expect(getFrontendPort()).toBe(3001);
    });

    it("zero or negative port falls back to default", async () => {
      vi.stubEnv("OPENHANDS_URL", "");
      vi.stubEnv("OPENHANDS_PORT", "0");
      const first = await loadModule();
      expect(first.getOpenHandsPort()).toBe(3000);

      vi.stubEnv("OPENHANDS_PORT", "-42");
      const second = await loadModule();
      expect(second.getOpenHandsPort()).toBe(3000);
    });

    it("trailing garbage after digits falls back to default", async () => {
      // `Number.parseInt` would have silently accepted this as 3000; the
      // regex-based strict parser must reject it.
      vi.stubEnv("OPENHANDS_URL", "");
      vi.stubEnv("OPENHANDS_PORT", "3000abc");
      const { getOpenHandsPort } = await loadModule();
      expect(getOpenHandsPort()).toBe(3000);
    });

    it("port 0 falls back to default (out of 1-65535 range)", async () => {
      vi.stubEnv("OPENHANDS_URL", "");
      vi.stubEnv("OPENHANDS_PORT", "0");
      const { getOpenHandsPort } = await loadModule();
      expect(getOpenHandsPort()).toBe(3000);
    });

    it("port 65536 falls back to default (out of 1-65535 range)", async () => {
      vi.stubEnv("OPENHANDS_URL", "");
      vi.stubEnv("OPENHANDS_PORT", "65536");
      const { getOpenHandsPort } = await loadModule();
      expect(getOpenHandsPort()).toBe(3000);
    });

    it("negative port string is rejected by the digit regex", async () => {
      vi.stubEnv("OPENHANDS_URL", "");
      vi.stubEnv("OPENHANDS_PORT", "-1");
      const { getOpenHandsPort } = await loadModule();
      expect(getOpenHandsPort()).toBe(3000);
    });
  });

  describe("APP_ORIGIN precedence", () => {
    it("APP_ORIGIN wins over port derivation for getFrontendUrl", async () => {
      vi.stubEnv("PORT", "4321");
      vi.stubEnv("FRONTEND_PORT", "4321");
      vi.stubEnv("APP_ORIGIN", "https://scienceswarm.test");
      const { getFrontendUrl, getFrontendPort } = await loadModule();
      expect(getFrontendUrl()).toBe("https://scienceswarm.test");
      // Port accessor is unaffected by APP_ORIGIN.
      expect(getFrontendPort()).toBe(4321);
    });
  });

  describe("OpenClaw gateway default", () => {
    it("returns ws://127.0.0.1:18789/ws at default", async () => {
      vi.stubEnv("OPENCLAW_URL", "");
      const { getOpenClawGatewayUrl } = await loadModule();
      expect(getOpenClawGatewayUrl()).toBe("ws://127.0.0.1:18789/ws");
    });
  });
});
