import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Wiki-link backlink extractor
//
// Scans a directory of .md files for [[wiki-link]] syntax and builds a
// forward + backward link graph. Used by /api/backlinks/[projectId] to power
// backlink panels in the project wiki UI.
//
// Resolution rules:
//   - Filename index is built from each .md basename (without extension),
//     compared case-insensitively with no other normalisation.
//   - A link target resolves if the index contains it, OR if the target
//     includes a "/" and the relative path exists on disk.
//   - Broken links (unresolved) are collected separately and do NOT populate
//     the backward map.
// ---------------------------------------------------------------------------

export interface WikiLink {
  /** Source file relative to the scanned root. */
  src: string;
  /** Raw target text (the thing inside [[...]]). */
  target: string;
  /** Alias after "|" if present, e.g. [[target|Nice label]] → alias = "Nice label". */
  alias?: string;
  /** 1-indexed line number in the source. */
  line: number;
}

export interface BacklinkGraph {
  /** source file → unique target names it links to (insertion order). */
  forward: Record<string, string[]>;
  /** target name → unique source files that link to it (resolved only). */
  backward: Record<string, string[]>;
  /** Links whose target does not resolve to any file in the scan. */
  brokenLinks: WikiLink[];
  scannedFiles: number;
  /** ISO timestamp of when the scan completed. */
  scannedAt: string;
}

// Matches [[target]] and [[target|alias]]. The target must not contain "]",
// "|" or a newline; the alias, if present, must not contain "]" or a newline.
const WIKI_LINK_RE = /\[\[([^\]|\n]+?)(?:\|([^\]\n]*))?\]\]/g;

// Matches a fenced code block opener/closer. We track toggle state line by
// line — any line starting with ``` (possibly indented) flips the in-code
// state. We deliberately do not try to parse nested fences or backtick
// counts; the simple toggle matches GitHub-flavoured Markdown well enough
// for wiki-link extraction and keeps the implementation tiny.
const FENCE_RE = /^\s*```/;

/**
 * Extract wiki-links from a chunk of markdown text.
 *
 * - Handles aliased links: `[[target|alias]]` → `{target, alias}`.
 * - Multiple links on the same line are all captured.
 * - Lines inside fenced code blocks (``` ... ```) are skipped entirely.
 * - Inline backticks are ignored — `[[x]]` inside `code` is still captured,
 *   which is an acceptable trade-off for simplicity.
 */
export function extractWikiLinksFromText(text: string, src: string): WikiLink[] {
  const links: WikiLink[] = [];
  const lines = text.split(/\r?\n/);
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    // Reset lastIndex each line — WIKI_LINK_RE is a /g regex and re-using
    // a single instance across iterations is a classic stateful footgun.
    WIKI_LINK_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = WIKI_LINK_RE.exec(line)) !== null) {
      const target = match[1].trim();
      const rawAlias = match[2];
      const alias = rawAlias !== undefined ? rawAlias.trim() : undefined;
      if (!target) continue;
      links.push({
        src,
        target,
        ...(alias !== undefined && alias.length > 0 ? { alias } : {}),
        line: i + 1,
      });
    }
  }

  return links;
}

/**
 * Recursively walk `dir` and yield every `.md` file path relative to `root`.
 * Skips `node_modules`, dotfiles, and `.claude` to avoid scanning tooling.
 */
function walkMarkdown(root: string, dir: string): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.name === "node_modules") continue;
    if (entry.name === ".claude") continue;

    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkMarkdown(root, full));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      out.push(path.relative(root, full));
    }
  }

  return out;
}

function normalizeLinkKey(target: string): string {
  const normalized = target.split(path.sep).join("/");
  const withoutExt = normalized.toLowerCase().endsWith(".md")
    ? normalized.slice(0, -3)
    : normalized;
  return withoutExt.toLowerCase();
}

function isPathInsideRoot(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Build a {@link BacklinkGraph} for every .md file under `root`.
 *
 * - Missing root → returns an empty graph with `scannedFiles: 0` rather than
 *   throwing, so callers can call this on slugs that may not have a wiki yet.
 * - Basenames are compared case-insensitively with no other normalisation.
 * - Duplicate links from the same source are collapsed in `forward[src]`.
 */
export async function buildBacklinkGraph(root: string): Promise<BacklinkGraph> {
  const empty: BacklinkGraph = {
    forward: {},
    backward: {},
    brokenLinks: [],
    scannedFiles: 0,
    scannedAt: new Date().toISOString(),
  };

  if (!fs.existsSync(root)) {
    return empty;
  }

  let scanBase = root;
  let files: string[] = [];
  try {
    const stat = fs.statSync(root);
    if (stat.isDirectory()) {
      files = walkMarkdown(root, root);
    } else if (stat.isFile() && root.toLowerCase().endsWith(".md")) {
      scanBase = path.dirname(root);
      files = [path.basename(root)];
    } else {
      return empty;
    }
  } catch {
    return empty;
  }

  // Build the basename and exact-path indexes using normalized, lower-cased keys.
  const indexByBasename = new Map<string, string>();
  const indexByExactPath = new Map<string, string>();
  for (const rel of files) {
    const base = path.basename(rel, path.extname(rel));
    indexByBasename.set(normalizeLinkKey(base), rel);
    indexByExactPath.set(normalizeLinkKey(rel), rel);
  }

  const forward: Record<string, string[]> = {};
  const backward: Record<string, string[]> = {};
  const brokenLinks: WikiLink[] = [];

  for (const rel of files) {
    let text: string;
    try {
      text = await fs.promises.readFile(path.join(scanBase, rel), "utf-8");
    } catch {
      continue;
    }

    const links = extractWikiLinksFromText(text, rel);
    if (links.length === 0) continue;

    // Track unique targets per source in insertion order.
    const seenTargets = new Set<string>();
    const targetsForSrc: string[] = [];

    for (const link of links) {
      // A link resolves if the basename index contains it case-insensitively
      // OR the target is a relative path that exists on disk. We deliberately
      // do NOT match partial paths — only explicit "/"-containing targets get
      // the relative-path treatment so "notes" stays a basename lookup.
      const normalizedTarget = normalizeLinkKey(link.target);
      let resolved: string | undefined =
        indexByExactPath.get(normalizedTarget)
        ?? indexByBasename.get(normalizedTarget);
      if (!resolved && link.target.includes("/")) {
        // Allow both "foo/bar" and "foo/bar.md" relative targets.
        const withExt = link.target.endsWith(".md")
          ? link.target
          : `${link.target}.md`;
        const candidate = path.resolve(scanBase, withExt);
        if (
          isPathInsideRoot(scanBase, candidate)
          && fs.existsSync(candidate)
          && fs.statSync(candidate).isFile()
        ) {
          resolved = path.relative(scanBase, candidate);
        }
      }

      if (!seenTargets.has(link.target)) {
        seenTargets.add(link.target);
        targetsForSrc.push(link.target);
      }

      if (resolved) {
        const backwardKey = normalizeLinkKey(resolved);
        const bucket = backward[backwardKey] ?? [];
        if (!bucket.includes(rel)) {
          bucket.push(rel);
        }
        backward[backwardKey] = bucket;
      } else {
        brokenLinks.push(link);
      }
    }

    forward[rel] = targetsForSrc;
  }

  return {
    forward,
    backward,
    brokenLinks,
    scannedFiles: files.length,
    scannedAt: new Date().toISOString(),
  };
}
