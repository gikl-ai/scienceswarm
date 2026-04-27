// @vitest-environment jsdom

import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SettingsPage from "@/app/dashboard/settings/page";
import { ThemeProvider } from "@/components/theme-provider";

function stubSettingsFetch() {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";

    if (url === "/api/settings" && method === "GET") {
      return Response.json({
        agent: "openclaw",
        openaiKey: null,
        llmModel: "gpt-5.4",
        llmProvider: "openai",
        ollamaUrl: "http://localhost:11434",
        ollamaModel: "gemma4",
        userHandle: "alice",
        userEmail: "",
        telegramPhone: "",
        telegram: {
          botToken: null,
          configured: false,
          username: null,
          creature: null,
          userId: null,
        },
        slack: { botToken: null, signingSecret: null, configured: false },
      });
    }

    if (url === "/api/settings" && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { action?: string };
      if (body.action === "health") {
        return Response.json({
          openhands: "disconnected",
          openclaw: "connected",
          openai: "not-set",
          ollama: "disconnected",
          ollamaModels: [],
          database: "filesystem",
          agent: "openclaw",
          llmProvider: "openai",
        });
      }

      if (body.action === "local-health") {
        return Response.json({
          running: false,
          models: [],
          url: "http://localhost:11434",
          binaryInstalled: false,
        });
      }

      return Response.json({ ok: true });
    }

    if (url === "/api/settings/telegram") {
      return Response.json({ pendingPairing: null });
    }

    if (url === "/api/settings/nanoclaw") {
      return Response.json({
        cloned: false,
        installed: false,
        configured: false,
        running: false,
        version: null,
        steps: { clone: false, install: false, configure: false, start: false },
      });
    }

    if (url === "/api/settings/openclaw") {
      return Response.json({
        installed: true,
        configured: true,
        running: true,
        version: "2026.4.5",
        model: "openai/gpt-5.4",
        configPath: "~/.openclaw/openclaw.json",
        source: "system",
        steps: { install: true, configure: true, start: true },
      });
    }

    if (url === "/api/runtime/health") {
      return Response.json({
        checkedAt: "2026-04-23T01:00:00.000Z",
        hosts: [
          {
            profile: {
              id: "openclaw",
              label: "OpenClaw",
              authMode: "local",
              authProvider: "openclaw",
              privacyClass: "local-network",
              transport: { kind: "cli", protocol: "stdio" },
              capabilities: ["chat", "task", "artifact-import"],
              lifecycle: {
                canStream: true,
                canCancel: true,
                canResumeNativeSession: false,
                canListNativeSessions: false,
                cancelSemantics: "kill-wrapper-process",
                resumeSemantics: "scienceSwarm-wrapper-session",
              },
              accountDisclosure: {
                storesTokensInScienceSwarm: false,
                requiresProjectPrivacy: "local-only",
              },
              mcpTools: [],
            },
            health: {
              status: "ready",
              checkedAt: "2026-04-23T01:00:00.000Z",
            },
            auth: {
              status: "not-required",
              authMode: "local",
              provider: "openclaw",
            },
            privacy: {
              privacyClass: "local-network",
              adapterProof: "declared-local",
            },
          },
        ],
      });
    }

    if (url.startsWith("/api/runtime/sessions?")) {
      return Response.json({ sessions: [] });
    }

    if (url.startsWith("/api/runtime/sessions/")) {
      if (url.endsWith("/events")) {
        return Response.json({ events: [] });
      }
      return Response.json({ session: null });
    }

    if (url === "/api/studies") {
      return Response.json({
        studies: [{ slug: "alpha-project", name: "Alpha Project" }],
      });
    }

    if (url.startsWith("/api/brain/watch-config?project=")) {
      return Response.json({
        project: "alpha-project",
        config: {
          version: 1,
          objective: "",
          keywords: [],
          promotionThreshold: 5,
          stagingThreshold: 2,
          schedule: {
            enabled: false,
            cadence: "daily",
            time: "08:00",
            timezone: "local",
          },
          sources: [],
        },
      });
    }

    throw new Error(`Unhandled fetch: ${url}`);
  });
}

describe("SettingsPage hydration", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", stubSettingsFetch());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("hydrates without mismatch by deferring password fields until after mount", async () => {
    // Core invariant: the server render must never emit a `type="password"`
    // input (DeferredPasswordInput renders a placeholder div on the
    // server so password-manager extensions can't inject attributes that
    // would cause hydration mismatches). React must then hydrate the
    // client tree without a "Hydration failed" error.
    const tree = (
      <ThemeProvider>
        <SettingsPage />
      </ThemeProvider>
    );
    const serverMarkup = renderToString(tree);
    expect(serverMarkup).not.toContain('type="password"');

    const container = document.createElement("div");
    container.innerHTML = serverMarkup;
    document.body.appendChild(container);

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const root = hydrateRoot(container, tree);

    // Give React a microtask tick to flush initial hydration. We don't
    // wait for a specific field because the settings layout varies with
    // agent/provider/health state — pinning to a single selector made
    // this test brittle to unrelated UI refactors.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(
      consoleError.mock.calls.some(([message]) => String(message).includes("Hydration failed")),
    ).toBe(false);

    root.unmount();
    container.remove();
  });
});
