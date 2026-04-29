import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const DESKTOP_DIAGNOSTICS_CHANNEL = "scienceswarm:desktop-diagnostics";
const DEFAULT_SERVER_READY_TIMEOUT_MS = 30_000;
const DEFAULT_SERVER_READY_INTERVAL_MS = 250;
const DEFAULT_SERVER_READY_REQUEST_TIMEOUT_MS = 1_000;

/**
 * @typedef {Record<string, string | undefined>} DesktopEnv
 */

/**
 * @typedef {{ firstLaunchComplete?: boolean }} DesktopStartOptions
 */

export function resolveDesktopLaunchMarkerPath(app) {
  return path.join(app.getPath("userData"), "desktop-first-launch.json");
}

export function isDesktopFirstLaunchComplete(app) {
  return existsSync(resolveDesktopLaunchMarkerPath(app));
}

export function isTruthyDesktopEnvValue(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? "").trim());
}

/**
 * @param {DesktopEnv} env
 */
export function shouldForceDesktopSetup(env = process.env) {
  return isTruthyDesktopEnvValue(env.SCIENCESWARM_DESKTOP_FORCE_SETUP);
}

/**
 * @param {DesktopEnv} env
 * @param {DesktopStartOptions} options
 */
export function resolveDesktopStartPath(env = process.env, options = {}) {
  const configuredPath = env.SCIENCESWARM_DESKTOP_START_PATH?.trim();
  if (!configuredPath) {
    if (shouldForceDesktopSetup(env)) {
      return "/setup";
    }

    return options.firstLaunchComplete ? "/" : "/setup";
  }

  return configuredPath.startsWith("/") ? configuredPath : `/${configuredPath}`;
}

/**
 * @param {DesktopEnv} env
 * @param {DesktopStartOptions} options
 */
export function resolveDesktopStartUrl(env = process.env, options = {}) {
  const explicitUrl = env.SCIENCESWARM_DESKTOP_URL?.trim();
  if (explicitUrl) {
    return explicitUrl;
  }

  const host = env.FRONTEND_PUBLIC_HOST?.trim()
    || env.FRONTEND_HOST?.trim()
    || env.HOSTNAME?.trim()
    || "127.0.0.1";
  const port = env.FRONTEND_PORT?.trim() || env.PORT?.trim() || "3001";
  const protocol = env.FRONTEND_USE_HTTPS === "true" ? "https" : "http";
  const url = new URL(`${protocol}://${host}:${port}`);
  url.pathname = resolveDesktopStartPath(env, options);
  return url.toString();
}

/**
 * @param {DesktopEnv} env
 */
export function shouldStartStandaloneServer(env = process.env) {
  return !env.SCIENCESWARM_DESKTOP_URL?.trim();
}

export function shouldWaitForDesktopServer(url) {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

export function resolveStandaloneEntry(root = projectRoot) {
  return path.join(root, "scripts", "start-standalone.mjs");
}

export function resolveDesktopWindowOptions() {
  return {
    width: 1440,
    height: 960,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: "#f4f4ef",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, "preload.cjs"),
    },
  };
}

export function markDesktopFirstLaunchComplete(app) {
  try {
    const markerPath = resolveDesktopLaunchMarkerPath(app);
    mkdirSync(path.dirname(markerPath), { recursive: true });
    writeFileSync(markerPath, JSON.stringify({ completedAt: new Date().toISOString() }));
  } catch {
    // Non-fatal: if persistence fails, the next launch can return to /setup.
  }
}

/**
 * @param {{ getPath(name: string): string }} app
 * @param {DesktopEnv} env
 * @param {DesktopStartOptions} options
 */
export function resolveDesktopDiagnostics(app, env = process.env, options = {}) {
  return {
    shell: "electron",
    platform: process.platform,
    startUrl: resolveDesktopStartUrl(env, options),
    userDataPath: app.getPath("userData"),
    logsPath: app.getPath("logs"),
  };
}

/**
 * @param {{ senderFrame?: { url?: string }, sender?: { getURL?: () => string } } | undefined} event
 * @param {DesktopEnv} env
 * @param {DesktopStartOptions} options
 */
export function isTrustedDesktopIpcSender(event, env = process.env, options = {}) {
  const senderUrl = event?.senderFrame?.url || event?.sender?.getURL?.() || "";
  if (!senderUrl) {
    return false;
  }

  try {
    return new URL(senderUrl).origin === new URL(resolveDesktopStartUrl(env, options)).origin;
  } catch {
    return false;
  }
}

/**
 * @param {string} url
 * @param {{
 *   fetch?: typeof globalThis.fetch,
 *   sleep?: (ms: number) => Promise<void>,
 *   timeoutMs?: number,
 *   intervalMs?: number,
 *   requestTimeoutMs?: number,
 * }} options
 */
export async function waitForDesktopServer(url, options = {}) {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("Fetch API is not available for desktop server readiness checks.");
  }

  const intervalMs = options.intervalMs ?? DEFAULT_SERVER_READY_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_SERVER_READY_TIMEOUT_MS;
  const requestTimeoutMs = Math.max(
    1,
    options.requestTimeoutMs ?? DEFAULT_SERVER_READY_REQUEST_TIMEOUT_MS,
  );
  const attempts = Math.max(1, Math.ceil(timeoutMs / Math.max(1, intervalMs)));
  const sleep = options.sleep ?? ((durationMs) =>
    new Promise((resolve) => setTimeout(resolve, durationMs)));
  const startedAt = Date.now();
  let lastError;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const remainingTimeoutMs = timeoutMs - (Date.now() - startedAt);
    if (attempt > 0 && remainingTimeoutMs <= 0) {
      break;
    }

    const controller = new AbortController();
    const requestTimeout = setTimeout(() => {
      controller.abort();
    }, Math.min(requestTimeoutMs, Math.max(1, remainingTimeoutMs || requestTimeoutMs)));

    try {
      const response = await fetchImpl(url, {
        method: "GET",
        signal: controller.signal,
      });
      if (response.ok || response.status < 500) {
        return;
      }

      throw new Error(`Server responded with ${response.status}`);
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(requestTimeout);
    }

    const nextRemainingTimeoutMs = timeoutMs - (Date.now() - startedAt);
    if (attempt < attempts - 1 && nextRemainingTimeoutMs > 0) {
      await sleep(Math.min(intervalMs, nextRemainingTimeoutMs));
    }
  }

  const suffix = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new Error(`Timed out waiting for desktop server at ${url}${suffix}`);
}

export function logDesktopWindowLoadFailure(context, error) {
  console.error(
    `Failed to load ${context}:`,
    error instanceof Error ? error.message : error,
  );
}

export function isDesktopMainEntrypoint({
  argv = process.argv,
  modulePath = fileURLToPath(import.meta.url),
  versions = process.versions,
  processType = process.type,
} = {}) {
  if (versions?.electron && processType === "browser") {
    return true;
  }

  return Boolean(argv[1] && path.resolve(argv[1]) === path.resolve(modulePath));
}

export async function launchDesktopShell(options = {}) {
  const [{ app, BrowserWindow, ipcMain }, { startStandaloneServer }] = await Promise.all([
    import("electron"),
    import(pathToFileURL(resolveStandaloneEntry(options.projectRoot)).href),
  ]);

  await app.whenReady();
  const firstLaunchComplete = isDesktopFirstLaunchComplete(app);
  const startUrl = resolveDesktopStartUrl(options.env, { firstLaunchComplete });
  if (shouldStartStandaloneServer(options.env)) {
    await startStandaloneServer({
      cwd: options.projectRoot,
      env: options.env,
    });
  }
  if (shouldWaitForDesktopServer(startUrl)) {
    await waitForDesktopServer(startUrl, {
      fetch: options.fetch,
      intervalMs: options.serverReadyIntervalMs,
      requestTimeoutMs: options.serverReadyRequestTimeoutMs,
      timeoutMs: options.serverReadyTimeoutMs,
    });
  }
  ipcMain.handle(DESKTOP_DIAGNOSTICS_CHANNEL, (event) => {
    const diagnosticsOptions = {
      firstLaunchComplete: isDesktopFirstLaunchComplete(app),
    };
    if (!isTrustedDesktopIpcSender(event, options.env, diagnosticsOptions)) {
      throw new Error("Blocked desktop diagnostics request from an untrusted renderer.");
    }

    return resolveDesktopDiagnostics(app, options.env, diagnosticsOptions);
  });

  const window = new BrowserWindow(resolveDesktopWindowOptions());

  await window.loadURL(startUrl);
  if (!firstLaunchComplete && !shouldForceDesktopSetup(options.env)) {
    markDesktopFirstLaunchComplete(app);
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const nextWindow = new BrowserWindow(resolveDesktopWindowOptions());
      void nextWindow.loadURL(
        resolveDesktopStartUrl(options.env, {
          firstLaunchComplete: isDesktopFirstLaunchComplete(app),
        }),
      ).catch((error) => {
        logDesktopWindowLoadFailure("reactivated desktop window", error);
      });
    }
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });
}

if (isDesktopMainEntrypoint()) {
  launchDesktopShell({
    projectRoot,
    env: process.env,
  }).catch((error) => {
    console.error(
      error instanceof Error ? error.message : "Failed to launch ScienceSwarm desktop shell.",
    );
    process.exit(1);
  });
}
