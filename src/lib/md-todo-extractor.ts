import fs from "node:fs/promises";
import path from "node:path";

export interface TodoItem {
  /** Path relative to the scanned root, forward-slashed. */
  file: string;
  /** 1-indexed source line number. */
  line: number;
  /** The todo text (without the checkbox). */
  text: string;
  /** true for `- [x]`, false for `- [ ]`. */
  done: boolean;
}

export interface TodoScanResult {
  todos: TodoItem[];
  scannedFiles: number;
  scannedAt: string;
}

// Matches "- [ ] task", "* [x] task", or "+ [ ] task" (with leading
// whitespace). CommonMark/GFM allows `-`, `*`, and `+` as list bullets.
// Group 1 = the checkbox content (space, x, or X). Group 2 = the todo text.
const CHECKBOX_RE = /^\s*[-*+]\s*\[([ xX])\]\s+(.+)$/;

/**
 * Scan a single file's text and return every markdown checkbox as a
 * {@link TodoItem}. Items are returned in source order with 1-indexed lines
 * and trailing whitespace trimmed from the text.
 */
export function extractTodosFromText(text: string, file: string): TodoItem[] {
  const todos: TodoItem[] = [];
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const match = CHECKBOX_RE.exec(lines[i]);
    if (!match) continue;
    const marker = match[1];
    const body = match[2].replace(/\s+$/, "");
    todos.push({
      file,
      line: i + 1,
      text: body,
      done: marker === "x" || marker === "X",
    });
  }

  return todos;
}

function toRelativePosix(root: string, absolute: string): string {
  const rel = path.relative(root, absolute);
  return rel.split(path.sep).join("/");
}

/**
 * Return true if `candidate` is the same path as `root` or a descendant of it.
 * Both inputs are expected to already be real (symlink-resolved) absolute
 * paths; this is a plain string-prefix test with a separator guard so that
 * e.g. `/tmp/root-other` is NOT treated as being under `/tmp/root`.
 */
function isWithinRoot(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  const withSep = root.endsWith(path.sep) ? root : root + path.sep;
  return candidate.startsWith(withSep);
}

async function walkMarkdownFiles(
  root: string,
  current: string,
  visited: Set<string>,
  out: string[],
): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(current, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const name = entry.name;
    // Skip dotfiles/dot-directories (covers `.claude`, `.git`, `.vscode`, ...).
    if (name.startsWith(".")) continue;
    // Skip node_modules regardless of depth.
    if (name === "node_modules") continue;

    const fullPath = path.join(current, name);

    // Resolve symlinks once and track by their real path so cycles are
    // broken after the first visit.
    let realPath: string;
    try {
      realPath = await fs.realpath(fullPath);
    } catch {
      continue;
    }
    // Reject anything whose resolved path escapes the project root. Without
    // this check a symlink inside the wiki could point at `/etc` (or any
    // other path) and leak files via the TODO API.
    if (!isWithinRoot(root, realPath)) continue;
    if (visited.has(realPath)) continue;
    visited.add(realPath);

    let stat;
    try {
      stat = await fs.stat(realPath);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      await walkMarkdownFiles(root, realPath, visited, out);
    } else if (stat.isFile() && name.toLowerCase().endsWith(".md")) {
      out.push(fullPath);
    }
  }
}

/**
 * Recursively scan a brain-wiki root for markdown files and extract all
 * checkbox-style TODOs. Missing roots return an empty result rather than
 * throwing.
 */
export async function scanProjectTodos(root: string): Promise<TodoScanResult> {
  const scannedAt = new Date().toISOString();

  let rootReal: string;
  try {
    rootReal = await fs.realpath(root);
  } catch {
    return { todos: [], scannedFiles: 0, scannedAt };
  }

  let rootStat;
  try {
    rootStat = await fs.stat(rootReal);
  } catch {
    return { todos: [], scannedFiles: 0, scannedAt };
  }
  if (!rootStat.isDirectory()) {
    return { todos: [], scannedFiles: 0, scannedAt };
  }

  const visited = new Set<string>([rootReal]);
  const mdFiles: string[] = [];
  await walkMarkdownFiles(rootReal, rootReal, visited, mdFiles);

  // Read all .md files concurrently. A single large wiki tree can contain
  // hundreds of files; a sequential awaited loop serialised every read and
  // inflated endpoint latency. Promise.all preserves source ordering (the
  // result array matches mdFiles) so the final todo order is deterministic.
  const perFile = await Promise.all(
    mdFiles.map(async (filePath) => {
      try {
        const content = await fs.readFile(filePath, "utf-8");
        const relative = toRelativePosix(rootReal, filePath);
        return extractTodosFromText(content, relative);
      } catch {
        return [] as TodoItem[];
      }
    }),
  );
  const todos: TodoItem[] = perFile.flat();

  return {
    todos,
    scannedFiles: mdFiles.length,
    scannedAt,
  };
}
