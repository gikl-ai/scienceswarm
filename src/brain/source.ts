import { existsSync, readFileSync } from "fs";
import { basename, extname } from "path";
import { sanitizePdfExtractedText } from "@/lib/pdf-text-extractor";
import { loadPdfParseCtor, withPdfParseTimeout } from "@/lib/pdf-parse";
import type { ContentType } from "./types";
import { resolveArxivSource, downloadArxivPdf } from "./arxiv-download";

const RAW_DIRECTORY_BY_TYPE: Record<ContentType, string> = {
  paper: "papers",
  dataset: "data",
  code: "code",
  note: "notes",
  experiment: "experiments",
  observation: "observations",
  hypothesis: "hypotheses",
  data: "data",
  web: "web",
  voice: "voice",
  concept: "concepts",
  project: "projects",
  decision: "decisions",
  task: "tasks",
  artifact: "artifacts",
  frontier_item: "frontier",
  person: "people",
};

export function getRawDirectory(type: ContentType): string {
  return `raw/${RAW_DIRECTORY_BY_TYPE[type]}`;
}

export function buildRawFilename(
  source: string,
  type: ContentType,
  now = new Date()
): string {
  const datePrefix = now.toISOString().slice(0, 10);

  if (source.startsWith("http://") || source.startsWith("https://")) {
    return `${datePrefix}-${slugify(source, 80)}.md`;
  }

  if (source.match(/^10\.\d{4,9}\//) || isArxivId(source)) {
    return `${datePrefix}-${slugify(source, 80)}.md`;
  }

  const base = basename(source);
  const ext = extname(base).toLowerCase();
  const looksLikeFilename =
    ext.length > 1 && !/\s/.test(base) && !base.includes("\n");
  if (looksLikeFilename) {
    return sanitizeFilename(base);
  }

  return `${datePrefix}-${slugify(source, 80) || type}.md`;
}

export async function readSourceContent(
  source: string,
  downloadDir?: string,
): Promise<string> {
  // Check if the source is an arXiv reference — download the PDF first
  const arxiv = resolveArxivSource(source);
  if (arxiv) {
    const dest = downloadDir ?? "/tmp/scienceswarm-arxiv";
    try {
      const pdfPath = await downloadArxivPdf(arxiv.arxivId, dest);
      return readBrainFile(pdfPath);
    } catch {
      // If download fails, return the source string as-is so the LLM can
      // still try to work with whatever was provided
      return source;
    }
  }

  if (!existsSync(source)) return source;
  return readBrainFile(source);
}

export async function readBrainFile(absPath: string): Promise<string> {
  const ext = extname(absPath).toLowerCase();
  if (ext === ".pdf") {
    return extractPdfText(absPath);
  }
  return readFileSync(absPath, "utf-8");
}

export function isArxivId(value: string): boolean {
  return /^\d{4}\.\d{4,5}(v\d+)?$/i.test(value.trim());
}

function sanitizeFilename(filename: string): string {
  return filename
    .replace(/[^\w.\-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function slugify(value: string, maxLength: number): string {
  return value
    .toLowerCase()
    .replace(/https?:\/\//g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");
}

async function extractPdfText(absPath: string): Promise<string> {
  try {
    const buffer = readFileSync(absPath);
    const PDFParse = loadPdfParseCtor<{
      getText: () => Promise<{ text: string; total: number }>;
      destroy: () => Promise<void>;
    }>();
    const parser = new PDFParse({ data: buffer });
    let parsed: { text: string; total: number };
    try {
      parsed = await withPdfParseTimeout(parser.getText(), "text extraction");
    } finally {
      await parser.destroy().catch(() => {});
    }
    const pages = parsed.total ?? 0;
    const text = sanitizePdfExtractedText(parsed.text ?? "").trim();

    if (!text) {
      return [
        `# PDF Extract: ${basename(absPath)}`,
        "",
        `Pages: ${pages}`,
        "",
        "[No extractable text found. This PDF may be scanned or image-based.]",
      ].join("\n");
    }

    const truncated =
      text.length > 80_000
        ? `${text.slice(0, 80_000)}\n\n[... truncated at 80k chars, ${pages} pages total ...]`
        : text;

    return [
      `# PDF Extract: ${basename(absPath)}`,
      "",
      `Pages: ${pages}`,
      "",
      truncated,
    ].join("\n");
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown PDF extraction error";
    return [
      `# PDF Extract: ${basename(absPath)}`,
      "",
      `[PDF extraction failed: ${message}]`,
    ].join("\n");
  }
}
