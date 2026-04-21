/**
 * Port-drift regression guard.
 *
 * ScienceSwarm has a single source of truth for service ports in
 * `src/lib/config/ports.ts`. Every runtime URL that points at
 * `localhost` or `127.0.0.1` must flow through a getter in that module
 * (or equivalent env-var interpolation in shell/Docker configs).
 *
 * This test walks the worktree and fails if any hardcoded
 * `localhost:<port>` or `127.0.0.1:<port>` literal appears outside the
 * allowlist below. Comments are stripped before matching so historical
 * prose and explanatory asides do not trigger the guard — only live
 * source tokens count.
 *
 * Adding a new port? Update `PORT_LITERALS`. Adding a new file that
 * legitimately needs the literal (e.g. the central config itself or a
 * client-side default that cannot read the server env)? Extend
 * `ALLOWLIST` with a short justification.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const REPO_ROOT = join(__dirname, "..", "..");

/**
 * Every known ScienceSwarm service port. The list is intentionally
 * closed: if a new service is added we want this test to be updated
 * deliberately rather than silently passing.
 */
const PORTS = [3000, 3001, 3002, 8000, 11434, 18789, 19002] as const;

const PORT_LITERALS: string[] = [
  ...PORTS.map((p) => `localhost:${p}`),
  ...PORTS.map((p) => `127.0.0.1:${p}`),
];

/**
 * Files that MAY contain raw `localhost:<port>` or `127.0.0.1:<port>`
 * literals. Paths are repo-relative and use POSIX separators.
 *
 * - `src/lib/config/ports.ts` is the single source of truth. The
 *   literals appear only as template-string fragments there, but the
 *   file is listed for clarity.
 * - `src/app/dashboard/settings/page.tsx` holds client-side default
 *   values in `useState` and placeholder props. Client components
 *   cannot read server env at render time, so baking the same default
 *   the server uses is correct.
 */
const ALLOWLIST = new Set<string>([
  "src/lib/config/ports.ts",
  "src/app/dashboard/settings/page.tsx",
]);

/**
 * Directories we never descend into. `tests/` is explicitly skipped so
 * the test fixtures can reference literal ports without tripping this
 * guard. `scripts/print-port.ts` is also skipped — it is a CLI helper
 * that legitimately prints the resolved port.
 */
const SKIP_DIRS = new Set<string>([
  "node_modules",
  ".git",
  ".next",
  ".turbo",
  "dist",
  "out",
  "build",
  "coverage",
  "tests",
]);

/**
 * Individual files to skip regardless of extension. `scripts/print-port.ts`
 * is a CLI that prints the resolved port — it reads from the config
 * module and therefore has no hardcoded literals, but we skip it
 * defensively in case future iterations reference a default literal.
 */
const SKIP_FILES = new Set<string>([
  "scripts/print-port.ts",
]);

/** Extensions of source files that get comment-stripped TS/TSX parsing. */
const TS_EXT = new Set<string>([".ts", ".tsx"]);

/** Files whose names are scanned verbatim regardless of extension. */
const ROOT_INFRA_FILES = new Set<string>([
  "install.sh",
  "start.sh",
  "Dockerfile",
]);

/** Predicate for whether a basename is an infra yaml file. */
function isComposeFile(name: string): boolean {
  return name === "docker-compose.yml" || /^docker-compose\..+\.yml$/.test(name);
}

/**
 * Return true if a file basename under `src/` should be scanned. We
 * restrict to TS/TSX so JSON schemas, lockfiles, and other noise do
 * not introduce false positives.
 */
function isSrcScannable(name: string): boolean {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return false;
  return TS_EXT.has(name.slice(dot));
}

/**
 * Walk a directory recursively, collecting file paths that match the
 * per-tree predicate. Skips entries in `SKIP_DIRS` and anything starting
 * with a dot (hidden files/dirs) except the ones we explicitly enter.
 */
function walk(dir: string, pred: (name: string) => boolean, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    let stats;
    try {
      stats = statSync(full);
    } catch {
      continue;
    }
    if (stats.isDirectory()) {
      walk(full, pred, out);
    } else if (stats.isFile() && pred(name)) {
      out.push(full);
    }
  }
}

/**
 * Build the list of files to scan:
 * - Everything under `src/` matching TS/TSX.
 * - The root-level infra files (install.sh, start.sh, Dockerfile).
 * - Any `docker-compose*.yml` at the repo root.
 */
function collectFiles(root: string): string[] {
  const out: string[] = [];
  walk(join(root, "src"), isSrcScannable, out);

  let rootEntries: string[] = [];
  try {
    rootEntries = readdirSync(root);
  } catch {
    // no-op
  }
  for (const name of rootEntries) {
    if (ROOT_INFRA_FILES.has(name) || isComposeFile(name)) {
      const full = join(root, name);
      try {
        if (statSync(full).isFile()) out.push(full);
      } catch {
        // ignore
      }
    }
  }
  return out;
}

/**
 * Strip TS/TSX comments from source so explanatory prose does not
 * count as a hit. Handles both `//` line comments and `/* *\/` block
 * comments while preserving string-literal contents. Line structure
 * is preserved by replacing comment bodies with spaces so error
 * messages still point at the original line numbers.
 */
function stripTsComments(src: string): string {
  const chars = src.split("");
  const out: string[] = new Array(chars.length);
  const enum Mode {
    Code,
    LineComment,
    BlockComment,
    SingleQuote,
    DoubleQuote,
    BackTick,
  }
  let mode: Mode = Mode.Code;
  let i = 0;
  while (i < chars.length) {
    const c = chars[i];
    const next = chars[i + 1];
    if (mode === Mode.Code) {
      if (c === "/" && next === "/") {
        out[i] = " ";
        out[i + 1] = " ";
        i += 2;
        mode = Mode.LineComment;
        continue;
      }
      if (c === "/" && next === "*") {
        out[i] = " ";
        out[i + 1] = " ";
        i += 2;
        mode = Mode.BlockComment;
        continue;
      }
      if (c === "'") mode = Mode.SingleQuote;
      else if (c === '"') mode = Mode.DoubleQuote;
      else if (c === "`") mode = Mode.BackTick;
      out[i] = c;
      i += 1;
      continue;
    }
    if (mode === Mode.LineComment) {
      if (c === "\n") {
        out[i] = c;
        mode = Mode.Code;
      } else {
        out[i] = c === "\r" ? c : " ";
      }
      i += 1;
      continue;
    }
    if (mode === Mode.BlockComment) {
      if (c === "*" && next === "/") {
        out[i] = " ";
        out[i + 1] = " ";
        i += 2;
        mode = Mode.Code;
        continue;
      }
      out[i] = c === "\n" || c === "\r" ? c : " ";
      i += 1;
      continue;
    }
    // Inside a string literal: preserve escapes and look for the
    // matching terminator. We intentionally keep string contents
    // intact — a literal like "http://localhost:3000" should still be
    // caught.
    if (c === "\\" && i + 1 < chars.length) {
      out[i] = c;
      out[i + 1] = chars[i + 1];
      i += 2;
      continue;
    }
    if (
      (mode === Mode.SingleQuote && c === "'") ||
      (mode === Mode.DoubleQuote && c === '"') ||
      (mode === Mode.BackTick && c === "`")
    ) {
      out[i] = c;
      mode = Mode.Code;
      i += 1;
      continue;
    }
    out[i] = c;
    i += 1;
  }
  return out.join("");
}

/**
 * Strip `#`-style line comments from shell / yaml / Dockerfile
 * content. Line structure is preserved. We do not try to be fancy
 * about `#` appearing inside quoted strings — the infra files in this
 * repo do not use `#` inside URLs, so a simple strip is sufficient
 * and has zero false negatives for the port literals we care about.
 */
function stripHashComments(src: string): string {
  return src
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("#");
      if (idx < 0) return line;
      // Preserve column alignment by padding the stripped region with
      // spaces so downstream line numbers/columns still line up.
      return line.slice(0, idx) + " ".repeat(line.length - idx);
    })
    .join("\n");
}

function toPosix(relPath: string): string {
  return sep === "/" ? relPath : relPath.split(sep).join("/");
}

function prepareContent(relPath: string, raw: string): string {
  if (relPath.endsWith(".ts") || relPath.endsWith(".tsx")) {
    return stripTsComments(raw);
  }
  // start.sh, install.sh, Dockerfile, docker-compose*.yml all use `#`.
  return stripHashComments(raw);
}

interface Violation {
  file: string;
  line: number;
  literal: string;
}

function scanFile(absPath: string, relPath: string): Violation[] {
  const raw = readFileSync(absPath, "utf8");
  const cleaned = prepareContent(relPath, raw);
  const hits: Violation[] = [];
  const lines = cleaned.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const lit of PORT_LITERALS) {
      if (line.includes(lit)) {
        hits.push({ file: relPath, line: i + 1, literal: lit });
      }
    }
  }
  return hits;
}

describe("port-drift regression guard", () => {
  it("no hardcoded localhost:PORT literals outside src/lib/config/ports.ts", () => {
    const files = collectFiles(REPO_ROOT);

    // Sanity check: the walker must actually find files or the test is
    // vacuous. This guards against a future refactor that silently
    // breaks the traversal.
    expect(files.length).toBeGreaterThan(10);

    const violations: Violation[] = [];
    for (const abs of files) {
      const rel = toPosix(relative(REPO_ROOT, abs));
      if (ALLOWLIST.has(rel)) continue;
      if (SKIP_FILES.has(rel)) continue;
      violations.push(...scanFile(abs, rel));
    }

    if (violations.length > 0) {
      const detail = violations
        .map((v) => `  ${v.file}:${v.line} contains "${v.literal}"`)
        .join("\n");
      throw new Error(
        `port-drift: found ${violations.length} hardcoded port literal(s) outside the allowlist.\n` +
          `Route these through a getter in src/lib/config/ports.ts, or (if this is a legitimate client-side default) add the file to ALLOWLIST in tests/integration/port-drift.test.ts.\n\n` +
          `Violations:\n${detail}`,
      );
    }

    expect(violations).toEqual([]);
  });
});
