/**
 * PDF ingest — runs the repo's pdf-parse wrapper, enforces the
 * text-layer sanity check, and hands back a ready-to-write markdown body
 * plus the metadata fields the upload route needs for frontmatter.
 *
 * The route builder owns frontmatter composition; this module just returns
 * the inputs (title, body, page/word count) so the frontmatter stays
 * Zod-validated at the call site with `PaperFrontmatterSchema`.
 */

import {
  extractPdfText,
  isPdfExtractError,
  type PdfExtractResult,
} from "@/lib/pdf-text-extractor";
import { titleFromFilename } from "@/brain/page-title";
import {
  checkPdfTextLayer,
  type TextLayerCheckResult,
} from "./text-layer-check";

const PDF_TITLE_SCAN_LINE_LIMIT = 80;

export interface PdfIngestInput {
  pdfPath: string;
  fileName: string;
}

export interface PdfIngestOk {
  ok: true;
  title: string;
  markdown: string;
  pageCount: number;
  wordCount: number;
}

export interface PdfIngestError {
  ok: false;
  code: "not_found" | "invalid_pdf" | "text_layer_too_thin";
  message: string;
}

export type PdfIngestResult = PdfIngestOk | PdfIngestError;

/**
 * Read a PDF from disk, enforce the text-layer check, and return a
 * gbrain-ready markdown body. Callers (e.g. the workspace upload route)
 * build the frontmatter with `PaperFrontmatterSchema` and persist via
 * gbrain.
 */
export async function ingestPdfFromPath(
  input: PdfIngestInput,
): Promise<PdfIngestResult> {
  let extracted: PdfExtractResult;
  try {
    extracted = await extractPdfText(input.pdfPath);
  } catch (error) {
    if (isPdfExtractError(error)) {
      return {
        ok: false,
        code: error.code,
        message:
          error.code === "not_found"
            ? `${input.fileName}: file not found on disk before ingest.`
            : `${input.fileName}: file is not a valid PDF.`,
      };
    }
    throw error;
  }

  const check: TextLayerCheckResult = checkPdfTextLayer({
    wordCount: extracted.wordCount,
    pageCount: extracted.pageCount,
    fileName: input.fileName,
  });

  if (!check.ok) {
    return {
      ok: false,
      code: "text_layer_too_thin",
      message: check.message ?? "text layer too thin",
    };
  }

  const title = derivePdfTitleForIngest(extracted.text, input.fileName);
  const markdown = renderMarkdown({
    title,
    fileName: input.fileName,
    text: extracted.text,
    pageCount: extracted.pageCount,
    wordCount: extracted.wordCount,
  });

  return {
    ok: true,
    title,
    markdown,
    pageCount: extracted.pageCount,
    wordCount: extracted.wordCount,
  };
}

export function derivePdfTitleForIngest(text: string, fallback: string): string {
  const fallbackTitle = titleFromFilename(fallback);
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, PDF_TITLE_SCAN_LINE_LIMIT);

  for (const line of lines) {
    const candidate = normalizeTitleCandidate(line);
    if (candidate) return candidate.slice(0, 140);
  }

  return fallbackTitle;
}

function normalizeTitleCandidate(line: string): string | null {
  if (!/\p{L}/u.test(line)) return null;
  if (line.length <= 2) return null;
  if (/^(abstract|introduction|references|bibliography)$/i.test(line)) return null;
  // Skip all-caps journal preambles if a PDF text layer emits them before
  // the actual title, e.g. "PROC. N. A. S.".
  if (/^[A-Z\. ]+$/.test(line) && line.length < 40) return null;
  return line;
}

interface RenderArgs {
  title: string;
  fileName: string;
  text: string;
  pageCount: number;
  wordCount: number;
}

function renderMarkdown(args: RenderArgs): string {
  const { title, fileName, text, pageCount, wordCount } = args;
  const metaBlock = [
    "```yaml",
    "source:",
    `  filename: ${fileName}`,
    `  page_count: ${pageCount}`,
    `  word_count: ${wordCount}`,
    "```",
  ].join("\n");
  // Normalise whitespace: collapse runs of blank lines so the stored body
  // is readable in the dashboard without reflowing paragraphs.
  const bodyText = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return `# ${title}\n\n${metaBlock}\n\n${bodyText}\n`;
}
