// @vitest-environment jsdom

import type { AnchorHTMLAttributes, ReactNode } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import SettingsPage from "@/app/dashboard/settings/page";
import { DEFAULT_OPENAI_MODEL } from "@/lib/openai-models";
import { hasRecommendedOllamaModel } from "@/lib/ollama-models";
import type { RuntimeHealthResponse } from "@/components/runtime/RuntimeHostMatrix";
import { FILE_PREVIEW_LOCATION_STORAGE_KEY } from "@/lib/file-preview-preferences";
import { TEST_TELEGRAM_BOT_TOKEN } from "../helpers/telegram-fixtures";

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: { href: string; children: ReactNode } & AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

type SettingsFixture = {
  strictLocalOnly?: boolean;
  openaiKey?: string | null;
  llmModel?: string;
  llmProvider?: string;
  ollamaModel?: string;
  userHandle?: string;
  userEmail?: string;
  telegramPhone?: string;
  telegram?: {
    botToken?: string | null;
    configured?: boolean;
    paired?: boolean;
    username?: string | null;
    creature?: string | null;
    userId?: string | null;
    pendingPairing?: {
      userId: string;
      username?: string | null;
      firstName?: string | null;
      lastName?: string | null;
      createdAt?: string | null;
      lastSeenAt?: string | null;
    } | null;
  };
};

type HealthFixture = {
  strictLocalOnly?: boolean;
  openclaw?: "connected" | "disconnected";
  ollama?: "connected" | "disconnected";
  ollamaModels?: string[];
};

type OpenClawFixture = {
  installed: boolean;
  configured: boolean;
  running: boolean;
  version?: string | null;
  model?: string | null;
  configPath?: string | null;
  source?: "system" | "none";
};

type LocalHealthFixture = {
  running: boolean;
  models: string[];
  binaryInstalled: boolean;
  installCommand?: string | null;
  startCommand?: string | null;
  installHint?: string;
  installUrl?: string;
};

function runtimeHostFixture(
  input: {
    id: string;
    label: string;
    authMode: "local" | "subscription-native" | "api-key";
    authProvider:
      | "openclaw"
      | "anthropic"
      | "openai"
      | "google-ai"
      | "vertex-ai"
      | "ollama"
      | "openhands";
    privacyClass: "local-only" | "local-network" | "hosted" | "external-network";
    healthStatus?: "ready" | "unavailable" | "misconfigured";
    authStatus?: "not-required" | "authenticated" | "missing" | "invalid" | "unknown";
    capabilities?: RuntimeHealthResponse["hosts"][number]["profile"]["capabilities"];
    command?: string;
    requiresProjectPrivacy?: "local-only" | "cloud-ok" | "execution-ok";
    mcpTools?: string[];
    canCancel?: boolean;
    canResumeNativeSession?: boolean;
    canListNativeSessions?: boolean;
  },
): RuntimeHealthResponse["hosts"][number] {
  return {
    profile: {
      id: input.id,
      label: input.label,
      authMode: input.authMode,
      authProvider: input.authProvider,
      privacyClass: input.privacyClass,
      transport: {
        kind: input.authMode === "api-key" ? "http" : "cli",
        protocol: input.authMode === "api-key" ? "https" : "stdio",
        command: input.command,
      },
      capabilities: input.capabilities ?? ["chat"],
      lifecycle: {
        canStream: true,
        canCancel: input.canCancel ?? false,
        canResumeNativeSession: input.canResumeNativeSession ?? false,
        canListNativeSessions: input.canListNativeSessions ?? false,
        cancelSemantics: input.canCancel ? "kill-wrapper-process" : "none",
        resumeSemantics: input.canResumeNativeSession ? "open-native-session" : "none",
      },
      accountDisclosure: {
        storesTokensInScienceSwarm: input.authMode === "api-key" ? "api-key-only" : false,
        requiresProjectPrivacy: input.requiresProjectPrivacy
          ?? (input.privacyClass === "hosted" ? "cloud-ok" : "local-only"),
      },
      mcpTools: input.mcpTools ?? [],
    },
    health: {
      status: input.healthStatus ?? "ready",
      checkedAt: "2026-04-23T01:00:00.000Z",
      detail: input.healthStatus === "unavailable" ? `${input.label} unavailable` : undefined,
    },
    auth: {
      status: input.authStatus ?? (input.authMode === "local" ? "not-required" : "authenticated"),
      authMode: input.authMode,
      provider: input.authProvider,
    },
    privacy: {
      privacyClass: input.privacyClass,
      adapterProof: input.privacyClass === "hosted" ? "declared-hosted" : "declared-local",
      observedAt: "2026-04-23T01:00:00.000Z",
    },
  };
}

function buildRuntimeHealthFixture(
  overrides?: Partial<RuntimeHealthResponse>,
): RuntimeHealthResponse {
  return {
    checkedAt: "2026-04-23T01:00:00.000Z",
    hosts: [
      runtimeHostFixture({
        id: "openclaw",
        label: "OpenClaw",
        authMode: "local",
        authProvider: "openclaw",
        privacyClass: "local-network",
        capabilities: ["chat", "task", "artifact-import"],
        canCancel: true,
      }),
      runtimeHostFixture({
        id: "claude-code",
        label: "Claude Code",
        authMode: "subscription-native",
        authProvider: "anthropic",
        privacyClass: "hosted",
        capabilities: ["chat", "task", "mcp-tools"],
        command: "claude",
        mcpTools: ["gbrain_search"],
      }),
      runtimeHostFixture({
        id: "codex",
        label: "Codex",
        authMode: "subscription-native",
        authProvider: "openai",
        privacyClass: "hosted",
        capabilities: ["chat", "task", "mcp-tools"],
        command: "codex",
        mcpTools: ["gbrain_search", "gbrain_capture"],
      }),
      runtimeHostFixture({
        id: "gemini-cli",
        label: "Gemini CLI",
        authMode: "subscription-native",
        authProvider: "google-ai",
        privacyClass: "hosted",
        command: "gemini",
      }),
      runtimeHostFixture({
        id: "openhands",
        label: "OpenHands",
        authMode: "local",
        authProvider: "openhands",
        privacyClass: "local-network",
        capabilities: ["task", "artifact-import"],
        healthStatus: "unavailable",
        authStatus: "unknown",
        canCancel: true,
      }),
      runtimeHostFixture({
        id: "openai-api",
        label: "OpenAI API key",
        authMode: "api-key",
        authProvider: "openai",
        privacyClass: "hosted",
      }),
    ],
    ...overrides,
  };
}

function buildFetchStub(options?: {
  settings?: SettingsFixture;
  health?: HealthFixture;
  openclaw?: OpenClawFixture;
  localHealth?: LocalHealthFixture;
  runtimeHealth?: RuntimeHealthResponse;
  approvePendingWarning?: string | null;
}) {
  const state = {
    settings: {
      strictLocalOnly: options?.settings?.strictLocalOnly ?? false,
      openaiKey: options?.settings?.openaiKey ?? null,
      llmModel: options?.settings?.llmModel ?? DEFAULT_OPENAI_MODEL,
      llmProvider: options?.settings?.llmProvider ?? "local",
      ollamaModel: options?.settings?.ollamaModel ?? "gemma4:latest",
      userHandle: options?.settings?.userHandle ?? "alice",
      userEmail: options?.settings?.userEmail ?? "",
      telegramPhone: options?.settings?.telegramPhone ?? "",
      telegram: {
        botToken: options?.settings?.telegram?.botToken ?? null,
        configured: options?.settings?.telegram?.configured ?? false,
        paired:
          options?.settings?.telegram?.paired
          ?? Boolean(options?.settings?.telegram?.userId ?? null),
        username: options?.settings?.telegram?.username ?? null,
        creature: options?.settings?.telegram?.creature ?? null,
        userId: options?.settings?.telegram?.userId ?? null,
        pendingPairing: options?.settings?.telegram?.pendingPairing ?? null,
      },
    },
    health: {
      strictLocalOnly: options?.health?.strictLocalOnly ?? false,
      openclaw: options?.health?.openclaw ?? "disconnected",
      ollama: options?.health?.ollama ?? "disconnected",
      ollamaModels: options?.health?.ollamaModels ?? [],
    },
    openclaw: {
      installed: options?.openclaw?.installed ?? true,
      configured: options?.openclaw?.configured ?? true,
      running: options?.openclaw?.running ?? false,
      version: options?.openclaw?.version ?? "2026.4.5",
      model: options?.openclaw?.model ?? "ollama/gemma4:latest",
      configPath: options?.openclaw?.configPath ?? "~/.openclaw/openclaw.json",
      source: options?.openclaw?.source ?? "system",
    },
    localHealth: {
      running: options?.localHealth?.running ?? true,
      models: options?.localHealth?.models ?? ["gemma4:latest"],
      binaryInstalled: options?.localHealth?.binaryInstalled ?? true,
      installCommand: options?.localHealth?.installCommand ?? "brew install ollama",
      startCommand: options?.localHealth?.startCommand ?? "ollama serve",
      installHint: options?.localHealth?.installHint,
      installUrl: options?.localHealth?.installUrl,
    },
    runtimeHealth: options?.runtimeHealth ?? buildRuntimeHealthFixture(),
  };

  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const method = init?.method ?? "GET";

    if (url === "/api/settings" && method === "GET") {
      return Response.json({
        agent: "openclaw",
        agentUrl: "",
        agentApiKey: null,
        openaiKey: state.settings.openaiKey,
        llmModel: state.settings.llmModel,
        llmProvider: state.settings.llmProvider,
        strictLocalOnly: state.settings.strictLocalOnly,
        ollamaUrl: "http://localhost:11434",
        ollamaModel: state.settings.ollamaModel,
        userHandle: state.settings.userHandle,
        userEmail: state.settings.userEmail,
        telegramPhone: state.settings.telegramPhone,
        telegram: state.settings.telegram,
        slack: { botToken: null, signingSecret: null, configured: false },
      });
    }

    if (url === "/api/settings/telegram" && method === "GET") {
      return Response.json({
        pendingPairing: state.settings.telegram.pendingPairing,
      });
    }

    if (url === "/api/settings" && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        action?: string;
        enabled?: boolean;
        key?: string;
        model?: string;
        provider?: string;
        ollamaModel?: string;
        userHandle?: string;
        userEmail?: string;
        telegramPhone?: string;
      };

      if (body.action === "health") {
        return Response.json({
          openhands: "disconnected",
          openclaw: state.health.openclaw,
          openai: state.settings.strictLocalOnly
            ? "disabled"
            : state.settings.openaiKey
              ? "configured"
              : "missing",
          ollama: state.health.ollama,
          ollamaModels: state.health.ollamaModels,
          database: "filesystem",
          agent: "openclaw",
          llmProvider: state.settings.llmProvider,
          strictLocalOnly: state.health.strictLocalOnly,
        });
      }

      if (body.action === "local-health") {
        const hasRecommendedModel = hasRecommendedOllamaModel(state.localHealth.models);
        return Response.json({
          ...state.localHealth,
          url: "http://localhost:11434",
          hasRecommendedModel,
        });
      }

      if (body.action === "ollama-library") {
        return Response.json({
          models: [
            { name: "gemma4", size: 5 * 1024 ** 3 },
            { name: "qwen3:4b", size: 3 * 1024 ** 3 },
          ],
        });
      }

      if (body.action === "save-strict-local-only") {
        state.settings.strictLocalOnly = Boolean(body.enabled);
        state.health.strictLocalOnly = Boolean(body.enabled);
        state.settings.llmProvider = state.settings.strictLocalOnly ? "local" : state.settings.llmProvider;
        return Response.json({
          ok: true,
          strictLocalOnly: state.settings.strictLocalOnly,
          llmProvider: state.settings.strictLocalOnly ? "local" : state.settings.llmProvider,
        });
      }

      if (body.action === "save-provider") {
        state.settings.llmProvider = body.provider === "openai" ? "openai" : "local";
        return Response.json({
          ok: true,
          provider: state.settings.llmProvider,
        });
      }

      if (body.action === "save-key") {
        state.settings.openaiKey = "sk-...cdef";
        return Response.json({
          ok: true,
          masked: state.settings.openaiKey,
        });
      }

      if (body.action === "test-key") {
        return Response.json({ valid: true });
      }

      if (body.action === "save-model") {
        state.settings.llmModel = body.model ?? state.settings.llmModel;
        return Response.json({
          ok: true,
          model: state.settings.llmModel,
        });
      }

      if (body.action === "save-user-handle") {
        state.settings.userHandle = body.userHandle ?? state.settings.userHandle;
        return Response.json({
          ok: true,
          userHandle: state.settings.userHandle,
        });
      }

      if (body.action === "save-user-email") {
        state.settings.userEmail = body.userEmail ?? state.settings.userEmail;
        return Response.json({
          ok: true,
          userEmail: state.settings.userEmail,
        });
      }

      if (body.action === "save-telegram-phone") {
        state.settings.telegramPhone = body.telegramPhone ?? state.settings.telegramPhone;
        return Response.json({
          ok: true,
          telegramPhone: state.settings.telegramPhone,
        });
      }

      if (body.action === "save-ollama-model") {
        state.settings.ollamaModel = body.ollamaModel ?? state.settings.ollamaModel;
        return Response.json({
          ok: true,
          ollamaModel: state.settings.ollamaModel,
        });
      }

      return Response.json({ ok: true });
    }

    if (url === "/api/runtime/health") {
      return Response.json(state.runtimeHealth);
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

    if (url === "/api/settings/telegram" && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        action?: "approve-pending";
        mode?: "fresh" | "reuse";
        phone?: string;
        botToken?: string;
      };
      if (body.action === "approve-pending") {
        state.settings.telegram = {
          ...state.settings.telegram,
          configured: true,
          paired: true,
          userId: state.settings.telegram.pendingPairing?.userId ?? "8647564254",
          pendingPairing: null,
        };
        return Response.json({
          ok: true,
          userId: state.settings.telegram.userId,
          warning: options?.approvePendingWarning ?? null,
        });
      }
      if (body.mode === "fresh") {
        state.settings.telegramPhone = body.phone ?? state.settings.telegramPhone;
      }
      state.settings.telegram = {
        botToken: "1234...abcd",
        configured: true,
        paired: true,
        username: "mistbun_test_bot",
        creature: "mistbun",
        userId: "8647564254",
        pendingPairing: null,
      };
      const streamBody = [
        `data: ${JSON.stringify({
          type: "task",
          task: "telegram-bot",
          status: "running",
          detail:
            body.mode === "fresh"
              ? "Sending SMS code…"
              : "Reusing existing Telegram bot token…",
        })}\n\n`,
        `data: ${JSON.stringify({
          type: "task",
          task: "telegram-bot",
          status: "succeeded",
          detail: "Mistbun — your ScienceSwarm claw — https://t.me/mistbun_test_bot",
        })}\n\n`,
        `data: ${JSON.stringify({
          type: "summary",
          status: "ok",
          failed: [],
          skipped: [],
        })}\n\n`,
      ].join("");
      return new Response(streamBody, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }

    if (url === "/api/settings/openclaw" && method === "GET") {
      return Response.json({
        ...state.openclaw,
        steps: {
          install: state.openclaw.installed,
          configure: state.openclaw.configured,
          start: state.openclaw.running,
        },
      });
    }

    if (url === "/api/settings/openclaw" && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { action?: string };
      if (body.action === "configure") {
        state.openclaw.configured = true;
        state.openclaw.model =
          state.settings.llmProvider === "openai"
            ? `openai/${state.settings.llmModel}`
            : `ollama/${state.settings.ollamaModel}`;
      }
      if (body.action === "stop") {
        state.openclaw.running = false;
        state.health.openclaw = "disconnected";
      }
      if (body.action === "start") {
        state.openclaw.running = true;
        state.health.openclaw = "connected";
      }
      return Response.json({ ok: true });
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

    if (url === "/api/projects") {
      return Response.json({
        projects: [
          { slug: "alpha-project", name: "Alpha Project" },
          { slug: "beta-project", name: "Beta Project" },
        ],
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

    if (url === "/api/brain/watch-config/compose" && method === "POST") {
      return Response.json({
        plan: {
          objective: "Track AI news for Alpha Project.",
          compiledPrompt: "Search for and compile today's most important AI news.",
          keywords: ["ai news"],
          searchQueries: ["AI news today"],
        },
      });
    }

    if (url === "/api/brain/watch-config" && method === "POST") {
      return Response.json({
        project: "alpha-project",
        config: JSON.parse(String(init?.body ?? "{}")).config,
      });
    }

    throw new Error(`Unhandled fetch: ${method} ${url}`);
  });
}

describe("SettingsPage runtime settings", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it("renders the runtime settings shell and onboarding bridge", async () => {
    vi.stubGlobal("fetch", buildFetchStub());

    render(<SettingsPage />);

    const link = await screen.findByRole("link", { name: "Open onboarding" });
    expect(link).toHaveAttribute("href", "/setup");
    expect(screen.getByText("Strict local-only mode")).toBeInTheDocument();
    expect(await screen.findByText("API Keys & Model")).toBeInTheDocument();
    expect(screen.getByText("LLM Provider")).toBeInTheDocument();
    expect(screen.getByText("Telegram & OpenClaw")).toBeInTheDocument();
    expect(screen.getByText("Create a new personal bot")).toBeInTheDocument();
    expect(screen.getByText("Connect an existing bot token")).toBeInTheDocument();
    expect(screen.queryByText("Channel Connections")).toBeNull();
    expect(screen.queryByText("NanoClaw")).toBeNull();
  });

  it("saves and applies the OpenAI runtime to OpenClaw from Settings", async () => {
    const fetchMock = buildFetchStub({
      health: { openclaw: "connected", ollama: "connected", ollamaModels: ["gemma4:latest"] },
      openclaw: {
        installed: true,
        configured: true,
        running: true,
        model: "ollama/gemma4:latest",
      },
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<SettingsPage />);

    await screen.findByText("API Keys & Model");

    fireEvent.click(screen.getByTestId("llm-provider-openai"));
    fireEvent.change(await screen.findByTestId("openai-api-key-input"), {
      target: { value: "sk-test-openai-1234" },
    });
    fireEvent.change(screen.getByTestId("openai-model-input"), {
      target: { value: "gpt-5.4-mini" },
    });
    fireEvent.click(screen.getByTestId("runtime-apply-button"));

    await waitFor(() => {
      expect(screen.getByText("OpenAI runtime saved and applied to OpenClaw")).toBeInTheDocument();
    });

    const settingsActions = fetchMock.mock.calls
      .filter(([, init]) => (init?.method ?? "GET") === "POST")
      .filter(([input]) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        return url === "/api/settings";
      })
      .map(([, init]) => JSON.parse(String(init?.body ?? "{}")) as { action?: string });

    expect(settingsActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "save-key" }),
        expect.objectContaining({ action: "save-provider", provider: "openai" }),
        expect.objectContaining({ action: "save-model", model: "gpt-5.4-mini" }),
      ]),
    );

    const openclawActions = fetchMock.mock.calls
      .filter(([, init]) => (init?.method ?? "GET") === "POST")
      .filter(([input]) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        return url === "/api/settings/openclaw";
      })
      .map(([, init]) => (JSON.parse(String(init?.body ?? "{}")) as { action?: string }).action);

    expect(openclawActions).toEqual(["configure", "stop", "start"]);
  });

  it("keeps OpenAI apply enabled when the selected model falls back to the default", async () => {
    vi.stubGlobal(
      "fetch",
      buildFetchStub({
        settings: {
          openaiKey: "sk-...cdef",
          llmProvider: "openai",
          llmModel: "",
        },
        health: { openclaw: "connected", ollama: "connected", ollamaModels: ["gemma4:latest"] },
        openclaw: {
          installed: true,
          configured: true,
          running: true,
          model: "openai/gpt-5",
        },
      }),
    );

    render(<SettingsPage />);

    expect(await screen.findByTestId("openai-model-input")).toHaveValue(DEFAULT_OPENAI_MODEL);
    expect(screen.getByTestId("runtime-apply-button")).toBeEnabled();
  });

  it("connects an existing Telegram bot token from Settings", async () => {
    const fetchMock = buildFetchStub();
    vi.stubGlobal("fetch", fetchMock);

    render(<SettingsPage />);

    await screen.findByText("Telegram & OpenClaw");

    fireEvent.click(screen.getByTestId("settings-telegram-mode-reuse"));
    fireEvent.change(screen.getByTestId("settings-telegram-bot-token-input"), {
      target: { value: TEST_TELEGRAM_BOT_TOKEN },
    });
    fireEvent.click(screen.getByTestId("settings-telegram-connect-button"));

    await waitFor(() => {
      expect(screen.getByTestId("telegram-bot-ready")).toBeInTheDocument();
    });

    const telegramCalls = fetchMock.mock.calls.filter(([input]) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      return url === "/api/settings/telegram";
    });

    expect(telegramCalls).toHaveLength(1);
    expect(
      JSON.parse(String(telegramCalls[0]?.[1]?.body ?? "{}")),
    ).toMatchObject({
      mode: "reuse",
      botToken: TEST_TELEGRAM_BOT_TOKEN,
    });
  });

  it("shows pending Telegram pairing and approves it from Settings", async () => {
    const fetchMock = buildFetchStub({
      settings: {
        telegram: {
          botToken: "1234...abcd",
          configured: true,
          paired: false,
          username: "bogmonkey_alice_bot",
          userId: null,
          pendingPairing: {
            userId: "8325267942",
            username: "polarbear55555",
            firstName: "Alice",
          },
        },
      },
      health: { openclaw: "connected", ollama: "connected", ollamaModels: ["gemma4:latest"] },
      openclaw: { installed: true, configured: true, running: true },
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<SettingsPage />);

    expect(await screen.findByTestId("settings-telegram-pairing-status")).toBeInTheDocument();
    expect(screen.getByTestId("settings-telegram-pending-pairing")).toBeInTheDocument();
    expect(screen.getByText(/OpenClaw saw a pending Telegram pairing request from Alice/)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("settings-telegram-approve-pending-button"));

    await waitFor(() => {
      expect(screen.getByTestId("settings-telegram-success")).toHaveTextContent(
        "Telegram pairing approved. Send your message again.",
      );
    });

    await waitFor(() => {
      expect(screen.getByText(/Paired bot:/)).toBeInTheDocument();
    });

    const approveCalls = fetchMock.mock.calls.filter(([input, init]) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      return url === "/api/settings/telegram"
        && (init?.method ?? "GET") === "POST"
        && JSON.parse(String(init?.body ?? "{}")).action === "approve-pending";
    });
    expect(approveCalls).toHaveLength(1);
  });

  it("checks for pending Telegram pairing on demand instead of during initial settings load", async () => {
    const fetchMock = buildFetchStub({
      settings: {
        telegram: {
          botToken: "1234...abcd",
          configured: true,
          paired: false,
          username: "bogmonkey_alice_bot",
          userId: null,
          pendingPairing: null,
        },
      },
      health: { openclaw: "connected", ollama: "connected", ollamaModels: ["gemma4:latest"] },
      openclaw: { installed: true, configured: true, running: true },
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<SettingsPage />);

    expect(await screen.findByTestId("settings-telegram-pairing-status")).toBeInTheDocument();
    expect(screen.getByTestId("settings-telegram-refresh-pending-button")).toBeInTheDocument();

    const initialPendingChecks = fetchMock.mock.calls.filter(([input, init]) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      return url === "/api/settings/telegram" && (init?.method ?? "GET") === "GET";
    });
    expect(initialPendingChecks).toHaveLength(0);

    fireEvent.click(screen.getByTestId("settings-telegram-refresh-pending-button"));

    await waitFor(() => {
      const pendingChecks = fetchMock.mock.calls.filter(([input, init]) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        return url === "/api/settings/telegram" && (init?.method ?? "GET") === "GET";
      });
      expect(pendingChecks).toHaveLength(1);
    });
  });

  it("shows an approval warning as an error banner instead of a success banner", async () => {
    const fetchMock = buildFetchStub({
      settings: {
        telegram: {
          botToken: "1234...abcd",
          configured: true,
          paired: false,
          username: "bogmonkey_alice_bot",
          userId: null,
          pendingPairing: {
            userId: "8325267942",
            username: "polarbear55555",
            firstName: "Alice",
          },
        },
      },
      health: { openclaw: "connected", ollama: "connected", ollamaModels: ["gemma4:latest"] },
      openclaw: { installed: true, configured: true, running: true },
      approvePendingWarning:
        "Warning: saved your Telegram user id but could not switch OpenClaw to allowlist mode.",
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<SettingsPage />);

    expect(await screen.findByTestId("settings-telegram-pairing-status")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("settings-telegram-approve-pending-button"));

    await waitFor(() => {
      expect(screen.getByTestId("settings-telegram-error")).toHaveTextContent(
        "Warning: saved your Telegram user id but could not switch OpenClaw to allowlist mode.",
      );
    });

    expect(screen.queryByTestId("settings-telegram-success")).not.toBeInTheDocument();
  });

  it("shows configured, not running for OpenClaw in Services Health when the local CLI is stopped", async () => {
    vi.stubGlobal(
      "fetch",
      buildFetchStub({
        health: { openclaw: "disconnected", ollama: "connected", ollamaModels: ["gemma4:latest"] },
        openclaw: { installed: true, configured: true, running: false },
      }),
    );

    render(<SettingsPage />);

    // With autoStart enabled on Settings, the component auto-starts
    // OpenClaw. Wait for the auto-start effect to fire and resolve
    // the status back to "Running" (the stub immediately sets
    // running=true on start action).
    await waitFor(() => {
      expect(screen.getByTestId("openclaw-status-pill")).toHaveTextContent("Running");
    });
    expect(screen.getByTestId("openclaw-auto-status")).toBeInTheDocument();
  });

  it("shows OpenClaw as running when the local CLI is active", async () => {
    vi.stubGlobal(
      "fetch",
      buildFetchStub({
        health: { openclaw: "connected", ollama: "connected", ollamaModels: ["gemma4:latest"] },
        openclaw: { installed: true, configured: true, running: true },
      }),
    );

    render(<SettingsPage />);

    expect(await screen.findByText("running")).toBeInTheDocument();
    expect(screen.getByTestId("openclaw-status-pill")).toHaveTextContent("Running");
    // With autoStart, the auto-start success message replaces the
    // disabled Start button.
    expect(screen.getByTestId("openclaw-auto-status")).toBeInTheDocument();
  });

  it("shows gemma4:26b as a selectable local model in Settings", async () => {
    vi.stubGlobal(
      "fetch",
      buildFetchStub({
        health: { ollama: "connected", ollamaModels: ["gemma4:latest"] },
        localHealth: {
          running: true,
          models: ["gemma4:latest"],
          binaryInstalled: true,
        },
      }),
    );

    render(<SettingsPage />);

    expect(await screen.findByText("Local model")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Settings defaults to Ollama + gemma4, and can switch to larger local models like gemma4:26b.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByTestId("ollama-model-select")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "gemma4:26b" })).toBeInTheDocument();
    expect(screen.getByText("LLM Provider")).toBeInTheDocument();
  });

  it("treats gemma4:26b as pending until that exact model is available", async () => {
    vi.stubGlobal(
      "fetch",
      buildFetchStub({
        settings: { ollamaModel: "gemma4:26b" },
        health: { ollama: "connected", ollamaModels: ["gemma4:latest"] },
        localHealth: {
          running: true,
          models: ["gemma4:latest"],
          binaryInstalled: true,
        },
      }),
    );

    render(<SettingsPage />);

    expect(await screen.findByText("gemma4:26b selected, pull pending")).toBeInTheDocument();
    expect(
      screen.getByText((_, node) => node?.textContent === "Selected local model: gemma4:26b not ready yet"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("ollama-pull-button")).not.toBeInTheDocument();
  });

  it("shows install ollama flow when the local runtime is missing", async () => {
    vi.stubGlobal(
      "fetch",
      buildFetchStub({
        health: { ollama: "disconnected", ollamaModels: [] },
        localHealth: {
          running: false,
          models: [],
          binaryInstalled: false,
          installCommand: "brew install ollama",
          installHint: "Install Ollama first.",
        },
      }),
    );

    render(<SettingsPage />);

    expect(await screen.findByRole("button", { name: "Install Ollama" })).toBeInTheDocument();
  });

  it("toggles strict local-only mode from Settings", async () => {
    vi.stubGlobal("fetch", buildFetchStub());

    render(<SettingsPage />);

    const toggle = await screen.findByRole("button", { name: "Turn on strict local-only" });
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(screen.getByText("on")).toBeInTheDocument();
    });
  });

  it("persists the workspace file preview location", async () => {
    vi.stubGlobal("fetch", buildFetchStub());

    render(<SettingsPage />);

    const upperPane = await screen.findByRole("radio", { name: /Upper pane/ });
    const chatPane = screen.getByRole("radio", { name: /Chat pane/ });

    expect(upperPane).toHaveAttribute("aria-checked", "true");
    fireEvent.click(chatPane);

    expect(chatPane).toHaveAttribute("aria-checked", "true");
    expect(window.localStorage.getItem(FILE_PREVIEW_LOCATION_STORAGE_KEY)).toBe("chat-pane");
  });

  it("supports arrow-key navigation for the workspace file preview radios", async () => {
    vi.stubGlobal("fetch", buildFetchStub());

    render(<SettingsPage />);

    const upperPane = await screen.findByRole("radio", { name: /Upper pane/ });
    const chatPane = screen.getByRole("radio", { name: /Chat pane/ });

    upperPane.focus();
    fireEvent.keyDown(upperPane, { key: "ArrowRight" });

    expect(chatPane).toHaveAttribute("aria-checked", "true");
    expect(chatPane).toHaveFocus();
    expect(window.localStorage.getItem(FILE_PREVIEW_LOCATION_STORAGE_KEY)).toBe("chat-pane");

    fireEvent.keyDown(chatPane, { key: "ArrowLeft" });

    expect(upperPane).toHaveAttribute("aria-checked", "true");
    expect(upperPane).toHaveFocus();
    expect(window.localStorage.getItem(FILE_PREVIEW_LOCATION_STORAGE_KEY)).toBe("upper-pane");
  });

  it("updates the workspace file preview selection when storage is unavailable", async () => {
    vi.stubGlobal("fetch", buildFetchStub());
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage unavailable");
    });

    render(<SettingsPage />);

    const chatPane = await screen.findByRole("radio", { name: /Chat pane/ });
    fireEvent.click(chatPane);

    expect(chatPane).toHaveAttribute("aria-checked", "true");
  });

  it("renders runtime hosts from /api/runtime/health", async () => {
    const fetchMock = buildFetchStub({
      runtimeHealth: buildRuntimeHealthFixture({
        hosts: [
          runtimeHostFixture({
            id: "lab-runtime",
            label: "Lab Runtime",
            authMode: "local",
            authProvider: "openclaw",
            privacyClass: "local-only",
          }),
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<SettingsPage />);

    expect(await screen.findByTestId("runtime-host-matrix")).toBeInTheDocument();
    expect(screen.getAllByText("Lab Runtime").length).toBeGreaterThan(0);
    expect(screen.queryByText("Claude Code")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/runtime/health",
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("renders project runtime controls and keeps hosted hosts disabled under local-only policy", async () => {
    vi.stubGlobal("fetch", buildFetchStub());

    render(<SettingsPage />);

    expect(await screen.findByTestId("project-runtime-project-select")).toHaveValue("alpha-project");
    const hostSelect = await screen.findByTestId("runtime-host-select");
    const codexOption = within(hostSelect).getByRole("option", {
      name: "Codex - Requires cloud-ok",
    });

    expect(codexOption).toBeDisabled();
  });

  it("still renders the frontier watch composer below the runtime settings", async () => {
    vi.stubGlobal("fetch", buildFetchStub());

    render(<SettingsPage />);

    expect(await screen.findByText("What should ScienceSwarm watch for this project?")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Generate Specific Search Prompt" })).toBeInTheDocument();
  });
});
