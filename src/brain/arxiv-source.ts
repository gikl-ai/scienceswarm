/**
 * Second Brain — arXiv e-print Source Downloader
 *
 * Downloads the LaTeX source archive that arXiv ships alongside a paper's
 * PDF (the "e-print") and unpacks the .tex / .bbl / .bib files into a
 * destination directory.
 *
 * Why this matters: a paper's PDF is the rendered artifact, but its
 * compiled bibliography lives in `.bbl` (and the database it was built
 * from in `.bib`). Pulling the source lets the Paper Library extract
 * the exact reference list the paper cited — far more accurate than
 * heuristic PDF-text scraping.
 *
 * arXiv e-prints come in three flavours:
 *
 *   1. Gzipped tarball of .tex / .bbl / .bib / figures / cls / sty
 *   2. A single gzipped .tex file
 *   3. A bare PDF when the author withheld source — rejected
 *
 * The kind is sniffed by gunzipping the payload and inspecting the
 * first 512 bytes (gzip magic 1f 8b on the wire, ustar magic at offset
 * 257 of the gunzipped tar, %PDF magic if the author shipped a bare
 * PDF), then dispatched to the appropriate extractor. Tarballs are
 * extracted via the same `execFile`-based subprocess pattern used
 * elsewhere in this repo, but only after a verbose archive listing is
 * checked for absolute / `..`-traversing entry paths *and* symlink
 * targets, so a hostile archive cannot tar-slip out of the destination
 * directory through either vector. The post-extraction file walker
 * uses `lstatSync` and skips symlinks entirely, so a same-name symlink
 * that the listing missed cannot smuggle a path outside `destDir` into
 * the returned `files.tex` / `.bbl` / `.bib` list.
 *
 * No new npm dependencies: the module relies only on Node's built-in
 * `node:zlib`, `node:child_process`, and `node:fs`.
 */

import { execFileSync } from "child_process";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "fs";
import { join, resolve } from "path";
import { gunzipSync } from "zlib";

import {
  applyArxivRateLimit,
  resolveArxivSource,
  resetRateLimit as resetArxivDownloadRateLimit,
} from "./arxiv-download";

// ── Public API ────────────────────────────────────────

export interface ArxivSourceFiles {
  /** Absolute paths to `.tex` files discovered after extraction. */
  tex: string[];
  /** Absolute paths to `.bbl` (compiled bibliography) files. */
  bbl: string[];
  /** Absolute paths to `.bib` (BibTeX database) files. */
  bib: string[];
}

export interface ArxivSourceResult {
  /** Bare arXiv id (with any `vN` suffix removed) used for naming. */
  arxivId: string;
  /** Destination directory the source was extracted into. */
  destDir: string;
  /** Saved e-print payload, kept for provenance / re-extraction. */
  eprintPath: string;
  /** What kind of payload arXiv served. */
  kind: ArxivSourceKind;
  /** Discovered LaTeX / bibliography files. */
  files: ArxivSourceFiles;
}

export type ArxivSourceKind = "tarball" | "gzipped-tex" | "tar" | "tex";

export interface DownloadArxivSourceOptions {
  /** Re-download even if the e-print payload is already cached. */
  force?: boolean;
  /** Override the per-call request timeout (default 30s). */
  timeoutMs?: number;
  /** Override the cooperative rate-limit (default 3s between downloads). */
  rateLimitMs?: number;
}

const ARXIV_SOURCE_TIMEOUT_MS = 30_000;
const TAR_TIMEOUT_MS = 60_000;

/**
 * Download an arXiv e-print and unpack the LaTeX source files into
 * `destDir`. Returns a summary of the extracted layout.
 *
 * Throws `ArxivSourceError` for unrecoverable conditions (network
 * failure, bare-PDF e-print, malformed archive, suspect path inside
 * archive).
 */
export async function downloadArxivSource(
  arxivIdInput: string,
  destDir: string,
  opts: DownloadArxivSourceOptions = {},
): Promise<ArxivSourceResult> {
  const resolved = resolveArxivSource(arxivIdInput);
  if (!resolved) {
    throw new ArxivSourceError(
      `Not a recognizable arXiv id: ${arxivIdInput}`,
      arxivIdInput,
    );
  }
  // arXiv accepts versioned ids on /e-print, but we save under the bare
  // id so re-downloads with and without the vN suffix collide cleanly.
  const bareId = resolved.arxivId.replace(/v\d+$/i, "");

  mkdirSync(destDir, { recursive: true });
  const eprintPath = join(destDir, `${bareId}.eprint.bin`);

  const force = opts.force === true;
  if (!force && existsSync(eprintPath) && statSync(eprintPath).size > 0) {
    // Already cached — just re-run extraction so the result is fresh.
    return extractArxivSource(bareId, eprintPath, destDir);
  }

  await applyArxivRateLimit({ rateLimitMs: opts.rateLimitMs });

  const eprintUrl = `https://arxiv.org/e-print/${bareId}`;
  const timeoutMs = opts.timeoutMs ?? ARXIV_SOURCE_TIMEOUT_MS;
  let response: Response;
  try {
    response = await fetch(eprintUrl, {
      headers: {
        "User-Agent":
          "ScienceSwarm-Brain/1.0 (research tool; mailto:contact@scienceswarm.dev)",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (isRequestTimeout(error)) {
      throw new ArxivSourceError(
        `Timed out downloading arXiv e-print ${bareId} after ${timeoutMs}ms`,
        bareId,
      );
    }
    throw error;
  }

  if (!response.ok) {
    throw new ArxivSourceError(
      `Failed to download arXiv e-print ${bareId}: HTTP ${response.status} ${response.statusText}`,
      bareId,
      response.status,
    );
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length === 0) {
    throw new ArxivSourceError(
      `Empty e-print payload for ${bareId}`,
      bareId,
    );
  }

  writeFileSync(eprintPath, buffer);
  return extractArxivSource(bareId, eprintPath, destDir);
}

/**
 * Extract a previously-downloaded arXiv e-print payload into `destDir`.
 *
 * `bareId` is used to name the on-disk artifact when the payload is a
 * bare gzipped .tex without an embedded filename.
 */
export function extractArxivSource(
  bareId: string,
  eprintPath: string,
  destDir: string,
): ArxivSourceResult {
  if (!existsSync(eprintPath)) {
    throw new ArxivSourceError(
      `e-print payload missing: ${eprintPath}`,
      bareId,
    );
  }
  mkdirSync(destDir, { recursive: true });

  const head = readHeadBytes(eprintPath, 512);
  const payload = classifyPayload(head);
  let kind: ArxivSourceKind;
  switch (payload) {
    case "pdf":
      throw new ArxivSourceError(
        `e-print is a bare PDF — no LaTeX source available for ${bareId}`,
        bareId,
      );
    case "gzip":
      kind = extractGzipPayload(bareId, eprintPath, destDir);
      break;
    case "tar":
      extractTarball(eprintPath, destDir, /* gzipped */ false);
      kind = "tar";
      break;
    case "tex":
      writeFileSync(join(destDir, `${bareId}.tex`), readFileSync(eprintPath));
      kind = "tex";
      break;
    default:
      throw new ArxivSourceError(
        `Unknown e-print payload format for ${bareId}`,
        bareId,
      );
  }

  return {
    arxivId: bareId,
    destDir,
    eprintPath,
    kind,
    files: listSourceFiles(destDir),
  };
}

// ── Errors ────────────────────────────────────────────

export class ArxivSourceError extends Error {
  public readonly arxivId: string;
  public readonly httpStatus?: number;

  constructor(message: string, arxivId: string, httpStatus?: number) {
    super(message);
    this.name = "ArxivSourceError";
    this.arxivId = arxivId;
    this.httpStatus = httpStatus;
  }
}

/**
 * Reset the cooperative arxiv.org rate-limit timer. Test-only; defers
 * to the shared timer in `arxiv-download.ts` so PDF and e-print tests
 * stay in lockstep.
 */
export function resetArxivSourceRateLimit(): void {
  resetArxivDownloadRateLimit();
}

// ── Internal helpers ──────────────────────────────────

type PayloadKind = "gzip" | "tar" | "pdf" | "tex" | "unknown";

function classifyPayload(head: Buffer): PayloadKind {
  if (head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b) {
    return "gzip";
  }
  if (head.length >= 5 && head.subarray(0, 5).toString("ascii") === "%PDF-") {
    return "pdf";
  }
  if (head.length >= 263) {
    // POSIX writes `ustar\0`, GNU writes `ustar ` (trailing space).
    // Accept either so uncompressed GNU tarballs aren't silently
    // rejected as "unknown".
    const magic = head.subarray(257, 263).toString("ascii");
    if (magic === "ustar\0" || magic === "ustar ") {
      return "tar";
    }
  }
  // Heuristic: ASCII-printable with a TeX-y prefix.
  if (looksLikeTex(head)) {
    return "tex";
  }
  return "unknown";
}

function looksLikeTex(head: Buffer): boolean {
  const text = head.toString("utf8", 0, Math.min(head.length, 512));
  return (
    text.includes("\\documentclass") ||
    text.includes("\\begin{document}") ||
    text.includes("%!TEX") ||
    /^\s*%/.test(text)
  );
}

/**
 * Read up to `count` bytes from the start of `filePath`. Uses an
 * explicit `openSync` + `readSync` pair rather than `readFileSync` so
 * arXiv tarballs that include figures (often tens of MB) don't get
 * fully materialised into memory just to sniff their magic bytes.
 */
function readHeadBytes(filePath: string, count: number): Buffer {
  const fd = openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(count);
    const n = readSync(fd, buf, 0, count, 0);
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

function extractGzipPayload(
  bareId: string,
  eprintPath: string,
  destDir: string,
): ArxivSourceKind {
  // Decompress the payload once and inspect the first 512 bytes of
  // the gunzipped result. This is more reliable than asking `tar
  // -tzf` whether the archive is a tarball — different tar
  // implementations disagree on what to do when handed a bare-gzip
  // non-tar payload (BSD tar errors out, GNU tar may silently
  // misbehave), and we'd rather decide it ourselves from magic
  // bytes than depend on the host tool's tolerance.
  const gunzipped = gunzipSync(readFileSync(eprintPath));
  const sub = classifyPayload(gunzipped.subarray(0, 512));
  if (sub === "pdf") {
    throw new ArxivSourceError(
      `e-print decompresses to a PDF — no LaTeX source for ${bareId}`,
      bareId,
    );
  }
  if (sub === "tar") {
    // It's a tar.gz — let `tar` extract it directly from the still-
    // compressed payload on disk so we don't have to rewrite a temp
    // uncompressed copy.
    extractTarball(eprintPath, destDir, /* gzipped */ true);
    return "tarball";
  }
  // Anything else (TeX, plain text, "unknown") gets written as a bare
  // .tex named after the arxiv id.
  writeFileSync(join(destDir, `${bareId}.tex`), gunzipped);
  return "gzipped-tex";
}

function extractTarball(
  archivePath: string,
  destDir: string,
  gzipped: boolean,
): void {
  // Verbose listing so we can see symlink targets ("name -> target")
  // and reject hostile entries before any byte hits disk.
  const listFlags = gzipped ? "-tvzf" : "-tvf";
  const listing = runBinary("tar", [listFlags, archivePath]);
  assertSafeTarListing(listing);
  const extractFlags = gzipped
    ? ["--no-same-owner", "-xzf"]
    : ["--no-same-owner", "-xf"];
  runBinary("tar", [...extractFlags, archivePath, "-C", destDir]);
}

/**
 * Throw if any line in a `tar -tvf` listing is suspect — either an
 * absolute path / `..`-traversing entry name, or a symlink whose
 * target is absolute or `..`-traversing. Exported so tests can
 * exercise the policy without having to hand-build a malicious
 * tarball. Accepts both verbose listings (with permission prefix and
 * `name -> target` for symlinks) and bare `tar -tf` listings (paths
 * only) so older callers and tests keep working.
 */
export function assertSafeTarListing(listing: string): void {
  for (const line of listing.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parsed = parseTarListingLine(trimmed);
    rejectIfSuspectPath(parsed.entry);
    if (parsed.linkTarget !== undefined) {
      rejectIfSuspectPath(parsed.linkTarget, parsed.entry);
    }
  }
}

interface ParsedTarListingLine {
  entry: string;
  linkTarget?: string;
}

function parseTarListingLine(line: string): ParsedTarListingLine {
  // Bare `tar -tf` listings have no permission prefix; the whole
  // line is the entry path.
  if (!/^[lLcbpd-][rwxsStT-]{9}/.test(line)) {
    return { entry: line };
  }
  // Verbose lines from GNU tar (`-rw-r--r-- user/user 100 2026-01-01
  // 00:00 paper.tex`) and BSD tar (`-rw-r--r-- 0 user user 100 Jan
  // 01 00:00 paper.tex`) both end with the entry path after a final
  // `HH:MM` time field. Anchor on that time pattern so paths
  // containing spaces (e.g. `my paper/main.tex`, or a malicious
  // `../../../etc main.tex`) are captured intact rather than reduced
  // to their last whitespace-separated token. Symlinks append
  // ` -> target` after the path.
  const match = line.match(
    /^[lLcbpd-][rwxsStT-]{9}\s.*\s\d{1,2}:\d{2}\s+(.+?)(?:\s+->\s+(.+))?$/,
  );
  if (match) {
    return { entry: match[1], linkTarget: match[2] };
  }
  // Unfamiliar verbose dialect — fall back to last-token. The
  // assertSafeTarListing caller validates whatever we return, so a
  // best-effort parse is still safer than crashing on an unknown
  // listing format.
  const tokens = line.split(/\s+/);
  return { entry: tokens[tokens.length - 1] };
}

function rejectIfSuspectPath(value: string, owningEntry?: string): void {
  if (
    value.startsWith("/") ||
    value.split("/").some((part) => part === "..")
  ) {
    const where = owningEntry
      ? `symlink '${owningEntry}' with target '${value}'`
      : `path '${value}'`;
    throw new Error(`Refusing to extract suspect ${where} from arXiv e-print`);
  }
}

/**
 * Synchronous, shell-free invocation of an external binary. Used for
 * `tar` listing and extraction. Throws on non-zero exit. The args array
 * goes straight to `execve`, so no shell interpolation can leak.
 */
function runBinary(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, {
    timeout: TAR_TIMEOUT_MS,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }) as string;
}

function listSourceFiles(destDir: string): ArxivSourceFiles {
  const tex: string[] = [];
  const bbl: string[] = [];
  const bib: string[] = [];

  function walk(dir: string, depth: number): void {
    if (depth > 4) return; // arxiv tarballs are shallow; bound recursion.
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const abs = resolve(dir, name);
      let st: ReturnType<typeof lstatSync>;
      try {
        // `lstatSync` does NOT follow symlinks. The tar listing pass
        // above rejects symlinks whose targets escape the destination,
        // but a defence-in-depth read here means even a same-name
        // symlink that slipped past listing-level checks won't have
        // its target included in the returned file lists.
        st = lstatSync(abs);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) {
        // Symlinks are never trusted as source files. The verbatim
        // e-print payload is still on disk for callers that want to
        // handle them with their own policy.
        continue;
      }
      if (st.isDirectory()) {
        walk(abs, depth + 1);
        continue;
      }
      if (!st.isFile()) continue;
      const lower = name.toLowerCase();
      if (lower.endsWith(".tex")) tex.push(abs);
      else if (lower.endsWith(".bbl")) bbl.push(abs);
      else if (lower.endsWith(".bib")) bib.push(abs);
    }
  }

  walk(destDir, 0);
  tex.sort();
  bbl.sort();
  bib.sort();
  return { tex, bbl, bib };
}

function isRequestTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "TimeoutError" || error.name === "AbortError";
}
