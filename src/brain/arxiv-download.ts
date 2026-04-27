/**
 * Second Brain — arXiv PDF Downloader
 *
 * Downloads PDFs from arXiv given an arXiv ID in various formats.
 * Handles rate limiting (arXiv asks for 3s between requests),
 * validates responses, and saves to the designated directory.
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync } from "fs";
import { join } from "path";

// ── Public API ────────────────────────────────────────

/**
 * Parse arXiv ID from various input formats.
 *
 * Supported formats:
 * - Plain ID: `2309.08600`
 * - Prefixed: `arXiv:2309.08600`, `arxiv:2309.08600v2`
 * - Abstract URL: `https://arxiv.org/abs/2309.08600`
 * - PDF URL: `https://arxiv.org/pdf/2309.08600.pdf`
 * - PDF URL (no ext): `https://arxiv.org/pdf/2309.08600`
 */
export function resolveArxivSource(
  source: string,
): { arxivId: string; pdfUrl: string } | null {
  const trimmed = source.trim();

  // Try each pattern
  const patterns: RegExp[] = [
    // Full URL: https://arxiv.org/abs/2309.08600 or /pdf/2309.08600.pdf
    /arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5}(?:v\d+)?)/i,
    // Prefixed: arXiv:2309.08600 or arxiv:2309.08600v2
    /^arxiv:\s*(\d{4}\.\d{4,5}(?:v\d+)?)/i,
    // Plain ID: 2309.08600 or 2309.08600v2
    /^(\d{4}\.\d{4,5}(?:v\d+)?)$/,
  ];

  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    if (match) {
      const arxivId = match[1];
      return {
        arxivId,
        pdfUrl: `https://arxiv.org/pdf/${arxivId}.pdf`,
      };
    }
  }

  return null;
}

/**
 * Check whether a string looks like an arXiv reference in any supported format.
 */
export function isArxivReference(source: string): boolean {
  return resolveArxivSource(source) !== null;
}

// Track the last arXiv host hit for rate limiting. Module-level so the
// limiter is shared across every consumer that imports
// `applyArxivRateLimit` — arxiv.org's 3 s policy is per-IP, so the
// PDF downloader and the e-print source downloader (and any future
// arxiv.org consumer) must all serialise through one timer.
let lastDownloadTime = 0;
const ARXIV_RATE_LIMIT_MS = 3000;
// Allow real-world PDF downloads to complete while still bounding ingest latency.
const ARXIV_FETCH_TIMEOUT_MS = 15000;

/**
 * Cooperative rate-limit gate for outbound arxiv.org requests.
 *
 * Sleeps if needed so that successive callers honour arxiv's
 * recommended 3 s gap between requests. Exported so the e-print
 * source downloader (`arxiv-source.ts`) can serialise through the
 * same timer as `downloadArxivPdf`.
 *
 * Reservation discipline: when the caller has to wait, we set
 * `lastDownloadTime` to the *target wake-up time* before yielding,
 * not after. Otherwise two concurrent callers entering this function
 * with a stale `lastDownloadTime` would read the same value, compute
 * identical sleep durations, wake up together, and fire two requests
 * simultaneously — exactly the race the shared timer is meant to
 * prevent. With reservation in place, a second caller observing a
 * `lastDownloadTime` that's still in the future sleeps for an
 * additional full window past it instead.
 */
export async function applyArxivRateLimit(opts: { rateLimitMs?: number } = {}): Promise<void> {
  const rateLimitMs = opts.rateLimitMs ?? ARXIV_RATE_LIMIT_MS;
  const now = Date.now();
  const elapsed = now - lastDownloadTime;
  if (lastDownloadTime > 0 && elapsed < rateLimitMs) {
    const waitMs = rateLimitMs - elapsed;
    // Reserve the slot at the target wake time before yielding.
    lastDownloadTime = now + waitMs;
    await sleep(waitMs);
  } else {
    lastDownloadTime = now;
  }
}

/**
 * Download an arXiv PDF to the destination directory.
 *
 * - Respects arXiv rate limiting (3s between requests).
 * - Validates the response is actually a PDF (content-type + magic bytes).
 * - Returns the local file path on success.
 */
export async function downloadArxivPdf(
  arxivId: string,
  destDir: string,
): Promise<string> {
  const pdfUrl = `https://arxiv.org/pdf/${arxivId}.pdf`;

  // Ensure destination directory exists
  mkdirSync(destDir, { recursive: true });

  const filename = `${arxivId.replace(/\//g, "-")}.pdf`;
  const destPath = join(destDir, filename);

  // If already downloaded, return existing path
  if (existsSync(destPath)) {
    // Validate it's actually a PDF
    const existing = readFileSync(destPath);
    if (existing.length > 0 && isPdfBuffer(existing)) {
      return destPath;
    }
    // Otherwise re-download (corrupt/incomplete)
  }

  // Rate limiting: wait if needed (shared timer with arxiv-source).
  await applyArxivRateLimit();

  let response: Response;
  try {
    response = await fetch(pdfUrl, {
      headers: {
        "User-Agent": "ScienceSwarm-Brain/1.0 (research tool; mailto:contact@scienceswarm.dev)",
      },
      signal: AbortSignal.timeout(ARXIV_FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    if (isRequestTimeout(error)) {
      throw new ArxivDownloadError(
        `Timed out downloading arXiv PDF ${arxivId} after ${ARXIV_FETCH_TIMEOUT_MS}ms`,
        arxivId,
      );
    }
    throw error;
  }

  if (!response.ok) {
    throw new ArxivDownloadError(
      `Failed to download arXiv PDF ${arxivId}: HTTP ${response.status} ${response.statusText}`,
      arxivId,
      response.status,
    );
  }

  // Validate content type
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/pdf") && !contentType.includes("octet-stream")) {
    throw new ArxivDownloadError(
      `Unexpected content type for arXiv PDF ${arxivId}: ${contentType}`,
      arxivId,
    );
  }

  const buffer = Buffer.from(await response.arrayBuffer());

  // Validate PDF magic bytes
  if (!isPdfBuffer(buffer)) {
    throw new ArxivDownloadError(
      `Downloaded file for ${arxivId} is not a valid PDF (bad magic bytes)`,
      arxivId,
    );
  }

  writeFileSync(destPath, buffer);
  return destPath;
}

// ── Helpers ───────────────────────────────────────────

function isPdfBuffer(buffer: Buffer): boolean {
  // PDF files start with %PDF
  return buffer.length >= 4 && buffer.subarray(0, 4).toString("ascii") === "%PDF";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRequestTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.name === "TimeoutError" || error.name === "AbortError";
}

/**
 * Reset the rate-limit timer (useful for testing).
 */
export function resetRateLimit(): void {
  lastDownloadTime = 0;
}

// ── Errors ────────────────────────────────────────────

export class ArxivDownloadError extends Error {
  public readonly arxivId: string;
  public readonly httpStatus?: number;

  constructor(message: string, arxivId: string, httpStatus?: number) {
    super(message);
    this.name = "ArxivDownloadError";
    this.arxivId = arxivId;
    this.httpStatus = httpStatus;
  }
}
