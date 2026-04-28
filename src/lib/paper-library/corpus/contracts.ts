import { z } from "zod";

import {
  IsoDateStringSchema,
  NonEmptyStringSchema,
  PaperIdentifierSchema,
  ProjectSlugSchema,
} from "../contracts";

export const PAPER_CORPUS_STATE_VERSION = 1;

export const CorpusArtifactStatusSchema = z.enum([
  "planned",
  "queued",
  "current",
  "stale",
  "failed",
  "skipped",
  "blocked",
]);
export type CorpusArtifactStatus = z.infer<typeof CorpusArtifactStatusSchema>;

export const PaperSourceTypeSchema = z.enum([
  "latex",
  "html",
  "pdf",
  "metadata",
]);
export type PaperSourceType = z.infer<typeof PaperSourceTypeSchema>;

export const PaperSourceOriginSchema = z.enum([
  "arxiv_source",
  "local_sidecar",
  "local_pdf",
  "remote_html",
  "manual",
  "gbrain",
]);
export type PaperSourceOrigin = z.infer<typeof PaperSourceOriginSchema>;

export const PaperSourceCandidateStatusSchema = z.enum([
  "available",
  "preferred",
  "fallback",
  "unavailable",
  "blocked",
]);
export type PaperSourceCandidateStatus = z.infer<typeof PaperSourceCandidateStatusSchema>;

export const PaperCorpusWarningCodeSchema = z.enum([
  "duplicate_identity",
  "source_fallback",
  "source_changed",
  "parser_unavailable",
  "parser_timeout",
  "no_text_layer",
  "low_text_layer",
  "low_table_fidelity",
  "equations_degraded",
  "references_not_found",
  "figure_captions_missing",
  "ocr_required",
  "short_body",
  "math_corruption",
  "privacy_blocked",
  "gbrain_write_failed",
  "capability_unavailable",
  "insufficient_local_evidence",
]);
export type PaperCorpusWarningCode = z.infer<typeof PaperCorpusWarningCodeSchema>;

export const PaperCorpusWarningSchema = z.object({
  code: PaperCorpusWarningCodeSchema,
  message: NonEmptyStringSchema,
  artifactSlug: NonEmptyStringSchema.optional(),
  severity: z.enum(["info", "warning", "error"]).default("warning"),
});
export type PaperCorpusWarning = z.infer<typeof PaperCorpusWarningSchema>;

export const CorpusExtractorSchema = z.object({
  name: NonEmptyStringSchema,
  version: NonEmptyStringSchema.optional(),
  adapter: NonEmptyStringSchema.optional(),
  installed: z.boolean().default(true),
});
export type CorpusExtractor = z.infer<typeof CorpusExtractorSchema>;

export const SourceQualitySchema = z.object({
  score: z.number().min(0).max(1),
  wordCount: z.number().int().nonnegative().optional(),
  hasTextLayer: z.boolean().optional(),
  hasTables: z.boolean().optional(),
  hasEquations: z.boolean().optional(),
  hasFigures: z.boolean().optional(),
  warnings: z.array(PaperCorpusWarningSchema).default([]),
});
export type SourceQuality = z.infer<typeof SourceQualitySchema>;

export const GbrainChunkHandleSchema = z.object({
  sourceSlug: NonEmptyStringSchema,
  chunkId: z.union([z.string().min(1), z.number().int().nonnegative()]).optional(),
  chunkIndex: z.number().int().nonnegative().optional(),
  sectionId: NonEmptyStringSchema.optional(),
});
export type GbrainChunkHandle = z.infer<typeof GbrainChunkHandleSchema>;

export const PaperSourceCandidateSchema = z.object({
  id: NonEmptyStringSchema,
  paperId: NonEmptyStringSchema,
  paperSlug: NonEmptyStringSchema.optional(),
  sourceType: PaperSourceTypeSchema,
  origin: PaperSourceOriginSchema,
  status: PaperSourceCandidateStatusSchema,
  preferenceRank: z.number().int().positive(),
  confidence: z.number().min(0).max(1),
  identifiers: PaperIdentifierSchema.default({}),
  title: NonEmptyStringSchema.optional(),
  relativePath: NonEmptyStringSchema.optional(),
  localPath: NonEmptyStringSchema.optional(),
  url: z.string().url().optional(),
  detectedAt: IsoDateStringSchema,
  evidence: z.array(NonEmptyStringSchema).default([]),
  warnings: z.array(PaperCorpusWarningSchema).default([]),
  unavailableReason: NonEmptyStringSchema.optional(),
});
export type PaperSourceCandidate = z.infer<typeof PaperSourceCandidateSchema>;

export const PaperSourceArtifactSchema = z.object({
  paperId: NonEmptyStringSchema,
  paperSlug: NonEmptyStringSchema,
  sourceSlug: NonEmptyStringSchema,
  selectedCandidateId: NonEmptyStringSchema,
  sourceType: PaperSourceTypeSchema,
  origin: PaperSourceOriginSchema,
  status: CorpusArtifactStatusSchema,
  extractor: CorpusExtractorSchema,
  sourceHash: NonEmptyStringSchema,
  sectionMapHash: NonEmptyStringSchema,
  normalizedMarkdown: z.string().default(""),
  quality: SourceQualitySchema,
  createdAt: IsoDateStringSchema,
  updatedAt: IsoDateStringSchema,
  warnings: z.array(PaperCorpusWarningSchema).default([]),
});
export type PaperSourceArtifact = z.infer<typeof PaperSourceArtifactSchema>;

export const PaperSectionAnchorSchema = z.object({
  sectionId: NonEmptyStringSchema,
  title: NonEmptyStringSchema,
  level: z.number().int().min(1).max(6),
  ordinal: z.number().int().nonnegative(),
  anchor: NonEmptyStringSchema,
  startOffset: z.number().int().nonnegative().optional(),
  endOffset: z.number().int().nonnegative().optional(),
  childSourceSlug: NonEmptyStringSchema.optional(),
  chunkHandles: z.array(GbrainChunkHandleSchema).default([]),
});
export type PaperSectionAnchor = z.infer<typeof PaperSectionAnchorSchema>;

export const PaperSectionMapSchema = z.object({
  paperSlug: NonEmptyStringSchema,
  sourceSlug: NonEmptyStringSchema,
  sourceHash: NonEmptyStringSchema,
  sectionMapHash: NonEmptyStringSchema,
  status: CorpusArtifactStatusSchema,
  sections: z.array(PaperSectionAnchorSchema).min(1),
  createdAt: IsoDateStringSchema,
  updatedAt: IsoDateStringSchema,
  warnings: z.array(PaperCorpusWarningSchema).default([]),
});
export type PaperSectionMap = z.infer<typeof PaperSectionMapSchema>;

export const PaperSummaryTierSchema = z.enum([
  "relevance",
  "brief",
  "detailed",
]);
export type PaperSummaryTier = z.infer<typeof PaperSummaryTierSchema>;

export const PaperSummaryStatusSchema = z.enum([
  "current",
  "stale",
  "missing",
  "failed",
  "queued",
  "blocked",
]);
export type PaperSummaryStatus = z.infer<typeof PaperSummaryStatusSchema>;

export const SummaryEvidenceSchema = z.object({
  claimId: NonEmptyStringSchema.optional(),
  statement: NonEmptyStringSchema.optional(),
  chunkHandles: z.array(GbrainChunkHandleSchema).default([]),
  sectionAnchors: z.array(NonEmptyStringSchema).default([]),
  caveats: z.array(NonEmptyStringSchema).default([]),
}).superRefine((value, context) => {
  if (
    value.claimId
    || value.statement
    || value.chunkHandles.length > 0
    || value.sectionAnchors.length > 0
  ) {
    return;
  }

  context.addIssue({
    code: "custom",
    message: "Summary evidence must include a claim, statement, chunk handle, or section anchor.",
  });
});
export type SummaryEvidence = z.infer<typeof SummaryEvidenceSchema>;

export const PaperSummaryArtifactSchema = z.object({
  paperSlug: NonEmptyStringSchema,
  sourceSlug: NonEmptyStringSchema,
  summarySlug: NonEmptyStringSchema,
  tier: PaperSummaryTierSchema,
  status: PaperSummaryStatusSchema,
  sourceHash: NonEmptyStringSchema,
  sectionMapHash: NonEmptyStringSchema,
  promptVersion: NonEmptyStringSchema,
  modelId: NonEmptyStringSchema.optional(),
  generationSettings: z.record(z.string(), z.unknown()).default({}),
  createdAt: IsoDateStringSchema,
  updatedAt: IsoDateStringSchema,
  generatedAt: IsoDateStringSchema.optional(),
  generatedBy: NonEmptyStringSchema.optional(),
  evidence: z.array(SummaryEvidenceSchema).default([]),
  staleReason: NonEmptyStringSchema.optional(),
  warnings: z.array(PaperCorpusWarningSchema).default([]),
});
export type PaperSummaryArtifact = z.infer<typeof PaperSummaryArtifactSchema>;

export const BibliographyExtractionSourceSchema = z.enum([
  "latex_bib",
  "bbl",
  "html_references",
  "pdf_references",
  "api",
  "manual",
]);
export type BibliographyExtractionSource = z.infer<typeof BibliographyExtractionSourceSchema>;

export const BibliographyLocalStatusSchema = z.enum([
  "local",
  "external",
  "metadata_only",
  "unresolved",
]);
export type BibliographyLocalStatus = z.infer<typeof BibliographyLocalStatusSchema>;

export const BibliographySeenInSchema = z.object({
  paperSlug: NonEmptyStringSchema,
  bibKey: NonEmptyStringSchema.optional(),
  extractionSource: BibliographyExtractionSourceSchema,
  confidence: z.number().min(0).max(1),
});
export type BibliographySeenIn = z.infer<typeof BibliographySeenInSchema>;

export const BibliographyEntryArtifactSchema = z.object({
  bibliographySlug: NonEmptyStringSchema,
  identifiers: PaperIdentifierSchema.default({}),
  title: NonEmptyStringSchema.optional(),
  authors: z.array(NonEmptyStringSchema).default([]),
  year: z.number().int().min(1000).max(3000).optional(),
  venue: NonEmptyStringSchema.optional(),
  canonicalPaperSlug: NonEmptyStringSchema.optional(),
  localStatus: BibliographyLocalStatusSchema,
  seenIn: z.array(BibliographySeenInSchema).default([]),
  warnings: z.array(PaperCorpusWarningSchema).default([]),
});
export type BibliographyEntryArtifact = z.infer<typeof BibliographyEntryArtifactSchema>;

export const PaperProvenanceEventTypeSchema = z.enum([
  "identity_resolution",
  "source_choice",
  "extraction",
  "section_map",
  "bibliography",
  "citation_edge",
  "summary",
  "gbrain_materialization",
  "staleness",
  "repair",
]);
export type PaperProvenanceEventType = z.infer<typeof PaperProvenanceEventTypeSchema>;

export const PaperProvenanceEventStatusSchema = z.enum([
  "queued",
  "succeeded",
  "failed",
  "blocked",
  "stale",
  "skipped",
]);
export type PaperProvenanceEventStatus = z.infer<typeof PaperProvenanceEventStatusSchema>;

export const PaperProvenanceLedgerRecordSchema = z.object({
  id: NonEmptyStringSchema,
  paperSlug: NonEmptyStringSchema,
  occurredAt: IsoDateStringSchema,
  eventType: PaperProvenanceEventTypeSchema,
  status: PaperProvenanceEventStatusSchema,
  actor: NonEmptyStringSchema.optional(),
  sourceSlug: NonEmptyStringSchema.optional(),
  artifactSlug: NonEmptyStringSchema.optional(),
  sourceType: PaperSourceTypeSchema.optional(),
  summaryTier: PaperSummaryTierSchema.optional(),
  inputHash: NonEmptyStringSchema.optional(),
  outputHash: NonEmptyStringSchema.optional(),
  staleReason: NonEmptyStringSchema.optional(),
  message: NonEmptyStringSchema.optional(),
  warnings: z.array(PaperCorpusWarningSchema).default([]),
  details: z.record(z.string(), z.unknown()).default({}),
});
export type PaperProvenanceLedgerRecord = z.infer<typeof PaperProvenanceLedgerRecordSchema>;

export const GbrainCorpusRetrievalModeSchema = z.enum([
  "keyword_chunks",
  "embeddings",
  "typed_links",
  "backlinks",
  "frontmatter_filter",
  "section_anchors",
  "health",
]);
export type GbrainCorpusRetrievalMode = z.infer<typeof GbrainCorpusRetrievalModeSchema>;

export const GbrainCorpusCapabilitySchema = z.object({
  mode: GbrainCorpusRetrievalModeSchema,
  status: z.enum(["available", "degraded", "unavailable"]),
  reason: NonEmptyStringSchema.optional(),
  evidence: z.array(NonEmptyStringSchema).default([]),
});
export type GbrainCorpusCapability = z.infer<typeof GbrainCorpusCapabilitySchema>;

export const GbrainCorpusCapabilitiesSchema = z.object({
  generatedAt: IsoDateStringSchema,
  capabilities: z.array(GbrainCorpusCapabilitySchema).default([]),
  warnings: z.array(PaperCorpusWarningSchema).default([]),
});
export type GbrainCorpusCapabilities = z.infer<typeof GbrainCorpusCapabilitiesSchema>;

export const ResearchContextPaperRoleSchema = z.enum([
  "core",
  "supporting",
  "background",
  "contrary",
  "missing",
  "ignored",
]);
export type ResearchContextPaperRole = z.infer<typeof ResearchContextPaperRoleSchema>;

export const ResearchContextGraphPathSchema = z.object({
  from: NonEmptyStringSchema,
  relation: z.enum([
    "has_source",
    "has_summary",
    "derived_from",
    "cites",
    "same_identity",
    "included_in_survey",
    "selected_for_context",
  ]),
  to: NonEmptyStringSchema,
  evidence: z.array(NonEmptyStringSchema).default([]),
});
export type ResearchContextGraphPath = z.infer<typeof ResearchContextGraphPathSchema>;

export const ResearchContextPaperSchema = z.object({
  paperSlug: NonEmptyStringSchema,
  title: NonEmptyStringSchema.optional(),
  role: ResearchContextPaperRoleSchema,
  reasonSelected: NonEmptyStringSchema.optional(),
  reasonNotDeeper: NonEmptyStringSchema.optional(),
  relevanceCardSlug: NonEmptyStringSchema.optional(),
  briefSummarySlug: NonEmptyStringSchema.optional(),
  detailedSummarySlug: NonEmptyStringSchema.optional(),
  sourceChunks: z.array(GbrainChunkHandleSchema).default([]),
  graphPaths: z.array(ResearchContextGraphPathSchema).default([]),
  caveats: z.array(NonEmptyStringSchema).default([]),
});
export type ResearchContextPaper = z.infer<typeof ResearchContextPaperSchema>;

export const ResearchContextClaimSchema = z.object({
  id: NonEmptyStringSchema,
  statement: NonEmptyStringSchema,
  confidence: z.enum(["high", "medium", "low", "insufficient"]),
  supportingChunks: z.array(GbrainChunkHandleSchema).default([]),
  contradictingChunks: z.array(GbrainChunkHandleSchema).default([]),
  paperSlugs: z.array(NonEmptyStringSchema).default([]),
  caveats: z.array(NonEmptyStringSchema).default([]),
});
export type ResearchContextClaim = z.infer<typeof ResearchContextClaimSchema>;

export const ResearchContextTensionSchema = z.object({
  id: NonEmptyStringSchema,
  summary: NonEmptyStringSchema,
  paperSlugs: z.array(NonEmptyStringSchema).default([]),
  evidence: z.array(GbrainChunkHandleSchema).default([]),
});
export type ResearchContextTension = z.infer<typeof ResearchContextTensionSchema>;

export const ResearchContextMissingPaperSchema = z.object({
  bibliographySlug: NonEmptyStringSchema,
  reason: NonEmptyStringSchema,
  acquisitionStatus: z.enum([
    "local",
    "downloadable",
    "metadata_only",
    "license_uncertain",
    "unresolved",
  ]),
});
export type ResearchContextMissingPaper = z.infer<typeof ResearchContextMissingPaperSchema>;

export const ResearchContextPacketSchema = z.object({
  question: NonEmptyStringSchema,
  generatedAt: IsoDateStringSchema,
  studySlug: ProjectSlugSchema,
  selectionPolicy: NonEmptyStringSchema,
  capabilities: GbrainCorpusCapabilitiesSchema,
  papers: z.array(ResearchContextPaperSchema).default([]),
  claims: z.array(ResearchContextClaimSchema).default([]),
  tensions: z.array(ResearchContextTensionSchema).default([]),
  missingPapers: z.array(ResearchContextMissingPaperSchema).default([]),
  caveats: z.array(NonEmptyStringSchema).default([]),
  warnings: z.array(PaperCorpusWarningSchema).default([]),
});
export type ResearchContextPacket = z.infer<typeof ResearchContextPacketSchema>;

export const PaperIngestPaperSchema = z.object({
  paperId: NonEmptyStringSchema,
  paperSlug: NonEmptyStringSchema,
  identifiers: PaperIdentifierSchema.default({}),
  title: NonEmptyStringSchema.optional(),
  status: CorpusArtifactStatusSchema,
  sourceCandidates: z.array(PaperSourceCandidateSchema).default([]),
  selectedSourceCandidateId: NonEmptyStringSchema.optional(),
  sourceArtifact: PaperSourceArtifactSchema.optional(),
  sectionMap: PaperSectionMapSchema.optional(),
  summaries: z.array(PaperSummaryArtifactSchema).default([]),
  bibliography: z.array(BibliographyEntryArtifactSchema).default([]),
  provenance: z.array(PaperProvenanceLedgerRecordSchema).default([]),
  warnings: z.array(PaperCorpusWarningSchema).default([]),
});
export type PaperIngestPaper = z.infer<typeof PaperIngestPaperSchema>;

export const PaperIngestManifestSchema = z.object({
  version: z.literal(PAPER_CORPUS_STATE_VERSION),
  id: NonEmptyStringSchema,
  project: ProjectSlugSchema,
  scanId: NonEmptyStringSchema.optional(),
  status: CorpusArtifactStatusSchema,
  createdAt: IsoDateStringSchema,
  updatedAt: IsoDateStringSchema,
  parserConcurrencyLimit: z.number().int().positive(),
  summaryConcurrencyLimit: z.number().int().positive(),
  papers: z.array(PaperIngestPaperSchema).default([]),
  warnings: z.array(PaperCorpusWarningSchema).default([]),
});
export type PaperIngestManifest = z.infer<typeof PaperIngestManifestSchema>;

function stableSlugHash(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36);
}

function slugSegment(value: string): string {
  const slug = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "paper";
  if (slug.length <= 120) return slug;
  const hash = stableSlugHash(slug);
  return `${slug.slice(0, 119 - hash.length)}-${hash}`;
}

function normalizeCorpusDoi(value: string): string {
  return value
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "")
    .replace(/[)\].,;:\s]+$/g, "")
    .toLowerCase();
}

function normalizeCorpusArxivId(value: string): string {
  return value
    .trim()
    .replace(/^arxiv\s*:\s*/i, "")
    .replace(/[)\].,;:\s]+$/g, "");
}

function normalizeCorpusOpenAlexId(value: string): string {
  return value
    .trim()
    .replace(/^https?:\/\/openalex\.org\//i, "")
    .replace(/^openalex:\s*/i, "")
    .replace(/[)\].,;:\s]+$/g, "")
    .toLowerCase();
}

export function paperCorpusPaperSegment(paperSlug: string): string {
  const normalized = paperSlug.trim().replace(/^\/+/, "").replace(/\.md$/i, "");
  const parts = normalized.split("/").filter(Boolean);
  const paperIndex = parts.lastIndexOf("papers");
  if (paperIndex >= 0 && parts[paperIndex + 1]) {
    return slugSegment(parts[paperIndex + 1]);
  }
  return slugSegment(parts[parts.length - 1] ?? normalized);
}

export function paperCorpusSourceSlugForPaperSlug(paperSlug: string): string {
  return `wiki/sources/papers/${paperCorpusPaperSegment(paperSlug)}/source`;
}

export function paperCorpusSummarySlugForPaperSlug(
  paperSlug: string,
  tier: PaperSummaryTier,
): string {
  return `wiki/summaries/papers/${paperCorpusPaperSegment(paperSlug)}/${tier}`;
}

export function paperCorpusBibliographySlug(
  identifiers: z.infer<typeof PaperIdentifierSchema>,
  fallback: string,
): string {
  if (identifiers.doi) return `wiki/bibliography/doi-${slugSegment(normalizeCorpusDoi(identifiers.doi))}`;
  if (identifiers.arxivId) return `wiki/bibliography/arxiv-${slugSegment(normalizeCorpusArxivId(identifiers.arxivId))}`;
  if (identifiers.pmid) return `wiki/bibliography/pmid-${slugSegment(identifiers.pmid.trim())}`;
  if (identifiers.openAlexId) {
    return `wiki/bibliography/openalex-${slugSegment(normalizeCorpusOpenAlexId(identifiers.openAlexId))}`;
  }
  return `wiki/bibliography/title-${slugSegment(fallback)}`;
}
