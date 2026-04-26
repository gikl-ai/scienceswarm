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
 * The kind is sniffed from the response bytes (gzip magic 1f 8b, ustar
 * magic at offset 257, %PDF magic), then dispatched to the appropriate
 * extractor. Tarballs are extracted via the system `tar` (the same tool
 * used elsewhere in this repo for subprocess work) but only after the
 * archive listing is checked for absolute or `..`-traversing paths so a
 * malicious archive cannot escape the destination directory.
 *
 * No new npm dependencies: the module relies only on Node's built-in
 * `node:zlib`, `node:child_process`, and `node:fs`.
 */

import { execFileSync } from "child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "fs";
import { join, resolve } from "path";
import { gunzipSync } from "zlib";

import { resolveArxivSource } from "./arxiv-download";

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

const ARXIV_SOURCE_RATE_LIMIT_MS = 3000;
const ARXIV_SOURCE_TIMEOUT_MS = 30_000;
const TAR_TIMEOUT_MS = 60_000;

let lastDownloadTime = 0;

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

  await applyRateLimit(opts.rateLimitMs ?? ARXIV_SOURCE_RATE_LIMIT_MS);

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
 * Reset the cooperative rate-limit timer. Test-only.
 */
export function resetArxivSourceRateLimit(): void {
  lastDownloadTime = 0;
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
  if (
    head.length >= 263 &&
    head.subarray(257, 263).toString("ascii") === "ustar\0"
  ) {
    return "tar";
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

function readHeadBytes(filePath: string, count: number): Buffer {
  const all = readFileSync(filePath);
  return all.subarray(0, Math.min(count, all.length));
}

function extractGzipPayload(
  bareId: string,
  eprintPath: string,
  destDir: string,
): ArxivSourceKind {
  // gzip-compressed payload may be either a tar.gz or a single .tex.gz.
  // Try tar first; fall back to a bare gunzip on failure.
  if (isGzippedTar(eprintPath)) {
    extractTarball(eprintPath, destDir, /* gzipped */ true);
    return "tarball";
  }
  const gunzipped = gunzipSync(readFileSync(eprintPath));
  const sub = classifyPayload(gunzipped.subarray(0, 512));
  if (sub === "pdf") {
    throw new ArxivSourceError(
      `e-print decompresses to a PDF — no LaTeX source for ${bareId}`,
      bareId,
    );
  }
  // Treat anything that is not a tar or PDF as a bare .tex file.
  writeFileSync(join(destDir, `${bareId}.tex`), gunzipped);
  return "gzipped-tex";
}

function isGzippedTar(eprintPath: string): boolean {
  try {
    // `tar -tzf` on macOS BSD-tar and GNU-tar both list entries from a
    // gzipped tar; non-tar gzip payloads exit non-zero.
    runBinary("tar", ["-tzf", eprintPath]);
    return true;
  } catch {
    return false;
  }
}

function extractTarball(
  archivePath: string,
  destDir: string,
  gzipped: boolean,
): void {
  // Defensive listing pass: refuse any entry whose name is absolute or
  // contains `..` so a hostile archive cannot tar-slip out of destDir.
  const listFlags = gzipped ? "-tzf" : "-tf";
  const listing = runBinary("tar", [listFlags, archivePath]);
  assertSafeTarListing(listing);
  const extractFlags = gzipped ? ["--no-same-owner", "-xzf"] : ["--no-same-owner", "-xf"];
  runBinary("tar", [...extractFlags, archivePath, "-C", destDir]);
}

/**
 * Throw if any line in a `tar -tf` listing is an absolute path or
 * contains a `..` segment. Exported so tests can exercise the policy
 * without having to hand-build a malicious tarball.
 */
export function assertSafeTarListing(listing: string): void {
  for (const line of listing.split(/\r?\n/)) {
    const entry = line.trim();
    if (!entry) continue;
    if (entry.startsWith("/") || entry.split("/").some((part) => part === "..")) {
      throw new Error(
        `Refusing to extract suspect path '${entry}' from arXiv e-print`,
      );
    }
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
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(abs);
      } catch {
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

async function applyRateLimit(rateLimitMs: number): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastDownloadTime;
  if (lastDownloadTime > 0 && elapsed < rateLimitMs) {
    await new Promise<void>((res) => setTimeout(res, rateLimitMs - elapsed));
  }
  lastDownloadTime = Date.now();
}

function isRequestTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "TimeoutError" || error.name === "AbortError";
}
