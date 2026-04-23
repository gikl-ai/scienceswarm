import path from "node:path";

import type {
  ApplyOperation,
  AppliedPaperMetadata,
  PaperIdentityCandidate,
  PaperIdentifier,
  PaperReviewItem,
} from "./contracts";

function slugSegment(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || "paper";
}

function candidateForReviewItem(item: PaperReviewItem | undefined): PaperIdentityCandidate | undefined {
  if (!item) return undefined;
  return item.candidates.find((candidate) => candidate.id === item.selectedCandidateId) ?? item.candidates[0];
}

function correctionString(item: PaperReviewItem | undefined, key: string): string | undefined {
  const value = item?.correction?.[key];
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

function correctionNumber(item: PaperReviewItem | undefined, key: string): number | undefined {
  const value = item?.correction?.[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function correctionAuthors(item: PaperReviewItem | undefined): string[] | undefined {
  const value = item?.correction?.authors;
  if (Array.isArray(value)) {
    const authors = value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter(Boolean);
    return authors.length > 0 ? authors : undefined;
  }
  if (typeof value === "string") {
    const authors = value.split(/,\s*/).map((entry) => entry.trim()).filter(Boolean);
    return authors.length > 0 ? authors : undefined;
  }
  return undefined;
}

function identifiersForReviewItem(
  item: PaperReviewItem | undefined,
  candidate: PaperIdentityCandidate | undefined,
): PaperIdentifier {
  return {
    ...candidate?.identifiers,
    doi: correctionString(item, "doi") ?? candidate?.identifiers.doi,
    arxivId: correctionString(item, "arxiv_id") ?? candidate?.identifiers.arxivId,
    pmid: correctionString(item, "pmid") ?? candidate?.identifiers.pmid,
  };
}

export function paperLibraryPageSlugForMetadata(
  paperId: string,
  identifiers: PaperIdentifier,
): string {
  if (identifiers.doi) return `wiki/entities/papers/doi-${slugSegment(identifiers.doi)}`;
  if (identifiers.arxivId) return `wiki/entities/papers/arxiv-${slugSegment(identifiers.arxivId)}`;
  if (identifiers.pmid) return `wiki/entities/papers/pmid-${slugSegment(identifiers.pmid)}`;
  return `wiki/entities/papers/local-${slugSegment(paperId)}`;
}

export function buildAppliedPaperMetadata(
  operation: ApplyOperation,
  reviewItem: PaperReviewItem | undefined,
): AppliedPaperMetadata {
  const candidate = candidateForReviewItem(reviewItem);
  const identifiers = identifiersForReviewItem(reviewItem, candidate);
  const title = correctionString(reviewItem, "title")
    ?? candidate?.title
    ?? path.basename(operation.destinationRelativePath, path.extname(operation.destinationRelativePath));
  const authors = correctionAuthors(reviewItem) ?? candidate?.authors ?? [];
  const year = correctionNumber(reviewItem, "year") ?? candidate?.year;
  const venue = correctionString(reviewItem, "venue") ?? candidate?.venue;

  return {
    pageSlug: paperLibraryPageSlugForMetadata(operation.paperId, identifiers),
    title,
    identifiers,
    authors,
    year,
    venue,
  };
}
