// Round-trippable `.env` parser / writer for the `/setup` page.
//
// The setup UI lets a user fill in a handful of env values (API keys,
// paths, toggles). When they confirm, we write the result to
// `.env`. Two constraints drive the shape of this module:
//
//   1. Users edit `.env` by hand. If we blow away their
//      comments, reorder their keys, or rewrite quotes they put in on
//      purpose, that's a surprising regression. So we parse into an
//      ordered list of lines that preserves the raw bytes of every
//      line we're not actively modifying.
//
//   2. A partial write is worse than no write. If Node crashes halfway
//      through a `fs.writeFile`, the user's `.env` is now
//      truncated garbage and the app doesn't boot. We write to a
//      tempfile and `rename` at the end — POSIX `rename` is atomic on
//      the same filesystem, so either the old file or the new file is
//      present, never both and never neither.
//
// Pure parse/serialize/merge functions (no I/O); the only I/O is the
// single `writeEnvFileAtomic` helper.
//
// -----------------------------------------------------------------
// Parsing scope
// -----------------------------------------------------------------
// This is a deliberately narrow dotenv parser — it handles the
// dialect ScienceSwarm actually writes. In particular:
//
//   * `KEY=value`                      — raw value, no quotes
//   * `KEY="value"` / `KEY='value'`    — quoted value, outer quotes stripped
//   * Lines beginning (after optional whitespace) with `#` are comments
//   * Blank lines are preserved verbatim
//   * Windows line endings are accepted on input; on serialize we
//     emit LF-normalized lines but preserve the original `raw` bytes
//     for untouched entries so round-tripping Windows files back out
//     is lossless.
//
// We don't try to implement variable interpolation (`${FOO}`),
// multi-line values, or escape sequences inside values. Those would
// be nice to have but would also turn this into a real dotenv parser,
// which is out of scope for /setup.

import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";

export interface EnvCommentLine {
  type: "comment";
  raw: string;
}

export interface EnvInvalidLine {
  type: "invalid";
  raw: string;
  lineNumber: number;
}

export interface EnvBlankLine {
  type: "blank";
  raw: string;
}

export interface EnvEntryLine {
  type: "entry";
  key: string;
  value: string;
  raw: string;
}

export type EnvLine = EnvCommentLine | EnvInvalidLine | EnvBlankLine | EnvEntryLine;

export interface EnvDocument {
  lines: EnvLine[];
  /**
   * Whichever newline style dominated the input. We use this for any
   * *new* lines we append so they blend in with the rest of the file.
   * Defaults to `"\n"` for a fresh document.
   */
  newline: "\n" | "\r\n";
  /**
   * Whether the original input ended in a newline. We record this
   * separately from the line list so that a single trailing newline
   * survives the round-trip without turning into a phantom blank
   * line. Defaults to `false` for empty input; defaults to `true`
   * when we construct a fresh document ourselves.
   */
  trailingNewline: boolean;
}

const ENTRY_REGEX = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

/**
 * Split a raw string into an array of line records, one per physical
 * line. We keep the original line bytes in `raw` so that serializing
 * an untouched line reproduces it exactly, including any leading
 * whitespace or non-canonical quoting that we don't otherwise model.
 */
export function parseEnvFile(contents: string): EnvDocument {
  const newline = detectNewline(contents);
  const trailingNewline =
    contents.endsWith("\r\n") || contents.endsWith("\n");
  const rawLines = splitLines(contents);
  const lines: EnvLine[] = [];
  for (const [index, raw] of rawLines.entries()) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      lines.push({ type: "blank", raw });
      continue;
    }
    if (trimmed.startsWith("#")) {
      lines.push({ type: "comment", raw });
      continue;
    }
    const match = ENTRY_REGEX.exec(raw);
    if (!match) {
      lines.push({ type: "invalid", raw, lineNumber: index + 1 });
      continue;
    }
    const rawValue = match[2] ?? "";
    if (hasUnterminatedQuotedValue(rawValue)) {
      lines.push({ type: "invalid", raw, lineNumber: index + 1 });
      continue;
    }
    const key = match[1] as string;
    const value = unquoteValue(rawValue);
    lines.push({ type: "entry", key, value, raw });
  }
  return { lines, newline, trailingNewline };
}

/**
 * Emit the document back to a string. Untouched lines are reproduced
 * from their stored `raw` bytes verbatim; lines that have been
 * re-serialised (e.g. via `mergeEnvValues`) are built from their
 * key/value pair using the document's newline style.
 */
export function serializeEnvDocument(doc: EnvDocument): string {
  const body = doc.lines.map((line) => line.raw).join(doc.newline);
  if (doc.lines.length === 0) {
    return doc.trailingNewline ? doc.newline : "";
  }
  return doc.trailingNewline ? `${body}${doc.newline}` : body;
}

/**
 * Apply a map of `{ key: value | null }` updates against the document.
 *
 *   - `null` or `""` removes every entry with this key. Surrounding
 *     comments are kept as-is; we only touch entry lines. Users
 *     occasionally write "section header" comments above a group of
 *     keys, and guessing which header describes which key is a great
 *     way to destroy user content. Be conservative.
 *   - An existing key has its first occurrence's value updated in
 *     place; any later duplicates of the same key are removed so the
 *     saved value is definitively the one that wins at load time.
 *     (Node's dotenv loaders take the first occurrence, but leaving
 *     duplicates around makes the file misleading when users open it
 *     in an editor — and some libraries and external tools pick the
 *     last occurrence instead.)
 *   - A new key is appended at the end of the document. If the last
 *     line isn't already blank, we prepend a blank line first so the
 *     new entry is visually separated from whatever came before.
 *
 * We return a new document rather than mutating in place.
 */
export function mergeEnvValues(
  doc: EnvDocument,
  updates: Record<string, string | null>,
): EnvDocument {
  let lines = [...doc.lines];

  for (const [key, rawValue] of Object.entries(updates)) {
    const remove = rawValue === null || rawValue === "";
    const matchingIndexes: number[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (line && line.type === "entry" && line.key === key) {
        matchingIndexes.push(i);
      }
    }

    if (matchingIndexes.length > 0) {
      if (remove) {
        // Drop every occurrence so no stale duplicate can shadow the
        // caller's intent to clear this key.
        lines = lines.filter((_line, i) => !matchingIndexes.includes(i));
      } else {
        // Update the first occurrence in place; delete any later
        // duplicates. Removing trailing duplicates instead of the head
        // keeps the key's original position in the file, which tends
        // to keep section comments meaningful.
        const [firstIndex, ...extraIndexes] = matchingIndexes;
        if (firstIndex !== undefined) {
          const next: EnvEntryLine = {
            type: "entry",
            key,
            value: rawValue as string,
            raw: formatEntryLine(key, rawValue as string),
          };
          lines[firstIndex] = next;
        }
        if (extraIndexes.length > 0) {
          const extras = new Set(extraIndexes);
          lines = lines.filter((_line, i) => !extras.has(i));
        }
      }
      continue;
    }
    if (remove) {
      // Nothing to remove, nothing to insert.
      continue;
    }
    // Appending: make sure there's a visual break.
    const last = lines[lines.length - 1];
    if (last && last.type !== "blank") {
      lines.push({ type: "blank", raw: "" });
    }
    lines.push({
      type: "entry",
      key,
      value: rawValue as string,
      raw: formatEntryLine(key, rawValue as string),
    });
  }

  return {
    lines,
    newline: doc.newline,
    trailingNewline: doc.trailingNewline,
  };
}

/**
 * Write `contents` to `filePath` atomically. We write to a sibling
 * temp file, then rename into place. On any failure — write error,
 * rename error, anything — we try to clean up the temp file so we
 * don't litter the user's dir with `.env.tmp-1234-…` debris.
 *
 * Parent directory is not created; if it doesn't exist, caller gets
 * the underlying ENOENT. (Our caller checks that upstream, so we
 * don't need to swallow it here.)
 */
export async function writeEnvFileAtomic(
  filePath: string,
  contents: string,
): Promise<void> {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  // `pid + Date.now()` collides if two concurrent saves land on the
  // same millisecond in the same process — `Promise.all([save, save])`
  // is enough to hit it. Adding a crypto-random suffix makes the
  // collision probability effectively zero.
  const tempName = `${base}.tmp-${process.pid}-${Date.now()}-${randomBytes(6).toString("hex")}`;
  const tempPath = path.join(dir, tempName);
  try {
    await fs.writeFile(tempPath, contents, { encoding: "utf8", mode: 0o600 });
    await fs.rename(tempPath, filePath);
  } catch (err) {
    await safeUnlink(tempPath);
    throw err;
  }
}

// -----------------------------------------------------------------
// Internals
// -----------------------------------------------------------------

function detectNewline(contents: string): "\n" | "\r\n" {
  // If the input contains any `\r\n`, treat the whole document as
  // Windows-style. Mixed files are vanishingly rare and almost
  // always a mistake we'd rather normalise than preserve.
  return contents.includes("\r\n") ? "\r\n" : "\n";
}

function splitLines(contents: string): string[] {
  // Strip a single trailing newline if present so we don't end up
  // with a phantom empty line at the end of the document. Anything
  // beyond a single trailing newline is preserved as blank lines.
  if (contents.length === 0) {
    return [];
  }
  const stripped = contents.endsWith("\r\n")
    ? contents.slice(0, -2)
    : contents.endsWith("\n")
      ? contents.slice(0, -1)
      : contents;
  return stripped.split(/\r?\n/);
}

function hasUnterminatedQuotedValue(raw: string): boolean {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return false;
  }
  const first = trimmed[0];
  if (first !== '"' && first !== "'") {
    return false;
  }
  if (trimmed.length === 1) {
    return true;
  }
  return trimmed[trimmed.length - 1] !== first;
}

function unquoteValue(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      const inner = trimmed.slice(1, -1);
      if (first === '"') {
        // For double-quoted values, honour a minimal escape set: `\"`
        // and `\\`. Anything else is passed through unchanged so we
        // don't mangle regex/template strings a user wrote by hand.
        return inner.replace(/\\(["\\])/g, "$1");
      }
      return inner;
    }
  }
  return trimmed;
}

/**
 * Produce the canonical `raw` bytes for an entry line. We only quote
 * when we must — raw values win on round-trip fidelity when the
 * caller hasn't introduced whitespace or special characters.
 */
function formatEntryLine(key: string, value: string): string {
  return `${key}=${serializeValue(value)}`;
}

function serializeValue(value: string): string {
  if (value.length === 0) {
    return "";
  }
  const mustQuote = /[\s#"']/.test(value);
  if (!mustQuote) {
    return value;
  }
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}

async function safeUnlink(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch {
    // Swallow; the temp file may never have been created, or may
    // have already been cleaned up by the rename we were attempting.
    // This helper exists to clear debris, not to assert anything.
  }
}
