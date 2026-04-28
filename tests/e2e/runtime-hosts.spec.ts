import { expect, test, type Page, type Route } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

const PROJECT_ID = "project-alpha";
const NOW = "2026-04-23T02:00:00.000Z";

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

const HOST_PROFILES = new Map([
  [OPENCLAW_PROFILE.id, OPENCLAW_PROFILE],
  [CODEX_PROFILE.id, CODEX_PROFILE],
  [GEMINI_PROFILE.id, GEMINI_PROFILE],
]);

function profileForHost(hostId: string): typeof OPENCLAW_PROFILE {
  return HOST_PROFILES.get(hostId) ?? OPENCLAW_PROFILE;
}

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
  const selectedProfiles = selectedHostIds.map(profileForHost);
  const hostedProfile = selectedProfiles.find((profile) => profile.privacyClass === "hosted");
  const primaryProfile = profileForHost(input.hostId);
  const disclosureProfile = hostedProfile ?? primaryProfile;
  const effectivePrivacyClass = hostedProfile ? "hosted" : "local-network";
  return {
    allowed: true,
    projectPolicy: input.projectPolicy,
    hostId: input.hostId,
    mode: input.mode,
    effectivePrivacyClass,
    destinations: selectedProfiles.map((profile) => ({
      hostId: profile.id,
      label: profile.label,
      privacyClass: profile.privacyClass,
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
      operationPrivacyClass: effectivePrivacyClass,
      adapterProof: hostedProfile ? "declared-hosted" : "declared-local",
    },
    blockReason: null,
    requiresUserApproval: input.requiresUserApproval ?? Boolean(hostedProfile),
    accountDisclosure: {
      authMode: disclosureProfile.authMode,
      provider: disclosureProfile.authProvider,
      billingClass: disclosureProfile.authMode === "subscription-native"
        ? "subscription"
        : "local-compute",
      accountSource: disclosureProfile.authMode === "subscription-native"
        ? "host-cli-login"
        : "local-service",
      costCopyRequired: false,
    },
    hostLabel: input.hostLabel,
  };
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

interface ReadyRuntimeServer {
  baseUrl: string;
  process: ChildProcess | null;
  runtimeHome: string | null;
  distDir: string | null;
  tsconfigPath: string | null;
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Could not allocate a runtime e2e port.")));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

async function waitForReadyServer(
  baseUrl: string,
  child: ChildProcess,
  logs: string[],
): Promise<void> {
  const deadline = Date.now() + 180_000;
  let exited = false;
  child.once("exit", (code, signal) => {
    exited = true;
    logs.push(`[exit] code=${code ?? "null"} signal=${signal ?? "null"}`);
  });

  while (Date.now() < deadline) {
    if (exited) {
      throw new Error(`Runtime host e2e server exited before ready:\n${logs.join("\n")}`);
    }
    try {
      const response = await fetch(`${baseUrl}/setup`);
      if (response.ok) return;
    } catch {
      // Server is still booting.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`Timed out waiting for runtime host e2e server:\n${logs.join("\n")}`);
}

async function startReadyRuntimeServer(): Promise<ReadyRuntimeServer> {
  const externalBaseUrl = process.env.E2E_RUNTIME_HOSTS_BASE_URL?.trim();
  if (externalBaseUrl) {
    return {
      baseUrl: externalBaseUrl.replace(/\/$/, ""),
      process: null,
      runtimeHome: null,
      distDir: null,
      tsconfigPath: null,
    };
  }

  const port = process.env.E2E_RUNTIME_HOSTS_PORT
    ? Number(process.env.E2E_RUNTIME_HOSTS_PORT)
    : await getFreePort();
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("E2E_RUNTIME_HOSTS_PORT must be a positive integer.");
  }

  const runtimeHome = await fs.mkdtemp(path.join(tmpdir(), "scienceswarm-runtime-hosts-e2e-"));
  const brainRoot = path.join(runtimeHome, "brain");
  await fs.mkdir(brainRoot, { recursive: true });
  const distDir = `.omc/next-runtime-hosts-e2e-${process.pid}-${port}`;
  const distDirPath = path.join(process.cwd(), distDir);
  const tsconfigPath = `tsconfig.runtime-hosts-e2e-${process.pid}-${port}.json`;
  await fs.mkdir(distDirPath, { recursive: true });
  await fs.writeFile(
    path.join(process.cwd(), tsconfigPath),
    "{\n  \"extends\": \"./tsconfig.json\"\n}\n",
  );
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    FRONTEND_PORT: String(port),
    PORT: String(port),
    NEXT_DIST_DIR: distDir,
    NEXT_TSCONFIG_PATH: tsconfigPath,
    AGENT_BACKEND: "openclaw",
    LLM_PROVIDER: "local",
    OLLAMA_MODEL: "gemma4:e4b",
    SCIENCESWARM_HOME: runtimeHome,
    SCIENCESWARM_DIR: runtimeHome,
    BRAIN_ROOT: brainRoot,
    SCIENCESWARM_USER_HANDLE: "smoke-test",
    ENABLE_RADAR_RUNNER: "false",
    OPENAI_API_KEY: "",
  };
  const logs: string[] = [];
  const child = spawn("npm", ["run", "dev"], {
    cwd: process.cwd(),
    detached: true,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const capture = (chunk: Buffer | string) => {
    logs.push(chunk.toString());
    while (logs.join("").length > 8000) logs.shift();
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);

  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForReadyServer(baseUrl, child, logs);
  } catch (error) {
    await stopReadyRuntimeServer({
      baseUrl,
      process: child,
      runtimeHome,
      distDir,
      tsconfigPath,
    });
    throw error;
  }

  return {
    baseUrl,
    process: child,
    runtimeHome,
    distDir,
    tsconfigPath,
  };
}

async function stopReadyRuntimeServer(server: ReadyRuntimeServer): Promise<void> {
  if (server.process?.pid) {
    const pid = server.process.pid;
    const exited = new Promise<void>((resolve) => {
      server.process?.once("exit", () => resolve());
    });
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      // Already stopped.
    }
    const stopped = await Promise.race([
      exited.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000)),
    ]);
    if (!stopped) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // Already stopped.
      }
    }
  }
  if (server.runtimeHome) {
    await fs.rm(server.runtimeHome, { recursive: true, force: true });
  }
  if (server.tsconfigPath) {
    await fs.rm(path.join(process.cwd(), server.tsconfigPath), { force: true });
  }
  if (server.distDir) {
    try {
      await fs.rm(path.join(process.cwd(), server.distDir), {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 250,
      });
    } catch (error) {
      console.warn(
        "[runtime-hosts.spec] Could not remove isolated Next cache",
        error instanceof Error ? error.name : "unknown_error",
      );
    }
  }
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
        ollamaModels: ["gemma4:e4b"],
        configuredLocalModel: "gemma4:e4b",
      });
      return;
    }

    if (url.pathname === "/api/chat/unified" && method === "POST") {
      state.chatSends += 1;
      await fulfillJson(route, {
        response: "OpenClaw local response from gemma4:e4b",
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

    if (url.pathname === "/api/scheduler") {
      await fulfillJson(route, { jobs: [], pipelines: [] });
      return;
    }

    if (url.pathname === "/api/scienceswarm-auth/status") {
      await fulfillJson(route, {
        detail: "",
        expiresAt: null,
        signedIn: false,
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
            error: "Local-only policy blocks Codex because it would send data to a third party.",
          },
          403,
        );
        return;
      }

      await fulfillJson(route, {
        preview: turnPreview({
          hostId: body.hostId,
          hostLabel: profileForHost(body.hostId).label,
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
        label: profileForHost(body.hostId).label,
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
        nextMove: { recommendation: "Review where data will be sent before sending third-party work." },
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

    if (url.pathname === "/api/studies") {
      await fulfillJson(route, {
        studies: [
          {
            id: PROJECT_ID,
            slug: PROJECT_ID,
            name: "Study Alpha",
            status: "active",
          },
        ],
      });
      return;
    }

    console.warn(`[runtime-hosts.spec] Unmocked API route: ${method} ${url.pathname}`);
    await fulfillJson(
      route,
      { error: `Unmocked API route: ${method} ${url.pathname}` },
      404,
    );
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

async function openProjectRuntimeSettings(page: Page, baseUrl: string): Promise<void> {
  await page.goto(`${baseUrl}/dashboard/settings?project=${PROJECT_ID}`);
  await expect(page.getByTestId("project-runtime-project-select")).toHaveValue(PROJECT_ID);
  await expect(page.getByTestId("runtime-picker")).toBeVisible();
}

async function sendProjectPrompt(page: Page, prompt: string): Promise<void> {
  const input = page.getByTestId("chat-input");
  await expect(input).toBeVisible();
  await expect(input).toBeEnabled();
  await input.click();
  await input.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  await input.press("Backspace");
  await input.pressSequentially(prompt);
  await expect(input).toHaveValue(prompt);

  const sendButton = page.getByRole("button", { name: "Send" });
  await expect(sendButton).toBeVisible();
  await expect(sendButton).toBeEnabled();
  await sendButton.click();
}

async function clearBrowserStorage(page: Page, baseUrl: string): Promise<void> {
  await page.goto(baseUrl);
  await page.evaluate(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });
}

test.describe.serial("runtime hosts rollout smoke", () => {
  let readyServer: ReadyRuntimeServer;

  test.beforeAll(async () => {
    readyServer = await startReadyRuntimeServer();
  });

  test.afterAll(async () => {
    await stopReadyRuntimeServer(readyServer);
  });

  test("keeps OpenClaw as the local-only default and blocks third-party destinations", async ({
    page,
  }) => {
    const state = await installRuntimeRoutes(page);
    await clearBrowserStorage(page, readyServer.baseUrl);

    await openProjectRuntimeSettings(page, readyServer.baseUrl);

    await expect(page.getByTestId("runtime-project-policy")).toHaveValue("local-only");
    await expect(page.getByTestId("runtime-host-select")).toHaveValue("openclaw");
    const codexOption = page.locator('[data-testid="runtime-host-select"] option[value="codex"]');
    await expect(codexOption).toHaveAttribute("disabled", "");
    await expect(codexOption).toContainText("Requires cloud-ok");
    await expect(page.getByTestId("runtime-selected-summary")).toContainText("OpenClaw");
    await expect(page.getByTestId("runtime-selected-summary")).toContainText("Ready to send");

    await page.goto(`${readyServer.baseUrl}/dashboard/project?name=${PROJECT_ID}`);

    await expect(page.locator('[data-testid="runtime-picker"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="runtime-task-board"]')).toHaveCount(0);

    await sendProjectPrompt(page, "Use the local OpenClaw path.");

    await expect(page.getByText("OpenClaw local response from gemma4:e4b")).toBeVisible();
    expect(state.chatSends).toBe(1);
    expect(state.previewRequests).toBe(0);
  });

  test("requires third-party review approval and keeps recovery visible in sessions", async ({
    page,
  }) => {
    await installRuntimeRoutes(page);
    await clearBrowserStorage(page, readyServer.baseUrl);

    await openProjectRuntimeSettings(page, readyServer.baseUrl);
    await expect(page.getByTestId("runtime-selected-summary")).toContainText("Ready to send");
    await selectRuntimePolicy(page, "cloud-ok");
    await expect(page.locator('[data-testid="runtime-host-select"] option[value="codex"]'))
      .not.toHaveAttribute("disabled", "");
    await page.getByTestId("runtime-host-select").selectOption("codex");
    await expect(page.getByTestId("runtime-host-select")).toHaveValue("codex");
    await page.getByTestId("runtime-mode-task").click();

    await page.goto(`${readyServer.baseUrl}/dashboard/project?name=${PROJECT_ID}`);
    await sendProjectPrompt(page, "Run a third-party task and write the summary.");

    const preview = page.getByTestId("turn-preview-sheet");
    await expect(preview).toBeVisible();
    await expect(preview).toContainText("Review before sending");
    await expect(preview).not.toContainText("Approval required");
    await expect(preview).toContainText("Codex");
    await expect(preview).toContainText("User prompt");

    await page.getByRole("button", { name: "Approve and send" }).click();

    await expect(preview).toBeHidden();
    await openProjectRuntimeSettings(page, readyServer.baseUrl);
    const taskBoard = page.getByTestId("runtime-task-board");
    await expect(taskBoard).toContainText("Codex");
    await expect(taskBoard).toContainText("failed");
    await expect(taskBoard).toContainText("No cancel control");

    await taskBoard.getByRole("button", { name: "Codex" }).click();
    const detail = page.getByTestId("runtime-session-detail");
    await expect(detail).toContainText("results/summary.md");
    await expect(detail).toContainText("gbrain-writeback-failed");
    await expect(detail).toContainText("Retry from the composer after changing destination or policy.");
  });

  test("shows compare partial failures without hiding synthesis provenance", async ({
    page,
  }) => {
    await installRuntimeRoutes(page);
    await clearBrowserStorage(page, readyServer.baseUrl);

    await openProjectRuntimeSettings(page, readyServer.baseUrl);
    await expect(page.getByTestId("runtime-selected-summary")).toContainText("Ready to send");
    await selectRuntimePolicy(page, "cloud-ok");
    await expect(page.locator('[data-testid="runtime-host-select"] option[value="codex"]'))
      .not.toHaveAttribute("disabled", "");
    await page.getByTestId("runtime-mode-compare").click();
    await page.getByTestId("runtime-compare-hosts").getByLabel("Codex").check();

    await page.goto(`${readyServer.baseUrl}/dashboard/project?name=${PROJECT_ID}`);
    await sendProjectPrompt(page, "Compare the AI destination answers.");

    await expect(page.getByTestId("turn-preview-sheet")).toContainText("Codex");
    await page.getByRole("button", { name: "Approve and send" }).click();

    const results = page.getByTestId("compare-results");
    await expect(results).toBeVisible();
    await expect(results).toContainText("Partial failure");
    await expect(results).toContainText("OpenClaw answer");
    await expect(results).toContainText("Codex auth expired");
    await expect(results).toContainText("Synthesis preview");

    await openProjectRuntimeSettings(page, readyServer.baseUrl);
    await expect(page.getByTestId("runtime-task-board")).toContainText("compare");
  });
});
