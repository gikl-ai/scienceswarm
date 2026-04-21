/**
 * POST /api/setup/reset
 *
 * Gated by `process.env.SCIENCESWARM_ALLOW_RESET === "1"`. When enabled,
 * clears the same state as `npm run setup:reset`. Intended for dev /
 * E2E use only — exposing this in production would let anyone wipe a
 * fresh install.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import { isLocalRequest } from "@/lib/local-guard";
import {
  mergeEnvValues,
  parseEnvFile,
  serializeEnvDocument,
  writeEnvFileAtomic,
} from "@/lib/setup/env-writer";
import { readTelegramBotEnvValues } from "@/lib/setup/telegram-bot-env";
import {
  getScienceSwarmBrainRoot,
  getScienceSwarmDataRoot,
  getScienceSwarmOpenClawStateDir,
  getScienceSwarmTelegramSessionPath,
} from "@/lib/scienceswarm-paths";

/**
 * Guard: only allow deletes under the resolved ScienceSwarm data root.
 *
 * Strictly stronger than a `~/.openclaw-*` glob check because
 * `path.resolve` collapses `..` before we compare — so a path
 * traversal bug (e.g. `SCIENCESWARM_DIR=/tmp/x/../../../..`) can't
 * sneak past it.
 */
function isUnderScienceSwarmDataRoot(target: string): boolean {
  const root = path.resolve(getScienceSwarmDataRoot());
  const resolved = path.resolve(target);
  return resolved === root || resolved.startsWith(root + path.sep);
}

export async function POST(request: Request): Promise<Response> {
  if (!(await isLocalRequest(request))) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  if (process.env.SCIENCESWARM_ALLOW_RESET !== "1") {
    return Response.json(
      { error: "Reset disabled. Set SCIENCESWARM_ALLOW_RESET=1." },
      { status: 403 },
    );
  }

  let keepTelegramBot = false;
  try {
    const rawBody = await request.text();
    if (rawBody.trim()) {
      const body = JSON.parse(rawBody) as { keepTelegramBot?: unknown };
      keepTelegramBot = body.keepTelegramBot === true;
    }
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Snapshot the resolved paths BEFORE clearing the .env — if
  // BRAIN_ROOT / SCIENCESWARM_DIR is set via .env (not the shell),
  // clearing it first would make the resolver fall back to defaults
  // and we'd wipe the wrong directory.
  const brainDir = getScienceSwarmBrainRoot();
  const openClawStateDir = getScienceSwarmOpenClawStateDir();
  const sessionPath = getScienceSwarmTelegramSessionPath();

  // Guard every delete target against the resolved ScienceSwarm root.
  // Refuse rather than `rm -rf` something outside the sandbox.
  for (const target of [brainDir, openClawStateDir, sessionPath]) {
    if (!isUnderScienceSwarmDataRoot(target)) {
      return Response.json(
        {
          error: `refused to delete ${target}: not under ScienceSwarm data root ${path.resolve(
            getScienceSwarmDataRoot(),
          )}`,
        },
        { status: 500 },
      );
    }
  }

  const repoRoot = process.cwd();
  const envPath = path.join(repoRoot, ".env");
  try {
    const existing = await fs.readFile(envPath, "utf8");
    const doc = parseEnvFile(existing);
    const preservedTelegram = keepTelegramBot
      ? readTelegramBotEnvValues(doc)
      : {};
    const merged = mergeEnvValues(doc, {
      SCIENCESWARM_USER_HANDLE: "",
      GIT_USER_EMAIL: "",
      BRAIN_ROOT: "",
      BRAIN_PGLITE_PATH: "",
      AGENT_BACKEND: "",
      LLM_PROVIDER: "",
      OLLAMA_MODEL: "",
      OLLAMA_API_KEY: "",
      OPENCLAW_PROFILE: "",
      OPENCLAW_URL: "",
      TELEGRAM_BOT_TOKEN: "",
      TELEGRAM_BOT_USERNAME: "",
      TELEGRAM_BOT_CREATURE: "",
      TELEGRAM_USER_ID: "",
      TELEGRAM_PHONE: "",
      ...preservedTelegram,
    });
    await writeEnvFileAtomic(envPath, serializeEnvDocument(merged));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      return Response.json(
        { error: (err as Error).message },
        { status: 500 },
      );
    }
  }

  await fs.rm(brainDir, { recursive: true, force: true });
  await fs.rm(openClawStateDir, { recursive: true, force: true });
  await fs.unlink(sessionPath).catch(() => {});

  return Response.json({ ok: true });
}
