import fs from "node:fs/promises";
import { loadPdfParseCtor, withPdfParseTimeout } from "@/lib/pdf-parse";

/**
 * Thin wrapper around pdf-parse that returns a small, typed summary of a PDF
 * on disk. Callers get back enough to render a quick preview (first sentence
 * or the leading 160 chars as a fallback) without having to touch pdf-parse
 * directly.
 *
 * The real pdf-parse module is loaded through CommonJS `require()` to stay
 * aligned with the rest of the repo's PDF parsing boundary.
 */

export interface PdfExtractResult {
  text: string;
  pageCount: number;
  wordCount: number;
  firstSentence: string;
  abstract?: string;
  info?: Record<string, unknown>;
}

const FIRST_SENTENCE_MAX = 300;
const FIRST_SENTENCE_FALLBACK = 160;
const ABSTRACT_MAX = 2_000;
const PDF_NULL_BYTE_RE = /\u0000/g;
const PDF_CONTROL_CHAR_RE = /[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

interface PdfTextData {
  text?: string;
  total?: number;
}

interface PdfInfoData {
  total?: number;
  info?: Record<string, unknown>;
}

class PdfExtractError extends Error {
  constructor(
    readonly code: "not_found" | "invalid_pdf",
    message: string,
  ) {
    super(message);
    this.name = "PdfExtractError";
  }
}

interface PdfParseInstance {
  getText: () => Promise<PdfTextData>;
  getInfo: (options?: { parsePageInfo?: boolean }) => Promise<PdfInfoData>;
  destroy: () => Promise<void>;
}

async function fileExists(pdfPath: string): Promise<boolean> {
  try {
    await fs.access(pdfPath);
    return true;
  } catch {
    return false;
  }
}

function computeFirstSentence(text: string): string {
  if (!text) return "";
  const previewSource = text
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .find((part) => part.length > 0) ?? text;
  // Split on sentence-ending punctuation followed by whitespace. We keep this
  // intentionally simple: the goal is a preview, not grammatically perfect
  // segmentation.
  const parts = previewSource.split(/[.!?]\s+/);
  const candidate = (parts[0] ?? "").trim();
  if (candidate.length > 0) {
    return candidate.slice(0, FIRST_SENTENCE_MAX);
  }
  // Fall back to a fixed-width slice of the raw text so PDFs that don't
  // contain sentence punctuation (tables, headings, code listings) still get
  // a non-empty preview.
  return previewSource.slice(0, FIRST_SENTENCE_FALLBACK);
}

export function extractAbstractFromPdfText(text: string): string | undefined {
  if (!text.trim()) return undefined;
  const normalized = text.replace(/\r\n?/g, "\n");
  const patterns = [
    /\bAbstract\b[:\s.\-—]*\n?\s*([\s\S]{20,2000}?)(?=\n\s*\n|\n\s*(?:(?:Introduction|Keywords|References)\b|(?:1(?:\s+|\.\s+)|I\.\s+)))/i,
    /\bAbstract\b[:\s.\-—]*\n?\s*([\s\S]{20,2000}?)(?=\s+(?:Introduction|Keywords|References)\b|\n\s*(?:1(?:\s+|\.\s+)|I\.\s+))/i,
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    const candidate = match?.[1]
      ?.replace(/\s+/g, " ")
      .trim()
      .replace(/^Abstract[:\s.\-—]*/i, "")
      .trim();
    if (candidate && candidate.length >= 20) {
      return candidate.slice(0, ABSTRACT_MAX);
    }
  }

  return undefined;
}

export async function extractPdfText(pdfPath: string): Promise<PdfExtractResult> {
  if (!(await fileExists(pdfPath))) {
    throw new PdfExtractError("not_found", "PDF file not found");
  }

  const buffer = await fs.readFile(pdfPath);

  let data: PdfTextData;
  let infoData: PdfInfoData | undefined;
  const PDFParse = loadPdfParseCtor<PdfParseInstance>();
  const parser = new PDFParse({ data: buffer });
  try {
    try {
      data = await withPdfParseTimeout(parser.getText(), "text extraction");
    } catch {
      throw new PdfExtractError("invalid_pdf", "Invalid PDF");
    }

    try {
      infoData = await withPdfParseTimeout(
        parser.getInfo({ parsePageInfo: false }),
        "info extraction",
      );
    } catch {
      infoData = undefined;
    }
  } finally {
    await parser.destroy().catch(() => {});
  }

  const text = sanitizePdfExtractedText(data.text ?? "");
  const pageCount = data.total ?? infoData?.total ?? 0;
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  const firstSentence = computeFirstSentence(text);
  const abstract = extractAbstractFromPdfText(text);

  const result: PdfExtractResult = {
    text,
    pageCount,
    wordCount,
    firstSentence,
  };
  if (abstract) {
    result.abstract = abstract;
  }
  if (infoData?.info !== undefined) {
    result.info = infoData.info;
  }
  return result;
}

export function isPdfExtractError(error: unknown): error is PdfExtractError {
  return error instanceof PdfExtractError;
}

export function sanitizePdfExtractedText(text: string): string {
  return text
    .replace(PDF_NULL_BYTE_RE, "")
    .replace(PDF_CONTROL_CHAR_RE, " ");
}
