/**
 * Second Brain — Shared Types
 *
 * Pure types for the brain engine. No framework imports.
 * Used by: src/brain/*, src/mcp/*, src/app/api/brain/*
 */

// ── Content Types ──────────────────────────────────────

export type ContentType =
  | "paper"
  | "dataset"
  | "code"
  | "note"
  | "experiment"
  | "observation"
  | "hypothesis"
  | "data"
  | "web"
  | "voice"
  | "concept"
  | "topic"
  | "survey"
  | "method"
  | "project"
  | "decision"
  | "task"
  | "artifact"
  | "original_synthesis"
  | "research_packet"
  | "overnight_journal"
  | "job_run"
  | "frontier_item"
  | "person";

export type ResearchContentType =
  | "concept"
  | "topic"
  | "survey"
  | "method"
  | "hypothesis"
  | "original_synthesis"
  | "research_packet"
  | "overnight_journal"
  | "job_run"
  | "paper"
  | "project";

export type PARACategory = "projects" | "areas" | "resources" | "archives";

export type PrivacyMode = "local-only" | "cloud-ok" | "execution-ok";

export type Confidence = "low" | "medium" | "high";

export type ProjectStatus = "active" | "paused" | "archived";

export type TaskStatus = "open" | "scheduled" | "done" | "dropped";

export type ArtifactStatus = "queued" | "running" | "completed" | "failed";

export type FrontierStatus = "staged" | "promoted" | "dismissed";

export type CaptureChannel = "telegram" | "web" | "openclaw";

export type CaptureKind = "note" | "observation" | "decision" | "hypothesis" | "task";

export interface SourceRef {
  kind: "import" | "capture" | "external" | "artifact" | "conversation";
  ref: string;
  hash?: string;
}

export interface SharedFrontmatterFields {
  title?: string;
  project?: string;
  source_refs?: SourceRef[];
  confidence?: Confidence;
  privacy?: PrivacyMode;
  status?: string;
  derived_from?: string[];
}

export type HypothesisStatus =
  | "active"
  | "supported"
  | "weakened"
  | "refuted"
  | "conflict";

export type ExperimentStatus =
  | "planning"
  | "running"
  | "completed"
  | "failed";

// ── Frontmatter Schemas ────────────────────────────────

export interface BaseFrontmatter extends SharedFrontmatterFields {
  date: string; // YYYY-MM-DD
  type: ContentType;
  para: PARACategory;
  tags: string[];
}

export interface ProjectFrontmatter extends BaseFrontmatter {
  type: "project";
}

export interface DecisionFrontmatter extends BaseFrontmatter {
  type: "decision";
}

export interface TaskFrontmatter extends BaseFrontmatter {
  type: "task";
}

export interface ArtifactFrontmatter extends BaseFrontmatter {
  type: "artifact";
}

export interface FrontierItemFrontmatter extends BaseFrontmatter {
  type: "frontier_item";
}

export interface PersonFrontmatter extends BaseFrontmatter {
  type: "person";
  name: string;
  affiliation?: string;
  role?: string;
  hIndex?: number;
  keyPapers?: string[];
  links?: Record<string, string>;
}

export interface PaperFrontmatter extends BaseFrontmatter {
  type: "paper";
  authors: string[];
  year: number;
  venue: string;
  doi?: string;
  arxiv?: string;
}

export interface ExperimentFrontmatter extends BaseFrontmatter {
  type: "experiment";
  status: ExperimentStatus;
  protocol?: string; // wikilink to protocol page
  hypotheses: string[]; // wikilinks to hypothesis pages
}

export interface HypothesisFrontmatter extends BaseFrontmatter {
  type: "hypothesis";
  status: HypothesisStatus;
}

export interface ObservationFrontmatter extends BaseFrontmatter {
  type: "observation";
  experiment?: string; // wikilink to experiment page
  timestamp: string; // ISO 8601
}

export interface NoteFrontmatter extends BaseFrontmatter {
  type: "note";
}

export interface DataFrontmatter extends BaseFrontmatter {
  type: "data";
  experiment?: string;
  format: string; // csv, notebook, results
}

export interface WebFrontmatter extends BaseFrontmatter {
  type: "web";
  url: string;
}

export interface VoiceFrontmatter extends BaseFrontmatter {
  type: "voice";
  duration_seconds?: number;
  transcription_model?: string;
}

export type Frontmatter =
  | PaperFrontmatter
  | ExperimentFrontmatter
  | HypothesisFrontmatter
  | ObservationFrontmatter
  | NoteFrontmatter
  | DataFrontmatter
  | WebFrontmatter
  | VoiceFrontmatter
  | ProjectFrontmatter
  | DecisionFrontmatter
  | TaskFrontmatter
  | ArtifactFrontmatter
  | FrontierItemFrontmatter
  | PersonFrontmatter;

// ── Brain Configuration ────────────────────────────────

export interface BrainConfig {
  /** Absolute path to the brain root directory */
  root: string;

  /** LLM model for extraction/metadata (cheaper) */
  extractionModel: string;

  /** LLM model for synthesis/writing (stronger) */
  synthesisModel: string;

  /** Max pages updated per ingest ripple */
  rippleCap: number;

  /** Monthly budget for Paper Watch auto-ingest ($) */
  paperWatchBudget: number;

  /** Probability of "Did You Know?" in chat (0.0-1.0) */
  serendipityRate: number;
}

export const DEFAULT_BRAIN_CONFIG: Omit<BrainConfig, "root"> = {
  extractionModel: "gpt-4.1-mini",
  synthesisModel: "gpt-4.1",
  rippleCap: 15,
  paperWatchBudget: 50,
  serendipityRate: 0.2,
};

// ── Pipeline Types ─────────────────────────────────────

export interface IngestInput {
  /** File path, URL, DOI, arXiv ID, or raw text */
  source: string;
  /** Override auto-detected content type */
  type?: ContentType;
  /** For observations: link to experiment */
  experiment?: string;
  /** Optional tags to apply */
  tags?: string[];
}

export interface IngestResult {
  /** Content type detected */
  type: ContentType;
  /** Path to raw source saved */
  rawPath: string;
  /** Path to wiki page created */
  wikiPath: string;
  /** Pages updated during ripple */
  rippleUpdates: RippleUpdate[];
  /** Contradictions found */
  contradictions: Contradiction[];
  /** Reading suggestions */
  readingSuggestions: ReadingSuggestion[];
  /** Token cost for this ingest */
  cost: IngestCost;
  /** Duration in milliseconds */
  durationMs: number;
}

export interface RippleUpdate {
  /** Wiki page path that was updated */
  page: string;
  /** What changed */
  reason: string;
  /** Whether git verification passed */
  verified: boolean;
}

export interface Contradiction {
  /** The claim that conflicts */
  claim: string;
  /** Existing page with the contradicted claim */
  existingPage: string;
  /** New source that contradicts */
  newSource: string;
}

export interface ReadingSuggestion {
  /** Paper title or concept */
  title: string;
  /** Why it's relevant */
  reason: string;
  /** DOI or wikilink if in brain */
  reference: string;
}

export interface IngestCost {
  inputTokens: number;
  outputTokens: number;
  estimatedUsd: number;
  model: string;
}

// ── MVP Contracts ──────────────────────────────────────

export interface PdfMetadata {
  title: string | null;
  authors: string[];
  abstract: string | null;
  doi: string | null;
  arxivId: string | null;
  pageCount: number;
  textPreview: string;
  extractionConfidence: "high" | "medium" | "low";
}

export interface ImportPreviewFile {
  path: string;
  type: string;
  size: number;
  hash?: string;
  classification: string;
  projectCandidates: string[];
  warnings: string[];
  /** PDF metadata extracted during scan (title, authors, abstract, etc.) */
  metadata?: PdfMetadata;
}

export interface ImportPreviewProject {
  slug: string;
  title: string;
  confidence: Confidence;
  reason: string;
  sourcePaths: string[];
}

export interface ImportPreview {
  analysis: string;
  backend: string;
  totalFiles?: number;
  previewFileLimit?: number;
  files: ImportPreviewFile[];
  projects: ImportPreviewProject[];
  duplicateGroups: Array<{
    id: string;
    paths: string[];
    reason: string;
    hashPrefix?: string;
    contentType?: string;
  }>;
  warnings: Array<{
    path?: string;
    code: string;
    message: string;
  }>;
}

export interface ProjectManifest {
  version: 1;
  projectId: string;
  slug: string;
  title: string;
  privacy: PrivacyMode;
  status: ProjectStatus;
  projectPagePath: string;
  sourceRefs: SourceRef[];
  decisionPaths: string[];
  taskPaths: string[];
  artifactPaths: string[];
  frontierPaths: string[];
  activeThreads: Array<{
    channel: CaptureChannel;
    threadId: string;
    lastCaptureId?: string;
    lastActivityAt: string;
  }>;
  dedupeKeys: string[];
  lastBriefAt?: string;
  updatedAt: string;
}

export interface ChannelClarificationState {
  captureId: string;
  rawPath?: string;
  question: string;
  choices: string[];
}

export interface ChannelSessionState {
  version: 1;
  channel: "telegram";
  userId: string;
  activeProject: string | null;
  pendingClarification: ChannelClarificationState | null;
  recentCaptureIds: string[];
  updatedAt: string;
}

export interface CaptureEnvelope {
  captureId: string;
  channel: CaptureChannel;
  userId: string;
  kind: CaptureKind;
  project: string | null;
  privacy: PrivacyMode;
  sourceRefs: SourceRef[];
  rawPath: string;
  attachmentPaths: string[];
  transcript?: string;
  requiresClarification: boolean;
  clarificationQuestion?: string;
}

export interface CaptureRequest {
  channel?: CaptureChannel;
  userId?: string;
  content: string;
  project?: string | null;
  kind?: CaptureKind;
  privacy?: PrivacyMode;
  transcript?: string;
  attachmentPaths?: string[];
  sourceRefs?: SourceRef[];
}

export interface CaptureResult {
  captureId: string;
  channel: CaptureChannel;
  userId: string;
  kind: CaptureKind;
  project: string | null;
  privacy: PrivacyMode;
  rawPath: string;
  materializedPath?: string;
  requiresClarification: boolean;
  clarificationQuestion?: string;
  choices: string[];
  status: "saved" | "needs-clarification";
  createdAt: string;
  /** Task pages auto-created from this capture */
  extractedTasks?: string[];
}

export interface ProjectBrief {
  project: string;
  generatedAt: string;
  topMatters: Array<{
    summary: string;
    evidence: string[];
  }>;
  unresolvedRisks: Array<{
    risk: string;
    evidence: string[];
  }>;
  nextMove: {
    recommendation: string;
    assumptions: string[];
    missingEvidence: string[];
  };
  dueTasks: Array<{
    path: string;
    title: string;
    status: TaskStatus;
  }>;
  frontier: Array<{
    path: string;
    title: string;
    status: FrontierStatus;
    whyItMatters: string;
  }>;
}

export interface ArtifactCreateRequest {
  project: string;
  artifactType:
    | "notebook"
    | "memo"
    | "literature-table"
    | "plan"
    | "draft-section"
    | "checklist";
  intent: string;
  conversationId?: string;
  messageIds?: string[];
  privacy?: PrivacyMode;
}

export interface ArtifactCreateResponse {
  jobId: string;
  status: ArtifactStatus;
  savePath?: string;
  artifactPage?: string;
  assumptions: string[];
  reviewFirst: string[];
}

// ── Coldstart Types ───────────────────────────────────

export interface ColdstartScan extends ImportPreview {
  clusters: Array<{
    name: string;
    keywords: string[];
    filePaths: string[];
    confidence: Confidence;
  }>;
  suggestedQuestions: string[];
}

export interface ColdstartResult {
  imported: number;
  skipped: number;
  errors: Array<{ path: string; error: string }>;
  projectsCreated: string[];
  pagesCreated: number;
  firstBriefing: ColdstartBriefing;
  durationMs: number;
}

export interface ColdstartBriefing {
  generatedAt: string;
  activeThreads: Array<{
    name: string;
    evidence: string[];
    confidence: Confidence;
  }>;
  stalledThreads: Array<{
    name: string;
    lastActivity: string;
    evidence: string[];
  }>;
  centralPapers: Array<{
    title: string;
    path: string;
    whyItMatters: string;
  }>;
  suggestedQuestions: string[];
  stats: {
    papers: number;
    notes: number;
    experiments: number;
    projects: number;
    totalPages: number;
  };
}

// ── Search Types ───────────────────────────────────────

export type SearchMode = "index" | "grep" | "qmd" | "list";
export type SearchDetail = "low" | "medium" | "high";

export interface SearchInput {
  query: string;
  mode?: SearchMode;
  limit?: number;
  detail?: SearchDetail;
}

export interface SearchResult {
  path: string;
  title: string;
  snippet: string;
  relevance: number; // 0-1
  type: ContentType;
  /** Synthesized concept-page view metadata for compiled-truth results. */
  compiledView?: {
    pagePath: string;
    summary: string;
    sourceCounts: {
      papers: number;
      notes: number;
      experiments: number;
      datasets: number;
      other: number;
    };
    totalSources: number;
    lastUpdated: string | null;
  };
  /** gbrain content_chunks.id for exact evidence lookup when available. */
  chunkId?: number;
  /** gbrain content_chunks.chunk_index for stable per-page chunk ordering. */
  chunkIndex?: number;
}

// ── Observe Types ──────────────────────────────────────

export interface ObserveInput {
  content: string;
  experiment?: string;
  tags?: string[];
}

export interface ObserveResult {
  /** Path where observation was saved */
  rawPath: string;
  /** Experiment it was linked to (if any) */
  linkedExperiment: string | null;
  /** Facts extracted */
  extractedFacts: string[];
  /** Hypothesis pages impacted */
  hypothesisImpacts: Array<{
    page: string;
    impact: "supporting" | "contradicting";
  }>;
}

// ── Guide Types ────────────────────────────────────────

export interface GuideBriefing {
  /** Brain stats */
  stats: {
    sourceCount: number;
    pageCount: number;
    crossReferences: number;
    monthCostUsd: number;
    monthBudgetUsd: number;
  };
  /** Attention-ordered sections */
  alerts: Alert[];
  activeExperiments: ExperimentSummary[];
  recentChanges: RecentChange[];
  readingQueue: ReadingSuggestion[];
}

export interface Alert {
  severity: "critical" | "warning" | "info";
  message: string;
  page: string; // wikilink
  action: string; // suggested next step
}

export interface ExperimentSummary {
  name: string;
  status: ExperimentStatus;
  lastObservation: string | null; // date
  nextAction: string;
  linkedHypotheses: string[];
}

export interface RecentChange {
  date: string;
  operation: "ingest" | "observe" | "ripple" | "lint";
  description: string;
  page: string;
}

// ── Events (events.jsonl schema) ───────────────────────

export type BrainEventType =
  | "ingest"
  | "observe"
  | "ripple"
  | "search"
  | "lint"
  | "compile"
  | "guide"
  | "dream"
  | "error";

export interface BrainEvent {
  /** ISO 8601 timestamp */
  ts: string;
  /** Event type */
  type: BrainEventType;
  /** Content type involved (for ingest/observe) */
  contentType?: ContentType;
  /** Pages created */
  created?: string[];
  /** Pages updated */
  updated?: string[];
  /** Search query (for search events) */
  query?: string;
  /** Token cost */
  cost?: IngestCost;
  /** Duration in milliseconds */
  durationMs?: number;
  /** Error message (for error events) */
  error?: string;
}

// ── Lint Types ─────────────────────────────────────────

export interface LintResult {
  pagesChecked: number;
  critical: LintFinding[];
  warnings: LintFinding[];
  info: LintFinding[];
  repairs: RepairSuggestion[];
}

export interface LintFinding {
  page: string;
  issue: string;
  details: string;
}

export interface RepairSuggestion {
  command: string;
  description: string;
}

// ── Dream Cycle Types ─────────────────────────────────

export type EnrichmentTargetType = "paper" | "author" | "concept" | "method";

export type EnrichmentPriority = "high" | "medium" | "low";

export type DreamCycleMode = "full" | "sweep-only" | "enrich-only";

// ── Research Briefing Types ──────────────────────────

export interface MeetingAttendeePrep {
  name: string;
  brainPagePath?: string;
  lastInteraction?: string;
  openThreads: string[];
}

export interface MeetingPrep {
  title: string;
  time: string;
  attendees: MeetingAttendeePrep[];
  suggestedTopics: string[];
}

export interface MorningBrief {
  generatedAt: string;
  greeting: string;

  /** Top 3 things that changed and matter to the scientist's work */
  topMatters: Array<{
    summary: string;
    whyItMatters: string;
    evidence: string[];
    urgency: "act-now" | "this-week" | "awareness";
  }>;

  /** Contradictions or tensions discovered in the brain */
  contradictions: Array<{
    claim1: { summary: string; source: string; date: string };
    claim2: { summary: string; source: string; date: string };
    implication: string;
  }>;

  /** Frontier items: new papers/developments relevant to active projects */
  frontier: Array<{
    title: string;
    source: string;
    relevanceScore: number;
    whyItMatters: string;
    threatOrOpportunity: "supports" | "challenges" | "adjacent" | "noise";
  }>;

  /** Stale threads that need attention */
  staleThreads: Array<{
    name: string;
    lastActivity: string;
    daysSinceActivity: number;
    suggestedAction: string;
  }>;

  /** Unresolved questions across all projects */
  openQuestions: Array<{
    question: string;
    project: string;
    firstAsked: string;
    daysPending: number;
  }>;

  /** Recommended next experiment/action with reasoning */
  nextMove: {
    recommendation: string;
    reasoning: string;
    assumptions: string[];
    missingEvidence: string[];
    experiment?: {
      hypothesis: string;
      method: string;
      expectedOutcome: string;
    };
  };

  /** Proactive meeting prep — populated when calendar data is available */
  meetingPrep?: MeetingPrep[];

  /** Stats */
  stats: {
    brainPages: number;
    newPagesYesterday: number;
    capturesYesterday: number;
    enrichmentsYesterday: number;
  };
}

export interface ProgramBrief {
  generatedAt: string;
  programStatus: "on-track" | "at-risk" | "blocked";

  /** What changed since yesterday across all team projects */
  whatChanged: Array<{
    project: string;
    change: string;
    impact: "high" | "medium" | "low";
  }>;

  /** Scientific risks across the program */
  scientificRisks: Array<{
    risk: string;
    project: string;
    severity: "critical" | "high" | "medium";
    competingExplanations?: Array<{
      explanation: string;
      evidence: string[];
      confidence: Confidence;
    }>;
  }>;

  /** Best next experiment recommendation */
  bestNextExperiment: {
    hypothesis: string;
    method: string;
    expectedOutcome: string;
    whyThisOne: string;
    assumptions: string[];
    discriminates: string;
  };

  /** Summary suitable for a standup */
  standupSummary: string;
}

export interface ContradictionReport {
  contradictions: Array<{
    id: string;
    severity: "critical" | "notable" | "minor";
    claim1: { text: string; source: string; date: string };
    claim2: { text: string; source: string; date: string };
    implication: string;
    suggestedResolution: string;
  }>;
  tensions: Array<{
    description: string;
    sources: string[];
    resolution: string;
  }>;
  scannedPages: number;
}

// ── Reference Import Types ───────────────────────────

export interface ParsedReference {
  bibtexKey?: string;
  title: string;
  authors: string[];
  year: number;
  venue: string;
  doi?: string;
  arxiv?: string;
  abstract?: string;
  keywords: string[];
  entryType: string; // article, inproceedings, misc, etc.
  rawEntry: string; // original BibTeX/RIS text for provenance
}

export interface DeduplicationResult {
  newRefs: ParsedReference[];
  matchedRefs: Array<{
    ref: ParsedReference;
    existingPath: string;
    matchType: "doi" | "arxiv" | "title";
  }>;
  stats: { total: number; new: number; matched: number };
}

export interface ReferenceImportResult {
  pagesCreated: string[];
  pagesEnriched: string[];
  pagesSkipped: number;
  errors: Array<{ ref: string; error: string }>;
  durationMs: number;
}
