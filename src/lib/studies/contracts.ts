import { z } from "zod";

export const StudyIdSchema = z.string().regex(/^study_[a-z0-9][a-z0-9_-]*$/);
export type StudyId = z.infer<typeof StudyIdSchema>;

export const StudySlugSchema = z.string().regex(/^[a-z0-9-]+$/);
export type StudySlug = z.infer<typeof StudySlugSchema>;

export const ThreadIdSchema = z.string().regex(/^thread_[a-z0-9][a-z0-9_-]*$/);
export type ThreadId = z.infer<typeof ThreadIdSchema>;

export const RunIdSchema = z.string().regex(/^run_[a-z0-9][a-z0-9_-]*$/);
export type RunId = z.infer<typeof RunIdSchema>;

export const SourceIdSchema = z.string().regex(/^source_[a-z0-9][a-z0-9_-]*$/);
export type SourceId = z.infer<typeof SourceIdSchema>;

export const WorkspaceIdSchema = z.string().regex(/^workspace_[a-z0-9][a-z0-9_-]*$/);
export type WorkspaceId = z.infer<typeof WorkspaceIdSchema>;

export const AgentSessionIdSchema = z.string().regex(/^agent_session_[a-z0-9][a-z0-9_-]*$/);
export type AgentSessionId = z.infer<typeof AgentSessionIdSchema>;

export const IsoDateStringSchema = z.string().datetime({ offset: true });

export const PrivacyPolicySchema = z.enum(["local-first", "local-only", "cloud-ok", "execution-ok"]);
export type PrivacyPolicy = z.infer<typeof PrivacyPolicySchema>;

export const StudyStatusSchema = z.enum(["active", "paused", "archived"]);
export type StudyStatus = z.infer<typeof StudyStatusSchema>;

export const SourceKindSchema = z.enum([
  "repo",
  "folder",
  "paper-library",
  "notebook-set",
  "dataset",
  "md-workflow",
]);
export type SourceKind = z.infer<typeof SourceKindSchema>;

export const SourceStateSchema = z.object({
  type: z.literal("source"),
  id: SourceIdSchema,
  slug: StudySlugSchema,
  title: z.string().trim().min(1),
  kind: SourceKindSchema,
  uri: z.string().trim().min(1),
  syncStrategy: z.string().trim().min(1),
  classifier: z.object({
    recognizedKinds: z.array(z.string().trim().min(1)).default([]),
    languageFallback: z.string().trim().min(1).optional(),
  }).default({ recognizedKinds: [] }),
  indexing: z.object({
    gbrainVersion: z.string().trim().min(1).optional(),
    schemaVersion: z.number().int().nonnegative().optional(),
    chunkerVersion: z.string().trim().min(1).optional(),
    lastSyncAt: IsoDateStringSchema.optional(),
    lastRewalkAt: IsoDateStringSchema.optional(),
    supportsStructuralGraph: z.boolean().default(false),
  }).default({ supportsStructuralGraph: false }),
  createdAt: IsoDateStringSchema,
  updatedAt: IsoDateStringSchema,
});
export type SourceState = z.infer<typeof SourceStateSchema>;

export const StudyKnowledgeSchema = z.object({
  type: z.literal("study"),
  id: StudyIdSchema,
  slug: StudySlugSchema,
  title: z.string().trim().min(1),
  status: StudyStatusSchema.default("active"),
  questions: z.array(z.string().trim().min(1)).default([]),
  hypotheses: z.array(z.string().trim().min(1)).default([]),
  linkedSourceIds: z.array(SourceIdSchema).default([]),
  linkedObjectIds: z.array(z.string().trim().min(1)).default([]),
  linkedArtifactIds: z.array(z.string().trim().min(1)).default([]),
  pinnedPageIds: z.array(z.string().trim().min(1)).default([]),
  deliverables: z.array(z.string().trim().min(1)).default([]),
  createdAt: IsoDateStringSchema,
  updatedAt: IsoDateStringSchema,
});
export type StudyKnowledge = z.infer<typeof StudyKnowledgeSchema>;

export const StudyStateSchema = z.object({
  version: z.literal(1),
  studyId: StudyIdSchema,
  legacyProjectSlug: StudySlugSchema.optional(),
  privacyPolicy: PrivacyPolicySchema.default("local-first"),
  defaultAgentPolicy: z.object({
    hostPreference: z.array(z.string().trim().min(1)).default([]),
    hostedModelAllowed: z.boolean().default(false),
  }).default({ hostPreference: [], hostedModelAllowed: false }),
  activeThreadIds: z.array(ThreadIdSchema).default([]),
  lastOpenedThreadId: ThreadIdSchema.optional(),
  workspaceId: WorkspaceIdSchema.optional(),
  ui: z.record(z.string(), z.unknown()).default({}),
  updatedAt: IsoDateStringSchema.optional(),
});
export type StudyState = z.infer<typeof StudyStateSchema>;

export const ThreadStateSchema = z.object({
  version: z.literal(1),
  id: ThreadIdSchema,
  studyIds: z.array(StudyIdSchema).default([]),
  title: z.string().trim().min(1),
  status: z.enum(["active", "paused", "archived"]).default("active"),
  createdAt: IsoDateStringSchema,
  updatedAt: IsoDateStringSchema,
  messageLogPath: z.string().trim().min(1),
  runIds: z.array(RunIdSchema).default([]),
  summaryPageId: z.string().trim().min(1).optional(),
  decisionPageIds: z.array(z.string().trim().min(1)).default([]),
});
export type ThreadState = z.infer<typeof ThreadStateSchema>;

export const RuntimeRetrievalSchema = z.object({
  engine: z.string().trim().min(1),
  query: z.string().trim().min(1),
  nearSymbol: z.string().trim().min(1).optional(),
  walkDepth: z.number().int().nonnegative().optional(),
  sourceIds: z.array(SourceIdSchema).default([]),
  pageIds: z.array(z.string().trim().min(1)).default([]),
  chunkIds: z.array(z.string().trim().min(1)).default([]),
  structuralEdges: z.array(z.string().trim().min(1)).default([]),
});
export type RuntimeRetrieval = z.infer<typeof RuntimeRetrievalSchema>;

export const RunStateSchema = z.object({
  version: z.literal(1),
  id: RunIdSchema,
  threadId: ThreadIdSchema.optional(),
  studyIds: z.array(StudyIdSchema).default([]),
  host: z.string().trim().min(1),
  agentSessionId: AgentSessionIdSchema.optional(),
  launchBundlePath: z.string().trim().min(1),
  workspaceId: WorkspaceIdSchema.optional(),
  cwd: z.string().trim().min(1),
  contextSnapshot: z.object({
    knowledgePageIds: z.array(z.string().trim().min(1)).default([]),
    sourceIds: z.array(SourceIdSchema).default([]),
    chunkIds: z.array(z.string().trim().min(1)).default([]),
    policyId: z.string().trim().min(1).optional(),
    retrievals: z.array(RuntimeRetrievalSchema).default([]),
  }).default({
    knowledgePageIds: [],
    sourceIds: [],
    chunkIds: [],
    retrievals: [],
  }),
  status: z.enum(["queued", "running", "completed", "failed", "cancelled"]),
  startedAt: IsoDateStringSchema,
  endedAt: IsoDateStringSchema.optional(),
  outputs: z.array(z.string().trim().min(1)).default([]),
  writebacks: z.array(z.string().trim().min(1)).default([]),
  errors: z.array(z.object({
    code: z.string().trim().min(1),
    message: z.string().trim().min(1),
  })).default([]),
});
export type RunState = z.infer<typeof RunStateSchema>;

export const LaunchAuditStateSchema = z.object({
  version: z.literal(1),
  runId: RunIdSchema,
  host: z.string().trim().min(1),
  launchBundlePath: z.string().trim().min(1),
  cwd: z.string().trim().min(1),
  redactedEnv: z.record(z.string(), z.string()).default({}),
  promptHash: z.string().trim().min(1).optional(),
  mcpConfigHash: z.string().trim().min(1).optional(),
  tokenMaterial: z.array(z.object({
    label: z.string().trim().min(1),
    present: z.boolean(),
    redacted: z.literal(true),
  })).default([]),
  createdAt: IsoDateStringSchema,
  expiresAt: IsoDateStringSchema.optional(),
});
export type LaunchAuditState = z.infer<typeof LaunchAuditStateSchema>;

export const LegacyProjectParseResultSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    legacyProjectSlug: StudySlugSchema,
  }),
  z.object({
    ok: z.literal(false),
    reason: z.enum(["missing", "invalid"]),
    input: z.string().optional(),
  }),
]);
export type LegacyProjectParseResult = z.infer<typeof LegacyProjectParseResultSchema>;

export const LegacyStudyAliasSchema = z.object({
  legacyProjectSlug: StudySlugSchema,
  studyId: StudyIdSchema,
  studySlug: StudySlugSchema.optional(),
});
export type LegacyStudyAlias = z.infer<typeof LegacyStudyAliasSchema>;

export const LegacyToStudyResolveResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("resolved"),
    source: z.enum(["study-id", "study-slug", "legacy-alias", "legacy-slug-fallback"]),
    studyId: StudyIdSchema,
    studySlug: StudySlugSchema,
    legacyProjectSlug: StudySlugSchema.optional(),
  }),
  z.object({
    status: z.literal("not-found"),
    source: z.enum(["study-id", "study-slug", "legacy-project"]),
    lookup: z.string().trim().min(1),
  }),
  z.object({
    status: z.literal("invalid"),
    source: z.enum(["study-id", "study-slug", "legacy-project"]),
    reason: z.string().trim().min(1),
  }),
]);
export type LegacyToStudyResolveResult = z.infer<typeof LegacyToStudyResolveResultSchema>;
