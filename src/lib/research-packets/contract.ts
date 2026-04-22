import type { PersistedEntityResult, DbEntity } from "@/lib/skills/db-base";

export type ResearchLandscapeSource =
  | "pubmed"
  | "arxiv"
  | "openalex"
  | "crossref";

export type ResearchLandscapeStatus = "completed" | "partial" | "failed";

export type PaperEntity = Extract<DbEntity, { type: "paper" }>;

export interface ResearchLandscapeInput {
  query: string;
  exactTitle?: string;
  project?: string;
  sources?: ResearchLandscapeSource[];
  perSourceLimit?: number;
  retainedLimit?: number;
  startYear?: number;
  endYear?: number;
  retryCount?: number;
}

export interface ResearchLandscapeSourceRun {
  source: ResearchLandscapeSource;
  status: "ok" | "failed";
  attempts: number;
  candidatesFetched: number;
  candidatesAfterYearFilter: number;
  total: number;
  cursor?: string;
  error?: string;
}

export interface ResearchLandscapeCandidate {
  source: ResearchLandscapeSource;
  rank: number;
  entity: PaperEntity;
  normalizedTitle: string;
  exactTitleMatch: boolean;
}

export interface ResearchLandscapeDuplicate {
  droppedTitle: string;
  droppedSource: ResearchLandscapeSource;
  keptTitle: string;
  keptSources: ResearchLandscapeSource[];
  reason: "shared_doi" | "shared_identifier" | "title_similarity";
  similarity?: number;
}

export interface ResearchLandscapeRetainedCandidate {
  entity: PaperEntity;
  normalizedTitle: string;
  exactTitleMatch: boolean;
  bestRank: number;
  sources: ResearchLandscapeSource[];
  duplicates: ResearchLandscapeDuplicate[];
}

export interface ResearchLandscapeFailure {
  stage: "source" | "persist_paper";
  source?: ResearchLandscapeSource;
  title?: string;
  message: string;
}

export interface PersistedResearchArtifact {
  slug: string;
  diskPath: string;
  title: string;
  write_status: "persisted";
}

export interface ResearchLandscapeTitleResolution {
  target: string;
  status: "resolved" | "ambiguous" | "unresolved";
  matchedCount: number;
  matches: Array<{
    title: string;
    slug?: string;
    sources: ResearchLandscapeSource[];
  }>;
}

export interface ResearchLandscapeRetainedWrite {
  candidate: ResearchLandscapeRetainedCandidate;
  persisted?: PersistedEntityResult;
  error?: string;
}

export interface ResearchLandscapeLastRun {
  timestamp: string;
  status: ResearchLandscapeStatus;
  query: string;
  exact_title?: string;
  project?: string;
  packet_slug: string;
  journal_slug: string;
  collected_candidates: number;
  retained_candidates: number;
  duplicates_dropped: number;
  partial: boolean;
  source_failures: Array<{
    source: ResearchLandscapeSource;
    message: string;
  }>;
}

export interface ResearchLandscapeResult {
  status: ResearchLandscapeStatus;
  query: string;
  exactTitle?: string;
  project?: string;
  packet: PersistedResearchArtifact;
  journal: PersistedResearchArtifact;
  pointerPath: string;
  sourceRuns: ResearchLandscapeSourceRun[];
  collectedCandidates: number;
  retainedCandidates: number;
  duplicatesDropped: number;
  retainedWrites: ResearchLandscapeRetainedWrite[];
  failures: ResearchLandscapeFailure[];
  titleResolution?: ResearchLandscapeTitleResolution;
}

export const DEFAULT_RESEARCH_LANDSCAPE_SOURCES: ResearchLandscapeSource[] = [
  "pubmed",
  "arxiv",
  "openalex",
  "crossref",
];

export const DEFAULT_PER_SOURCE_LIMIT = 12;
export const DEFAULT_RETAINED_LIMIT = 10;
export const DEFAULT_RETRY_COUNT = 1;
export const RESEARCH_LANDSCAPE_LAST_RUN_FILENAME = ".research-landscape-last-run.json";
