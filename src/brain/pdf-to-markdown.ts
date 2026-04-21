/**
 * PDF-to-Markdown Pipeline via Docling
 *
 * Converts PDFs to markdown using Docling (MIT, IBM), enriches with
 * metadata frontmatter from our pdf-metadata extractor, then imports
 * into gbrain.
 *
 * Docling is called as a subprocess — no GPL contamination.
 * Install: pip install docling
 */

import { execFile as execFileCb } from "child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "fs";
import { basename, extname, join, resolve } from "path";
import { homedir } from "os";
import matter from "gray-matter";
import { extractPdfMetadata } from "./pdf-metadata";

function execFile(
  cmd: string,
  args: string[],
  opts: { timeout: number },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFileCb(cmd, args, opts, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

// ── Types ───────────────────────────────────────────

export interface DoclingCheck {
  ok: boolean;
  version?: string;
  error?: string;
}

export interface ConvertOptions {
  /** Timeout for the entire batch in ms (default 600_000 = 10 min) */
  timeoutMs?: number;
  /** Progress callback */
  onProgress?: (status: {
    phase: "convert" | "enrich" | "import";
    current: number;
    total: number;
    file: string;
  }) => void;
}

export interface ConvertResult {
  stagingDir: string;
  converted: string[];
  failed: Array<{ path: string; error: string }>;
  durationMs: number;
}

export interface PipelineOptions extends ConvertOptions {
  /** Only convert — don't run gbrain import */
  skipImport?: boolean;
  /** Override default staging directory */
  stagingDir?: string;
}

export interface PipelineResult {
  converted: number;
  imported: number;
  failed: Array<{ path: string; error: string }>;
  stagingDir: string;
  durationMs: number;
}

// ── Constants ───────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 600_000; // 10 minutes
const MIN_DOCLING_PDF_BYTES = 1024;

function defaultStagingDir(): string {
  return join(homedir(), ".scienceswarm", "brain", "raw", "imports", "pdf-staging");
}

// ── Docling Check ───────────────────────────────────

let _doclingCache: DoclingCheck | null = null;

/**
 * Check whether the `docling` CLI is installed and accessible.
 */
export async function checkDoclingInstalled(): Promise<DoclingCheck> {
  if (_doclingCache) return _doclingCache;

  try {
    const { stdout } = await execFile("docling", ["--help"], {
      timeout: 10_000,
    });
    // Docling --help output includes "Usage: docling" — extract version if present
    const versionMatch = stdout.match(/docling\s+(\d+\.\d+\.\d+)/i);
    _doclingCache = { ok: true, version: versionMatch?.[1] ?? "unknown" };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    _doclingCache = {
      ok: false,
      error: msg.includes("ENOENT")
        ? "docling is not installed. Install with: pip install docling"
        : `docling check failed: ${msg}`,
    };
  }
  return _doclingCache;
}

/** Reset the cached check (for testing). */
export function resetDoclingCache(): void {
  _doclingCache = null;
}

// ── Batch Conversion ────────────────────────────────

/**
 * Discover PDF files in a directory (non-recursive for now).
 */
function discoverPdfs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && extname(e.name).toLowerCase() === ".pdf")
    .map((e) => join(dir, e.name));
}

/**
 * Convert PDFs in a directory to markdown using Docling.
 * Tries batch mode first; on failure, falls back to per-file.
 */
export async function convertPdfsToMarkdown(
  pdfDir: string,
  stagingDir: string,
  opts?: ConvertOptions,
): Promise<ConvertResult> {
  const start = Date.now();
  const timeout = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const resolvedPdfDir = resolve(pdfDir);
  const resolvedStaging = resolve(stagingDir);
  mkdirSync(resolvedStaging, { recursive: true });

  const pdfs = discoverPdfs(resolvedPdfDir);
  if (pdfs.length === 0) {
    return {
      stagingDir: resolvedStaging,
      converted: [],
      failed: [],
      durationMs: Date.now() - start,
    };
  }

  // Try batch mode first
  try {
    opts?.onProgress?.({
      phase: "convert",
      current: 0,
      total: pdfs.length,
      file: `batch (${pdfs.length} PDFs)`,
    });

    await execFile(
      "docling",
      [resolvedPdfDir, "--to", "md", "--output", resolvedStaging],
      { timeout },
    );

    const converted = readdirSync(resolvedStaging)
      .filter((f) => f.endsWith(".md"))
      .map((f) => join(resolvedStaging, f));

    return {
      stagingDir: resolvedStaging,
      converted,
      failed: [],
      durationMs: Date.now() - start,
    };
  } catch {
    // Batch failed — fall back to per-file
  }

  // Per-file fallback
  const converted: string[] = [];
  const failed: Array<{ path: string; error: string }> = [];

  for (let i = 0; i < pdfs.length; i++) {
    const pdf = pdfs[i];
    opts?.onProgress?.({
      phase: "convert",
      current: i + 1,
      total: pdfs.length,
      file: basename(pdf),
    });

    try {
      await execFile(
        "docling",
        [pdf, "--to", "md", "--output", resolvedStaging],
        { timeout: Math.max(timeout / pdfs.length, 60_000) },
      );

      const expectedName = basename(pdf, ".pdf") + ".md";
      const outputPath = join(resolvedStaging, expectedName);
      if (existsSync(outputPath)) {
        converted.push(outputPath);
      } else {
        // Docling may use a slightly different filename — check for new .md files
        const mdFiles = readdirSync(resolvedStaging).filter((f) =>
          f.endsWith(".md"),
        );
        const newest = mdFiles.find(
          (f) => !converted.includes(join(resolvedStaging, f)),
        );
        if (newest) {
          converted.push(join(resolvedStaging, newest));
        }
      }
    } catch (e: unknown) {
      failed.push({
        path: pdf,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return {
    stagingDir: resolvedStaging,
    converted,
    failed,
    durationMs: Date.now() - start,
  };
}

// ── Frontmatter Enrichment ──────────────────────────

/**
 * For each .md file in the staging dir, find the matching PDF in pdfDir,
 * extract metadata, and prepend YAML frontmatter.
 */
export async function enrichWithFrontmatter(
  stagingDir: string,
  pdfDir: string,
  onProgress?: ConvertOptions["onProgress"],
): Promise<void> {
  const mdFiles = readdirSync(stagingDir).filter((f) => f.endsWith(".md"));
  const pdfMap = buildPdfMap(pdfDir);

  for (let i = 0; i < mdFiles.length; i++) {
    const mdFile = mdFiles[i];
    const mdPath = join(stagingDir, mdFile);

    onProgress?.({
      phase: "enrich",
      current: i + 1,
      total: mdFiles.length,
      file: mdFile,
    });

    // Find matching PDF by basename
    const stem = mdFile.replace(/\.md$/, "");
    const pdfPath = pdfMap.get(stem);

    // Read existing markdown body
    const rawMd = readFileSync(mdPath, "utf-8");
    const existing = matter(rawMd);

    // If already has frontmatter with title, skip (idempotent)
    if (existing.data?.title) continue;

    // Extract metadata from the original PDF if available
    let meta = {
      title: stem.replace(/[-_]/g, " "),
      authors: [] as string[],
      doi: null as string | null,
      arxivId: null as string | null,
      abstract: null as string | null,
      extractionConfidence: "low" as string,
    };

    if (pdfPath) {
      try {
        const pdfMeta = await extractPdfMetadata(pdfPath);
        meta = {
          title: pdfMeta.title ?? meta.title,
          authors: pdfMeta.authors,
          doi: pdfMeta.doi,
          arxivId: pdfMeta.arxivId,
          abstract: pdfMeta.abstract,
          extractionConfidence: pdfMeta.extractionConfidence,
        };
      } catch {
        // Metadata extraction is non-fatal
      }
    }

    const date = new Date().toISOString().slice(0, 10);
    const frontmatterData: Record<string, unknown> = {
      title: meta.title,
      date,
      type: "paper",
      para: "resources",
      authors: meta.authors,
      tags: ["pdf-import"],
      extractionConfidence: meta.extractionConfidence,
    };
    if (meta.doi) frontmatterData.doi = meta.doi;
    if (meta.arxivId) frontmatterData.arxiv = meta.arxivId;

    const enriched = matter.stringify(existing.content, frontmatterData);
    writeFileSync(mdPath, enriched);
  }
}

/**
 * Build a map from PDF stem (filename without extension) to full path.
 */
function buildPdfMap(pdfDir: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!existsSync(pdfDir)) return map;

  for (const entry of readdirSync(pdfDir, { withFileTypes: true })) {
    if (entry.isFile() && extname(entry.name).toLowerCase() === ".pdf") {
      const stem = entry.name.replace(/\.pdf$/i, "");
      map.set(stem, join(pdfDir, entry.name));
    }
  }
  return map;
}

// ── gbrain Import ───────────────────────────────────

/**
 * Import a staging directory of markdown files into gbrain.
 */
async function gbrainImport(
  stagingDir: string,
  timeoutMs: number,
): Promise<{ ok: boolean; output: string }> {
  try {
    const { stdout, stderr } = await execFile(
      "gbrain",
      ["import", stagingDir, "--no-embed"],
      { timeout: timeoutMs },
    );
    return { ok: true, output: (stdout + "\n" + stderr).trim() };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, output: msg };
  }
}

// ── Full Pipeline ───────────────────────────────────

/**
 * Full pipeline: check Docling → convert PDFs → enrich with frontmatter →
 * import into gbrain.
 */
export async function convertAndImportPdfs(
  pdfDir: string,
  opts?: PipelineOptions,
): Promise<PipelineResult> {
  const start = Date.now();
  const stagingDir = opts?.stagingDir ?? defaultStagingDir();
  const timeout = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // 1. Check Docling
  const check = await checkDoclingInstalled();
  if (!check.ok) {
    throw new Error(check.error);
  }

  // 2. Convert
  const convertResult = await convertPdfsToMarkdown(pdfDir, stagingDir, opts);

  // 3. Enrich with frontmatter
  await enrichWithFrontmatter(stagingDir, pdfDir, opts?.onProgress);

  // 4. Import into gbrain
  let imported = 0;
  if (!opts?.skipImport) {
    opts?.onProgress?.({
      phase: "import",
      current: 0,
      total: convertResult.converted.length,
      file: "gbrain import",
    });

    const importResult = await gbrainImport(stagingDir, timeout);
    if (importResult.ok) {
      imported = convertResult.converted.length;
    } else {
      // Import failed but conversion succeeded — report it
      convertResult.failed.push({
        path: stagingDir,
        error: `gbrain import failed: ${importResult.output}`,
      });
    }
  }

  return {
    converted: convertResult.converted.length,
    imported,
    failed: convertResult.failed,
    stagingDir,
    durationMs: Date.now() - start,
  };
}

// ── Single-File Conversion (for coldstart integration) ──

/**
 * Convert a single PDF to an enriched markdown file in the brain wiki.
 * Returns the wiki-relative path on success, null on failure.
 */
export async function convertSinglePdf(
  pdfPath: string,
  brainRoot: string,
): Promise<string | null> {
  if (!existsSync(pdfPath)) {
    return null;
  }

  // Skip obviously truncated fixtures/corrupt files before paying the Docling startup cost.
  if (statSync(pdfPath).size < MIN_DOCLING_PDF_BYTES) {
    return null;
  }

  const check = await checkDoclingInstalled();
  if (!check.ok) return null;

  const stem = basename(pdfPath, ".pdf");
  const slug = stem
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);

  const wikiDir = join(brainRoot, "wiki", "entities", "papers");
  mkdirSync(wikiDir, { recursive: true });

  const destPath = join(wikiDir, `${slug}.md`);
  if (existsSync(destPath)) return null; // Already exists

  // Convert to a temp staging dir
  const tempStaging = join(brainRoot, "raw", "imports", "pdf-staging-single");
  mkdirSync(tempStaging, { recursive: true });

  try {
    await execFile("docling", [pdfPath, "--to", "md", "--output", tempStaging], {
      timeout: 120_000,
    });

    // Find the output file
    const expectedName = stem + ".md";
    const outputPath = join(tempStaging, expectedName);
    if (!existsSync(outputPath)) return null;

    // Read Docling output and enrich with frontmatter
    const rawMd = readFileSync(outputPath, "utf-8");
    let meta = {
      title: stem.replace(/[-_]/g, " "),
      authors: [] as string[],
      doi: null as string | null,
      arxivId: null as string | null,
      extractionConfidence: "low" as string,
    };

    try {
      const pdfMeta = await extractPdfMetadata(pdfPath);
      meta = {
        title: pdfMeta.title ?? meta.title,
        authors: pdfMeta.authors,
        doi: pdfMeta.doi,
        arxivId: pdfMeta.arxivId,
        extractionConfidence: pdfMeta.extractionConfidence,
      };
    } catch {
      // Non-fatal
    }

    const date = new Date().toISOString().slice(0, 10);
    const frontmatterData: Record<string, unknown> = {
      title: meta.title,
      date,
      type: "paper",
      para: "resources",
      authors: meta.authors,
      tags: ["pdf-import"],
      extractionConfidence: meta.extractionConfidence,
    };
    if (meta.doi) frontmatterData.doi = meta.doi;
    if (meta.arxivId) frontmatterData.arxiv = meta.arxivId;

    const enriched = matter.stringify(rawMd, frontmatterData);
    writeFileSync(destPath, enriched);

    return `wiki/entities/papers/${slug}.md`;
  } catch {
    return null;
  }
}
