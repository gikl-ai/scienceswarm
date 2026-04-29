import crypto from "node:crypto";
import path from "node:path";
import type { PaperIdentifier, PaperIdentityCandidate } from "./contracts";

const DOI_RE = /\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+\b/gi;
const ARXIV_RE = /\b(?:arXiv\s*:\s*)?(\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?)\b/gi;
const PMID_RE = /\b(?:PMID\s*:?\s*)(\d{6,9})\b/gi;
const YEAR_RE = /\b(19\d{2}|20\d{2})\b/;
const PDF_TITLE_SCAN_LINE_LIMIT = 80;
const SPACED_DASH_SEPARATOR = String.raw`\s+[-\u2013\u2014]\s+`;
const YEAR_AUTHOR_TITLE_PATH_RE = new RegExp(
  `^(?:19\\d{2}|20\\d{2})${SPACED_DASH_SEPARATOR}.+?${SPACED_DASH_SEPARATOR}(.+)$`,
  "u",
);
const AUTHOR_YEAR_TITLE_PATH_RE = new RegExp(`^.+?\\s+(?:19\\d{2}|20\\d{2})${SPACED_DASH_SEPARATOR}(.+)$`, "u");
const YEAR_TITLE_PATH_RE = new RegExp(`^(?:19\\d{2}|20\\d{2})${SPACED_DASH_SEPARATOR}(.+)$`, "u");

export interface PaperIdentityEvidenceInput {
  relativePath: string;
  text?: string | null;
  pageCount?: number;
  wordCount?: number;
}

export interface PaperIdentityEvidence {
  identifiers: PaperIdentifier;
  titleHint?: string;
  yearHint?: number;
  textLayerTooThin: boolean;
  evidence: string[];
}

export function normalizeDoi(value: string): string {
  return value
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "")
    .replace(/[)\].,;:\s]+$/g, "")
    .toLowerCase();
}

export function normalizeArxivId(value: string): string {
  return value
    .trim()
    .replace(/^arxiv\s*:\s*/i, "")
    .replace(/[)\].,;:\s]+$/g, "");
}

export function deriveTitleHintFromPath(relativePath: string): string | undefined {
  const parsed = path.parse(relativePath);
  const rawName = parsed.name
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const structuredTitle =
    rawName.match(YEAR_AUTHOR_TITLE_PATH_RE)?.[1]
    ?? rawName.match(AUTHOR_YEAR_TITLE_PATH_RE)?.[1]
    ?? rawName.match(YEAR_TITLE_PATH_RE)?.[1];
  const cleaned = (structuredTitle ?? rawName)
    .replace(structuredTitle ? /_/g : /[_-]+/g, " ")
    .replace(/\b(?:final|draft|copy|download|paper|pdf)\b/gi, " ")
    .replace(/\b(?:v\d+|\(\d+\))\b/gi, " ")
    .replace(/(?:^|\s)[-\u2013\u2014]+(?=\s|$)/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (cleaned.length < 4) return undefined;
  return cleaned;
}

function stripReferenceSection(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const referenceIndex = lines.findIndex((line, index) => {
    if (index < Math.floor(lines.length * 0.25)) return false;
    return /^(references|bibliography|works cited)$/i.test(line.trim());
  });
  return (referenceIndex >= 0 ? lines.slice(0, referenceIndex) : lines).join("\n");
}

function normalizeTitleCandidate(line: string): string | null {
  const candidate = line.replace(/\s+/g, " ").trim();
  if (!/\p{L}/u.test(candidate)) return null;
  if (candidate.length <= 2) return null;
  if (/^(abstract|introduction|references|bibliography|keywords|contents|authors?)\b/i.test(candidate)) return null;
  if (/^(arxiv|doi|preprint|published as|proceedings|technical report)\b/i.test(candidate)) return null;
  if (/^[A-Z\. ]+$/.test(candidate) && candidate.length < 10) return null;
  return candidate;
}

function isLikelyTitleContinuation(line: string, currentTitle: string): boolean {
  if (/^(abstract|introduction|keywords|contents|authors?)\b/i.test(line)) return false;
  if (/^(arxiv|doi|preprint|published as|proceedings|technical report)\b/i.test(line)) return false;
  if (/[,@]/.test(line) && !/[?:]/.test(line)) return false;
  if (/\b(university|institute|laboratory|department|school)\b/i.test(line)) return false;
  if (/\b(team|community)\b/i.test(line) && line.split(/\s+/).length <= 4) return false;
  if (currentTitle.length >= 12 && /[*†‡]|\b[A-Z]\./.test(line) && !/[?:]/.test(line)) return false;
  if (currentTitle.length >= 45 && /^[A-Z]/.test(line) && line.split(/\s+/).length <= 4 && /[a-z]/.test(line)) return false;
  if (/^\p{Lu}\p{Ll}+(?:\s+\p{Lu}\p{Ll}+){1,3}$/u.test(line) && currentTitle.length >= 12) return false;
  return true;
}

export function deriveTitleHintFromText(text: string | undefined | null): string | undefined {
  if (!text) return undefined;
  const frontMatter = stripReferenceSection(text);
  const lines = frontMatter
    .split(/\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, PDF_TITLE_SCAN_LINE_LIMIT);

  for (let index = 0; index < lines.length; index += 1) {
    const candidate = normalizeTitleCandidate(lines[index]);
    if (!candidate) continue;

    const titleLines = [candidate];
    for (const nextLine of lines.slice(index + 1, index + 4)) {
      if (!isLikelyTitleContinuation(nextLine, titleLines.join(" "))) break;
      const nextCandidate = normalizeTitleCandidate(nextLine);
      if (!nextCandidate) break;
      titleLines.push(nextCandidate);
    }
    return titleLines.join(" ").slice(0, 180);
  }

  return undefined;
}

function firstMatch(regex: RegExp, value: string): string | undefined {
  regex.lastIndex = 0;
  const match = regex.exec(value);
  return match?.[1] ?? match?.[0];
}

export function extractPaperIdentityEvidence(input: PaperIdentityEvidenceInput): PaperIdentityEvidence {
  const text = input.text ?? "";
  const frontMatterText = stripReferenceSection(text);
  const identifierSearchable = `${input.relativePath}\n${frontMatterText.slice(0, 12_000)}`;
  const doi = firstMatch(DOI_RE, identifierSearchable);
  const arxivId = firstMatch(ARXIV_RE, identifierSearchable);
  const pmid = firstMatch(PMID_RE, identifierSearchable);
  const year = firstMatch(YEAR_RE, input.relativePath) ?? firstMatch(YEAR_RE, frontMatterText.slice(0, 5000));
  const wordCount = input.wordCount ?? text.trim().split(/\s+/).filter(Boolean).length;

  const evidence: string[] = [];
  const identifiers: PaperIdentifier = {};

  if (doi) {
    identifiers.doi = normalizeDoi(doi);
    evidence.push("doi_detected");
  }
  if (arxivId) {
    identifiers.arxivId = normalizeArxivId(arxivId);
    evidence.push("arxiv_detected");
  }
  if (pmid) {
    identifiers.pmid = pmid.trim();
    evidence.push("pmid_detected");
  }

  const textTitle = deriveTitleHintFromText(frontMatterText);
  const titleHint = textTitle ?? deriveTitleHintFromPath(input.relativePath);
  if (titleHint) {
    evidence.push(textTitle ? "title_from_pdf_text" : "title_from_filename");
  }

  const textLayerTooThin = wordCount < 80 && !doi && !arxivId && !pmid;
  if (textLayerTooThin) evidence.push("text_layer_too_thin");

  return {
    identifiers,
    titleHint,
    yearHint: year ? Number(year) : undefined,
    textLayerTooThin,
    evidence,
  };
}

export function createIdentityCandidateFromEvidence(
  evidence: PaperIdentityEvidence,
  sourcePath: string,
): PaperIdentityCandidate {
  const identifierScore = evidence.identifiers.doi || evidence.identifiers.arxivId || evidence.identifiers.pmid ? 0.86 : 0;
  const titleScore = evidence.titleHint ? 0.25 : 0;
  const yearScore = evidence.yearHint ? 0.05 : 0;
  const confidence = Math.min(0.95, identifierScore + titleScore + yearScore);

  return {
    id: crypto
      .createHash("sha1")
      .update(`${sourcePath}:${JSON.stringify(evidence.identifiers)}:${evidence.titleHint ?? ""}`)
      .digest("hex"),
    identifiers: evidence.identifiers,
    title: evidence.titleHint,
    authors: [],
    year: evidence.yearHint,
    source: "pdf_text",
    confidence,
    evidence: evidence.evidence,
    conflicts: evidence.textLayerTooThin ? ["text_layer_too_thin"] : [],
  };
}
