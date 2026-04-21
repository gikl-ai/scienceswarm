// POST /api/settings/openclaw — install, configure, start, stop
// GET  /api/settings/openclaw — status

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { isStrictLocalOnlyEnabled } from "@/lib/env-flags";
import { isLocalRequest } from "@/lib/local-guard";
import { OLLAMA_RECOMMENDED_MODEL } from "@/lib/ollama-constants";
import { getOpenClawPort } from "@/lib/config/ports";
import {
  buildOpenClawOllamaProviderConfig,
  OPENCLAW_OLLAMA_PROVIDER_KEY,
} from "@/lib/openclaw/ollama-provider";
import { resolveOpenAIModel } from "@/lib/openai-models";
import {
  isLocalOpenClawGatewayUrl,
  isOpenClawGatewayReachable,
} from "@/lib/openclaw/reachability";
import {
  killGatewayByPid,
  resolveOpenClawMode,
  runOpenClaw,
  spawnOpenClaw,
  writeGatewayPid,
} from "@/lib/openclaw/runner";
import { getOpenClawStatus } from "@/lib/openclaw-status";
import { parseEnvFile } from "@/lib/setup/env-writer";

const exec = promisify(execFile);
const ENV_PATH = resolve(process.cwd(), ".env");
// Canonical default model the rest of the settings surface assumes when
// `LLM_MODEL` is absent from `.env` (see `src/app/api/settings/route.ts`).
// Using this here means a new user who completes /setup without ever
// hand-picking a model still unblocks the OpenClaw Configure + Start
// actions — /api/setup writes LLM_PROVIDER + OLLAMA_MODEL but not
// LLM_MODEL, so a strict null return would leave the buttons permanently
// disabled with an opaque "Choose a model first" hint.
interface PostBody {
  action: string;
  model?: string;
}

async function hasCmd(name: string): Promise<boolean> {
  try {
    await exec("which", [name], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

async function killGatewayByPort(): Promise<boolean> {
  if (!(await hasCmd("lsof"))) {
    return false;
  }

  try {
    const { stdout } = await exec(
      "lsof",
      ["-nP", `-iTCP:${getOpenClawPort()}`, "-sTCP:LISTEN", "-t"],
      { timeout: 5000 },
    );
    const pids = Array.from(
      new Set(
        stdout
          .split(/\s+/)
          .map((value) => Number.parseInt(value, 10))
          .filter((pid) => Number.isFinite(pid) && pid > 0 && pid !== process.pid),
      ),
    );
    if (pids.length === 0) {
      return false;
    }

    for (const pid of pids) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Ignore stale PID races and continue trying the rest.
      }
    }

    await wait(1000);

    for (const pid of pids) {
      try {
        process.kill(pid, 0);
        process.kill(pid, "SIGKILL");
      } catch {
        // Process already exited; no escalation needed.
      }
    }

    return true;
  } catch {
    return false;
  }
}

async function readEffectiveEnv(): Promise<Record<string, string | undefined>> {
  const entries: Record<string, string | undefined> = { ...process.env };
  try {
    const doc = parseEnvFile(await readFile(ENV_PATH, "utf-8"));
    for (const line of doc.lines) {
      if (line.type === "entry") {
        entries[line.key] = line.value;
      }
    }
  } catch {
    // Missing .env is fine; process.env remains the fallback.
  }
  return entries;
}

type SavedLlmProvider = "openai" | "local";

async function getSavedSetupState(): Promise<{
  llmProvider: SavedLlmProvider;
  openAiKey: string | null;
  openAiModel: string;
  ollamaModel: string;
}> {
  const env = await readEffectiveEnv();
  const llmProvider: SavedLlmProvider =
    isStrictLocalOnlyEnabled(env) || env.LLM_PROVIDER?.trim() === "local"
      ? "local"
      : "openai";

  return {
    llmProvider,
    openAiKey: env.OPENAI_API_KEY?.trim() || null,
    openAiModel: resolveOpenAIModel(env.LLM_MODEL),
    ollamaModel:
      env.OLLAMA_MODEL?.trim()
      || OLLAMA_RECOMMENDED_MODEL,
  };
}

function normalizeOpenClawModel(
  model: string,
  llmProvider: SavedLlmProvider,
): string {
  if (llmProvider === "local") {
    if (model.startsWith("ollama/")) return model;
    return `ollama/${model.replace(/^openai\//, "").trim()}`;
  }
  if (model.startsWith("openai/")) return model;
  return `openai/${model.replace(/^ollama\//, "").trim()}`;
}

async function configureOpenClawModel(
  model: string,
  llmProvider: SavedLlmProvider,
): Promise<boolean> {
  if (llmProvider === "local") {
    const providerConfigResult = await runOpenClaw(
      [
        "config",
        "set",
        "models.providers.ollama",
        JSON.stringify(buildOpenClawOllamaProviderConfig(model)),
        "--strict-json",
      ],
      { timeoutMs: 5000 },
    );
    if (!providerConfigResult.ok) {
      return false;
    }
  }

  const modelResult = await runOpenClaw(["models", "set", model], {
    timeoutMs: 5000,
    extraEnv:
      llmProvider === "local"
        ? { OLLAMA_API_KEY: OPENCLAW_OLLAMA_PROVIDER_KEY }
        : undefined,
  });
  return modelResult.ok;
}

async function isOpenClawRunning(): Promise<boolean> {
  return await isOpenClawGatewayReachable();
}
async function wait(ms: number): Promise<void> {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function waitForOpenClawRunning(timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (await isOpenClawRunning()) {
      return true;
    }
    await wait(1_000);
  }
  return false;
}

export async function GET(): Promise<Response> {
  if (!(await isLocalRequest())) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  return Response.json(await getOpenClawStatus());
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
      model: typeof obj.model === "string" ? obj.model : undefined,
    };
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  switch (body.action) {
    case "install": {
      try {
        const status = await getOpenClawStatus();
        if (status.installed) {
          return Response.json({ ok: true, step: "install", alreadyInstalled: true, status });
        }
        if (!(await hasCmd("npm"))) {
          return Response.json({ error: "npm is not installed" }, { status: 400 });
        }
        await exec("npm", ["install", "-g", "openclaw"], { timeout: 300_000 });
        return Response.json({ ok: true, step: "install", status: await getOpenClawStatus() });
      } catch {
        return Response.json({ error: "Install failed" }, { status: 500 });
      }
    }

    case "configure": {
      const status = await getOpenClawStatus();
      if (status.source === "external") {
        return Response.json(
          { error: "OpenClaw is running as an external runtime. Configure it directly." },
          { status: 400 },
        );
      }

      if (!(await hasCmd("openclaw"))) {
        return Response.json({ error: "OpenClaw is not installed" }, { status: 400 });
      }

      const setupState = await getSavedSetupState();
      if (setupState.llmProvider === "openai" && !setupState.openAiKey) {
        return Response.json(
          { error: "Save an OpenAI API key in API Keys & Model first." },
          { status: 400 },
        );
      }

      const model =
        body.model?.trim()
        || (
          setupState.llmProvider === "local"
            ? setupState.ollamaModel
            : setupState.openAiModel
        );
      const normalizedModel = normalizeOpenClawModel(model, setupState.llmProvider);

      const configureSteps: readonly (readonly string[])[] = [
        ["config", "set", "gateway.mode", "local"],
        ["config", "set", "gateway.bind", "loopback"],
        ["config", "validate"],
      ];

      for (const step of configureSteps.slice(0, 2)) {
        const result = await runOpenClaw(step, { timeoutMs: 5000 });
        if (!result.ok) {
          return Response.json({ error: "Configure failed" }, { status: 500 });
        }
      }

      if (!(await configureOpenClawModel(normalizedModel, setupState.llmProvider))) {
        return Response.json({ error: "Configure failed" }, { status: 500 });
      }

      const validateResult = await runOpenClaw(configureSteps[2], { timeoutMs: 5000 });
      if (!validateResult.ok) {
        return Response.json({ error: "Configure failed" }, { status: 500 });
      }

      return Response.json({
        ok: true,
        step: "configure",
        model: normalizedModel,
        status: await getOpenClawStatus(),
      });
    }

    case "start": {
      const alreadyRunning = await isOpenClawRunning();
      if (alreadyRunning) {
        return Response.json({ ok: true, running: true, alreadyRunning: true });
      }

      if (!(await hasCmd("openclaw"))) {
        return Response.json({ error: "OpenClaw is not installed" }, { status: 400 });
      }

      const setupState = await getSavedSetupState();
      if (setupState.llmProvider === "openai" && !setupState.openAiKey) {
        return Response.json(
          { error: "Save an OpenAI API key in API Keys & Model first." },
          { status: 400 },
        );
      }
      // Start doesn't need to resolve the model here — the CLI reads
      // its configured model out of the `openclaw.json` written by
      // Configure. Dropping the lookup is what unblocks Start for a
      // user who jumped straight from /setup into the onboarding flow
      // without ever touching API Keys & Model.

      const extraEnv: Record<string, string> =
        setupState.llmProvider === "openai" && setupState.openAiKey
          ? { OPENAI_API_KEY: setupState.openAiKey }
          : {};

      try {
        const mode = resolveOpenClawMode();

        if (mode.kind === "state-dir") {
          // `openclaw gateway start` can daemonize into upstream's default
          // user-global state instead of preserving OPENCLAW_STATE_DIR. In
          // ScienceSwarm-managed state-dir mode, run the gateway process
          // directly so the wrapper-provided env remains attached.
          const runChild = spawnOpenClaw(
            ["gateway", "run", "--allow-unconfigured"],
            {
              mode,
              extraEnv,
              cwd: process.cwd(),
              detached: true,
              stdio: "ignore",
            },
          );
          if (typeof runChild.pid === "number") {
            writeGatewayPid(runChild.pid, mode);
          }
          runChild.unref();
          return Response.json({ ok: true, running: await waitForOpenClawRunning(10_000) });
        }

        // Try `gateway start` first. It typically exits quickly after
        // daemonizing the gateway; we capture the starter's PID into the
        // pidfile as a baseline so the stop path has something concrete
        // to target even if the daemon has since re-parented.
        const startChild = spawnOpenClaw(["gateway", "start"], {
          mode,
          extraEnv,
          cwd: process.cwd(),
          stdio: "ignore",
          detached: true,
        });
        if (typeof startChild.pid === "number") {
          writeGatewayPid(startChild.pid, mode);
        }
        // Wait briefly for the starter to exit so we can decide whether
        // to fall through to `gateway run --allow-unconfigured`.
        const startExit = await new Promise<number | "timeout">((resolvePromise) => {
          const timer = setTimeout(() => resolvePromise("timeout"), 15_000);
          startChild.once("exit", (code) => {
            clearTimeout(timer);
            resolvePromise(code ?? 0);
          });
          startChild.once("error", () => {
            clearTimeout(timer);
            resolvePromise(-1);
          });
        });
        startChild.unref();

        // If the starter is still running, wait for health instead of
        // spawning a second gateway process on the same port.
        if (startExit !== 0 && startExit !== "timeout") {
          const runChild = spawnOpenClaw(
            ["gateway", "run", "--allow-unconfigured"],
            {
              mode,
              extraEnv,
              cwd: process.cwd(),
              detached: true,
              stdio: "ignore",
            },
          );
          if (typeof runChild.pid === "number") {
            writeGatewayPid(runChild.pid, mode);
          }
          runChild.unref();
        }

        const running = await waitForOpenClawRunning();
        if (!running) {
          return Response.json(
            {
              error:
                "OpenClaw start command ran, but the gateway did not become reachable. Check the OpenClaw logs or retry Start.",
              running: false,
            },
            { status: 503 },
          );
        }
        return Response.json({ ok: true, running: true });
      } catch {
        return Response.json({ error: "Start failed" }, { status: 500 });
      }
    }

    case "stop": {
      if (!isLocalOpenClawGatewayUrl()) {
        return Response.json(
          {
            error:
              "OpenClaw is configured to use an external gateway URL. Stop that runtime directly.",
          },
          { status: 400 },
        );
      }

      try {
        let gracefulStopOk = false;
        if (await hasCmd("openclaw")) {
          const stopResult = await runOpenClaw(["gateway", "stop"], { timeoutMs: 10_000 });
          gracefulStopOk = stopResult.ok;
        }

        await wait(1000);
        let running = await isOpenClawRunning();

        // Safety net: if the graceful stop failed OR the gateway is
        // still reachable afterwards, kill the tracked PID directly.
        // No `pkill -f "openclaw.*gateway"` shotgun — that would kill
        // unrelated OpenClaw profiles the user runs for other tools.
        if (!gracefulStopOk || running) {
          await killGatewayByPid({ graceMs: 2_000 });
        }

        await wait(1000);
        running = await isOpenClawRunning();
        if (running) {
          await killGatewayByPort();
          await wait(1000);
          running = await isOpenClawRunning();
        }
        if (running) {
          return Response.json(
            {
              error:
                "OpenClaw stop command ran, but the gateway is still reachable. Retry Stop or inspect the gateway process.",
              running: true,
            },
            { status: 503 },
          );
        }
        return Response.json({ ok: true, running: false });
      } catch {
        return Response.json({ error: "Stop failed" }, { status: 500 });
      }
    }

    default:
      return Response.json({ error: `Unknown action: ${body.action}` }, { status: 400 });
  }
}
