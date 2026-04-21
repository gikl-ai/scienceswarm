/**
 * Second Brain — PDF Metadata Extractor
 *
 * Extracts metadata from local PDF files using multiple strategies:
 * 1. PDF document properties (title, author)
 * 2. First-page text heuristics (title, authors, abstract)
 * 3. DOI detection
 * 4. arXiv ID detection
 */

import { readFileSync } from "fs";
import { basename } from "path";
import { loadPdfParseCtor, withPdfParseTimeout } from "@/lib/pdf-parse";
import type { PdfMetadata } from "./types";

// ── Public API ────────────────────────────────────────

/**
 * Extract metadata from a local PDF file.
 *
 * Tries multiple extraction strategies and merges results,
 * preferring higher-confidence sources.
 */
export async function extractPdfMetadata(
  filePath: string,
): Promise<PdfMetadata> {
  const buffer = readFileSync(filePath);

  if (!isPdfBuffer(buffer)) {
    return emptyMetadata(filePath, "low");
  }

  // Try pdf-parse for structured extraction
  const parseResult = await extractViaPdfParse(buffer);

  // Extract from text content using heuristics
  const text = parseResult?.text ?? "";
  const textMeta = extractFromText(text);

  // Merge: prefer pdf-parse metadata properties, fall back to text heuristics
  const title =
    cleanTitle(parseResult?.metadata?.title) ??
    textMeta.title ??
    null;

  const authors =
    parseAuthors(parseResult?.metadata?.author) ??
    textMeta.authors ??
    [];

  const abstract = textMeta.abstract ?? null;
  const doi = textMeta.doi ?? null;
  const arxivId = textMeta.arxivId ?? null;
  const pageCount = parseResult?.pageCount ?? 0;

  const textPreview = text.slice(0, 500).trim();

  // Determine confidence
  const confidence = determineConfidence(title, authors, abstract, pageCount);

  return {
    title,
    authors,
    abstract,
    doi,
    arxivId,
    pageCount,
    textPreview,
    extractionConfidence: confidence,
  };
}

// ── PDF Parse Integration ─────────────────────────────

interface ParseResult {
  text: string;
  pageCount: number;
  metadata: {
    title?: string;
    author?: string;
  };
}

async function extractViaPdfParse(buffer: Buffer): Promise<ParseResult | null> {
  try {
    const PDFParse = loadPdfParseCtor<{
      getText: () => Promise<{ text: string; total: number }>;
      getMetadata: () => Promise<{ info?: Record<string, string> }>;
      destroy: () => Promise<void>;
    }>();
    const parser = new PDFParse({ data: buffer });
    let text = "";
    let pageCount = 0;
    let metadata: { title?: string; author?: string } = {};
    try {
      const textResult = await withPdfParseTimeout(parser.getText(), "text extraction");
      text = textResult.text ?? "";
      pageCount = textResult.total ?? 0;

      try {
        const meta = await withPdfParseTimeout(
          parser.getMetadata(),
          "metadata extraction",
        );
        if (meta.info) {
          metadata = {
            title: meta.info.Title ?? meta.info.title,
            author: meta.info.Author ?? meta.info.author,
          };
        }
      } catch {
        // Metadata extraction is optional
      }
    } finally {
      await parser.destroy().catch(() => {});
    }

    return { text, pageCount, metadata };
  } catch {
    return null;
  }
}

// ── Text-Based Extraction ─────────────────────────────

interface TextExtraction {
  title: string | null;
  authors: string[] | null;
  abstract: string | null;
  doi: string | null;
  arxivId: string | null;
}

/**
 * Extract metadata from the raw text content of a PDF.
 * Uses heuristics for title, authors, abstract, DOI, and arXiv ID.
 */
export function extractFromText(text: string): TextExtraction {
  if (!text || text.trim().length === 0) {
    return { title: null, authors: null, abstract: null, doi: null, arxivId: null };
  }

  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

  return {
    title: extractTitleFromLines(lines),
    authors: extractAuthorsFromLines(lines),
    abstract: extractAbstract(text),
    doi: extractDoi(text),
    arxivId: extractArxivId(text),
  };
}

/**
 * Title heuristic: the first substantial non-metadata line is often the title.
 * Skip lines that look like headers/footers, journal names, or page numbers.
 */
function extractTitleFromLines(lines: string[]): string | null {
  for (const line of lines.slice(0, 15)) {
    // Skip short lines, page numbers, dates
    if (line.length < 5) continue;
    if (/^\d+$/.test(line)) continue;
    if (/^(page|vol|issue|journal|proceedings)/i.test(line)) continue;
    if (/^\d{4}[-/]\d{2}/.test(line)) continue;
    // Skip arXiv identifiers alone on a line
    if (/^arXiv:\d{4}\.\d{4,5}/i.test(line)) continue;

    // A good title candidate: reasonably long, not all caps metadata
    if (line.length >= 10 && line.length <= 300) {
      return line;
    }
  }
  return null;
}

/**
 * Author heuristic: look for lines after the title that contain comma-separated
 * names, or lines with institutional patterns.
 */
function extractAuthorsFromLines(lines: string[]): string[] | null {
  // Look in lines 1-10 for author-like patterns
  for (let i = 1; i < Math.min(lines.length, 15); i++) {
    const line = lines[i];

    // Skip very short or very long lines
    if (line.length < 3 || line.length > 500) continue;

    // Skip lines that look like abstracts or section headers
    if (/^(abstract|introduction|keywords|1\s)/i.test(line)) break;

    // Author line patterns:
    // - Comma-separated names (at least 2 commas or "and")
    // - Contains typical name patterns
    const hasMultipleNames =
      (line.match(/,/g)?.length ?? 0) >= 1 &&
      /[A-Z][a-z]+/.test(line) &&
      !/^(department|university|institute|school)/i.test(line);

    const hasAndSeparator =
      /\band\b/i.test(line) &&
      /[A-Z][a-z]+ [A-Z]/.test(line);

    if (hasMultipleNames || hasAndSeparator) {
      // Parse author names
      const authors = line
        .split(/,\s*(?:and\s+)?|\s+and\s+/i)
        .map((a) => a.trim())
        .filter((a) => a.length > 1 && a.length < 60)
        .filter((a) => /[A-Za-z]/.test(a))
        // Filter out affiliations that got mixed in
        .filter((a) => !/^(department|university|institute)/i.test(a));

      if (authors.length > 0) {
        return authors;
      }
    }
  }

  return null;
}

/**
 * Abstract extraction: look for an "Abstract" header followed by text.
 */
function extractAbstract(text: string): string | null {
  // Pattern 1: Explicit "Abstract" section
  const abstractMatch = text.match(
    /\bAbstract\b[:\s.\-—]*\n?\s*([\s\S]{20,2000}?)(?:\n\s*\n|\n\s*(?:1\s|Introduction|Keywords|I\.\s))/i,
  );

  if (abstractMatch) {
    return abstractMatch[1].replace(/\s+/g, " ").trim();
  }

  // Pattern 2: Text between "Abstract" and "Introduction" (common in arXiv)
  const betweenMatch = text.match(
    /\bAbstract\b[:\s.\-—]*\n?\s*([\s\S]{20,2000}?)\s*(?:Introduction|1\.\s|I\.\s)/i,
  );

  if (betweenMatch) {
    return betweenMatch[1].replace(/\s+/g, " ").trim();
  }

  return null;
}

/**
 * DOI extraction: find DOI patterns in text.
 */
function extractDoi(text: string): string | null {
  const match = text.match(/\b(10\.\d{4,}\/\S+)/);
  if (match) {
    // Clean trailing punctuation
    return match[1].replace(/[.,;)\]]+$/, "");
  }
  return null;
}

/**
 * arXiv ID extraction: find arXiv identifiers in text.
 */
function extractArxivId(text: string): string | null {
  const match = text.match(/arXiv:\s*(\d{4}\.\d{4,5}(?:v\d+)?)/i);
  if (match) return match[1];

  // Also try bare patterns near "arXiv" mentions
  const bareMatch = text.match(/(\d{4}\.\d{4,5}(?:v\d+)?)/);
  // Only return bare match if there's an arXiv mention nearby
  if (bareMatch && /arxiv/i.test(text.slice(0, 2000))) {
    return bareMatch[1];
  }

  return null;
}

// ── Helpers ───────────────────────────────────────────

function isPdfBuffer(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer.subarray(0, 4).toString("ascii") === "%PDF";
}

function cleanTitle(raw: string | undefined): string | null {
  if (!raw || raw.trim().length === 0) return null;
  const trimmed = raw.trim();
  // Skip generic/useless PDF titles
  if (/^(untitled|microsoft word|document\d)/i.test(trimmed)) return null;
  if (trimmed.length < 3) return null;
  return trimmed;
}

function parseAuthors(raw: string | undefined): string[] | null {
  if (!raw || raw.trim().length === 0) return null;
  const authors = raw
    .split(/[,;]/)
    .map((a) => a.trim())
    .filter((a) => a.length > 1);
  return authors.length > 0 ? authors : null;
}

function determineConfidence(
  title: string | null,
  authors: string[],
  abstract: string | null,
  pageCount: number,
): PdfMetadata["extractionConfidence"] {
  let score = 0;
  if (title) score += 2;
  if (authors.length > 0) score += 2;
  if (abstract) score += 2;
  if (pageCount > 0) score += 1;

  if (score >= 5) return "high";
  if (score >= 2) return "medium";
  return "low";
}

function emptyMetadata(
  filePath: string,
  confidence: PdfMetadata["extractionConfidence"],
): PdfMetadata {
  return {
    title: basename(filePath, ".pdf"),
    authors: [],
    abstract: null,
    doi: null,
    arxivId: null,
    pageCount: 0,
    textPreview: "",
    extractionConfidence: confidence,
  };
}
