import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

export function resolveDesktopStartUrl(env = process.env) {
  const explicitUrl = env.SCIENCESWARM_DESKTOP_URL?.trim();
  if (explicitUrl) {
    return explicitUrl;
  }

  const host = env.FRONTEND_PUBLIC_HOST?.trim()
    || env.FRONTEND_HOST?.trim()
    || "127.0.0.1";
  const port = env.FRONTEND_PORT?.trim() || "3001";
  const protocol = env.FRONTEND_USE_HTTPS === "false" ? "http" : "https";
  return `${protocol}://${host}:${port}`;
}

export function resolveStandaloneEntry(root = projectRoot) {
  return path.join(root, "scripts", "start-standalone.mjs");
}

export async function launchDesktopShell(options = {}) {
  const [{ app, BrowserWindow }, { startStandaloneServer }] = await Promise.all([
    import("electron"),
    import(pathToFileURL(resolveStandaloneEntry(options.projectRoot)).href),
  ]);

  const startUrl = resolveDesktopStartUrl(options.env);

  await app.whenReady();
  await startStandaloneServer({
    cwd: options.projectRoot,
    env: options.env,
  });

  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: "#f4f4ef",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, "preload.mjs"),
    },
  });

  await window.loadURL(startUrl);

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const nextWindow = new BrowserWindow({
        width: 1440,
        height: 960,
        minWidth: 1100,
        minHeight: 720,
        backgroundColor: "#f4f4ef",
        autoHideMenuBar: true,
        webPreferences: {
          contextIsolation: true,
          sandbox: true,
          preload: path.join(__dirname, "preload.mjs"),
        },
      });
      await nextWindow.loadURL(startUrl);
    }
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
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
