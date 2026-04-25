import { z } from "zod";

export const PAPER_LIBRARY_STATE_VERSION = 1;

export const paperLibraryErrorCodes = [
  "invalid_root",
  "template_unknown_variable",
  "approval_token_expired",
  "invalid_approval_token",
  "source_changed_since_approval",
  "metadata_unavailable",
  "apply_blocked_conflicts",
  "job_not_found",
  "job_already_running",
  "manifest_not_found",
  "manifest_not_repairable",
  "unsafe_path",
  "invalid_project",
  "invalid_cursor",
  "invalid_state",
  "malformed_state",
  "model_unavailable",
  "resource_budget_exhausted",
  "suggestion_not_found",
] as const;

export const PaperLibraryErrorCodeSchema = z.enum(paperLibraryErrorCodes);
export type PaperLibraryErrorCode = z.infer<typeof PaperLibraryErrorCodeSchema>;

export const PaperLibraryErrorEnvelopeSchema = z.object({
  ok: z.literal(false),
  error: z.object({
    code: PaperLibraryErrorCodeSchema,
    message: z.string().min(1),
    details: z.unknown().optional(),
  }),
});
export type PaperLibraryErrorEnvelope = z.infer<typeof PaperLibraryErrorEnvelopeSchema>;

export function paperLibraryError(
  code: PaperLibraryErrorCode,
  message: string,
  details?: unknown,
): PaperLibraryErrorEnvelope {
  return {
    ok: false,
    error: details === undefined ? { code, message } : { code, message, details },
  };
}

export const ProjectSlugSchema = z.string().regex(/^[a-z0-9-]+$/);
export const IsoDateStringSchema = z.string().datetime({ offset: true });
export const NonEmptyStringSchema = z.string().trim().min(1);

export const PaperIdentifierSchema = z.object({
  doi: z.string().trim().min(1).optional(),
  arxivId: z.string().trim().min(1).optional(),
  pmid: z.string().trim().min(1).optional(),
  openAlexId: z.string().trim().min(1).optional(),
});
export type PaperIdentifier = z.infer<typeof PaperIdentifierSchema>;

export const PaperMetadataSourceSchema = z.enum([
  "pdf_text",
  "filename",
  "path",
  "gbrain",
  "crossref",
  "openalex",
  "pubmed",
  "arxiv",
  "semantic_scholar",
  "user",
  "model",
]);
export type PaperMetadataSource = z.infer<typeof PaperMetadataSourceSchema>;

export const PaperMetadataFieldSchema = z.object({
  name: z.string().min(1),
  value: z.unknown(),
  source: PaperMetadataSourceSchema,
  confidence: z.number().min(0).max(1),
  evidence: z.array(z.string()).default([]),
  conflict: z.boolean().default(false),
  sourceStatus: z.enum(["available", "unavailable", "not_queried"]).default("available"),
});
export type PaperMetadataField = z.infer<typeof PaperMetadataFieldSchema>;

export const PaperIdentityCandidateSchema = z.object({
  id: z.string().min(1),
  identifiers: PaperIdentifierSchema.default({}),
  title: z.string().optional(),
  authors: z.array(z.string()).default([]),
  year: z.number().int().min(1000).max(3000).optional(),
  venue: z.string().optional(),
  source: PaperMetadataSourceSchema,
  confidence: z.number().min(0).max(1),
  evidence: z.array(z.string()).default([]),
  conflicts: z.array(z.string()).default([]),
});
export type PaperIdentityCandidate = z.infer<typeof PaperIdentityCandidateSchema>;

export const PaperIdentitySchema = z.object({
  paperId: z.string().min(1),
  chosen: PaperIdentityCandidateSchema.nullable(),
  candidates: z.array(PaperIdentityCandidateSchema).default([]),
  status: z.enum(["identified", "needs_review", "blocked", "incomplete"]),
});
export type PaperIdentity = z.infer<typeof PaperIdentitySchema>;

export const FingerprintStrengthSchema = z.enum(["stat", "quick", "sha256"]);
export type FingerprintStrength = z.infer<typeof FingerprintStrengthSchema>;

export const PaperLibraryFileSnapshotSchema = z.object({
  relativePath: z.string().min(1),
  rootRealpath: z.string().min(1),
  size: z.number().int().nonnegative(),
  mtimeMs: z.number().nonnegative(),
  fingerprint: z.string().min(1),
  fingerprintStrength: FingerprintStrengthSchema,
  inode: z.number().int().nonnegative().optional(),
  dev: z.number().int().nonnegative().optional(),
  symlink: z.boolean().default(false),
});
export type PaperLibraryFileSnapshot = z.infer<typeof PaperLibraryFileSnapshotSchema>;

export const PaperReviewItemStateSchema = z.enum([
  "needs_review",
  "accepted",
  "corrected",
  "ignored",
  "unresolved",
]);
export type PaperReviewItemState = z.infer<typeof PaperReviewItemStateSchema>;

export const PaperReviewItemSchema = z.object({
  id: z.string().min(1),
  scanId: z.string().min(1),
  paperId: z.string().min(1),
  state: PaperReviewItemStateSchema,
  reasonCodes: z.array(z.string()).default([]),
  source: PaperLibraryFileSnapshotSchema.optional(),
  candidates: z.array(PaperIdentityCandidateSchema).default([]),
  selectedCandidateId: z.string().optional(),
  correction: z.record(z.string(), z.unknown()).optional(),
  semanticText: z.string().min(1).max(4000).optional(),
  semanticTextHash: z.string().min(1).optional(),
  firstSentence: z.string().min(1).max(400).optional(),
  pageCount: z.number().int().nonnegative().optional(),
  wordCount: z.number().int().nonnegative().optional(),
  version: z.number().int().nonnegative(),
  updatedAt: IsoDateStringSchema,
});
export type PaperReviewItem = z.infer<typeof PaperReviewItemSchema>;

export const PaperReviewShardSchema = z.object({
  version: z.literal(PAPER_LIBRARY_STATE_VERSION),
  scanId: z.string().min(1),
  items: z.array(PaperReviewItemSchema).default([]),
});
export type PaperReviewShard = z.infer<typeof PaperReviewShardSchema>;

export const PaperReviewUpdateRequestSchema = z.object({
  project: ProjectSlugSchema,
  scanId: z.string().min(1),
  itemId: z.string().min(1),
  action: z.enum(["accept", "correct", "ignore", "unresolve"]),
  selectedCandidateId: z.string().min(1).optional(),
  correction: z.record(z.string(), z.unknown()).optional(),
});
export type PaperReviewUpdateRequest = z.infer<typeof PaperReviewUpdateRequestSchema>;

export const PaperLibraryScanStatusSchema = z.enum([
  "queued",
  "scanning",
  "identifying",
  "enriching",
  "ready_for_review",
  "ready_for_apply",
  "completed",
  "failed",
  "canceled",
]);
export type PaperLibraryScanStatus = z.infer<typeof PaperLibraryScanStatusSchema>;

export const PaperLibraryScanSchema = z.object({
  version: z.literal(PAPER_LIBRARY_STATE_VERSION),
  id: z.string().min(1),
  project: ProjectSlugSchema,
  rootPath: z.string().min(1),
  rootRealpath: z.string().min(1).optional(),
  status: PaperLibraryScanStatusSchema,
  createdAt: IsoDateStringSchema,
  updatedAt: IsoDateStringSchema,
  heartbeatAt: IsoDateStringSchema.optional(),
  claimId: z.string().optional(),
  idempotencyKey: z.string().min(1).optional(),
  cancelRequestedAt: IsoDateStringSchema.optional(),
  counters: z.object({
    detectedFiles: z.number().int().nonnegative().default(0),
    identified: z.number().int().nonnegative().default(0),
    needsReview: z.number().int().nonnegative().default(0),
    readyForApply: z.number().int().nonnegative().default(0),
    failed: z.number().int().nonnegative().default(0),
  }),
  warnings: z.array(z.string()).default([]),
  currentPath: z.string().nullable().default(null),
  reviewShardIds: z.array(z.string()).default([]),
  applyPlanId: z.string().optional(),
});
export type PaperLibraryScan = z.infer<typeof PaperLibraryScanSchema>;

export const PaperLibraryScanStartRequestSchema = z.object({
  project: ProjectSlugSchema,
  rootPath: z.string().trim().min(1),
  mode: z.literal("dry-run").default("dry-run"),
  templateId: z.string().min(1).optional(),
  idempotencyKey: z.string().min(1).optional(),
});
export type PaperLibraryScanStartRequest = z.infer<typeof PaperLibraryScanStartRequestSchema>;

export const PaperLibraryScanStartResponseSchema = z.object({
  ok: z.literal(true),
  scanId: z.string().min(1),
  status: PaperLibraryScanStatusSchema,
  counters: PaperLibraryScanSchema.shape.counters,
});
export type PaperLibraryScanStartResponse = z.infer<typeof PaperLibraryScanStartResponseSchema>;

export const RenameTemplateSchema = z.object({
  id: z.string().min(1),
  format: z.string().min(1),
  createdAt: IsoDateStringSchema,
  updatedAt: IsoDateStringSchema,
  version: z.number().int().positive().default(1),
});
export type RenameTemplate = z.infer<typeof RenameTemplateSchema>;

export const ApplyPlanStatusSchema = z.enum([
  "draft",
  "validated",
  "approved",
  "applying",
  "applied",
  "blocked",
  "canceled",
  "failed",
  "applied_with_repair_required",
]);
export type ApplyPlanStatus = z.infer<typeof ApplyPlanStatusSchema>;

export const ApplyOperationSchema = z.object({
  id: z.string().min(1),
  paperId: z.string().min(1),
  kind: z.enum(["move", "rename", "mkdir"]),
  source: PaperLibraryFileSnapshotSchema.optional(),
  destinationRelativePath: z.string().min(1),
  reason: z.string().min(1),
  confidence: z.number().min(0).max(1),
  conflictCodes: z.array(z.string()).default([]),
});
export type ApplyOperation = z.infer<typeof ApplyOperationSchema>;

export const ApplyOperationShardSchema = z.object({
  version: z.literal(PAPER_LIBRARY_STATE_VERSION),
  applyPlanId: z.string().min(1),
  operations: z.array(ApplyOperationSchema).default([]),
});
export type ApplyOperationShard = z.infer<typeof ApplyOperationShardSchema>;

export const ApplyPlanSchema = z.object({
  version: z.literal(PAPER_LIBRARY_STATE_VERSION),
  id: z.string().min(1),
  scanId: z.string().min(1),
  project: ProjectSlugSchema,
  status: ApplyPlanStatusSchema,
  rootPath: z.string().min(1),
  rootRealpath: z.string().min(1),
  templateFormat: z.string().min(1),
  operationCount: z.number().int().nonnegative(),
  conflictCount: z.number().int().nonnegative(),
  operationShardIds: z.array(z.string()).default([]),
  planDigest: z.string().optional(),
  approvalTokenHash: z.string().optional(),
  approvalExpiresAt: IsoDateStringSchema.optional(),
  approvedAt: IsoDateStringSchema.optional(),
  manifestId: z.string().optional(),
  createdAt: IsoDateStringSchema,
  updatedAt: IsoDateStringSchema,
});
export type ApplyPlan = z.infer<typeof ApplyPlanSchema>;

export const ApplyPlanCreateRequestSchema = z.object({
  project: ProjectSlugSchema,
  scanId: z.string().min(1),
  rootPath: z.string().trim().min(1).optional(),
  templateFormat: z.string().trim().min(1).default("{year} - {title}.pdf"),
});
export type ApplyPlanCreateRequest = z.infer<typeof ApplyPlanCreateRequestSchema>;

export const ApplyPlanApproveRequestSchema = z.object({
  project: ProjectSlugSchema,
  applyPlanId: z.string().min(1),
  userConfirmation: z.literal(true),
});
export type ApplyPlanApproveRequest = z.infer<typeof ApplyPlanApproveRequestSchema>;

export const ApplyStartRequestSchema = z.object({
  project: ProjectSlugSchema,
  applyPlanId: z.string().min(1),
  approvalToken: z.string().min(16),
  idempotencyKey: z.string().min(1).optional(),
});
export type ApplyStartRequest = z.infer<typeof ApplyStartRequestSchema>;

export const ApplyIdempotencyRecordSchema = z.object({
  version: z.literal(PAPER_LIBRARY_STATE_VERSION),
  project: ProjectSlugSchema,
  applyPlanId: z.string().min(1),
  manifestId: z.string().min(1),
  planDigest: z.string().min(1),
  createdAt: IsoDateStringSchema,
});
export type ApplyIdempotencyRecord = z.infer<typeof ApplyIdempotencyRecordSchema>;

export const ApplyManifestStatusSchema = z.enum([
  "applying",
  "applied",
  "failed",
  "applied_with_repair_required",
  "undoing",
  "undone",
]);
export type ApplyManifestStatus = z.infer<typeof ApplyManifestStatusSchema>;

export const ApplyManifestOperationStatusSchema = z.enum([
  "pending",
  "applied",
  "verified",
  "failed",
  "undone",
]);
export type ApplyManifestOperationStatus = z.infer<typeof ApplyManifestOperationStatusSchema>;

export const AppliedPaperMetadataSchema = z.object({
  pageSlug: z.string().min(1),
  title: z.string().min(1),
  identifiers: PaperIdentifierSchema.default({}),
  authors: z.array(z.string()).default([]),
  year: z.number().int().min(1000).max(3000).optional(),
  venue: z.string().optional(),
});
export type AppliedPaperMetadata = z.infer<typeof AppliedPaperMetadataSchema>;

export const ApplyManifestOperationSchema = z.object({
  operationId: z.string().min(1),
  paperId: z.string().min(1),
  sourceRelativePath: z.string().min(1),
  destinationRelativePath: z.string().min(1),
  status: ApplyManifestOperationStatusSchema,
  source: PaperLibraryFileSnapshotSchema.optional(),
  destinationSnapshot: PaperLibraryFileSnapshotSchema.optional(),
  appliedMetadata: AppliedPaperMetadataSchema.optional(),
  appliedAt: IsoDateStringSchema.optional(),
  undoneAt: IsoDateStringSchema.optional(),
  error: z.string().optional(),
});
export type ApplyManifestOperation = z.infer<typeof ApplyManifestOperationSchema>;

export const ApplyManifestOperationShardSchema = z.object({
  version: z.literal(PAPER_LIBRARY_STATE_VERSION),
  manifestId: z.string().min(1),
  operations: z.array(ApplyManifestOperationSchema).default([]),
});
export type ApplyManifestOperationShard = z.infer<typeof ApplyManifestOperationShardSchema>;

export const ApplyManifestSchema = z.object({
  version: z.literal(PAPER_LIBRARY_STATE_VERSION),
  id: z.string().min(1),
  project: ProjectSlugSchema,
  applyPlanId: z.string().min(1),
  status: ApplyManifestStatusSchema,
  rootRealpath: z.string().min(1),
  planDigest: z.string().min(1),
  operationCount: z.number().int().nonnegative(),
  appliedCount: z.number().int().nonnegative().default(0),
  failedCount: z.number().int().nonnegative().default(0),
  undoneCount: z.number().int().nonnegative().default(0),
  operationShardIds: z.array(z.string()).default([]),
  warnings: z.array(z.string()).default([]),
  createdAt: IsoDateStringSchema,
  updatedAt: IsoDateStringSchema,
});
export type ApplyManifest = z.infer<typeof ApplyManifestSchema>;

export const UndoStartRequestSchema = z.object({
  project: ProjectSlugSchema,
  manifestId: z.string().min(1),
});
export type UndoStartRequest = z.infer<typeof UndoStartRequestSchema>;

export const RepairManifestRequestSchema = z.object({
  project: ProjectSlugSchema,
  manifestId: z.string().min(1),
});
export type RepairManifestRequest = z.infer<typeof RepairManifestRequestSchema>;

export const CursorWindowSchema = z.object({
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(250).default(50),
});
export type CursorWindow = z.infer<typeof CursorWindowSchema>;

export const CursorWindowResponseSchema = z.object({
  nextCursor: z.string().optional(),
  totalCount: z.number().int().nonnegative(),
  filteredCount: z.number().int().nonnegative(),
});
export type CursorWindowResponse = z.infer<typeof CursorWindowResponseSchema>;

export const SourceRunStatusSchema = z.enum([
  "success",
  "negative",
  "metadata_unavailable",
  "rate_limited",
  "auth_unavailable",
  "paused",
]);
export type SourceRunStatus = z.infer<typeof SourceRunStatusSchema>;

export const PaperLibraryGraphNodeKindSchema = z.enum([
  "local_paper",
  "external_paper",
  "bridge_suggestion",
]);
export type PaperLibraryGraphNodeKind = z.infer<typeof PaperLibraryGraphNodeKindSchema>;

export const PaperLibraryGraphNodeSchema = z.object({
  id: z.string().min(1),
  kind: PaperLibraryGraphNodeKindSchema,
  paperIds: z.array(z.string().min(1)).default([]),
  title: z.string().optional(),
  authors: z.array(z.string()).default([]),
  year: z.number().int().min(1000).max(3000).optional(),
  venue: z.string().optional(),
  identifiers: PaperIdentifierSchema.default({}),
  local: z.boolean(),
  suggestion: z.boolean().default(false),
  sources: z.array(PaperMetadataSourceSchema).default([]),
  evidence: z.array(z.string()).default([]),
  referenceCount: z.number().int().nonnegative().optional(),
  citationCount: z.number().int().nonnegative().optional(),
});
export type PaperLibraryGraphNode = z.infer<typeof PaperLibraryGraphNodeSchema>;

export const PaperLibraryGraphEdgeKindSchema = z.enum([
  "references",
  "cited_by",
  "same_identity",
  "bridge_suggestion",
]);
export type PaperLibraryGraphEdgeKind = z.infer<typeof PaperLibraryGraphEdgeKindSchema>;

export const PaperLibraryGraphEdgeSchema = z.object({
  id: z.string().min(1),
  sourceNodeId: z.string().min(1),
  targetNodeId: z.string().min(1),
  kind: PaperLibraryGraphEdgeKindSchema,
  source: PaperMetadataSourceSchema,
  evidence: z.array(z.string()).default([]),
});
export type PaperLibraryGraphEdge = z.infer<typeof PaperLibraryGraphEdgeSchema>;

export const PaperLibraryGraphSourceRunSchema = z.object({
  id: z.string().min(1),
  source: PaperMetadataSourceSchema,
  status: SourceRunStatusSchema,
  paperId: z.string().min(1).optional(),
  identifier: z.string().min(1).optional(),
  attempts: z.number().int().nonnegative().default(0),
  fetchedCount: z.number().int().nonnegative().default(0),
  cacheHits: z.number().int().nonnegative().default(0),
  retryAfter: IsoDateStringSchema.optional(),
  errorCode: PaperLibraryErrorCodeSchema.optional(),
  message: z.string().optional(),
  startedAt: IsoDateStringSchema,
  completedAt: IsoDateStringSchema,
});
export type PaperLibraryGraphSourceRun = z.infer<typeof PaperLibraryGraphSourceRunSchema>;

export const PaperLibraryGraphSchema = z.object({
  version: z.literal(PAPER_LIBRARY_STATE_VERSION),
  project: ProjectSlugSchema,
  scanId: z.string().min(1),
  createdAt: IsoDateStringSchema,
  updatedAt: IsoDateStringSchema,
  nodes: z.array(PaperLibraryGraphNodeSchema).default([]),
  edges: z.array(PaperLibraryGraphEdgeSchema).default([]),
  sourceRuns: z.array(PaperLibraryGraphSourceRunSchema).default([]),
  warnings: z.array(z.string()).default([]),
});
export type PaperLibraryGraph = z.infer<typeof PaperLibraryGraphSchema>;

export const PaperLibraryGraphResponseSchema = CursorWindowResponseSchema.extend({
  nodes: z.array(PaperLibraryGraphNodeSchema),
  edges: z.array(PaperLibraryGraphEdgeSchema),
  loadedNodeCount: z.number().int().nonnegative().optional(),
  totalEdgeCount: z.number().int().nonnegative().optional(),
  sourceRuns: z.array(PaperLibraryGraphSourceRunSchema),
  warnings: z.array(z.string()).default([]),
});
export type PaperLibraryGraphResponse = z.infer<typeof PaperLibraryGraphResponseSchema>;

export const PaperLibraryClusterModelStatusSchema = z.enum([
  "ready",
  "model_unavailable",
  "resource_budget_exhausted",
]);
export type PaperLibraryClusterModelStatus = z.infer<typeof PaperLibraryClusterModelStatusSchema>;

export const PaperLibraryEmbeddingSourceSchema = z.enum([
  "gbrain",
  "local_hash",
]);
export type PaperLibraryEmbeddingSource = z.infer<typeof PaperLibraryEmbeddingSourceSchema>;

export const PaperLibraryClusterModelSchema = z.object({
  id: z.string().min(1),
  provider: PaperLibraryEmbeddingSourceSchema,
  dimensions: z.number().int().positive(),
  chunking: z.string().min(1),
  status: PaperLibraryClusterModelStatusSchema,
  cacheHits: z.number().int().nonnegative().default(0),
  generatedCount: z.number().int().nonnegative().default(0),
  reusedGbrainCount: z.number().int().nonnegative().default(0),
  fallbackCount: z.number().int().nonnegative().default(0),
  remainingBudget: z.number().int().nonnegative().optional(),
});
export type PaperLibraryClusterModel = z.infer<typeof PaperLibraryClusterModelSchema>;

export const PaperLibraryEmbeddingCacheEntrySchema = z.object({
  key: z.string().min(1),
  paperId: z.string().min(1),
  textHash: z.string().min(1),
  modelId: z.string().min(1),
  provider: PaperLibraryEmbeddingSourceSchema,
  dimensions: z.number().int().positive(),
  chunking: z.string().min(1),
  embedding: z.array(z.number()),
  sourcePageSlug: z.string().min(1).optional(),
  updatedAt: IsoDateStringSchema,
});
export type PaperLibraryEmbeddingCacheEntry = z.infer<typeof PaperLibraryEmbeddingCacheEntrySchema>;

export const PaperLibraryEmbeddingRunSchema = z.object({
  scanId: z.string().min(1),
  status: PaperLibraryClusterModelStatusSchema,
  cursor: z.number().int().nonnegative().default(0),
  totalCount: z.number().int().nonnegative().default(0),
  processedCount: z.number().int().nonnegative().default(0),
  batchSize: z.number().int().positive().default(25),
  updatedAt: IsoDateStringSchema,
  cancelRequestedAt: IsoDateStringSchema.optional(),
  model: PaperLibraryClusterModelSchema,
});
export type PaperLibraryEmbeddingRun = z.infer<typeof PaperLibraryEmbeddingRunSchema>;

export const PaperLibraryEmbeddingCacheStoreSchema = z.object({
  version: z.literal(PAPER_LIBRARY_STATE_VERSION),
  entries: z.record(z.string(), PaperLibraryEmbeddingCacheEntrySchema).default({}),
  runs: z.record(z.string(), PaperLibraryEmbeddingRunSchema).default({}),
});
export type PaperLibraryEmbeddingCacheStore = z.infer<typeof PaperLibraryEmbeddingCacheStoreSchema>;

export const SemanticClusterMemberSchema = z.object({
  itemId: z.string().min(1),
  paperId: z.string().min(1),
  title: z.string().optional(),
  relativePath: z.string().optional(),
  confidence: z.number().min(0).max(1).default(0),
  score: z.number().min(0).max(1).default(0),
});
export type SemanticClusterMember = z.infer<typeof SemanticClusterMemberSchema>;

export const SemanticClusterSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  folderName: z.string().min(1),
  keywords: z.array(z.string().min(1)).default([]),
  memberCount: z.number().int().nonnegative(),
  confidence: z.number().min(0).max(1),
  representativePaperId: z.string().min(1).optional(),
  members: z.array(SemanticClusterMemberSchema).default([]),
});
export type SemanticCluster = z.infer<typeof SemanticClusterSchema>;

export const PaperLibraryClustersSchema = z.object({
  version: z.literal(PAPER_LIBRARY_STATE_VERSION),
  project: ProjectSlugSchema,
  scanId: z.string().min(1),
  createdAt: IsoDateStringSchema,
  updatedAt: IsoDateStringSchema,
  model: PaperLibraryClusterModelSchema,
  clusters: z.array(SemanticClusterSchema).default([]),
  unclusteredPaperIds: z.array(z.string().min(1)).default([]),
  warnings: z.array(z.string()).default([]),
});
export type PaperLibraryClusters = z.infer<typeof PaperLibraryClustersSchema>;

export const PaperLibraryClustersResponseSchema = CursorWindowResponseSchema.extend({
  clusters: z.array(SemanticClusterSchema),
  unclusteredCount: z.number().int().nonnegative(),
  model: PaperLibraryClusterModelSchema,
  warnings: z.array(z.string()).default([]),
});
export type PaperLibraryClustersResponse = z.infer<typeof PaperLibraryClustersResponseSchema>;

export const GapSuggestionStateSchema = z.enum([
  "open",
  "watching",
  "ignored",
  "saved",
  "imported",
]);
export type GapSuggestionState = z.infer<typeof GapSuggestionStateSchema>;

export const GapSuggestionReasonCodeSchema = z.enum([
  "citation_frequency",
  "bridge_position",
  "cluster_gap",
  "recent_connected",
  "source_disagreement",
]);
export type GapSuggestionReasonCode = z.infer<typeof GapSuggestionReasonCodeSchema>;

export const GapSuggestionScoreSchema = z.object({
  overall: z.number().min(0).max(1),
  citationFrequency: z.number().min(0).max(1).default(0),
  bridgePosition: z.number().min(0).max(1).default(0),
  clusterGap: z.number().min(0).max(1).default(0),
  recentConnected: z.number().min(0).max(1).default(0),
  disagreementPenalty: z.number().min(0).max(1).default(0),
});
export type GapSuggestionScore = z.infer<typeof GapSuggestionScoreSchema>;

export const GapSuggestionSchema = z.object({
  id: z.string().min(1),
  scanId: z.string().min(1),
  nodeId: z.string().min(1),
  title: z.string().min(1),
  authors: z.array(z.string()).default([]),
  year: z.number().int().min(1000).max(3000).optional(),
  venue: z.string().optional(),
  identifiers: PaperIdentifierSchema.default({}),
  sources: z.array(PaperMetadataSourceSchema).default([]),
  state: GapSuggestionStateSchema.default("open"),
  reasonCodes: z.array(GapSuggestionReasonCodeSchema).default([]),
  score: GapSuggestionScoreSchema,
  localConnectionCount: z.number().int().nonnegative().default(0),
  evidencePaperIds: z.array(z.string().min(1)).default([]),
  evidenceClusterIds: z.array(z.string().min(1)).default([]),
  evidenceNodeIds: z.array(z.string().min(1)).default([]),
  createdAt: IsoDateStringSchema,
  updatedAt: IsoDateStringSchema,
});
export type GapSuggestion = z.infer<typeof GapSuggestionSchema>;

export const PaperLibraryGapStateCountsSchema = z.object({
  open: z.number().int().nonnegative().default(0),
  watching: z.number().int().nonnegative().default(0),
  ignored: z.number().int().nonnegative().default(0),
  saved: z.number().int().nonnegative().default(0),
  imported: z.number().int().nonnegative().default(0),
});
export type PaperLibraryGapStateCounts = z.infer<typeof PaperLibraryGapStateCountsSchema>;

export const PaperLibraryGapsSchema = z.object({
  version: z.literal(PAPER_LIBRARY_STATE_VERSION),
  project: ProjectSlugSchema,
  scanId: z.string().min(1),
  createdAt: IsoDateStringSchema,
  updatedAt: IsoDateStringSchema,
  suggestions: z.array(GapSuggestionSchema).default([]),
  warnings: z.array(z.string()).default([]),
});
export type PaperLibraryGaps = z.infer<typeof PaperLibraryGapsSchema>;

export const PaperLibraryGapsResponseSchema = CursorWindowResponseSchema.extend({
  suggestions: z.array(GapSuggestionSchema),
  stateCounts: PaperLibraryGapStateCountsSchema,
  warnings: z.array(z.string()).default([]),
});
export type PaperLibraryGapsResponse = z.infer<typeof PaperLibraryGapsResponseSchema>;

export const PaperLibraryGapActionRequestSchema = z.object({
  project: ProjectSlugSchema,
  scanId: z.string().min(1),
  suggestionId: z.string().min(1),
  action: z.enum(["watch", "ignore", "save", "import", "reopen"]),
});
export type PaperLibraryGapActionRequest = z.infer<typeof PaperLibraryGapActionRequestSchema>;

export const LibraryCitationGraphNodeSchema = PaperLibraryGraphNodeSchema.extend({
  gbrainSlug: z.string().min(1).optional(),
  localStatus: z.enum(["local_pdf", "gbrain_page", "external", "suggested"]),
});
export type LibraryCitationGraphNode = z.infer<typeof LibraryCitationGraphNodeSchema>;

export const LibraryCitationGraphEdgeSchema = PaperLibraryGraphEdgeSchema.extend({
  evidence: z.array(z.string().min(1)).min(1),
  provenance: z.array(z.string().min(1)).min(1),
  agentDerived: z.boolean().default(false),
});
export type LibraryCitationGraphEdge = z.infer<typeof LibraryCitationGraphEdgeSchema>;

export const LibraryCitationGraphSourceSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["paper_library_graph", "paper_library_gaps", "gbrain_pages", "agent"]),
  generatedAt: IsoDateStringSchema.optional(),
  digest: z.string().min(1).optional(),
  itemCount: z.number().int().nonnegative().optional(),
});
export type LibraryCitationGraphSource = z.infer<typeof LibraryCitationGraphSourceSchema>;

export const PaperSuggestionDownloadStatusSchema = z.enum([
  "open_pdf_found",
  "metadata_only",
  "unknown",
  "already_local",
]);
export type PaperSuggestionDownloadStatus = z.infer<typeof PaperSuggestionDownloadStatusSchema>;

export const PaperSuggestionRecommendedActionSchema = z.enum([
  "download_now",
  "save_for_later",
  "cite_only",
  "ignore",
]);
export type PaperSuggestionRecommendedAction = z.infer<typeof PaperSuggestionRecommendedActionSchema>;

export const PaperSuggestionSchema = z.object({
  title: z.string().min(1),
  identifiers: PaperIdentifierSchema.default({}),
  sourceUrls: z.array(z.string().url()).default([]),
  reasonForThisQuestion: z.string().min(1),
  graphEvidence: z.array(z.string().min(1)).default([]),
  localEvidencePaperIds: z.array(z.string().min(1)).default([]),
  downloadStatus: PaperSuggestionDownloadStatusSchema,
  recommendedAction: PaperSuggestionRecommendedActionSchema,
  confidence: z.number().min(0).max(1),
});
export type PaperSuggestion = z.infer<typeof PaperSuggestionSchema>;

export const LibraryCitationGraphSchema = z.object({
  project: ProjectSlugSchema,
  scanId: z.string().min(1).optional(),
  question: z.string().min(1).optional(),
  generatedAt: IsoDateStringSchema,
  nodes: z.array(LibraryCitationGraphNodeSchema).default([]),
  edges: z.array(LibraryCitationGraphEdgeSchema).default([]),
  sources: z.array(LibraryCitationGraphSourceSchema).default([]),
  suggestions: z.array(PaperSuggestionSchema).default([]),
  warnings: z.array(z.string()).default([]),
});
export type LibraryCitationGraph = z.infer<typeof LibraryCitationGraphSchema>;

export const PaperAcquisitionToolSchema = z.enum([
  "openhands",
  "openclaw",
  "claude_code",
  "codex",
  "openai",
  "anthropic",
  "gemini",
  "arxiv",
  "semantic_scholar",
  "openalex",
  "manual",
]);
export type PaperAcquisitionTool = z.infer<typeof PaperAcquisitionToolSchema>;

export const PaperAcquisitionConsentScopeSchema = z.enum([
  "per_session",
  "single_paper",
  "manual",
]);
export type PaperAcquisitionConsentScope = z.infer<typeof PaperAcquisitionConsentScopeSchema>;

export const PaperAcquisitionRecordStatusSchema = z.enum([
  "downloaded",
  "metadata_persisted",
  "already_local",
  "skipped",
  "failed",
]);
export type PaperAcquisitionRecordStatus = z.infer<typeof PaperAcquisitionRecordStatusSchema>;

export const PaperAcquisitionRecordSchema = z.object({
  project: ProjectSlugSchema,
  originatingQuestion: z.string().min(1).optional(),
  suggestion: PaperSuggestionSchema,
  tool: PaperAcquisitionToolSchema,
  sourceUrl: z.string().url().optional(),
  downloadedPath: z.string().min(1).optional(),
  gbrainSlug: z.string().min(1).optional(),
  checksum: z.string().min(1).optional(),
  consentScope: PaperAcquisitionConsentScopeSchema.default("per_session"),
  status: PaperAcquisitionRecordStatusSchema,
  createdAt: IsoDateStringSchema,
  error: z.string().min(1).optional(),
}).superRefine((record, ctx) => {
  if (record.status === "downloaded") {
    if (!record.sourceUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sourceUrl"],
        message: "Downloaded paper records require a source URL.",
      });
    }
    if (!record.downloadedPath) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["downloadedPath"],
        message: "Downloaded paper records require a local file path.",
      });
    }
  }

  if (record.status === "metadata_persisted" && !record.sourceUrl) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["sourceUrl"],
      message: "Metadata-only paper records require a source URL.",
    });
  }
});
export type PaperAcquisitionRecord = z.infer<typeof PaperAcquisitionRecordSchema>;

export const PaperLibraryAcquisitionLocationSourceSchema = z.enum([
  "arxiv",
  "doi",
  "openalex",
  "pubmed",
  "semantic_scholar",
]);
export type PaperLibraryAcquisitionLocationSource = z.infer<typeof PaperLibraryAcquisitionLocationSourceSchema>;

export const PaperLibraryAcquisitionLocationKindSchema = z.enum([
  "pdf",
  "landing",
  "metadata",
]);
export type PaperLibraryAcquisitionLocationKind = z.infer<typeof PaperLibraryAcquisitionLocationKindSchema>;

export const PaperLibraryAcquisitionLocationSchema = z.object({
  source: PaperLibraryAcquisitionLocationSourceSchema,
  kind: PaperLibraryAcquisitionLocationKindSchema,
  identifier: z.string().min(1).optional(),
  url: z.string().url().optional(),
  openAccess: z.boolean().default(false),
  canDownloadPdf: z.boolean().default(false),
  confidence: z.number().min(0).max(1),
});
export type PaperLibraryAcquisitionLocation = z.infer<typeof PaperLibraryAcquisitionLocationSchema>;

export const PaperLibraryAcquisitionModeSchema = z.enum([
  "download_pdf",
  "metadata_only",
  "watch",
]);
export type PaperLibraryAcquisitionMode = z.infer<typeof PaperLibraryAcquisitionModeSchema>;

export const PaperLibraryAcquisitionItemStatusSchema = z.enum([
  "planned",
  "acquired",
  "metadata_only",
  "watching",
  "failed",
  "skipped",
]);
export type PaperLibraryAcquisitionItemStatus = z.infer<typeof PaperLibraryAcquisitionItemStatusSchema>;

export const PaperLibraryAcquisitionItemSchema = z.object({
  id: z.string().min(1),
  suggestionId: z.string().min(1),
  scanId: z.string().min(1),
  nodeId: z.string().min(1),
  title: z.string().min(1),
  authors: z.array(z.string()).default([]),
  year: z.number().int().min(1000).max(3000).optional(),
  venue: z.string().optional(),
  identifiers: PaperIdentifierSchema.default({}),
  sources: z.array(PaperMetadataSourceSchema).default([]),
  reasonCodes: z.array(GapSuggestionReasonCodeSchema).default([]),
  score: GapSuggestionScoreSchema,
  localConnectionCount: z.number().int().nonnegative().default(0),
  evidencePaperIds: z.array(z.string().min(1)).default([]),
  evidenceClusterIds: z.array(z.string().min(1)).default([]),
  evidenceNodeIds: z.array(z.string().min(1)).default([]),
  rationale: z.string().min(1),
  locations: z.array(PaperLibraryAcquisitionLocationSchema).default([]),
  selectedLocation: PaperLibraryAcquisitionLocationSchema.optional(),
  mode: PaperLibraryAcquisitionModeSchema,
  status: PaperLibraryAcquisitionItemStatusSchema.default("planned"),
  originatingQuestion: z.string().min(1).optional(),
  sourceUrl: z.string().url().optional(),
  localPath: z.string().min(1).optional(),
  gbrainSlug: z.string().min(1).optional(),
  checksum: z.string().min(1).optional(),
  tool: PaperAcquisitionToolSchema.optional(),
  consentScope: PaperAcquisitionConsentScopeSchema.optional(),
  error: z.string().optional(),
  updatedAt: IsoDateStringSchema,
});
export type PaperLibraryAcquisitionItem = z.infer<typeof PaperLibraryAcquisitionItemSchema>;

export const PaperLibraryAcquisitionPlanStatusSchema = z.enum([
  "planned",
  "running",
  "completed",
  "partial",
  "failed",
]);
export type PaperLibraryAcquisitionPlanStatus = z.infer<typeof PaperLibraryAcquisitionPlanStatusSchema>;

export const PaperLibraryAcquisitionPlanSchema = z.object({
  version: z.literal(PAPER_LIBRARY_STATE_VERSION),
  id: z.string().min(1),
  project: ProjectSlugSchema,
  scanId: z.string().min(1),
  status: PaperLibraryAcquisitionPlanStatusSchema,
  itemCount: z.number().int().nonnegative(),
  downloadableCount: z.number().int().nonnegative(),
  acquiredCount: z.number().int().nonnegative().default(0),
  metadataOnlyCount: z.number().int().nonnegative().default(0),
  watchCount: z.number().int().nonnegative().default(0),
  failedCount: z.number().int().nonnegative().default(0),
  items: z.array(PaperLibraryAcquisitionItemSchema).default([]),
  warnings: z.array(z.string()).default([]),
  createdAt: IsoDateStringSchema,
  updatedAt: IsoDateStringSchema,
});
export type PaperLibraryAcquisitionPlan = z.infer<typeof PaperLibraryAcquisitionPlanSchema>;

export const PaperLibraryAcquisitionCreateRequestSchema = z.object({
  action: z.literal("create"),
  project: ProjectSlugSchema,
  scanId: z.string().min(1),
  suggestionIds: z.array(z.string().min(1)).max(100).optional(),
  limit: z.number().int().min(1).max(100).default(10),
  includeStates: z.array(GapSuggestionStateSchema).default(["open", "watching", "saved"]),
  originatingQuestion: z.string().trim().min(1).optional(),
});
export type PaperLibraryAcquisitionCreateRequest = z.infer<typeof PaperLibraryAcquisitionCreateRequestSchema>;

export const PaperLibraryAcquisitionExecuteRequestSchema = z.object({
  action: z.literal("execute"),
  project: ProjectSlugSchema,
  acquisitionPlanId: z.string().min(1),
  userConfirmation: z.literal(true),
});
export type PaperLibraryAcquisitionExecuteRequest = z.infer<typeof PaperLibraryAcquisitionExecuteRequestSchema>;

export const PaperLibraryAcquisitionRequestSchema = z.discriminatedUnion("action", [
  PaperLibraryAcquisitionCreateRequestSchema,
  PaperLibraryAcquisitionExecuteRequestSchema,
]);
export type PaperLibraryAcquisitionRequest = z.infer<typeof PaperLibraryAcquisitionRequestSchema>;

export const RepairableStateSchema = z.object({
  ok: z.literal(false),
  code: z.enum(["missing", "malformed", "unsupported_version"]),
  message: z.string(),
  path: z.string().optional(),
  issues: z.array(z.string()).default([]),
});
export type RepairableState = z.infer<typeof RepairableStateSchema>;

export type PaperLibraryResult<T> = { ok: true; data: T } | PaperLibraryErrorEnvelope;

export const EnrichmentCacheEntrySchema = z.object({
  key: z.string().min(1),
  source: PaperMetadataSourceSchema,
  status: SourceRunStatusSchema,
  value: z.unknown().optional(),
  errorCode: PaperLibraryErrorCodeSchema.optional(),
  attempts: z.number().int().nonnegative().default(0),
  fetchedAt: IsoDateStringSchema,
  expiresAt: IsoDateStringSchema.optional(),
  retryAfter: IsoDateStringSchema.optional(),
});
export type EnrichmentCacheEntry = z.infer<typeof EnrichmentCacheEntrySchema>;

export const EnrichmentSourceHealthSchema = z.object({
  source: PaperMetadataSourceSchema,
  status: z.enum(["healthy", "degraded", "paused"]),
  consecutiveFailures: z.number().int().nonnegative().default(0),
  retryAfter: IsoDateStringSchema.optional(),
  remainingBudget: z.number().nonnegative().optional(),
  updatedAt: IsoDateStringSchema,
});
export type EnrichmentSourceHealth = z.infer<typeof EnrichmentSourceHealthSchema>;

export const EnrichmentCacheStoreSchema = z.object({
  version: z.literal(PAPER_LIBRARY_STATE_VERSION),
  entries: z.record(z.string(), EnrichmentCacheEntrySchema).default({}),
  sourceHealth: z.record(z.string(), EnrichmentSourceHealthSchema).default({}),
});
export type EnrichmentCacheStore = z.infer<typeof EnrichmentCacheStoreSchema>;
