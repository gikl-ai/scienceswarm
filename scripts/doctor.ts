#!/usr/bin/env npx tsx
/**
 * doctor - local ScienceSwarm readiness checks.
 *
 * This is intentionally read-only. It tells a new user what is ready,
 * what is optional, and what exact action fixes the next blocker.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { runOpenClawSync } from "@/lib/openclaw/runner";
import { isStrictLocalOnlyEnabled } from "@/lib/env-flags";
import {
  buildRuntimeCapabilityContract,
  buildOpenHandsLocalEvidenceSnapshot,
  ollamaModelMatches,
  readOpenHandsLocalEvidenceSync,
  resolveConfiguredLocalModel,
} from "@/lib/runtime";
import { DEFAULT_PORTS } from "@/lib/config/ports";

type Status = "ok" | "warn" | "fail";

interface Check {
  name: string;
  status: Status;
  detail: string;
  fix?: string;
}

interface CheckSet {
  node: Check;
  dependencies: Check;
  env: Check;
  ollama: Check;
  openclaw: Check;
  telegram: Check;
  brain: Check;
  docker: Check;
}

function expandPath(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return resolve(homedir(), value.slice(2));
  return resolve(value);
}

function parseEnv(contents: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

function command(name: string, args: string[] = [], timeoutMs = 5000) {
  return spawnSync(name, args, {
    encoding: "utf8",
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function hasCommand(name: string): boolean {
  return command("sh", ["-lc", `command -v ${name}`], 2000).status === 0;
}

function checkNode(): Check {
  const major = Number(process.versions.node.split(".")[0]);
  if (major >= 22) {
    return {
      name: "Node.js",
      status: "ok",
      detail: `v${process.versions.node}`,
    };
  }
  return {
    name: "Node.js",
    status: "fail",
    detail: `v${process.versions.node}; ScienceSwarm requires Node 22+`,
    fix: "Install Node 22. The pinned version is in .node-version.",
  };
}

function checkDependencies(): Check {
  if (existsSync("node_modules/.package-lock.json")) {
    return {
      name: "npm dependencies",
      status: "ok",
      detail: "node_modules exists",
    };
  }
  return {
    name: "npm dependencies",
    status: "fail",
    detail: "node_modules is missing",
    fix: "Run ./install.sh or npm install.",
  };
}

function checkDocker(): Check {
  if (!hasCommand("docker")) {
    return {
      name: "Docker/OpenHands",
      status: "warn",
      detail: "docker command not found",
      fix: "Install Docker Desktop or Docker Engine if you want OpenHands code execution.",
    };
  }
  const info = command("docker", ["info"], 5000);
  if (info.status === 0) {
    return {
      name: "Docker/OpenHands",
      status: "ok",
      detail: "Docker daemon is running",
    };
  }
  return {
    name: "Docker/OpenHands",
    status: "warn",
    detail: "Docker is installed but the daemon is not reachable",
    fix: "Open Docker Desktop or start the docker service, then rerun npm run doctor.",
  };
}

function listOllamaModels(): { running: boolean; models: string[] } {
  if (!hasCommand("ollama")) {
    return { running: false, models: [] };
  }
  const list = command("ollama", ["list"], 5000);
  if (list.status !== 0) {
    return { running: false, models: [] };
  }
  const models = list.stdout
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/)[0] ?? "")
    .filter((model) => model.length > 0 && model !== "NAME");
  return { running: true, models };
}

function checkOllama(env: Record<string, string>): Check {
  const configuredModel = resolveConfiguredLocalModel(env);
  if (!hasCommand("ollama")) {
    return {
      name: "Local model",
      status: "fail",
      detail: "ollama command not found",
      fix: "Run ./install.sh, open /setup, or install Ollama from https://ollama.com/download.",
    };
  }
  const list = command("ollama", ["list"], 5000);
  if (list.status !== 0) {
    return {
      name: "Local model",
      status: "fail",
      detail: "Ollama is installed but not responding",
      fix: "Start Ollama, then rerun npm run doctor.",
    };
  }
  const models = list.stdout
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/)[0] ?? "")
    .filter((model) => model.length > 0 && model !== "NAME");
  if (models.some((model) => ollamaModelMatches(configuredModel, model))) {
    return {
      name: "Local model",
      status: "ok",
      detail: `${configuredModel} is installed`,
    };
  }
  return {
    name: "Local model",
    status: "fail",
    detail: `${configuredModel} is not installed`,
    fix: `Run ollama pull ${configuredModel}.`,
  };
}

function checkOpenClaw(): Check {
  if (!hasCommand("openclaw")) {
    return {
      name: "OpenClaw",
      status: "fail",
      detail: "openclaw command not found",
      fix: "Open /setup to install OpenClaw, or run npm install -g openclaw@latest.",
    };
  }
  const health = runOpenClawSync(["health"], { timeoutMs: 5000 });
  const healthOutput = health ? `${health.stdout}\n${health.stderr}` : "";
  if (health && !/\b(unreachable|not ok|error)\b/i.test(healthOutput)) {
    return {
      name: "OpenClaw",
      status: "ok",
      detail: "openclaw health succeeded",
    };
  }
  return {
    name: "OpenClaw",
    status: "warn",
    detail: "OpenClaw health did not pass",
    fix: "Open /setup to install or reconnect OpenClaw, or run ./start.sh so ScienceSwarm can start the gateway.",
  };
}

function checkEnv(env: Record<string, string>): Check {
  const provider = env.LLM_PROVIDER || "local";
  if (env.OPENAI_API_KEY?.trim()) {
    return {
      name: "LLM mode",
      status: "ok",
      detail: `Optional OPENAI_API_KEY is configured; provider=${provider}`,
    };
  }
  return {
    name: "LLM mode",
    status: "ok",
    detail: `Local-first mode; provider=${provider}. OpenAI API keys are optional cloud fallback.`,
  };
}

function checkBrain(env: Record<string, string>): Check {
  const dataRoot = expandPath(env.SCIENCESWARM_DIR || "~/.scienceswarm");
  const brainRoot = expandPath(env.BRAIN_ROOT || join(dataRoot, "brain"));
  const brainMd = join(brainRoot, "BRAIN.md");
  const pglite = expandPath(env.BRAIN_PGLITE_PATH || join(brainRoot, "brain.pglite"));

  if (!existsSync(brainRoot)) {
    return {
      name: "Research brain",
      status: "fail",
      detail: `brain root missing at ${brainRoot}`,
      fix: "Open /setup to initialize the local store, then import your first corpus from /dashboard/project.",
    };
  }
  if (!existsSync(brainMd)) {
    return {
      name: "Research brain",
      status: "warn",
      detail: `brain root exists but BRAIN.md is missing at ${brainMd}`,
      fix: "Rerun /setup or npm run install:gbrain.",
    };
  }
  if (!existsSync(pglite)) {
    return {
      name: "Research brain",
      status: "warn",
      detail: `BRAIN.md exists but PGLite store is missing at ${pglite}`,
      fix: "Rerun /setup or npm run install:gbrain.",
    };
  }
  return {
    name: "Research brain",
    status: "ok",
    detail: `initialized at ${brainRoot}. Import data if page count is still zero.`,
  };
}

function checkTelegram(env: Record<string, string>): Check {
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_USER_ID) {
    return {
      name: "Telegram",
      status: "ok",
      detail: "bot token and user id are saved in .env",
    };
  }
  return {
    name: "Telegram",
    status: "warn",
    detail: "Telegram is not fully linked yet",
    fix: "Open /setup, enter the mobile number linked to your Telegram account, then enter the login code from Telegram or SMS.",
  };
}

function resolveOpenHandsUrl(env: Record<string, string>): string {
  const configured = env.OPENHANDS_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  const configuredPort = Number(env.OPENHANDS_PORT);
  const port =
    Number.isInteger(configuredPort)
    && configuredPort >= 1
    && configuredPort <= 65_535
      ? configuredPort
      : DEFAULT_PORTS.openhands;
  return `http://localhost:${port}`;
}

function probeOpenHands(url: string): "connected" | "disconnected" {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "disconnected";
    }
  } catch {
    return "disconnected";
  }

  const probe = command(
    process.execPath,
    [
      "-e",
      `fetch(${JSON.stringify(url)}, { signal: AbortSignal.timeout(2500) }).then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))`,
    ],
    4000,
  );
  return probe.status === 0 ? "connected" : "disconnected";
}

function icon(status: Status): string {
  if (status === "ok") return "OK";
  if (status === "warn") return "WARN";
  return "FAIL";
}

function buildDoctorRuntimeContract(env: Record<string, string>, checks: CheckSet) {
  const provider = env.LLM_PROVIDER?.trim().toLowerCase() === "openai"
    ? "openai"
    : "local";
  const ollama = listOllamaModels();
  const agentType = env.AGENT_BACKEND?.trim().toLowerCase()
    || (checks.openclaw.status === "ok" ? "openclaw" : "none");
  const brainReady = checks.brain.status === "ok";
  const openHandsLocalEvidence = buildOpenHandsLocalEvidenceSnapshot({
    env,
    evidence: readOpenHandsLocalEvidenceSync(env),
  });
  const openHandsUrl = resolveOpenHandsUrl(env);
  const openHandsStatus = probeOpenHands(openHandsUrl);

  return buildRuntimeCapabilityContract({
    strictLocalOnly: isStrictLocalOnlyEnabled(env),
    llmProvider: provider,
    localModel: resolveConfiguredLocalModel(env),
    ollama,
    agent: {
      type: agentType,
      status: checks.openclaw.status === "ok" ? "connected" : "disconnected",
    },
    openhands: {
      status: openHandsStatus,
      url: openHandsUrl,
      ...openHandsLocalEvidence,
    },
    openaiKeyConfigured: Boolean(env.OPENAI_API_KEY?.trim()),
    structuredCritiqueConfigured: Boolean(
      env.STRUCTURED_CRITIQUE_SERVICE_URL?.trim()
      && env.STRUCTURED_CRITIQUE_SERVICE_TOKEN?.trim(),
    ),
    telegramConfigured: Boolean(
      env.TELEGRAM_BOT_TOKEN?.trim() && env.TELEGRAM_USER_ID?.trim(),
    ),
    gbrain: {
      read: brainReady,
      write: brainReady,
      capture: brainReady,
      maintenance: brainReady,
      uploadFiles: brainReady,
      localFolder: brainReady,
    },
  });
}

function printRuntimeCapabilities(env: Record<string, string>, checks: CheckSet) {
  const contract = buildDoctorRuntimeContract(env, checks);
  console.log("\nRuntime capabilities\n");
  for (const capability of contract.capabilities) {
    const model = capability.model ? ` model=${capability.model}` : "";
    console.log(
      `${capability.status.toUpperCase().padEnd(13)} ${capability.capabilityId.padEnd(28)} ${capability.privacy}${model}`,
    );
    if (capability.nextAction) {
      console.log(`      Next: ${capability.nextAction}`);
    }
  }
}

function main() {
  const env = existsSync(".env") ? parseEnv(readFileSync(".env", "utf8")) : {};
  const checkSet: CheckSet = {
    node: checkNode(),
    dependencies: checkDependencies(),
    env: checkEnv(env),
    ollama: checkOllama(env),
    openclaw: checkOpenClaw(),
    telegram: checkTelegram(env),
    brain: checkBrain(env),
    docker: checkDocker(),
  };
  const checks = Object.values(checkSet);

  console.log("\nScienceSwarm doctor\n");
  for (const check of checks) {
    console.log(`${icon(check.status).padEnd(5)} ${check.name}: ${check.detail}`);
    if (check.fix) console.log(`      Fix: ${check.fix}`);
  }
  printRuntimeCapabilities(env, checkSet);

  const failures = checks.filter((check) => check.status === "fail").length;
  const warnings = checks.filter((check) => check.status === "warn").length;
  console.log(
    `\nResult: ${failures} failure(s), ${warnings} warning(s). Local Gemma is the primary path; OpenAI APIs are optional.\n`,
  );

  process.exitCode = failures > 0 ? 1 : 0;
}

main();
