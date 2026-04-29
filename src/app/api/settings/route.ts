// GET /api/settings  — returns current settings (keys masked, statuses)
// POST /api/settings — save-key, test-key, save-model, save-agent,
//                      save-telegram, save-slack, health

import { exec, execFile, spawn, type ExecException } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

import { isStrictLocalOnlyEnabled } from "@/lib/env-flags";
import { getOllamaUrl, getOpenHandsUrl } from "@/lib/config/ports";
import { isLocalRequest } from "@/lib/local-guard";
import { isSupportedOpenAIModel, resolveOpenAIModel } from "@/lib/openai-models";
import { getOllamaInstallStatus } from "@/lib/ollama-install";
import { ollamaModelsMatch } from "@/lib/ollama-models";
import { resolveConfiguredLocalModel } from "@/lib/runtime/model-catalog";
import {
  listPendingTelegramPairingRequests,
  selectLatestPendingTelegramPairing,
} from "@/lib/openclaw/telegram-link";
import { getScienceSwarmStateRoot } from "@/lib/scienceswarm-paths";

import {
  mergeEnvValues,
  parseEnvFile,
  serializeEnvDocument,
  writeEnvFileAtomic,
  type EnvDocument,
} from "@/lib/setup/env-writer";
import { resolveSetupEnvPath } from "@/lib/setup/config-root";
import { isValidUserHandle } from "@/lib/setup/user-handle";

type OllamaPullStatus = "running" | "completed" | "failed";

interface OllamaPullJob {
  model: string;
  pid: number | null;
  status: OllamaPullStatus;
  startedAt: number;
  updatedAt: number;
  error: string | null;
}

interface OllamaLibraryModel {
  name: string;
  size: number;
}

interface OllamaLibraryCacheEntry {
  models: OllamaLibraryModel[];
  fetchedAt: number;
}

const ollamaPullJobs = new Map<string, OllamaPullJob>();
let persistOllamaPullJobsQueue: Promise<void> = Promise.resolve();
const OLLAMA_LIBRARY_URL = "https://ollama.com/api/tags";
const OLLAMA_LIBRARY_CACHE_TTL_MS = 30 * 60 * 1000;
const SETTINGS_PENDING_TELEGRAM_PAIRING_TIMEOUT_MS = 500;
let ollamaLibraryCache: OllamaLibraryCacheEntry | null = null;

function getOllamaPullStatePath(): string {
  return join(getScienceSwarmStateRoot(), "ollama", "pull-jobs.json");
}

function isOllamaPullJob(value: unknown): value is OllamaPullJob {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<OllamaPullJob>;
  return (
    typeof candidate.model === "string"
    && (candidate.pid === null || typeof candidate.pid === "number")
    && (candidate.status === "running" || candidate.status === "completed" || candidate.status === "failed")
    && typeof candidate.startedAt === "number"
    && typeof candidate.updatedAt === "number"
    && (candidate.error === null || typeof candidate.error === "string")
  );
}

async function loadPersistedOllamaPullJobs(): Promise<void> {
  try {
    const raw = await readFile(getOllamaPullStatePath(), "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return;

    for (const entry of parsed) {
      if (!isOllamaPullJob(entry)) continue;
      const existing = ollamaPullJobs.get(entry.model);
      if (!existing || existing.updatedAt <= entry.updatedAt) {
        ollamaPullJobs.set(entry.model, entry);
      }
    }
  } catch {
    // No persisted jobs yet.
  }
}

function persistOllamaPullJobs(): Promise<void> {
  persistOllamaPullJobsQueue = persistOllamaPullJobsQueue
    .catch(() => undefined)
    .then(async () => {
      await mkdir(dirname(getOllamaPullStatePath()), { recursive: true });
      await writeFile(
        getOllamaPullStatePath(),
        JSON.stringify(Array.from(ollamaPullJobs.values()), null, 2),
        "utf-8",
      );
    })
    .catch((error) => {
      console.warn(
        "Failed to persist Ollama pull jobs:",
        error instanceof Error ? error.message : error,
      );
    });

  return persistOllamaPullJobsQueue;
}

/**
 * Check whether a binary is available on PATH. Uses execFile (no shell)
 * instead of exec so the binary name is never interpolated into a shell
 * command — eliminates a latent injection risk if a future caller ever
 * passes user input.
 */
function hasCmd(name: string): Promise<boolean> {
  return new Promise((res) => {
    execFile("which", [name], (err) => res(!err));
  });
}

function isProcessAlive(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function execFileText(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(typeof stdout === "string" ? stdout : "");
    });
  });
}

function parseRunningOllamaPulls(output: string): Array<{ model: string; pid: number | null }> {
  const running = new Map<string, { model: string; pid: number | null }>();
  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;

    const match = line.match(/^(\d+)\s+(.+)$/);
    const pid = match ? Number(match[1]) : null;
    const command = match ? match[2] : line;
    const pullMatch = command.match(/(?:^|[\\/ ])ollama\s+pull\s+([^\s]+)/);
    if (!pullMatch) continue;

    const model = pullMatch[1]?.trim();
    if (!model || running.has(model)) continue;
    running.set(model, { model, pid });
  }

  return Array.from(running.values());
}

async function detectRunningOllamaPulls(): Promise<boolean> {
  let output = "";

  try {
    if (await hasCmd("pgrep")) {
      output = await execFileText("pgrep", ["-fal", "ollama pull"]);
    } else if (await hasCmd("ps")) {
      output = await execFileText("ps", ["-axo", "pid=,command="]);
    }
  } catch {
    return false;
  }

  const now = Date.now();
  let changed = false;
  for (const processInfo of parseRunningOllamaPulls(output)) {
    const existing = ollamaPullJobs.get(processInfo.model);
    if (
      existing
      && existing.status === "running"
      && existing.pid === processInfo.pid
      && existing.error === null
    ) {
      continue;
    }
    ollamaPullJobs.set(processInfo.model, {
      model: processInfo.model,
      pid: processInfo.pid,
      status: "running",
      startedAt: existing?.startedAt ?? now,
      updatedAt: now,
      error: null,
    });
    changed = true;
  }

  return changed;
}

async function reconcileOllamaPullJobs(installedModels: string[]): Promise<OllamaPullJob[]> {
  await loadPersistedOllamaPullJobs();
  let changed = await detectRunningOllamaPulls();
  const now = Date.now();
  const jobs: OllamaPullJob[] = [];

  for (const [model, job] of ollamaPullJobs.entries()) {
    if (job.status === "running") {
      if (installedModels.some((installedModel) => ollamaModelsMatch(model, installedModel))) {
        const completedJob = {
          ...job,
          status: "completed" as const,
          updatedAt: now,
          error: null,
        };
        ollamaPullJobs.set(model, completedJob);
        changed = true;
        jobs.push(completedJob);
        continue;
      }

      if (!isProcessAlive(job.pid)) {
        const failedJob = {
          ...job,
          status: "failed" as const,
          updatedAt: now,
          error:
            job.error
            || `Ollama pull for ${model} stopped before the model became available. Click Pull Model to resume.`,
        };
        ollamaPullJobs.set(model, failedJob);
        changed = true;
        jobs.push(failedJob);
        continue;
      }
    }

    jobs.push(job);
  }

  if (changed) {
    await persistOllamaPullJobs();
  }

  return jobs;
}

function parseOllamaLibraryModels(payload: unknown): OllamaLibraryModel[] {
  if (!payload || typeof payload !== "object") return [];
  const models = (payload as { models?: unknown }).models;
  if (!Array.isArray(models)) return [];

  const uniqueModels = new Map<string, OllamaLibraryModel>();
  for (const entry of models) {
    if (!entry || typeof entry !== "object") continue;
    const name = typeof (entry as { name?: unknown }).name === "string"
      ? (entry as { name: string }).name.trim()
      : "";
    const size = typeof (entry as { size?: unknown }).size === "number"
      ? (entry as { size: number }).size
      : NaN;
    if (!name || !Number.isFinite(size) || size <= 0) continue;
    if (!uniqueModels.has(name)) {
      uniqueModels.set(name, { name, size });
    }
  }

  return Array.from(uniqueModels.values()).sort((left, right) => {
    if (left.size !== right.size) return left.size - right.size;
    return left.name.localeCompare(right.name);
  });
}

async function getOllamaLibraryModels(): Promise<OllamaLibraryModel[]> {
  if (ollamaLibraryCache && (Date.now() - ollamaLibraryCache.fetchedAt) < OLLAMA_LIBRARY_CACHE_TTL_MS) {
    return ollamaLibraryCache.models;
  }

  try {
    const response = await fetch(OLLAMA_LIBRARY_URL, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`Ollama catalog request failed with ${response.status}`);
    }
    const models = parseOllamaLibraryModels(await response.json());
    ollamaLibraryCache = {
      models,
      fetchedAt: Date.now(),
    };
    return models;
  } catch (error) {
    if (ollamaLibraryCache) {
      return ollamaLibraryCache.models;
    }
    throw error;
  }
}

async function startOllamaPullJob(model: string, ollamaBinaryPath: string | null): Promise<OllamaPullJob> {
  const { healthCheck: statusCheck } = await import("@/lib/local-llm");
  const { models } = await statusCheck();
  const existingJob = (await reconcileOllamaPullJobs(models)).find(
    (job) => job.model === model && job.status === "running",
  );
  if (existingJob) return existingJob;

  return new Promise((resolve, reject) => {
    let settled = false;
    const now = Date.now();
    const child = spawn(ollamaBinaryPath || "ollama", ["pull", model], {
      detached: true,
      stdio: "ignore",
    });

    child.once("error", (error) => {
      const failedJob: OllamaPullJob = {
        model,
        pid: child.pid ?? null,
        status: "failed",
        startedAt: now,
        updatedAt: Date.now(),
        error: error.message,
      };
      ollamaPullJobs.set(model, failedJob);
      void persistOllamaPullJobs();
      if (!settled) {
        settled = true;
        reject(error);
      }
    });

    child.once("spawn", () => {
      const runningJob: OllamaPullJob = {
        model,
        pid: child.pid ?? null,
        status: "running",
        startedAt: now,
        updatedAt: now,
        error: null,
      };
      child.unref();
      ollamaPullJobs.set(model, runningJob);
      void persistOllamaPullJobs();
      settled = true;
      resolve(runningJob);
    });
  });
}

/* ---------- helpers ---------- */

/** Mask an API key: "sk-...abc1" */
function maskKey(key: string | undefined): string | null {
  if (!key) return null;
  const trimmed = key.trim();
  if (trimmed.length <= 8) return "****";
  return `${trimmed.slice(0, 3)}...${trimmed.slice(-4)}`;
}

/**
 * Load the .env document for editing. Returns an empty document if .env
 * doesn't exist yet so first-time writes produce a clean file.
 */
async function loadEnvDocument(): Promise<EnvDocument> {
  try {
    return parseEnvFile(await readFile(resolveSetupEnvPath(), "utf-8"));
  } catch {
    return { lines: [], newline: "\n", trailingNewline: true };
  }
}

/**
 * Read settings as a key=value map from .env, with process.env as the
 * final fallback for keys missing from the file. Writes go through
 * loadEnvDocument/.env only.
 */
async function readEnvFile(): Promise<Record<string, string>> {
  const entries: Record<string, string> = {};
  try {
    const doc = parseEnvFile(await readFile(resolveSetupEnvPath(), "utf-8"));
    for (const line of doc.lines) {
      if (line.type === "entry") {
        entries[line.key] = line.value;
      }
    }
  } catch {
    // file missing — skip
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !(key in entries)) {
      entries[key] = value;
    }
  }
  return entries;
}

async function readEffectiveEnv(): Promise<Record<string, string | undefined>> {
  const fileEnv = await readEnvFile();
  return {
    ...process.env,
    ...fileEnv,
    SCIENCESWARM_STRICT_LOCAL_ONLY:
      process.env.SCIENCESWARM_STRICT_LOCAL_ONLY ?? fileEnv.SCIENCESWARM_STRICT_LOCAL_ONLY,
  };
}

/** Strip control characters that could inject extra .env entries */
function sanitizeEnvValue(value: string): string {
  return value.replace(/[\r\n]/g, "");
}

/** Write a single key into the .env file, preserving other keys */
async function setEnvValue(key: string, value: string): Promise<void> {
  const sanitized = sanitizeEnvValue(value);
  const doc = await loadEnvDocument();
  const updates: Record<string, string | null> = { [key]: sanitized };
  const nextDoc = mergeEnvValues(doc, updates);
  const serialized = serializeEnvDocument(nextDoc);
  await writeEnvFileAtomic(resolveSetupEnvPath(), serialized);

  // Also update process.env so subsequent reads pick it up
  process.env[key] = sanitized;
}

/* ---------- agent-config helpers ---------- */

const NANOCLAW_ENV = join(homedir(), ".scienceswarm", "nanoclaw", ".env");

/** Read the active agent from the project .env */
async function getActiveAgent(): Promise<string> {
  const env = await readEnvFile();
  return env.AGENT_BACKEND || "openclaw";
}

/** Write a key=value into NanoClaw's own .env file */
async function writeToNanoClawEnv(key: string, value: string): Promise<void> {
  await mkdir(dirname(NANOCLAW_ENV), { recursive: true });
  let content = "";
  try {
    content = await readFile(NANOCLAW_ENV, "utf-8");
  } catch {
    /* new file */
  }

  const lines = content.split("\n");
  const sanitized = sanitizeEnvValue(value);
  const idx = lines.findIndex((l) => l.trimStart().startsWith(`${key}=`));
  if (idx >= 0) {
    lines[idx] = `${key}=${sanitized}`;
  } else {
    lines.push(`${key}=${sanitized}`);
  }

  await writeFile(NANOCLAW_ENV, lines.join("\n"), "utf-8");
}

/** Configure OpenClaw model via its CLI (routed through the wrapper). */
async function writeToOpenClawConfig(model: string): Promise<void> {
  const { runOpenClaw } = await import("@/lib/openclaw/runner");
  const result = await runOpenClaw(["models", "set", model], { timeoutMs: 5000 });
  if (result.ok) return;
  // Missing binary is expected when openclaw isn't installed — ignore.
  // Any other error (e.g. rejected model name) should propagate so the UI
  // can surface it.
  if (/ENOENT|not found/i.test(result.stderr)) return;
  throw new Error(`openclaw models set failed: ${result.stderr || `exit ${result.code}`}`);
}

/** Sync current API key and model to the given agent's config */
async function syncConfigToAgent(agent: string): Promise<void> {
  const env = await readEnvFile();
  const apiKey = env.OPENAI_API_KEY || process.env.OPENAI_API_KEY;
  const model = resolveOpenAIModel(env.LLM_MODEL || process.env.LLM_MODEL);

  if (agent === "nanoclaw") {
    if (apiKey) await writeToNanoClawEnv("OPENAI_API_KEY", apiKey);
    await writeToNanoClawEnv("LLM_MODEL", model);
  } else if (agent === "openclaw") {
    const openclawModel = model.startsWith("openai/") ? model : `openai/${model}`;
    await writeToOpenClawConfig(openclawModel);
  }
}

/** Validate an OpenAI key by calling the models endpoint */
async function testOpenAIKey(key: string): Promise<boolean> {
  try {
    const res = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Check if a service is reachable at the given URL */
async function probeService(
  url: string,
): Promise<"connected" | "disconnected"> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return res.ok ? "connected" : "disconnected";
  } catch {
    return "disconnected";
  }
}

/* ---------- GET ---------- */

export async function GET(): Promise<Response> {
  if (!(await isLocalRequest())) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const env = await readEffectiveEnv();
  const strictLocalOnly = isStrictLocalOnlyEnabled(env);
  const telegramBotToken = env.TELEGRAM_BOT_TOKEN?.trim() || "";
  const telegramUserId = env.TELEGRAM_USER_ID?.trim() || "";
  let pendingTelegramPairing: {
    userId: string;
    username: string | null;
    firstName: string | null;
    lastName: string | null;
    createdAt: string | null;
    lastSeenAt: string | null;
  } | null = null;

  if (telegramBotToken && !telegramUserId) {
    try {
      const latestPairing = selectLatestPendingTelegramPairing(
        await listPendingTelegramPairingRequests({
          timeoutMs: SETTINGS_PENDING_TELEGRAM_PAIRING_TIMEOUT_MS,
        }),
      );
      if (latestPairing) {
        pendingTelegramPairing = {
          userId: latestPairing.id,
          username: latestPairing.meta?.username ?? null,
          firstName: latestPairing.meta?.firstName ?? null,
          lastName: latestPairing.meta?.lastName ?? null,
          createdAt: latestPairing.createdAt ?? null,
          lastSeenAt: latestPairing.lastSeenAt ?? null,
        };
      }
    } catch {
      pendingTelegramPairing = null;
    }
  }

  return Response.json({
    agent: env.AGENT_BACKEND || "none",
    agentUrl: env.AGENT_URL || "",
    agentApiKey: maskKey(env.AGENT_API_KEY),
    openaiKey: maskKey(env.OPENAI_API_KEY),
    llmModel: resolveOpenAIModel(env.LLM_MODEL),
    llmProvider: strictLocalOnly ? "local" : (env.LLM_PROVIDER || "openai"),
    strictLocalOnly,
    ollamaUrl: env.OLLAMA_URL || getOllamaUrl(),
    ollamaModel: resolveConfiguredLocalModel(env),
    userHandle: env.SCIENCESWARM_USER_HANDLE || "",
    userEmail: env.GIT_USER_EMAIL || "",
    telegramPhone: env.TELEGRAM_PHONE || "",
    telegram: {
      botToken: maskKey(env.TELEGRAM_BOT_TOKEN),
      configured: Boolean(telegramBotToken),
      paired: Boolean(telegramUserId),
      username: env.TELEGRAM_BOT_USERNAME || null,
      creature: env.TELEGRAM_BOT_CREATURE || null,
      userId: env.TELEGRAM_USER_ID || null,
      pendingPairing: pendingTelegramPairing,
    },
    slack: {
      botToken: maskKey(env.SLACK_BOT_TOKEN),
      signingSecret: maskKey(env.SLACK_SIGNING_SECRET),
      configured: Boolean(env.SLACK_BOT_TOKEN && env.SLACK_SIGNING_SECRET),
    },
  });
}

/* ---------- POST ---------- */

interface PostBody {
  action: string;
  key?: string;
  model?: string;
  agent?: string;
  agentUrl?: string;
  agentApiKey?: string;
  botToken?: string;
  signingSecret?: string;
  provider?: string;
  ollamaUrl?: string;
  ollamaModel?: string;
  enabled?: boolean;
  userHandle?: string;
  userEmail?: string;
  telegramPhone?: string;
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
      key: typeof obj.key === "string" ? obj.key : undefined,
      model: typeof obj.model === "string" ? obj.model : undefined,
      agent: typeof obj.agent === "string" ? obj.agent : undefined,
      botToken: typeof obj.botToken === "string" ? obj.botToken : undefined,
      signingSecret:
        typeof obj.signingSecret === "string" ? obj.signingSecret : undefined,
      provider: typeof obj.provider === "string" ? obj.provider : undefined,
      agentUrl: typeof obj.agentUrl === "string" ? obj.agentUrl : undefined,
      agentApiKey: typeof obj.agentApiKey === "string" ? obj.agentApiKey : undefined,
      ollamaUrl: typeof obj.ollamaUrl === "string" ? obj.ollamaUrl : undefined,
      ollamaModel: typeof obj.ollamaModel === "string" ? obj.ollamaModel : undefined,
      enabled: typeof obj.enabled === "boolean" ? obj.enabled : undefined,
      userHandle: typeof obj.userHandle === "string" ? obj.userHandle : undefined,
      userEmail: typeof obj.userEmail === "string" ? obj.userEmail : undefined,
      telegramPhone: typeof obj.telegramPhone === "string" ? obj.telegramPhone : undefined,
    };
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { action } = body;

  if (!action) {
    return Response.json({ error: "Missing action" }, { status: 400 });
  }

  switch (action) {
    /* ---- API key ---- */
    case "save-key": {
      if (!body.key) {
        return Response.json({ error: "Missing key" }, { status: 400 });
      }
      await setEnvValue("OPENAI_API_KEY", body.key);

      // Also write to the active agent's config
      const agent = await getActiveAgent();
      if (agent === "nanoclaw") {
        await writeToNanoClawEnv("OPENAI_API_KEY", body.key);
      }
      // OpenClaw reads OPENAI_API_KEY from the environment; no separate write needed

      return Response.json({ ok: true, masked: maskKey(body.key) });
    }

    case "test-key": {
      const effectiveEnv = await readEffectiveEnv();
      if (isStrictLocalOnlyEnabled(effectiveEnv)) {
        return Response.json({
          valid: false,
          error: "Strict local-only mode is enabled. OpenAI validation is disabled.",
        }, { status: 400 });
      }
      const keyToTest =
        body.key || process.env.OPENAI_API_KEY || effectiveEnv.OPENAI_API_KEY;
      if (!keyToTest) {
        return Response.json({ valid: false, error: "No key configured" });
      }
      const valid = await testOpenAIKey(keyToTest);
      return Response.json({ valid });
    }

    /* ---- LLM model ---- */
    case "save-model": {
      if (typeof body.model !== "string" || !body.model.trim()) {
        return Response.json({ error: "Missing model" }, { status: 400 });
      }
      const normalizedModel = resolveOpenAIModel(body.model);
      if (!isSupportedOpenAIModel(normalizedModel)) {
        return Response.json({ error: "Unsupported OpenAI model" }, { status: 400 });
      }
      await setEnvValue("LLM_MODEL", normalizedModel);

      // Also write to the active agent's config
      const agentForModel = await getActiveAgent();
      if (agentForModel === "nanoclaw") {
        await writeToNanoClawEnv("LLM_MODEL", normalizedModel);
      } else if (agentForModel === "openclaw") {
        const openclawModel = `openai/${normalizedModel}`;
        await writeToOpenClawConfig(openclawModel);
      }

      return Response.json({ ok: true, model: normalizedModel });
    }

    /* ---- Agent backend ---- */
    case "save-agent": {
      if (!body.agent || typeof body.agent !== "string") {
        return Response.json({ error: "agent is required" }, { status: 400 });
      }
      const agentValue = body.agent.trim().toLowerCase();
      if (!agentValue) {
        return Response.json({ error: "agent cannot be empty" }, { status: 400 });
      }
      await setEnvValue("AGENT_BACKEND", agentValue);

      // TODO(phase-2): remove syncConfigToAgent — agents manage their own config
      await syncConfigToAgent(agentValue);

      return Response.json({ ok: true, agent: agentValue });
    }

    case "save-strict-local-only": {
      if (typeof body.enabled !== "boolean") {
        return Response.json({ error: "enabled must be a boolean" }, { status: 400 });
      }
      await setEnvValue("SCIENCESWARM_STRICT_LOCAL_ONLY", body.enabled ? "1" : "0");
      if (body.enabled) {
        await setEnvValue("LLM_PROVIDER", "local");
      }
      const env = await readEffectiveEnv();
      return Response.json({
        ok: true,
        strictLocalOnly: body.enabled,
        llmProvider: body.enabled ? "local" : (env.LLM_PROVIDER || "openai"),
      });
    }

    case "save-agent-url": {
      const url = body.agentUrl?.trim();
      if (!url) {
        // Allow clearing the URL
        await setEnvValue("AGENT_URL", "");
        return Response.json({ ok: true });
      }
      try {
        const parsed = new URL(url);
        if (!["http:", "https:"].includes(parsed.protocol)) {
          return Response.json(
            { error: "Agent URL must use http:// or https://" },
            { status: 400 },
          );
        }
      } catch {
        return Response.json({ error: "Invalid URL format" }, { status: 400 });
      }
      await setEnvValue("AGENT_URL", url);
      return Response.json({ ok: true });
    }

    case "save-agent-api-key": {
      await setEnvValue("AGENT_API_KEY", body.agentApiKey?.trim() ?? "");
      return Response.json({ ok: true });
    }

    case "test-agent": {
      if (isStrictLocalOnlyEnabled(await readEffectiveEnv())) {
        return Response.json({
          ok: false,
          error: "Strict local-only mode is enabled. Remote agent probing is disabled.",
        }, { status: 400 });
      }
      const url = body.agentUrl?.trim();
      const apiKey = body.agentApiKey?.trim();
      const agentType = body.agent?.trim() || "unknown";
      if (!url) {
        return Response.json({ error: "URL is required" }, { status: 400 });
      }
      try {
        const parsed = new URL(url);
        if (!["http:", "https:"].includes(parsed.protocol)) {
          return Response.json({ error: "Agent URL must use http:// or https://" }, { status: 400 });
        }
      } catch {
        return Response.json({ error: "Invalid URL format" }, { status: 400 });
      }
      const { agentHealthCheck } = await import("@/lib/agent-client");
      const result = await agentHealthCheck({ type: agentType, url, apiKey });
      return Response.json({ ok: true, ...result });
    }

    /* ---- Identity ---- */
    case "save-user-handle": {
      const handle = body.userHandle?.trim() ?? "";
      if (!isValidUserHandle(handle)) {
        return Response.json(
          {
            error:
              "Handle must be 1-64 chars, letters/digits/._- only.",
          },
          { status: 400 },
        );
      }
      await setEnvValue("SCIENCESWARM_USER_HANDLE", handle);
      return Response.json({ ok: true, userHandle: handle });
    }

    case "save-user-email": {
      const email = body.userEmail?.trim() ?? "";
      await setEnvValue("GIT_USER_EMAIL", email);
      return Response.json({ ok: true, userEmail: email });
    }

    case "save-telegram-phone": {
      const phone = body.telegramPhone?.trim() ?? "";
      await setEnvValue("TELEGRAM_PHONE", phone);
      return Response.json({ ok: true, telegramPhone: phone });
    }

    /* ---- Telegram ---- */
    case "save-telegram": {
      if (!body.botToken) {
        return Response.json({ error: "Missing botToken" }, { status: 400 });
      }
      await setEnvValue("TELEGRAM_BOT_TOKEN", body.botToken);
      return Response.json({ ok: true });
    }

    /* ---- Slack ---- */
    case "save-slack": {
      if (!body.botToken || !body.signingSecret) {
        return Response.json(
          { error: "Missing botToken or signingSecret" },
          { status: 400 },
        );
      }
      await setEnvValue("SLACK_BOT_TOKEN", body.botToken);
      await setEnvValue("SLACK_SIGNING_SECRET", body.signingSecret);
      return Response.json({ ok: true });
    }

    /* ---- Health / status ---- */
    case "health": {
      const env = await readEffectiveEnv();
      const strictLocalOnly = isStrictLocalOnlyEnabled(env);
      const openhandsUrl = env.OPENHANDS_URL || getOpenHandsUrl();

      const { agentHealthCheck: checkAgent, resolveAgentConfig } = await import("@/lib/agent-client");
      const { healthCheck: localHealth } = await import("@/lib/local-llm");

      const agentCfg = resolveAgentConfig();
      const [agentResult, openhands, openai, ollamaStatus] = await Promise.all([
        strictLocalOnly || !agentCfg
          ? Promise.resolve({ status: "disconnected" as const })
          : checkAgent(agentCfg),
        strictLocalOnly ? Promise.resolve("disconnected" as const) : probeService(openhandsUrl),
        strictLocalOnly ? Promise.resolve(false) : (env.OPENAI_API_KEY ? testOpenAIKey(env.OPENAI_API_KEY) : false),
        localHealth(),
      ]);
      return Response.json({
        openhands,
        // New unified agent field
        agentHealth: { type: agentCfg?.type ?? "none", status: agentResult.status },
        // Legacy field for backward compat
        openclaw: agentCfg?.type === "openclaw" ? agentResult.status : "disconnected",
        openai: strictLocalOnly ? "disabled" : (openai ? "valid" : env.OPENAI_API_KEY ? "invalid" : "not-set"),
        ollama: ollamaStatus.running ? "connected" : "disconnected",
        ollamaModels: ollamaStatus.models,
        database: "unknown",
        agent: env.AGENT_BACKEND || "none",
        llmProvider: strictLocalOnly ? "local" : (env.LLM_PROVIDER || "openai"),
        strictLocalOnly,
      });
    }

    /* ---- LLM provider (openai | local) ---- */
    case "save-provider": {
      const allowed = ["openai", "local"];
      if (!body.provider || !allowed.includes(body.provider)) {
        return Response.json(
          { error: `provider must be one of: ${allowed.join(", ")}` },
          { status: 400 },
        );
      }
      if (isStrictLocalOnlyEnabled(await readEffectiveEnv()) && body.provider !== "local") {
        return Response.json(
          { error: "Strict local-only mode requires LLM_PROVIDER=local." },
          { status: 400 },
        );
      }
      await setEnvValue("LLM_PROVIDER", body.provider);
      return Response.json({ ok: true, provider: body.provider });
    }

    case "save-ollama-url": {
      const url = body.ollamaUrl?.trim();
      if (!url) {
        return Response.json({ error: "Missing ollamaUrl" }, { status: 400 });
      }
      await setEnvValue("OLLAMA_URL", url);
      return Response.json({ ok: true, ollamaUrl: url });
    }

    case "save-ollama-model": {
      const model = body.ollamaModel?.trim();
      if (!model) {
        return Response.json({ error: "Missing ollamaModel" }, { status: 400 });
      }
      await setEnvValue("OLLAMA_MODEL", model);
      return Response.json({ ok: true, ollamaModel: model });
    }

    case "ollama-library": {
      try {
        const models = await getOllamaLibraryModels();
        return Response.json({ ok: true, models });
      } catch {
        return Response.json(
          {
            ok: false,
            error: "Failed to load the official Ollama model catalog",
          },
          { status: 502 },
        );
      }
    }

    /* ---- Local model health / test / pull ----
     * Merges three signals so the /setup client can derive its entire
     * UI state from a single probe:
     *   1. `healthCheck()` — is the daemon reachable at /api/tags?
     *   2. `getOllamaInstallStatus()` — binary on disk? right arch?
     *   3. `hasRecommendedModel` — is the default gemma pulled?
     *
     * The third was previously absent, so the OllamaSection component
     * could never leave its "running-missing-model" state even on a
     * machine where the default Gemma model was already pulled. The
     * `models` array already comes back from `/api/tags`; matching is
     * tag-aware so `gemma4:e4b` is distinct from larger variants such
     * as `gemma4:26b`.
     */
    case "local-health": {
      const { healthCheck: localHealth } = await import("@/lib/local-llm");
      const { hasRecommendedOllamaModel } = await import(
        "@/lib/ollama-models"
      );
      const [status, installStatus] = await Promise.all([
        localHealth(),
        getOllamaInstallStatus(),
      ]);
      const hasRecommendedModel = hasRecommendedOllamaModel(status.models);
      return Response.json({
        ...status,
        ...installStatus,
        hasRecommendedModel,
      });
    }

    case "install-ollama": {
      // Convenience install — spawns in background, returns immediately.
      // The install path is hardware-aware so Apple Silicon does not
      // accidentally install the Intel Homebrew build under /usr/local.
      const installStatus = await getOllamaInstallStatus();
      if (installStatus.binaryInstalled && installStatus.binaryCompatible && !installStatus.reinstallRecommended) {
        return Response.json({
          ok: true,
          installing: false,
          alreadyInstalled: true,
          ...installStatus,
        });
      }

      if (!installStatus.installCommand) {
        return Response.json({
          ok: false,
          error: installStatus.installHint,
          ...installStatus,
        });
      }

      exec(installStatus.installCommand, (err: ExecException | null) => {
        if (err) {
          console.warn("Ollama install failed:", err.message);
        } else {
          console.info("Ollama installed successfully via settings UI");
        }
      });
      return Response.json({
        ok: true,
        installing: true,
        ...installStatus,
      });
    }

    /* ---- Start / Stop Ollama daemon ----
     * Fire-and-forget exec; return immediately. The caller refetches
     * local-health to see whether the daemon actually came up / went down.
     * Try the most reliable method per platform, falling back to
     * `ollama serve` / `pkill -f 'ollama serve'` if service managers are
     * unavailable. Only report ok:false if every method fails to even
     * launch the command.
     */
    case "start-ollama": {
      const installStatus = await getOllamaInstallStatus();

      const spawnServeFallback = (): void => {
        const child = spawn(installStatus.binaryPath || "ollama", ["serve"], {
          detached: true,
          stdio: "ignore",
        });
        child.once("error", (error) => {
          console.warn("Ollama direct serve fallback failed:", error.message);
        });
        child.unref();
      };

      // Bail early with an actionable error if the binary isn't installed.
      // Otherwise the fire-and-forget exec calls below all silently fail and
      // the client polls fetchHealth for ~16s waiting for a daemon that will
      // never come up.
      if (!installStatus.binaryInstalled) {
        return Response.json({
          ok: false,
          error: "Ollama is not installed. Click Install Ollama first.",
        });
      }

      try {
        if (!installStatus.startCommand) {
          return Response.json({
            ok: false,
            error: "No Ollama start command is available on this machine.",
          });
        }

        exec(installStatus.startCommand, (err: ExecException | null) => {
          if (err) {
            if (installStatus.serviceManager !== "direct") {
              console.warn(`${installStatus.serviceManager} start ollama failed, falling back to direct serve:`, err.message);
              spawnServeFallback();
              return;
            }
            console.warn(`${installStatus.serviceManager} start ollama failed:`, err.message);
          } else {
            console.info(`Ollama started via ${installStatus.serviceManager}`);
          }
        });
        return Response.json({ ok: true, starting: true });
      } catch (err) {
        return Response.json({
          ok: false,
          error: err instanceof Error ? err.message : "Failed to start Ollama",
        });
      }
    }

    case "stop-ollama": {
      const installStatus = await getOllamaInstallStatus();

      const stopServeFallback = (): void => {
        exec("pkill -f 'ollama serve'", (err: ExecException | null) => {
          if (err && err.code !== 1) {
            console.warn("Ollama direct stop fallback failed:", err.message);
          } else {
            console.info("Ollama stopped via direct fallback");
          }
        });
      };

      try {
        if (!installStatus.stopCommand) {
          return Response.json({
            ok: false,
            error: "No Ollama stop command is available on this machine.",
          });
        }

        exec(installStatus.stopCommand, (err: ExecException | null) => {
          // pkill exits 1 when no process matches — not a real failure
          if (err && err.code !== 1) {
            if (installStatus.serviceManager !== "direct") {
              console.warn(`${installStatus.serviceManager} stop ollama failed, falling back to pkill:`, err.message);
              stopServeFallback();
              return;
            }
            console.warn(`${installStatus.serviceManager} stop ollama failed:`, err.message);
          } else {
            console.info(`Ollama stopped via ${installStatus.serviceManager}`);
          }
        });
        return Response.json({ ok: true, stopping: true });
      } catch (err) {
        return Response.json({
          ok: false,
          error: err instanceof Error ? err.message : "Failed to stop Ollama",
        });
      }
    }

    case "pull-status": {
      const { healthCheck: statusCheck } = await import("@/lib/local-llm");
      const st = await statusCheck();
      const targetModel = body.ollamaModel?.trim();
      const jobs = await reconcileOllamaPullJobs(st.models);
      const activePulls = jobs
        .filter((job) => job.status === "running")
        .map((job) => job.model);
      const targetJob = targetModel
        ? jobs.find((job) => job.model === targetModel) ?? null
        : jobs.find((job) => job.status === "running") ?? null;
      return Response.json({
        pulling: targetJob?.status === "running",
        activePulls,
        models: st.models,
        running: st.running,
        error: targetJob?.status === "failed" ? targetJob.error : null,
      });
    }

    case "test-local": {
      const { completeLocal, getLocalModel } = await import("@/lib/local-llm");
      try {
        const reply = await completeLocal(
          [{ role: "user", content: "Say hello in one sentence." }],
          body.ollamaModel || getLocalModel(),
        );
        return Response.json({ ok: true, reply });
      } catch (err) {
        return Response.json({
          ok: false,
          error: err instanceof Error ? err.message : "Test failed",
        });
      }
    }

    case "pull-model": {
      const model = body.ollamaModel?.trim();
      if (!model) {
        return Response.json({ error: "Missing ollamaModel" }, { status: 400 });
      }
      const installStatus = await getOllamaInstallStatus();
      if (!installStatus.binaryInstalled) {
        return Response.json({
          ok: false,
          error: "Ollama is not installed. Click Install Ollama first.",
        });
      }

      const { healthCheck: statusCheck } = await import("@/lib/local-llm");
      const st = await statusCheck();
      if (st.models.some((availableModel) => ollamaModelsMatch(model, availableModel))) {
        return Response.json({ ok: true, model, pulling: false, alreadyPresent: true });
      }

      try {
        const job = await startOllamaPullJob(model, installStatus.binaryPath);
        return Response.json({
          ok: true,
          model,
          pulling: job.status === "running",
        });
      } catch {
        return Response.json({
          ok: false,
          error: "Failed to start model pull",
        });
      }
    }

    default:
      return Response.json({ error: `Unknown action: ${action}` }, { status: 400 });
  }
}
