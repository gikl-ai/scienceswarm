#!/usr/bin/env npx tsx
/**
 * Wipe onboarding state so /setup can be tested repeatedly.
 *
 * Honors `SCIENCESWARM_DIR` (shell env) and `BRAIN_ROOT` (either shell
 * env or the project `.env` written by the bootstrap orchestrator).
 * A user testing a fresh install with `SCIENCESWARM_DIR=~/.scienceswarm-test`
 * gets that exact directory wiped — no stray delete at `~/.scienceswarm`.
 *
 * Deletes:
 *   - .env keys: SCIENCESWARM_USER_HANDLE, GIT_USER_EMAIL, BRAIN_ROOT,
 *     TELEGRAM_BOT_TOKEN, TELEGRAM_BOT_USERNAME, TELEGRAM_BOT_CREATURE,
 *     TELEGRAM_USER_ID, ready flags, and OpenClaw profile/url overrides
 *   - The resolved brain dir (unless --keep-brain)
 *   - The resolved openclaw state dir (unless --keep-openclaw)
 *   - The resolved telegram session file
 *
 * Usage:
 *   npm run setup:reset
 *   npm run setup:reset -- --keep-brain
 *   npm run setup:reset -- --keep-openclaw
 *   npm run setup:reset -- --keep-telegram-bot
 *   SCIENCESWARM_DIR=~/.scienceswarm-test npm run setup:reset
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  mergeEnvValues,
  parseEnvFile,
  serializeEnvDocument,
  writeEnvFileAtomic,
} from "../src/lib/setup/env-writer";
import { readTelegramBotEnvValues } from "../src/lib/setup/telegram-bot-env";
import {
  getScienceSwarmBrainRoot,
  getScienceSwarmDataRoot,
  getScienceSwarmOpenClawStateDir,
  getScienceSwarmTelegramSessionPath,
} from "../src/lib/scienceswarm-paths";

/**
 * Guard: only allow deletes under the resolved ScienceSwarm data root.
 *
 * Strictly stronger than the old `~/.openclaw-*` glob check because
 * `path.resolve` collapses `..` before we compare — so a path
 * traversal bug (e.g. `SCIENCESWARM_DIR=/tmp/x/../../../..`) can't
 * sneak past it.
 */
export function isUnderScienceSwarmDataRoot(
  target: string,
  dataRoot: string = getScienceSwarmDataRoot(),
): boolean {
  const root = path.resolve(dataRoot);
  const resolved = path.resolve(target);
  return resolved === root || resolved.startsWith(root + path.sep);
}

/**
 * Hydrate the current process's `process.env` with `SCIENCESWARM_DIR`
 * and `BRAIN_ROOT` from the project `.env` IF the shell hasn't already
 * exported them. Lets the resolver see what the bootstrap wrote.
 */
function hydrateFromProjectEnv(envContents: string): void {
  const doc = parseEnvFile(envContents);
  for (const line of doc.lines) {
    if (line.type !== "entry") continue;
    if (line.key === "BRAIN_ROOT" && line.value && !process.env.BRAIN_ROOT) {
      process.env.BRAIN_ROOT = line.value;
    }
    if (
      line.key === "SCIENCESWARM_DIR" &&
      line.value &&
      !process.env.SCIENCESWARM_DIR
    ) {
      process.env.SCIENCESWARM_DIR = line.value;
    }
  }
}

export interface ResetOnboardingPathResolvers {
  getBrainDir: () => string;
  getOpenClawStateDir: () => string;
  getTelegramSessionPath: () => string;
  getDataRoot: () => string;
}

export interface ResetOnboardingOptions {
  repoRoot: string;
  keepBrain?: boolean;
  keepOpenClaw?: boolean;
  keepTelegramBot?: boolean;
  log?: (msg: string) => void;
  warn?: (msg: string) => void;
  /**
   * Test-seam: override the path resolvers. In production this is
   * undefined and we use the real `scienceswarm-paths` helpers.
   */
  resolvers?: ResetOnboardingPathResolvers;
}

export interface ResetOnboardingResult {
  ok: boolean;
  error?: string;
  removed: string[];
  skipped: string[];
}

export async function resetOnboarding(
  options: ResetOnboardingOptions,
): Promise<ResetOnboardingResult> {
  const log = options.log ?? ((msg: string) => console.log(msg));
  const warn = options.warn ?? ((msg: string) => console.warn(msg));
  const removed: string[] = [];
  const skipped: string[] = [];

  // 1. Read .env + hydrate process.env so the resolver sees the same
  // BRAIN_ROOT/SCIENCESWARM_DIR values the running server would use.
  const envPath = path.join(options.repoRoot, ".env");
  let existing = "";
  try {
    existing = await fs.readFile(envPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      return {
        ok: false,
        error: `read .env failed: ${(err as Error).message}`,
        removed,
        skipped,
      };
    }
  }
  if (existing) {
    hydrateFromProjectEnv(existing);
  }

  // 2. Snapshot resolved paths BEFORE clearing .env. Otherwise the
  // act of clearing SCIENCESWARM_DIR/BRAIN_ROOT would make the resolver
  // fall back to defaults and we'd wipe the wrong directory.
  const resolvers: ResetOnboardingPathResolvers = options.resolvers ?? {
    getBrainDir: getScienceSwarmBrainRoot,
    getOpenClawStateDir: getScienceSwarmOpenClawStateDir,
    getTelegramSessionPath: getScienceSwarmTelegramSessionPath,
    getDataRoot: getScienceSwarmDataRoot,
  };

  const dataRoot = resolvers.getDataRoot();
  const brainDir = resolvers.getBrainDir();
  const openClawStateDir = resolvers.getOpenClawStateDir();
  const sessionPath = resolvers.getTelegramSessionPath();

  // 3. Guard every delete target against the resolved ScienceSwarm root.
  // A non-zero error exit on any unsafe target — better to refuse than
  // `rm -rf` something outside the sandbox.
  for (const target of [brainDir, openClawStateDir, sessionPath]) {
    if (!isUnderScienceSwarmDataRoot(target, dataRoot)) {
      return {
        ok: false,
        error: `refused to delete ${target}: not under ScienceSwarm data root ${path.resolve(
          dataRoot,
        )}`,
        removed,
        skipped,
      };
    }
  }

  // 4. Clear onboarding keys from .env (preserve every other key).
  if (existing) {
    const doc = parseEnvFile(existing);
    const preservedTelegram = options.keepTelegramBot
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
    log(
      options.keepTelegramBot
        ? "  cleared .env onboarding keys; kept Telegram bot metadata"
        : "  cleared .env onboarding keys",
    );
  }

  // 5. Remove the resolved brain dir.
  if (!options.keepBrain) {
    try {
      await fs.rm(brainDir, { recursive: true, force: true });
      removed.push(brainDir);
      log(`  removed ${brainDir}`);
    } catch (err) {
      warn(`  warn: could not remove ${brainDir}: ${(err as Error).message}`);
    }
  } else {
    skipped.push(brainDir);
    log("  kept brain dir (--keep-brain)");
  }

  // 6. Remove the resolved openclaw state dir.
  if (!options.keepOpenClaw) {
    try {
      await fs.rm(openClawStateDir, { recursive: true, force: true });
      removed.push(openClawStateDir);
      log(`  removed ${openClawStateDir}`);
    } catch (err) {
      warn(
        `  warn: could not remove ${openClawStateDir}: ${(err as Error).message}`,
      );
    }
  } else {
    skipped.push(openClawStateDir);
    log("  kept openclaw state dir (--keep-openclaw)");
  }

  // 7. Remove the resolved telegram session file.
  try {
    await fs.unlink(sessionPath);
    removed.push(sessionPath);
    log(`  removed ${sessionPath}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      warn(`  warn: could not remove session: ${(err as Error).message}`);
    }
  }

  return { ok: true, removed, skipped };
}

async function main(): Promise<void> {
  const repoRoot = process.cwd();
  const keepBrain = process.argv.includes("--keep-brain");
  const keepOpenClaw = process.argv.includes("--keep-openclaw");
  const keepTelegramBot = process.argv.includes("--keep-telegram-bot");

  const result = await resetOnboarding({
    repoRoot,
    keepBrain,
    keepOpenClaw,
    keepTelegramBot,
  });
  if (!result.ok) {
    console.error(`error: ${result.error}`);
    process.exit(1);
  }

  console.log("\nOnboarding reset. Run `./start.sh` and reopen /setup to re-test.");
}

const isDirectInvocation =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectInvocation) {
  void main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
