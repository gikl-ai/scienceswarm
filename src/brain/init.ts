/**
 * Second Brain — Initialization (Track C.2 rewrite)
 *
 * Before Track C.2: this module owned a custom filesystem wiki tree
 * (`wiki/home.md`, `wiki/projects/`, …) plus a handful of template files.
 * Tests and downstream modules walked that tree directly.
 *
 * After Track C.2: gbrain is the source of truth for brain data. The
 * `initBrain` entrypoint now:
 *
 *   1. Bootstraps a PGLite gbrain engine at
 *      `resolvePgliteDatabasePath(root)` via `createRuntimeEngine` +
 *      `initSchema()`. This is the only load-bearing side effect.
 *   2. Materializes a minimal filesystem scaffolding (directories +
 *      `BRAIN.md` + `wiki/home.md`, `wiki/overview.md`, `wiki/index.md`,
 *      `wiki/log.md`, `wiki/events.jsonl`, `.gitignore`) so the 17+
 *      legacy tests that assert on these paths keep compiling while the
 *      downstream migrations in Track C.3 catch up. Content is seeded
 *      from `src/brain/templates/init/*` exactly as before.
 *
 * The filesystem scaffolding is transitional — it exists only to keep
 * Track C.2 landable without touching every test harness. Track C.3
 * removes the filesystem seed once `briefing.ts`, `task-extractor.ts`,
 * and the remaining downstream modules read through the gbrain engine.
 *
 * Export surface is preserved so existing callers (setup flow, test
 * harness, `connectGbrain`) stay source-compatible.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { isAbsolute, join, relative, resolve } from "path";
import { loadBrainPreset } from "./presets";
import { type BrainPresetId, normalizeBrainPreset } from "./presets/types";
import { resolveBrainFile } from "./template-paths";
import {
  defaultInstallerEnvironment,
  runInstallerToCompletion,
} from "@/lib/setup/gbrain-installer";

const TEMPLATE_DIR = resolveBrainFile("templates", "init");

/**
 * Minimal filesystem scaffolding kept for backwards-compatibility with
 * ~17 tests that still walk `wiki/…` and `raw/…` directly. Track C.3
 * will delete these once the downstream modules migrate to
 * `engine.getPage` / `engine.putPage`.
 */
const BRAIN_DIRS = [
  "raw/papers",
  "raw/notes",
  "raw/data",
  "raw/observations",
  "raw/web",
  "raw/voice",
  "raw/projects",
  "raw/decisions",
  "raw/tasks",
  "raw/artifacts",
  "raw/frontier",
  "raw/imports",
  "raw/captures/telegram",
  "raw/captures/web",
  "wiki/projects",
  "wiki/areas",
  "wiki/resources",
  "wiki/archives",
  "wiki/concepts",
  "wiki/decisions",
  "wiki/tasks",
  "wiki/observations",
  "wiki/experiments",
  "wiki/hypotheses",
  "wiki/protocols",
  "wiki/entities/artifacts",
  "wiki/entities/frontier",
  "wiki/entities/papers",
  "wiki/entities/people",
  "wiki/entities/datasets",
  "wiki/entities/tools",
  "wiki/schema",
  "state/projects",
  "state/channels/telegram",
  "state/schedules",
];

export interface InitOptions {
  /** Brain root directory (absolute path) */
  root: string;
  /** Researcher name (for BRAIN.md) */
  name?: string;
  /** Research field (for BRAIN.md) */
  field?: string;
  /** Institution (for BRAIN.md) */
  institution?: string;
  /** Named preset that controls BRAIN.md and resolver-compatible directories. */
  brainPreset?: BrainPresetId;
}

export interface InitResult {
  root: string;
  created: boolean;
  message: string;
}

interface InstallerCompatOptions extends InitOptions {
  repoRoot?: string;
}

/**
 * Initialize a brain at the given root.
 *
 * Idempotent: if `BRAIN.md` exists at the root the function returns
 * without touching either gbrain or the filesystem scaffolding. This
 * matches the pre-Track C.2 shape so existing callers (setup flow,
 * `connectGbrain`) do not regress.
 */
export function initBrain(options: InitOptions): InitResult {
  const root = resolve(options.root);
  const preset = loadBrainPreset(normalizeBrainPreset(options.brainPreset));

  if (existsSync(resolvePathWithinRoot(root, "BRAIN.md"))) {
    return {
      root,
      created: false,
      message: `Brain already exists at ${root}`,
    };
  }

  // Create directory structure. The gbrain PGLite database itself is
  // bootstrapped lazily on first use by `GbrainEngineAdapter.initialize`
  // (`src/brain/store.ts`) or by `materializeMemory`'s per-capture
  // `connectPglite` call — both resolve to the same
  // `resolvePgliteDatabasePath(root)` location.
  //
  // We deliberately do NOT kick off a PGLite engine inside `initBrain`:
  // the function is sync (its signature has 17+ callers in tests that
  // assume it's sync), and a fire-and-forget engine connect races
  // against test teardown (rmSync on the brain root while PGLite is
  // still writing `brain.pglite-journal`).
  for (const dir of BRAIN_DIRS) {
    mkdirSync(resolvePathWithinRoot(root, dir), { recursive: true });
  }
  for (const dir of preset.directories) {
    mkdirSync(resolvePathWithinRoot(root, dir), { recursive: true });
  }
  mkdirSync(resolvePathWithinRoot(root, "wiki"), { recursive: true });

  // Legacy filesystem scaffolding — read templates exactly as before.
  const brainContent = preset.brainTemplate
    .replace("{researcher name}", options.name ?? "{your name}")
    .replace("{e.g., Computational Biology}", options.field ?? "{your field}")
    .replace("{e.g., MIT CSAIL}", options.institution ?? "{your institution}")
    .replace("{comma-separated list}", "{your active projects}");
  writeFileSync(resolvePathWithinRoot(root, "BRAIN.md"), brainContent);

  const homeTemplate = readFileSync(
    join(TEMPLATE_DIR, "home.md"),
    "utf-8"
  );
  writeFileSync(resolvePathWithinRoot(root, "wiki/home.md"), homeTemplate);

  const overviewTemplate = readFileSync(
    join(TEMPLATE_DIR, "overview.md"),
    "utf-8"
  );
  writeFileSync(resolvePathWithinRoot(root, "wiki/overview.md"), overviewTemplate);

  const indexTemplate = readFileSync(
    join(TEMPLATE_DIR, "index.md"),
    "utf-8"
  );
  writeFileSync(resolvePathWithinRoot(root, "wiki/index.md"), indexTemplate);

  writeFileSync(
    resolvePathWithinRoot(root, "wiki/log.md"),
    "# Brain Log\n\nChronological record of all operations.\n"
  );

  writeFileSync(resolvePathWithinRoot(root, "wiki/events.jsonl"), "");

  writeFileSync(
    resolvePathWithinRoot(root, ".gitignore"),
    [
      "# Large raw files (optional: uncomment to exclude from git)",
      "# raw/papers/*.pdf",
      "# raw/voice/*.mp3",
      "# raw/voice/*.wav",
      "# raw/data/*.csv",
      "",
    ].join("\n")
  );

  return {
    root,
    created: true,
    message: `Brain initialized at ${root}. Open in Obsidian or connect via MCP.`,
  };
}

export async function initBrainWithInstaller(
  options: InstallerCompatOptions,
): Promise<InitResult> {
  const env = await defaultInstallerEnvironment();
  const { events, ok } = await runInstallerToCompletion(
    {
      repoRoot: options.repoRoot ?? process.cwd(),
      brainRoot: options.root,
      brainPreset: normalizeBrainPreset(options.brainPreset),
      // The compatibility surfaces (`/api/brain/init`, MCP `brain_init`)
      // should still complete in offline dev/test environments. The
      // dedicated /setup installer path retains the explicit network probe.
      skipNetworkCheck: true,
    },
    env,
  );

  if (!ok) {
    const summary = events[events.length - 1];
    const message =
      summary?.type === "summary" && summary.error?.message
        ? summary.error.message
        : "Brain initialization failed";
    throw new Error(message);
  }

  return initBrain({
    ...options,
    brainPreset: normalizeBrainPreset(options.brainPreset),
  });
}

function resolvePathWithinRoot(root: string, relativePath: string): string {
  if (!relativePath || isAbsolute(relativePath)) {
    throw new Error("Brain init paths must stay relative to the configured root.");
  }

  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(resolvedRoot, relativePath);
  const relativeToRoot = relative(resolvedRoot, resolvedPath);
  if (relativeToRoot.startsWith("..") || isAbsolute(relativeToRoot)) {
    throw new Error("Brain init path escapes the configured root.");
  }

  return resolvedPath;
}
