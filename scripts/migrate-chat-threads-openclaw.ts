#!/usr/bin/env npx tsx
/**
 * One-shot migration: rewrite legacy `conversationBackend` values
 * (`"agent"`, `"direct"`) in persisted chat threads to `"openclaw"`.
 *
 * Background: PR #13 (`feat-chat-openclaw-only`) collapsed the runtime
 * `Backend` union to a single value (`"openclaw"`). The hook already
 * normalises legacy values on read (`normalizeBackend` in
 * `src/hooks/use-unified-chat.ts`) and the store now does the same in
 * `src/lib/chat-thread-store.ts`. Both are belt-and-suspenders fallbacks;
 * after running this script every on-disk record is canonical.
 *
 * Behaviour:
 *   - Walks `$SCIENCESWARM_DIR/projects/<slug>/.brain/state/chat.json`
 *     using the same path resolvers the store uses (no hard-coded paths).
 *   - For each thread file: parse, replace legacy backend values with
 *     `"openclaw"`, write back via temp file + atomic rename.
 *   - Idempotent: a second run reports "0 migrated".
 *   - `--dry-run`: count would-migrate threads without writing.
 *
 * Out of scope:
 *   - Per-message `chatMode` is `"reasoning" | "openclaw-tools"` and was
 *     never widened, so it is not migrated here.
 *   - All other persisted fields (messages, artifactProvenance, etc.) are
 *     left exactly as they appear on disk.
 *
 * Usage:
 *   npm run migrate:chat-threads-openclaw
 *   npm run migrate:chat-threads-openclaw -- --dry-run
 *   SCIENCESWARM_DIR=~/.scienceswarm-test npm run migrate:chat-threads-openclaw
 */

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { getProjectLocalChatPath } from "../src/lib/state/project-storage";
import { getScienceSwarmProjectsRoot } from "../src/lib/scienceswarm-paths";

const PROJECT_SLUG_PATTERN = /^[a-z0-9-]+$/;
const LEGACY_BACKEND_VALUES = new Set(["agent", "direct"]);

export interface MigrationOptions {
  projectsRoot?: string;
  dryRun?: boolean;
  log?: (msg: string) => void;
  warn?: (msg: string) => void;
}

export interface MigrationSummary {
  scanned: number;
  migrated: number;
  alreadyCurrent: number;
  skipped: number;
  errors: Array<{ project: string; error: string }>;
  dryRun: boolean;
  projectsRoot: string;
}

/**
 * Scans the projects root for chat threads. Returns absolute paths to
 * `chat.json` files keyed by slug. Tolerates a missing projects root —
 * a fresh install simply has nothing to migrate.
 */
async function findChatThreadFiles(
  projectsRoot: string,
): Promise<Array<{ slug: string; chatPath: string }>> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(projectsRoot, { withFileTypes: true, encoding: "utf8" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const out: Array<{ slug: string; chatPath: string }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!PROJECT_SLUG_PATTERN.test(entry.name)) continue;
    const chatPath = getProjectLocalChatPath(entry.name, projectsRoot);
    try {
      const stat = await fs.stat(chatPath);
      if (stat.isFile()) {
        out.push({ slug: entry.name, chatPath });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
  return out;
}

/**
 * Atomic write: serialise to a sibling temp file inside the same
 * directory (so `rename` stays on the same filesystem) and rename into
 * place. If anything fails, remove the temp file before re-throwing so
 * partial state never lingers.
 */
async function atomicWriteJson(filePath: string, payload: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  const tempPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
  );
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(tempPath, body, "utf-8");
  try {
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true });
    throw error;
  }
}

interface ProcessResult {
  status: "migrated" | "already-current" | "skipped";
  reason?: string;
}

async function processThreadFile(
  slug: string,
  chatPath: string,
  dryRun: boolean,
): Promise<ProcessResult> {
  let raw: string;
  try {
    raw = await fs.readFile(chatPath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: "skipped", reason: "missing" };
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { status: "skipped", reason: `invalid JSON: ${(error as Error).message}` };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { status: "skipped", reason: "not an object" };
  }

  const record = parsed as Record<string, unknown>;
  const current = record.conversationBackend;

  if (current === "openclaw" || current === null || current === undefined) {
    return { status: "already-current" };
  }

  if (typeof current !== "string" || !LEGACY_BACKEND_VALUES.has(current)) {
    // Unknown shape — refuse to rewrite, but flag so the operator sees it.
    return { status: "skipped", reason: `unknown conversationBackend: ${JSON.stringify(current)}` };
  }

  if (dryRun) {
    return { status: "migrated" };
  }

  const next = { ...record, conversationBackend: "openclaw" as const };
  await atomicWriteJson(chatPath, next);
  return { status: "migrated" };
}

export async function migrateChatThreadsOpenClaw(
  options: MigrationOptions = {},
): Promise<MigrationSummary> {
  const projectsRoot = options.projectsRoot ?? getScienceSwarmProjectsRoot();
  const dryRun = Boolean(options.dryRun);
  const log = options.log ?? ((msg: string) => console.log(msg));
  const warn = options.warn ?? ((msg: string) => console.warn(msg));

  const summary: MigrationSummary = {
    scanned: 0,
    migrated: 0,
    alreadyCurrent: 0,
    skipped: 0,
    errors: [],
    dryRun,
    projectsRoot,
  };

  const files = await findChatThreadFiles(projectsRoot);
  for (const { slug, chatPath } of files) {
    summary.scanned += 1;
    try {
      const result = await processThreadFile(slug, chatPath, dryRun);
      if (result.status === "migrated") {
        summary.migrated += 1;
        log(
          dryRun
            ? `  [dry-run] would migrate ${slug} (${chatPath})`
            : `  migrated ${slug} (${chatPath})`,
        );
      } else if (result.status === "already-current") {
        summary.alreadyCurrent += 1;
      } else {
        summary.skipped += 1;
        warn(`  skipped ${slug}: ${result.reason}`);
      }
    } catch (error) {
      summary.errors.push({ project: slug, error: (error as Error).message });
      warn(`  error ${slug}: ${(error as Error).message}`);
    }
  }

  // Also surface the storage paths used so operators can sanity-check the
  // resolver picked the directory they expected.
  if (summary.scanned === 0) {
    log(`  no chat.json files found under ${projectsRoot}`);
  }

  return summary;
}

function printSummary(summary: MigrationSummary): void {
  const verb = summary.dryRun ? "would migrate" : "migrated";
  console.log("");
  console.log(`Projects root: ${summary.projectsRoot}`);
  console.log(`Scanned:        ${summary.scanned}`);
  console.log(`${verb}:        ${summary.migrated}`);
  console.log(`Already current: ${summary.alreadyCurrent}`);
  console.log(`Skipped:         ${summary.skipped}`);
  if (summary.errors.length > 0) {
    console.log(`Errors:          ${summary.errors.length}`);
    for (const error of summary.errors) {
      console.log(`  - ${error.project}: ${error.error}`);
    }
  }
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const help = process.argv.includes("--help") || process.argv.includes("-h");

  if (help) {
    console.log("Usage: npm run migrate:chat-threads-openclaw [-- --dry-run]");
    console.log("");
    console.log("Rewrites persisted chat threads so conversationBackend is");
    console.log("\"openclaw\" (collapsing the legacy \"agent\"/\"direct\" values).");
    console.log("Idempotent — safe to run repeatedly.");
    console.log("");
    console.log("Options:");
    console.log("  --dry-run   Report would-migrate count without writing.");
    return;
  }

  console.log(
    dryRun
      ? "Dry-run: scanning persisted chat threads (no writes)..."
      : "Migrating persisted chat threads to conversationBackend=\"openclaw\"...",
  );
  const summary = await migrateChatThreadsOpenClaw({ dryRun });
  printSummary(summary);

  if (summary.errors.length > 0) {
    process.exit(1);
  }
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
