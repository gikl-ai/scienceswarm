import path from "node:path";

import { paperLibraryPageSlugForMetadata } from "../applied-metadata";
import type { PaperIdentifier, PaperIdentityCandidate, PaperReviewItem } from "../contracts";
import {
  PAPER_CORPUS_STATE_VERSION,
  PaperIngestManifestSchema,
  PaperIngestPaperSchema,
  PaperSourceCandidateSchema,
  type PaperCorpusWarning,
  type PaperIngestManifest,
  type PaperIngestPaper,
  type PaperSourceCandidate,
  type PaperSourceType,
} from "./contracts";
import { buildSourceChoiceProvenanceRecord } from "./provenance";

export interface BuildPaperCorpusSourceCandidatesInput {
  item: PaperReviewItem;
  detectedAt: string;
  sidecarRelativePaths?: readonly string[];
  paperSlug?: string;
}

export interface BuildPaperCorpusIngestPaperInput extends BuildPaperCorpusSourceCandidatesInput {
  includeSourceChoiceProvenance?: boolean;
}

export interface BuildPaperCorpusManifestInput {
  id: string;
  project: string;
  createdAt: string;
  updatedAt?: string;
  scanId?: string;
  items: readonly PaperReviewItem[];
  sidecarRelativePaths?: readonly string[];
  sidecarRelativePathsByPaperId?: Readonly<Record<string, readonly string[]>>;
  parserConcurrencyLimit?: number;
  summaryConcurrencyLimit?: number;
}

function selectedIdentityCandidate(item: PaperReviewItem): PaperIdentityCandidate | undefined {
  if (item.selectedCandidateId) {
    return item.candidates.find((candidate) => candidate.id === item.selectedCandidateId);
  }
  return item.candidates[0];
}

function correctionString(item: PaperReviewItem, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = item.correction?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function identifiersForReviewItem(item: PaperReviewItem, candidate: PaperIdentityCandidate | undefined): PaperIdentifier {
  return {
    ...candidate?.identifiers,
    doi: correctionString(item, "doi") ?? candidate?.identifiers.doi,
    arxivId: correctionString(item, "arxiv_id", "arxivId") ?? candidate?.identifiers.arxivId,
    pmid: correctionString(item, "pmid") ?? candidate?.identifiers.pmid,
    openAlexId: correctionString(item, "openalex_id", "openAlexId") ?? candidate?.identifiers.openAlexId,
  };
}

function titleForReviewItem(item: PaperReviewItem, candidate: PaperIdentityCandidate | undefined): string | undefined {
  return correctionString(item, "title")
    ?? candidate?.title?.trim()
    ?? (item.source ? path.basename(item.source.relativePath, path.extname(item.source.relativePath)) : undefined);
}

function normalizeArxivId(value: string): string {
  return value
    .trim()
    .replace(/^arxiv\s*:\s*/i, "")
    .replace(/[)\].,;:\s]+$/g, "")
    .replace(/v\d+$/i, "");
}

function normalizeRelativePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\/+/, "");
}

function stemKey(relativePath: string): string {
  const normalized = normalizeRelativePath(relativePath).toLowerCase();
  const extension = path.posix.extname(normalized);
  return path.posix.join(path.posix.dirname(normalized), path.posix.basename(normalized, extension));
}

function sourceTypeForSidecar(relativePath: string): PaperSourceType | null {
  const extension = path.posix.extname(normalizeRelativePath(relativePath)).toLowerCase();
  if (extension === ".tex") return "latex";
  if (extension === ".html" || extension === ".htm") return "html";
  return null;
}

function candidateId(paperId: string, suffix: string): string {
  return `${paperId}:source:${suffix}`;
}

function stablePathId(relativePath: string): string {
  return normalizeRelativePath(relativePath)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "sidecar";
}

function duplicateIdentityWarning(item: PaperReviewItem, candidate: PaperIdentityCandidate | undefined): PaperCorpusWarning[] {
  const hasDuplicateReason = item.reasonCodes.some((reason) => reason === "duplicate_identity");
  const hasCandidateConflict = (candidate?.conflicts ?? []).some((conflict) => /duplicate/i.test(conflict));
  if (!hasDuplicateReason && !hasCandidateConflict) return [];
  return [
    {
      code: "duplicate_identity",
      message: "Paper identity has duplicate or conflicting metadata evidence.",
      severity: "warning",
    },
  ];
}

function withPreferredCandidate(candidates: PaperSourceCandidate[]): PaperSourceCandidate[] {
  const available = candidates
    .filter((candidate) => candidate.status !== "unavailable" && candidate.status !== "blocked")
    .sort((left, right) => left.preferenceRank - right.preferenceRank || left.id.localeCompare(right.id));
  const preferredId = available[0]?.id;
  return candidates.map((candidate) => {
    if (candidate.status === "unavailable" || candidate.status === "blocked") return candidate;
    return PaperSourceCandidateSchema.parse({
      ...candidate,
      status: candidate.id === preferredId ? "preferred" : "fallback",
    });
  });
}

export function buildPaperCorpusSourceCandidates(
  input: BuildPaperCorpusSourceCandidatesInput,
): PaperSourceCandidate[] {
  const candidate = selectedIdentityCandidate(input.item);
  const identifiers = identifiersForReviewItem(input.item, candidate);
  const title = titleForReviewItem(input.item, candidate);
  const paperSlug = input.paperSlug ?? paperLibraryPageSlugForMetadata(input.item.paperId, identifiers);
  const warnings = duplicateIdentityWarning(input.item, candidate);
  const confidence = Math.max(candidate?.confidence ?? 0.5, 0.5);
  const sourceCandidates: PaperSourceCandidate[] = [];

  if (identifiers.arxivId) {
    const arxivId = normalizeArxivId(identifiers.arxivId);
    if (arxivId) {
      sourceCandidates.push(PaperSourceCandidateSchema.parse({
        id: candidateId(input.item.paperId, "arxiv-source"),
        paperId: input.item.paperId,
        paperSlug,
        sourceType: "latex",
        origin: "arxiv_source",
        status: "available",
        preferenceRank: 1,
        confidence: Math.max(confidence, 0.82),
        identifiers,
        title,
        url: `https://arxiv.org/e-print/${arxivId}`,
        detectedAt: input.detectedAt,
        evidence: [`arXiv identifier ${arxivId}`],
        warnings,
      }));
    }
  }

  const sourceStem = input.item.source ? stemKey(input.item.source.relativePath) : null;
  const sidecars = (input.sidecarRelativePaths ?? [])
    .map(normalizeRelativePath)
    .filter((relativePath) => !sourceStem || stemKey(relativePath) === sourceStem)
    .sort((left, right) => left.localeCompare(right));

  for (const relativePath of sidecars) {
    const sourceType = sourceTypeForSidecar(relativePath);
    if (!sourceType) continue;
    sourceCandidates.push(PaperSourceCandidateSchema.parse({
      id: candidateId(input.item.paperId, `sidecar-${sourceType}-${stablePathId(relativePath)}`),
      paperId: input.item.paperId,
      paperSlug,
      sourceType,
      origin: "local_sidecar",
      status: "available",
      preferenceRank: 2,
      confidence: Math.max(confidence, 0.72),
      identifiers,
      title,
      relativePath,
      detectedAt: input.detectedAt,
      evidence: [`local ${sourceType} sidecar ${relativePath}`],
      warnings,
    }));
  }

  if (input.item.source) {
    sourceCandidates.push(PaperSourceCandidateSchema.parse({
      id: candidateId(input.item.paperId, "local-pdf"),
      paperId: input.item.paperId,
      paperSlug,
      sourceType: "pdf",
      origin: "local_pdf",
      status: "available",
      preferenceRank: 3,
      confidence,
      identifiers,
      title,
      relativePath: input.item.source.relativePath,
      detectedAt: input.detectedAt,
      evidence: [
        `local PDF ${input.item.source.relativePath}`,
        `fingerprint ${input.item.source.fingerprintStrength}:${input.item.source.fingerprint}`,
      ],
      warnings,
    }));
  }

  return withPreferredCandidate(sourceCandidates);
}

export function buildPaperCorpusIngestPaper(input: BuildPaperCorpusIngestPaperInput): PaperIngestPaper {
  const candidate = selectedIdentityCandidate(input.item);
  const identifiers = identifiersForReviewItem(input.item, candidate);
  const title = titleForReviewItem(input.item, candidate);
  const paperSlug = input.paperSlug ?? paperLibraryPageSlugForMetadata(input.item.paperId, identifiers);
  const sourceCandidates = buildPaperCorpusSourceCandidates(input);
  const selectedSourceCandidate = sourceCandidates.find((sourceCandidate) => sourceCandidate.status === "preferred");
  const warnings: PaperCorpusWarning[] = sourceCandidates.length > 0
    ? []
    : [
      {
        code: "insufficient_local_evidence",
        message: "No local PDF, source sidecar, or arXiv source candidate is available for this paper.",
        severity: "warning",
      },
    ];
  const provenance = input.includeSourceChoiceProvenance && selectedSourceCandidate
    ? [
      buildSourceChoiceProvenanceRecord({
        paperSlug,
        occurredAt: input.detectedAt,
        candidate: selectedSourceCandidate,
      }),
    ]
    : [];

  return PaperIngestPaperSchema.parse({
    paperId: input.item.paperId,
    paperSlug,
    identifiers,
    title,
    status: sourceCandidates.length > 0 ? "planned" : "blocked",
    sourceCandidates,
    selectedSourceCandidateId: selectedSourceCandidate?.id,
    provenance,
    warnings,
  });
}

export function buildPaperCorpusManifest(input: BuildPaperCorpusManifestInput): PaperIngestManifest {
  return PaperIngestManifestSchema.parse({
    version: PAPER_CORPUS_STATE_VERSION,
    id: input.id,
    project: input.project,
    scanId: input.scanId,
    status: "planned" as const,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt ?? input.createdAt,
    parserConcurrencyLimit: input.parserConcurrencyLimit ?? 2,
    summaryConcurrencyLimit: input.summaryConcurrencyLimit ?? 1,
    papers: input.items.map((item) => {
      const sidecarRelativePaths = input.sidecarRelativePathsByPaperId?.[item.paperId]
        ?? (item.source ? input.sidecarRelativePaths : undefined);
      return buildPaperCorpusIngestPaper({
        item,
        detectedAt: input.createdAt,
        sidecarRelativePaths,
        includeSourceChoiceProvenance: true,
      });
    }),
  });
}
