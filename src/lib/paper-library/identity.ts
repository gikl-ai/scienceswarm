import crypto from "node:crypto";
import path from "node:path";
import type { PaperIdentifier, PaperIdentityCandidate } from "./contracts";

const DOI_RE = /\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+\b/gi;
const ARXIV_RE = /\b(?:arXiv\s*:\s*)?(\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?)\b/gi;
const PMID_RE = /\b(?:PMID\s*:?\s*)(\d{6,9})\b/gi;
const YEAR_RE = /\b(19\d{2}|20\d{2})\b/;

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
  const cleaned = parsed.name
    .replace(/[_-]+/g, " ")
    .replace(/\b(?:final|draft|copy|download|paper|pdf)\b/gi, " ")
    .replace(/\b(?:v\d+|\(\d+\))\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (cleaned.length < 4) return undefined;
  return cleaned;
}

function firstMatch(regex: RegExp, value: string): string | undefined {
  regex.lastIndex = 0;
  const match = regex.exec(value);
  return match?.[1] ?? match?.[0];
}

export function extractPaperIdentityEvidence(input: PaperIdentityEvidenceInput): PaperIdentityEvidence {
  const text = input.text ?? "";
  const searchable = `${input.relativePath}\n${text}`;
  const doi = firstMatch(DOI_RE, searchable);
  const arxivId = firstMatch(ARXIV_RE, searchable);
  const pmid = firstMatch(PMID_RE, searchable);
  const year = firstMatch(YEAR_RE, input.relativePath) ?? firstMatch(YEAR_RE, text.slice(0, 5000));
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

  const titleHint = deriveTitleHintFromPath(input.relativePath);
  if (titleHint) evidence.push("title_from_filename");

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

