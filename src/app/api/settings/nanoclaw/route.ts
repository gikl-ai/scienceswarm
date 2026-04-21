// POST /api/settings/nanoclaw — install, configure, start, stop
// GET  /api/settings/nanoclaw — status

import { execFile, spawn } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import * as os from "node:os";

import { isLocalRequest } from "@/lib/local-guard";
import { NANOCLAW_URL } from "@/lib/nanoclaw";

const exec = promisify(execFile);

// NanoClaw lives in ~/.scienceswarm/nanoclaw/ alongside projects and other data
const SCIENCESWARM_HOME = resolve(process.env.SCIENCESWARM_DIR || resolve(os.homedir(), ".scienceswarm"));
const NANOCLAW_DIR = resolve(SCIENCESWARM_HOME, "nanoclaw");
const NANOCLAW_REPO = "https://github.com/gikl-ai/NanoClaw.git";

interface NanoClawStatus {
  cloned: boolean;
  installed: boolean;
  configured: boolean;
  running: boolean;
  version: string | null;
  managed: boolean;
  source: "managed" | "external" | "none";
  url: string;
  steps: {
    clone: boolean;
    install: boolean;
    configure: boolean;
    start: boolean;
  };
}

/* ---------- helpers ---------- */

async function dirExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function getNanoClawHealthUrl(): string {
  try {
    return new URL("/health", NANOCLAW_URL).toString();
  } catch {
    return `${NANOCLAW_URL.replace(/\/+$/, "")}/health`;
  }
}

async function isNanoClawRunning(): Promise<boolean> {
  try {
    const res = await fetch(getNanoClawHealthUrl(), {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { status?: string };
    return data.status === "connected";
  } catch {
    return false;
  }
}

async function getStatus(): Promise<NanoClawStatus> {
  const [cloned, nodeModules, configExists, running] = await Promise.all([
    dirExists(NANOCLAW_DIR),
    dirExists(resolve(NANOCLAW_DIR, "node_modules")),
    dirExists(resolve(NANOCLAW_DIR, ".env")),
    isNanoClawRunning(),
  ]);

  let version: string | null = null;
  if (cloned) {
    try {
      const pkg = JSON.parse(
        await readFile(resolve(NANOCLAW_DIR, "package.json"), "utf-8"),
      ) as { version?: string };
      version = pkg.version ?? null;
    } catch {
      // no package.json
    }
  }

  const managed = cloned && nodeModules;
  const hookedExternal = running && !managed;
  const installed = managed || hookedExternal;
  const configured = configExists || hookedExternal;

  return {
    cloned,
    installed,
    configured,
    running,
    version,
    managed,
    source: hookedExternal ? "external" : managed ? "managed" : "none",
    url: NANOCLAW_URL,
    steps: {
      clone: cloned,
      install: installed,
      configure: configured,
      start: running,
    },
  };
}

/* ---------- GET ---------- */

export async function GET(): Promise<Response> {
  if (!(await isLocalRequest())) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  return Response.json(await getStatus());
}

/* ---------- POST ---------- */

interface PostBody {
  action: string;
  apiKey?: string;
  telegramBotToken?: string;
}

export async function POST(request: Request): Promise<Response> {
  if (!(await isLocalRequest())) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: PostBody;
  try {
    const raw: unknown = await request.json();
    if (typeof raw !== "object" || raw === null) {
      return Response.json({ error: "Invalid body" }, { status: 400 });
    }
    const obj = raw as Record<string, unknown>;
    if (typeof obj.action !== "string") {
      return Response.json({ error: "Missing action" }, { status: 400 });
    }
    body = {
      action: obj.action,
      apiKey: typeof obj.apiKey === "string" ? obj.apiKey : undefined,
      telegramBotToken:
        typeof obj.telegramBotToken === "string"
          ? obj.telegramBotToken
          : undefined,
    };
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { action } = body;
  if (!action) {
    return Response.json({ error: "Missing action" }, { status: 400 });
  }

  switch (action) {
    case "install": {
      try {
        const status = await getStatus();
        if (status.installed) {
          return Response.json({ ok: true, step: "install", alreadyInstalled: true, status });
        }

        // Ensure ~/.scienceswarm/ exists
        await mkdir(SCIENCESWARM_HOME, { recursive: true });

        if (!status.cloned) {
          await exec("git", ["clone", "--depth", "1", NANOCLAW_REPO, NANOCLAW_DIR], {
            timeout: 120_000,
          });
        }
        await exec("npm", ["install"], {
          cwd: NANOCLAW_DIR,
          timeout: 120_000,
        });
        return Response.json({ ok: true, step: "install" });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return Response.json(
          { error: `Install failed: ${message}` },
          { status: 500 },
        );
      }
    }

    case "configure": {
      if (!body.apiKey) {
        return Response.json({ error: "Missing apiKey" }, { status: 400 });
      }

      // Validate OpenAI API key before saving
      try {
        const testRes = await fetch("https://api.openai.com/v1/models", {
          headers: { Authorization: `Bearer ${body.apiKey}` },
          signal: AbortSignal.timeout(5000),
        });
        if (!testRes.ok) {
          return Response.json(
            { error: `Invalid API key (OpenAI returned ${testRes.status})` },
            { status: 400 },
          );
        }
      } catch {
        return Response.json(
          { error: "Could not validate API key — check your network connection" },
          { status: 400 },
        );
      }

      try {
        const envPath = resolve(NANOCLAW_DIR, ".env");
        let existing = "";
        try {
          existing = await readFile(envPath, "utf-8");
        } catch {
          // file doesn't exist yet
        }

        const lines = existing.split("\n");
        const updates: Record<string, string> = {
          OPENAI_API_KEY: body.apiKey,
        };
        if (body.telegramBotToken) {
          updates.TELEGRAM_BOT_TOKEN = body.telegramBotToken;
        }

        // Strip control characters that could inject extra .env entries
        const sanitize = (v: string) => v.replace(/[\r\n]/g, "");

        for (const [key, value] of Object.entries(updates)) {
          const safe = sanitize(value);
          const idx = lines.findIndex((l) => l.trim().startsWith(`${key}=`));
          if (idx >= 0) {
            lines[idx] = `${key}=${safe}`;
          } else {
            lines.push(`${key}=${safe}`);
          }
        }

        await writeFile(envPath, lines.join("\n"), "utf-8");
        return Response.json({ ok: true, step: "configure" });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return Response.json(
          { error: `Configure failed: ${message}` },
          { status: 500 },
        );
      }
    }

    case "start": {
      try {
        if (await isNanoClawRunning()) {
          return Response.json({ ok: true, running: true, alreadyRunning: true });
        }

        const exists = await dirExists(NANOCLAW_DIR);
        if (!exists) {
          return Response.json(
            { error: "NanoClaw not installed" },
            { status: 400 },
          );
        }
        // Start nanoclaw in a detached background process so it outlives
        // the API route's lifecycle.
        const child = spawn("npm", ["start"], {
          cwd: NANOCLAW_DIR,
          detached: true,
          stdio: "ignore",
        });
        child.unref();

        // Wait a moment then check if it started
        await new Promise((r) => setTimeout(r, 2000));
        const running = await isNanoClawRunning();
        return Response.json({ ok: true, running });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return Response.json(
          { error: `Start failed: ${message}` },
          { status: 500 },
        );
      }
    }

    case "stop": {
      try {
        // Find and kill the nanoclaw process
        await exec("pkill", ["-f", "nanoclaw"], { timeout: 5000 }).catch(
          () => {
            // Process may not exist
          },
        );
        return Response.json({ ok: true, running: false });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return Response.json(
          { error: `Stop failed: ${message}` },
          { status: 500 },
        );
      }
    }

    default:
      return Response.json(
        { error: `Unknown action: ${action}` },
        { status: 400 },
      );
  }
}
