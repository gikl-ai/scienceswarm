import { expect, test, type Page, type Route } from "@playwright/test";
import { promises as fs } from "node:fs";
import path from "node:path";

const PROJECT_ID = "project-alpha";
const NOW = "2026-04-23T02:00:00.000Z";
const ENV_PATH = path.join(process.cwd(), ".env");

type RuntimeSessionStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

interface RuntimeSessionFixture {
  id: string;
  hostId: string;
  projectId: string;
  conversationId: string | null;
  mode: "chat" | "task" | "compare";
  status: RuntimeSessionStatus;
  createdAt: string;
  updatedAt: string;
  readOnly?: boolean;
  errorCode?: string;
  host: {
    known: boolean;
    readOnly: boolean;
    id: string;
    label: string;
    profile: {
      lifecycle: { canCancel: boolean };
      controlSurface: { supportsCancel: boolean };
    } | null;
  };
}

interface RuntimeEventFixture {
  id: string;
  sessionId: string;
  hostId: string;
  type: "status" | "message" | "artifact" | "done";
  createdAt: string;
  payload: Record<string, unknown>;
}

function hostProfile(input: {
  id: string;
  label: string;
  authMode: "local" | "subscription-native";
  authProvider: string;
  privacyClass: "local-network" | "hosted";
  requiresProjectPrivacy: "local-only" | "cloud-ok" | "execution-ok";
  capabilities: string[];
  canCancel?: boolean;
}) {
  return {
    id: input.id,
    label: input.label,
    authMode: input.authMode,
    authProvider: input.authProvider,
    privacyClass: input.privacyClass,
    capabilities: input.capabilities,
    requiresProjectPrivacy: input.requiresProjectPrivacy,
    dataSent: ["prompt", "gbrain-excerpt", "workspace-file"],
    storesTokensInScienceSwarm: false,
    transport: {
      kind: input.authMode === "local" ? "desktop-bridge" : "local-cli",
      protocol: input.authMode === "local" ? "websocket" : "stdio",
      command: input.authMode === "local" ? undefined : input.id,
    },
    lifecycle: {
      status: input.authMode === "local" ? "available" : "requires-auth",
      canStream: true,
      canCancel: input.canCancel ?? true,
      canResumeNativeSession: false,
      canListNativeSessions: false,
      cancelSemantics: "kill-wrapper-process",
      resumeSemantics: "scienceSwarm-wrapper-session",
    },
    controlSurface: {
      owner: "scienceSwarm-wrapper",
      sessionIdSource: "scienceSwarm",
      supportsCancel: input.canCancel ?? true,
      supportsResume: false,
      supportsNativeSessionList: false,
    },
    mcpToolProfile: {
      alwaysExposeTools: ["gbrain_read", "gbrain_write", "provenance_log"],
      conditionalWorkspaceTools: ["project_workspace_read", "artifact_import"],
      suppressWhenNativeToolsSafe: [],
    },
    accountDisclosure: {
      storesTokensInScienceSwarm: false,
      requiresProjectPrivacy: input.requiresProjectPrivacy,
    },
    mcpTools: ["gbrain_read", "gbrain_write", "provenance_log"],
  };
}

const OPENCLAW_PROFILE = hostProfile({
  id: "openclaw",
  label: "OpenClaw",
  authMode: "local",
  authProvider: "openclaw",
  privacyClass: "local-network",
  requiresProjectPrivacy: "local-only",
  capabilities: ["chat", "stream", "cancel", "resume", "mcp-tools"],
});

const CODEX_PROFILE = hostProfile({
  id: "codex",
  label: "Codex",
  authMode: "subscription-native",
  authProvider: "openai",
  privacyClass: "hosted",
  requiresProjectPrivacy: "cloud-ok",
  capabilities: ["chat", "task", "stream", "cancel", "mcp-tools", "artifact-import"],
});

const GEMINI_PROFILE = hostProfile({
  id: "gemini-cli",
  label: "Gemini CLI",
  authMode: "subscription-native",
  authProvider: "google-ai",
  privacyClass: "hosted",
  requiresProjectPrivacy: "cloud-ok",
  capabilities: ["chat", "task", "stream", "cancel", "mcp-tools", "artifact-import"],
});

function healthHost(profile: typeof OPENCLAW_PROFILE, authStatus = "authenticated") {
  return {
    profile,
    health: {
      status: authStatus === "authenticated" ? "ready" : "unavailable",
      checkedAt: NOW,
      detail: authStatus === "authenticated"
        ? `${profile.label} ready`
        : `${profile.label} CLI is installed but not authenticated`,
    },
    auth: {
      status: authStatus,
      authMode: profile.authMode,
      provider: profile.authProvider,
      detail: authStatus === "authenticated"
        ? `${profile.label} authenticated`
        : `Run the ${profile.label} CLI login flow, then refresh runtime health.`,
    },
    privacy: {
      privacyClass: profile.privacyClass,
      adapterProof: profile.privacyClass === "hosted" ? "declared-hosted" : "declared-local",
      observedAt: NOW,
    },
  };
}

function makeSession(input: {
  id: string;
  hostId: string;
  label: string;
  mode: "chat" | "task" | "compare";
  status: RuntimeSessionStatus;
  canCancel?: boolean;
  conversationId?: string | null;
}): RuntimeSessionFixture {
  return {
    id: input.id,
    hostId: input.hostId,
    projectId: PROJECT_ID,
    conversationId: input.conversationId ?? `${input.hostId}-native-session`,
    mode: input.mode,
    status: input.status,
    createdAt: NOW,
    updatedAt: NOW,
    errorCode: input.status === "failed" ? "RUNTIME_TRANSPORT_ERROR" : undefined,
    host: {
      known: true,
      readOnly: false,
      id: input.hostId,
      label: input.label,
      profile: {
        lifecycle: { canCancel: input.canCancel ?? true },
        controlSurface: { supportsCancel: input.canCancel ?? true },
      },
    },
  };
}

function turnPreview(input: {
  hostId: string;
  hostLabel: string;
  projectPolicy: "local-only" | "cloud-ok" | "execution-ok";
  mode: "chat" | "task" | "compare";
  selectedHostIds?: string[];
  requiresUserApproval?: boolean;
}) {
  const selectedHostIds = input.selectedHostIds?.length
    ? input.selectedHostIds
    : [input.hostId];
  return {
    allowed: true,
    projectPolicy: input.projectPolicy,
    hostId: input.hostId,
    mode: input.mode,
    effectivePrivacyClass: selectedHostIds.includes("codex") ? "hosted" : "local-network",
    destinations: selectedHostIds.map((hostId) => ({
      hostId,
      label: hostId === "codex" ? "Codex" : "OpenClaw",
      privacyClass: hostId === "codex" ? "hosted" : "local-network",
    })),
    dataIncluded: [
      {
        kind: "prompt",
        label: "User prompt",
        bytes: 42,
      },
      {
        kind: "gbrain-excerpt",
        label: `${PROJECT_ID} project context`,
        bytes: 128,
      },
    ],
    proof: {
      projectGatePassed: true,
      operationPrivacyClass: selectedHostIds.includes("codex") ? "hosted" : "local-network",
      adapterProof: selectedHostIds.includes("codex") ? "declared-hosted" : "declared-local",
    },
    blockReason: null,
    requiresUserApproval: input.requiresUserApproval ?? selectedHostIds.includes("codex"),
    accountDisclosure: {
      authMode: selectedHostIds.includes("codex") ? "subscription-native" : "local",
      provider: selectedHostIds.includes("codex") ? "openai" : "openclaw",
      billingClass: selectedHostIds.includes("codex") ? "subscription" : "local-compute",
      accountSource: selectedHostIds.includes("codex") ? "host-cli-login" : "local-service",
      costCopyRequired: false,
    },
    hostLabel: input.hostLabel,
  };
}

async function readOptionalFile(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeReadyEnv(): Promise<string | null> {
  const previous = await readOptionalFile(ENV_PATH);
  const runtimeHome = process.env.E2E_TMP_HOME
    ?? path.join(process.cwd(), ".tmp", "runtime-hosts-e2e");
  await fs.mkdir(runtimeHome, { recursive: true });
  await fs.writeFile(
    ENV_PATH,
    [
      "AGENT_BACKEND=openclaw",
      "LLM_PROVIDER=local",
      "OLLAMA_MODEL=gemma4:latest",
      `SCIENCESWARM_DIR=${runtimeHome}`,
      "SCIENCESWARM_USER_HANDLE=smoke-test",
      "",
    ].join("\n"),
  );
  return previous;
}

async function restoreEnv(previous: string | null): Promise<void> {
  if (previous === null) {
    if (process.env.CI) {
      // Next dev reloads `.env` into the shared smoke server process. If this
      // spec simply deletes the ready file, already-loaded readiness keys can
      // leak into later smoke files. Leave CI in an explicit unready state so
      // the fresh-install redirect smoke remains a real fresh-install check.
      await fs.writeFile(
        ENV_PATH,
        [
          "AGENT_BACKEND=none",
          "LLM_PROVIDER=",
          "OLLAMA_MODEL=",
          "OPENAI_API_KEY=",
          "SCIENCESWARM_DIR=",
          "",
        ].join("\n"),
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
      return;
    }
    await fs.rm(ENV_PATH, { force: true });
    return;
  }
  await fs.writeFile(ENV_PATH, previous);
}

interface RuntimeRouteState {
  chatSends: number;
  previewRequests: number;
  sessions: RuntimeSessionFixture[];
  events: Map<string, RuntimeEventFixture[]>;
}

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function installRuntimeRoutes(page: Page): Promise<RuntimeRouteState> {
  const state: RuntimeRouteState = {
    chatSends: 0,
    previewRequests: 0,
    sessions: [
      makeSession({
        id: "rt-history-openclaw",
        hostId: "openclaw",
        label: "OpenClaw",
        mode: "chat",
        status: "completed",
        canCancel: false,
      }),
    ],
    events: new Map(),
  };

  state.events.set("rt-history-openclaw", [
    {
      id: "rt-history-openclaw:done",
      sessionId: "rt-history-openclaw",
      hostId: "openclaw",
      type: "done",
      createdAt: NOW,
      payload: { status: "completed" },
    },
  ]);

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const pathWithSearch = `${url.pathname}${url.search}`;
    const method = request.method();

    if (url.pathname === "/api/health") {
      await fulfillJson(route, {
        openclaw: "connected",
        openhands: "disconnected",
        openai: "configured",
        features: {
          chat: true,
          codeExecution: true,
          github: false,
          multiChannel: false,
          structuredCritique: true,
        },
      });
      return;
    }

    if (pathWithSearch === "/api/chat/unified?action=health") {
      await fulfillJson(route, {
        openclaw: "connected",
        nanoclaw: "disconnected",
        openhands: "disconnected",
        llmProvider: "local",
        ollamaModels: ["gemma4:latest"],
        configuredLocalModel: "gemma4:latest",
      });
      return;
    }

    if (url.pathname === "/api/chat/unified" && method === "POST") {
      state.chatSends += 1;
      await fulfillJson(route, {
        response: "OpenClaw local response from gemma4:latest",
        conversationId: "openclaw-conversation-1",
        messages: [],
      });
      return;
    }

    if (url.pathname === "/api/chat/thread") {
      if (method === "POST") {
        await fulfillJson(route, { ok: true });
        return;
      }
      await fulfillJson(route, {
        version: 1,
        project: PROJECT_ID,
        conversationId: null,
        messages: [],
      });
      return;
    }

    if (url.pathname === "/api/runtime/health") {
      await fulfillJson(route, {
        checkedAt: NOW,
        hosts: [
          healthHost(OPENCLAW_PROFILE),
          healthHost(CODEX_PROFILE),
          healthHost(GEMINI_PROFILE, "missing"),
        ],
      });
      return;
    }

    if (url.pathname === "/api/runtime/preview" && method === "POST") {
      state.previewRequests += 1;
      const body = request.postDataJSON() as {
        hostId: string;
        projectPolicy: "local-only" | "cloud-ok" | "execution-ok";
        mode: "chat" | "task" | "compare";
        selectedHostIds?: string[];
      };
      const selectedHostIds = body.mode === "compare"
        ? body.selectedHostIds ?? []
        : [body.hostId];
      if (
        body.projectPolicy === "local-only"
        && selectedHostIds.some((hostId) => hostId !== "openclaw")
      ) {
        await fulfillJson(
          route,
          {
            code: "RUNTIME_PRIVACY_BLOCKED",
            error: "Project policy local-only blocks hosted runtime hosts before prompt construction.",
          },
          403,
        );
        return;
      }

      await fulfillJson(route, {
        preview: turnPreview({
          hostId: body.hostId,
          hostLabel: body.hostId === "codex" ? "Codex" : "OpenClaw",
          projectPolicy: body.projectPolicy,
          mode: body.mode,
          selectedHostIds,
        }),
      });
      return;
    }

    if (url.pathname === "/api/runtime/sessions") {
      if (method === "GET") {
        await fulfillJson(route, {
          sessions: state.sessions.filter((session) => session.projectId === PROJECT_ID),
        });
        return;
      }

      const body = request.postDataJSON() as {
        hostId: string;
        mode: "chat" | "task";
      };
      const session = makeSession({
        id: `rt-${body.hostId}-${body.mode}-1`,
        hostId: body.hostId,
        label: body.hostId === "codex" ? "Codex" : "OpenClaw",
        mode: body.mode,
        status: body.mode === "task" ? "failed" : "completed",
        canCancel: false,
      });
      state.sessions = [session, ...state.sessions];
      state.events.set(session.id, [
        {
          id: `${session.id}:message`,
          sessionId: session.id,
          hostId: session.hostId,
          type: "message",
          createdAt: NOW,
          payload: { text: "Codex task produced an artifact but writeback failed." },
        },
        {
          id: `${session.id}:artifact`,
          sessionId: session.id,
          hostId: session.hostId,
          type: "artifact",
          createdAt: NOW,
          payload: {
            sourcePath: "results/summary.md",
            writebackPhaseStatus: "gbrain-writeback-failed",
          },
        },
      ]);
      await fulfillJson(route, {
        session,
        events: state.events.get(session.id),
      });
      return;
    }

    const sessionEventsMatch = url.pathname.match(/^\/api\/runtime\/sessions\/([^/]+)\/events$/);
    if (sessionEventsMatch) {
      await fulfillJson(route, {
        events: state.events.get(decodeURIComponent(sessionEventsMatch[1])) ?? [],
      });
      return;
    }

    const sessionCancelMatch = url.pathname.match(/^\/api\/runtime\/sessions\/([^/]+)\/cancel$/);
    if (sessionCancelMatch && method === "POST") {
      const sessionId = decodeURIComponent(sessionCancelMatch[1]);
      state.sessions = state.sessions.map((session) =>
        session.id === sessionId ? { ...session, status: "cancelled" } : session,
      );
      await fulfillJson(route, {
        result: { cancelled: true },
        cancelSemantics: "kill-wrapper-process",
      });
      return;
    }

    const sessionMatch = url.pathname.match(/^\/api\/runtime\/sessions\/([^/]+)$/);
    if (sessionMatch) {
      const sessionId = decodeURIComponent(sessionMatch[1]);
      await fulfillJson(route, {
        session: state.sessions.find((session) => session.id === sessionId) ?? null,
      });
      return;
    }

    if (url.pathname === "/api/runtime/compare" && method === "POST") {
      const parentSession = makeSession({
        id: "rt-compare-parent-1",
        hostId: "openclaw",
        label: "OpenClaw",
        mode: "compare",
        status: "completed",
        canCancel: false,
        conversationId: "compare-parent",
      });
      state.sessions = [parentSession, ...state.sessions];
      await fulfillJson(route, {
        parentSession,
        partialFailure: true,
        childResults: [
          {
            sessionId: "rt-compare-openclaw",
            hostId: "openclaw",
            status: "completed",
            message: "OpenClaw answer",
            error: null,
          },
          {
            sessionId: "rt-compare-codex",
            hostId: "codex",
            status: "failed",
            message: null,
            error: "Codex auth expired",
          },
        ],
        synthesisPreview: turnPreview({
          hostId: "openclaw",
          hostLabel: "OpenClaw",
          projectPolicy: "cloud-ok",
          mode: "chat",
          selectedHostIds: ["openclaw"],
          requiresUserApproval: false,
        }),
      });
      return;
    }

    if (url.pathname === "/api/runtime/artifacts") {
      await fulfillJson(route, {
        validation: { ok: false, reason: "writeback-failed", approvalRequired: false },
        artifact: null,
        writeback: { phaseStatus: "gbrain-writeback-failed", retry: false },
      });
      return;
    }

    if (url.pathname === "/api/brain/status") {
      await fulfillJson(route, { pageCount: 1, backend: "filesystem" });
      return;
    }

    if (url.pathname === "/api/brain/brief") {
      await fulfillJson(route, {
        project: PROJECT_ID,
        generatedAt: NOW,
        nextMove: { recommendation: "Review runtime host disclosures before sending hosted work." },
        topMatters: [],
        unresolvedRisks: [],
        dueTasks: [],
        frontier: [],
      });
      return;
    }

    if (url.pathname === `/api/projects/${PROJECT_ID}/import-summary`) {
      await fulfillJson(route, { project: PROJECT_ID, lastImport: null });
      return;
    }

    if (url.pathname === "/api/workspace") {
      if (method === "POST") {
        await fulfillJson(route, { added: [], updated: [], missing: [], changed: [] });
        return;
      }
      await fulfillJson(route, { tree: [] });
      return;
    }

    if (url.pathname === "/api/workspace/upload") {
      await fulfillJson(route, { uploaded: [] });
      return;
    }

    if (url.pathname === "/api/brain/list") {
      await fulfillJson(route, []);
      return;
    }

    if (url.pathname === "/api/openclaw/slash-commands") {
      await fulfillJson(route, { commands: [] });
      return;
    }

    if (url.pathname === "/api/projects") {
      await fulfillJson(route, {
        projects: [
          {
            id: PROJECT_ID,
            slug: PROJECT_ID,
            name: "Project Alpha",
            status: "active",
          },
        ],
      });
      return;
    }

    await fulfillJson(route, {});
  });

  return state;
}

async function selectRuntimePolicy(
  page: Page,
  value: "local-only" | "cloud-ok" | "execution-ok",
): Promise<void> {
  await page.getByTestId("runtime-project-policy").selectOption(value);
  await expect(page.getByTestId("runtime-project-policy")).toHaveValue(value);
}

test.describe.serial("runtime hosts rollout smoke", () => {
  let previousEnv: string | null;

  test.beforeAll(async () => {
    previousEnv = await writeReadyEnv();
  });

  test.afterAll(async () => {
    await restoreEnv(previousEnv);
  });

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.clear();
      window.sessionStorage.clear();
    });
  });

  test("keeps OpenClaw as the local-only default and blocks hosted hosts", async ({
    page,
  }) => {
    const state = await installRuntimeRoutes(page);

    await page.goto(`/dashboard/project?name=${PROJECT_ID}`);

    await expect(page.getByTestId("runtime-picker")).toBeVisible();
    await expect(page.getByTestId("runtime-project-policy")).toHaveValue("local-only");
    await expect(page.getByTestId("runtime-host-select")).toHaveValue("openclaw");
    const codexOption = page.locator('[data-testid="runtime-host-select"] option[value="codex"]');
    await expect(codexOption).toHaveAttribute("disabled", "");
    await expect(codexOption).toContainText("Requires cloud-ok");
    await expect(page.getByTestId("runtime-selected-summary")).toContainText("OpenClaw");
    await expect(page.getByTestId("runtime-selected-summary")).toContainText("Ready for preview");

    await page.getByTestId("chat-input").fill("Use the local OpenClaw path.");
    await page.getByRole("button", { name: "Send" }).click();

    await expect(page.getByText("OpenClaw local response from gemma4:latest")).toBeVisible();
    expect(state.chatSends).toBe(1);
    expect(state.previewRequests).toBe(0);
  });

  test("requires hosted preview approval and keeps recovery visible in sessions", async ({
    page,
  }) => {
    await installRuntimeRoutes(page);

    await page.goto(`/dashboard/project?name=${PROJECT_ID}`);
    await expect(page.getByTestId("runtime-picker")).toBeVisible();
    await expect(page.getByTestId("runtime-selected-summary")).toContainText("Ready for preview");

    await selectRuntimePolicy(page, "cloud-ok");
    await expect(page.locator('[data-testid="runtime-host-select"] option[value="codex"]'))
      .not.toHaveAttribute("disabled", "");
    await page.getByTestId("runtime-host-select").selectOption("codex");
    await expect(page.getByTestId("runtime-host-select")).toHaveValue("codex");
    await page.getByTestId("runtime-mode-task").click();
    await page.getByTestId("chat-input").fill("Run a hosted task and write the summary.");
    await page.getByRole("button", { name: "Send" }).click();

    const preview = page.getByTestId("turn-preview-sheet");
    await expect(preview).toBeVisible();
    await expect(preview).toContainText("Runtime preview");
    await expect(preview).toContainText("Approval required");
    await expect(preview).toContainText("Codex");
    await expect(preview).toContainText("User prompt");

    await page.getByRole("button", { name: "Approve and send" }).click();

    await expect(preview).toBeHidden();
    const taskBoard = page.getByTestId("runtime-task-board");
    await expect(taskBoard).toContainText("Codex");
    await expect(taskBoard).toContainText("failed");
    await expect(taskBoard).toContainText("No cancel control");

    await taskBoard.getByRole("button", { name: "Codex" }).click();
    const detail = page.getByTestId("runtime-session-detail");
    await expect(detail).toContainText("results/summary.md");
    await expect(detail).toContainText("gbrain-writeback-failed");
    await expect(detail).toContainText("Retry from the composer after changing host or policy.");
  });

  test("shows compare partial failures without hiding synthesis provenance", async ({
    page,
  }) => {
    await installRuntimeRoutes(page);

    await page.goto(`/dashboard/project?name=${PROJECT_ID}`);
    await expect(page.getByTestId("runtime-picker")).toBeVisible();
    await expect(page.getByTestId("runtime-selected-summary")).toContainText("Ready for preview");

    await selectRuntimePolicy(page, "cloud-ok");
    await expect(page.locator('[data-testid="runtime-host-select"] option[value="codex"]'))
      .not.toHaveAttribute("disabled", "");
    await page.getByTestId("runtime-mode-compare").click();
    await page.getByTestId("runtime-compare-hosts").getByLabel("Codex").check();
    await page.getByTestId("chat-input").fill("Compare the runtime host answers.");
    await page.getByRole("button", { name: "Send" }).click();

    await expect(page.getByTestId("turn-preview-sheet")).toContainText("Codex");
    await page.getByRole("button", { name: "Approve and send" }).click();

    const results = page.getByTestId("compare-results");
    await expect(results).toBeVisible();
    await expect(results).toContainText("Partial failure");
    await expect(results).toContainText("OpenClaw answer");
    await expect(results).toContainText("Codex auth expired");
    await expect(results).toContainText("Synthesis preview");
    await expect(page.getByTestId("runtime-task-board")).toContainText("compare");
  });
});
