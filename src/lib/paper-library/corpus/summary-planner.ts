import { createHash } from "node:crypto";

import type { PrivacyMode } from "@/brain/types";
import {
  evaluateStrictLocalDestination,
  type RuntimeDestination,
} from "@/lib/runtime/strict-local-policy";

import {
  PaperIngestManifestSchema,
  PaperProvenanceLedgerRecordSchema,
  PaperSummaryArtifactSchema,
  paperCorpusSummarySlugForPaperSlug,
  type PaperCorpusWarning,
  type PaperIngestManifest,
  type PaperIngestPaper,
  type PaperProvenanceLedgerRecord,
  type PaperSourceArtifact,
  type PaperSummaryArtifact,
  type PaperSummaryTier,
  type SummaryEvidence,
} from "./contracts";

export const PAPER_SUMMARY_PROMPT_VERSIONS: Record<PaperSummaryTier, string> = {
  relevance: "paper-relevance-v1",
  brief: "paper-brief-v1",
  detailed: "paper-detailed-v1",
};

export const DEFAULT_PAPER_SUMMARY_MODEL_ID = "local-corpus-summary-v1";
export const DEFAULT_PAPER_SUMMARY_DESTINATION: RuntimeDestination = "local-ollama";

export type PaperSummaryTrigger =
  | "eager_relevance"
  | "active_study"
  | "graph_centrality"
  | "user_opened"
  | "agent_demand"
  | "selected_for_answer"
  | "deep_read"
  | "critique"
  | "evidence_map"
  | "user_pinned_core"
  | "repair";

export interface PaperSummaryRequest {
  paperSlug: string;
  tier: PaperSummaryTier;
  trigger: PaperSummaryTrigger;
  force?: boolean;
}

export interface PaperSummaryPlannerInput {
  manifest: PaperIngestManifest;
  generatedAt?: string;
  actor?: string;
  projectPolicy?: PrivacyMode;
  destination?: RuntimeDestination;
  modelId?: string;
  promptVersions?: Partial<Record<PaperSummaryTier, string>>;
  generationSettings?: Record<string, unknown>;
  requests?: readonly PaperSummaryRequest[];
  env?: Record<string, string | undefined> | NodeJS.ProcessEnv;
}

export interface PaperSummaryGenerationJob {
  jobId: string;
  paperSlug: string;
  paperId: string;
  title?: string;
  tier: PaperSummaryTier;
  summarySlug: string;
  sourceSlug: string;
  sourceHash: string;
  sectionMapHash: string;
  promptVersion: string;
  modelId: string;
  generationSettings: Record<string, unknown>;
  inputHash: string;
  triggeredBy: PaperSummaryTrigger[];
  staleReason?: string;
  sourceQualityScore: number;
  evidence: SummaryEvidence[];
}

export interface PaperSummaryPlannerResult {
  manifest: PaperIngestManifest;
  jobs: PaperSummaryGenerationJob[];
  provenanceRecords: PaperProvenanceLedgerRecord[];
  warnings: PaperCorpusWarning[];
}

export interface CompletePaperSummaryJobInput {
  job: PaperSummaryGenerationJob;
  summaryMarkdown: string;
  generatedAt?: string;
  generatedBy?: string;
  evidence?: SummaryEvidence[];
  warnings?: PaperCorpusWarning[];
}

export interface CompletePaperSummaryJobResult {
  summary: PaperSummaryArtifact;
  provenanceRecord: PaperProvenanceLedgerRecord;
}

export interface RunPaperSummaryJobsInput<Job, Result> {
  jobs: readonly Job[];
  concurrencyLimit: number;
  worker: (job: Job, index: number) => Promise<Result>;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
}

function summaryInputHash(input: {
  paperSlug: string;
  tier: PaperSummaryTier;
  sourceHash: string;
  sectionMapHash: string;
  promptVersion: string;
  modelId: string;
  generationSettings: Record<string, unknown>;
}): string {
  return sha256(stableJson(input));
}

function isLocalDestination(destination: RuntimeDestination): boolean {
  return destination === "local-ollama"
    || destination === "local-openclaw"
    || destination === "local-openhands"
    || destination === "local-gbrain";
}

function privacyWarning(reason: string, summarySlug: string): PaperCorpusWarning {
  return {
    code: "privacy_blocked",
    message: reason,
    artifactSlug: summarySlug,
    severity: "warning",
  };
}

function firstBlockingPrivacyReason(input: {
  projectPolicy: PrivacyMode;
  destination: RuntimeDestination;
  env: Record<string, string | undefined> | NodeJS.ProcessEnv;
}): string | null {
  const strictDecision = evaluateStrictLocalDestination({
    destination: input.destination,
    dataClass: "model-prompt",
    feature: "Paper corpus summary generation",
    privacy: isLocalDestination(input.destination) ? "local-network" : "hosted",
  }, input.env);

  if (!strictDecision.allowed) return strictDecision.reason;
  if (input.projectPolicy === "local-only" && !isLocalDestination(input.destination)) {
    return `Local-only project policy blocks paper corpus summary generation to ${input.destination}.`;
  }
  return null;
}

function summaryPromptVersion(
  tier: PaperSummaryTier,
  overrides?: Partial<Record<PaperSummaryTier, string>>,
): string {
  return overrides?.[tier] ?? PAPER_SUMMARY_PROMPT_VERSIONS[tier];
}

function summaryByTier(
  paper: PaperIngestPaper,
  tier: PaperSummaryTier,
): PaperSummaryArtifact | undefined {
  return paper.summaries.find((summary) => summary.tier === tier);
}

function selectedSource(paper: PaperIngestPaper): PaperSourceArtifact | null {
  const source = paper.sourceArtifact;
  if (!source || source.status !== "current") return null;
  if (!source.sourceHash || !source.sectionMapHash) return null;
  return source;
}

function sourceEvidence(paper: PaperIngestPaper, source: PaperSourceArtifact): SummaryEvidence[] {
  const firstHandle = paper.sectionMap?.sections
    .flatMap((section) => section.chunkHandles)
    .find((handle) => handle.sourceSlug === source.sourceSlug);
  if (firstHandle) {
    return [{
      statement: "Summary should be grounded in the selected corpus source.",
      chunkHandles: [firstHandle],
      sectionAnchors: [],
      caveats: [],
    }];
  }

  const firstSection = paper.sectionMap?.sections[0];
  if (firstSection) {
    return [{
      statement: "Summary should be grounded in the selected corpus section map.",
      chunkHandles: [],
      sectionAnchors: [firstSection.anchor],
      caveats: [],
    }];
  }

  return [{
    statement: "Summary should be grounded in the selected corpus source.",
    chunkHandles: [],
    sectionAnchors: [source.sourceSlug],
    caveats: [],
  }];
}

function requestedTiers(
  paper: PaperIngestPaper,
  requests: readonly PaperSummaryRequest[],
): Map<PaperSummaryTier, PaperSummaryRequest[]> {
  const byTier = new Map<PaperSummaryTier, PaperSummaryRequest[]>();
  byTier.set("relevance", [{
    paperSlug: paper.paperSlug,
    tier: "relevance",
    trigger: "eager_relevance",
  }]);

  for (const request of requests) {
    if (request.paperSlug !== paper.paperSlug) continue;
    const existing = byTier.get(request.tier) ?? [];
    existing.push(request);
    byTier.set(request.tier, existing);
  }

  return byTier;
}

function staleReasonForSummary(input: {
  existing: PaperSummaryArtifact;
  sourceHash: string;
  sectionMapHash: string;
  promptVersion: string;
  modelId: string;
  generationSettings: Record<string, unknown>;
  force: boolean;
}): string | null {
  if (input.force) return "Summary regeneration was explicitly requested.";
  if (input.existing.status === "stale") return input.existing.staleReason ?? "Summary is already stale.";
  if (input.existing.status === "failed") return "Previous summary generation failed.";
  if (input.existing.status === "blocked") return "Previous summary generation was blocked.";
  if (input.existing.status === "missing") return "Summary artifact is missing.";
  if (input.existing.status === "queued") return null;
  if (input.existing.sourceHash !== input.sourceHash) return "Selected source hash changed.";
  if (input.existing.sectionMapHash !== input.sectionMapHash) return "Section map hash changed.";
  if (input.existing.promptVersion !== input.promptVersion) return "Summary prompt version changed.";
  if (input.existing.modelId !== input.modelId) return "Summary model changed.";
  if (stableJson(input.existing.generationSettings) !== stableJson(input.generationSettings)) {
    return "Summary generation settings changed.";
  }
  return null;
}

function blockedSummaryArtifact(input: {
  paper: PaperIngestPaper;
  source: PaperSourceArtifact;
  tier: PaperSummaryTier;
  summarySlug: string;
  generatedAt: string;
  promptVersion: string;
  modelId: string;
  generationSettings: Record<string, unknown>;
  warning: PaperCorpusWarning;
}): PaperSummaryArtifact {
  return PaperSummaryArtifactSchema.parse({
    paperSlug: input.paper.paperSlug,
    sourceSlug: input.source.sourceSlug,
    summarySlug: input.summarySlug,
    tier: input.tier,
    status: "blocked",
    sourceHash: input.source.sourceHash,
    sectionMapHash: input.source.sectionMapHash,
    promptVersion: input.promptVersion,
    modelId: input.modelId,
    generationSettings: input.generationSettings,
    createdAt: input.generatedAt,
    updatedAt: input.generatedAt,
    warnings: [input.warning],
  });
}

function queuedSummaryArtifact(input: {
  paper: PaperIngestPaper;
  source: PaperSourceArtifact;
  tier: PaperSummaryTier;
  summarySlug: string;
  generatedAt: string;
  promptVersion: string;
  modelId: string;
  generationSettings: Record<string, unknown>;
  existing?: PaperSummaryArtifact;
  staleReason?: string;
}): PaperSummaryArtifact {
  if (input.existing && input.staleReason) {
    return PaperSummaryArtifactSchema.parse({
      ...input.existing,
      status: "stale",
      staleReason: input.staleReason,
      updatedAt: input.generatedAt,
    });
  }

  return PaperSummaryArtifactSchema.parse({
    paperSlug: input.paper.paperSlug,
    sourceSlug: input.source.sourceSlug,
    summarySlug: input.summarySlug,
    tier: input.tier,
    status: "queued",
    sourceHash: input.source.sourceHash,
    sectionMapHash: input.source.sectionMapHash,
    promptVersion: input.promptVersion,
    modelId: input.modelId,
    generationSettings: input.generationSettings,
    createdAt: input.generatedAt,
    updatedAt: input.generatedAt,
    evidence: sourceEvidence(input.paper, input.source),
  });
}

function summaryRecord(input: {
  id: string;
  paperSlug: string;
  occurredAt: string;
  actor: string;
  tier: PaperSummaryTier;
  summarySlug: string;
  sourceSlug: string;
  status: PaperProvenanceLedgerRecord["status"];
  inputHash: string;
  outputHash?: string;
  staleReason?: string;
  message: string;
  warnings?: PaperCorpusWarning[];
  details?: Record<string, unknown>;
}): PaperProvenanceLedgerRecord {
  return PaperProvenanceLedgerRecordSchema.parse({
    id: input.id,
    paperSlug: input.paperSlug,
    occurredAt: input.occurredAt,
    eventType: "summary",
    status: input.status,
    actor: input.actor,
    sourceSlug: input.sourceSlug,
    artifactSlug: input.summarySlug,
    summaryTier: input.tier,
    inputHash: input.inputHash,
    outputHash: input.outputHash,
    staleReason: input.staleReason,
    message: input.message,
    warnings: input.warnings ?? [],
    details: input.details ?? {},
  });
}

function replaceSummary(
  summaries: readonly PaperSummaryArtifact[],
  summary: PaperSummaryArtifact,
): PaperSummaryArtifact[] {
  const withoutTier = summaries.filter((entry) => entry.tier !== summary.tier);
  return [...withoutTier, summary].sort((left, right) => left.tier.localeCompare(right.tier));
}

export function planPaperSummaryJobs(
  input: PaperSummaryPlannerInput,
): PaperSummaryPlannerResult {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const actor = input.actor ?? "ScienceSwarm corpus";
  const projectPolicy = input.projectPolicy ?? "local-only";
  const destination = input.destination ?? DEFAULT_PAPER_SUMMARY_DESTINATION;
  const modelId = input.modelId ?? DEFAULT_PAPER_SUMMARY_MODEL_ID;
  const generationSettings = input.generationSettings ?? { temperature: 0 };
  const requests = input.requests ?? [];
  const privacyBlockReason = firstBlockingPrivacyReason({
    projectPolicy,
    destination,
    env: input.env ?? process.env,
  });

  const jobs: PaperSummaryGenerationJob[] = [];
  const warnings: PaperCorpusWarning[] = [...input.manifest.warnings];
  const provenanceRecords: PaperProvenanceLedgerRecord[] = [];

  const papers = input.manifest.papers.map((paper) => {
    const source = selectedSource(paper);
    if (!source) return paper;

    let summaries = paper.summaries;
    for (const [tier, tierRequests] of requestedTiers(paper, requests)) {
      const promptVersion = summaryPromptVersion(tier, input.promptVersions);
      const summarySlug = paperCorpusSummarySlugForPaperSlug(paper.paperSlug, tier);
      const inputHash = summaryInputHash({
        paperSlug: paper.paperSlug,
        tier,
        sourceHash: source.sourceHash ?? "",
        sectionMapHash: source.sectionMapHash ?? "",
        promptVersion,
        modelId,
        generationSettings,
      });
      const existing = summaryByTier({ ...paper, summaries }, tier);
      const force = tierRequests.some((request) => request.force || request.trigger === "repair");
      const staleReason = existing
        ? staleReasonForSummary({
            existing,
            sourceHash: source.sourceHash ?? "",
            sectionMapHash: source.sectionMapHash ?? "",
            promptVersion,
            modelId,
            generationSettings,
            force,
          })
        : "Summary artifact is missing.";

      if (!staleReason) continue;

      if (privacyBlockReason) {
        const warning = privacyWarning(privacyBlockReason, summarySlug);
        warnings.push(warning);
        summaries = replaceSummary(summaries, blockedSummaryArtifact({
          paper,
          source,
          tier,
          summarySlug,
          generatedAt,
          promptVersion,
          modelId,
          generationSettings,
          warning,
        }));
        provenanceRecords.push(summaryRecord({
          id: `summary:${tier}:${paper.paperSlug}:blocked:${inputHash.slice(0, 16)}`,
          paperSlug: paper.paperSlug,
          occurredAt: generatedAt,
          actor,
          tier,
          summarySlug,
          sourceSlug: source.sourceSlug,
          status: "blocked",
          inputHash,
          message: privacyBlockReason,
          warnings: [warning],
          details: { destination, projectPolicy },
        }));
        continue;
      }

      summaries = replaceSummary(summaries, queuedSummaryArtifact({
        paper,
        source,
        tier,
        summarySlug,
        generatedAt,
        promptVersion,
        modelId,
        generationSettings,
        existing,
        staleReason: existing ? staleReason : undefined,
      }));
      if (existing && staleReason) {
        provenanceRecords.push(summaryRecord({
          id: `summary:${tier}:${paper.paperSlug}:stale:${inputHash.slice(0, 16)}`,
          paperSlug: paper.paperSlug,
          occurredAt: generatedAt,
          actor,
          tier,
          summarySlug,
          sourceSlug: source.sourceSlug,
          status: "stale",
          inputHash,
          staleReason,
          message: staleReason,
          details: { destination, projectPolicy },
        }));
      }

      jobs.push({
        jobId: `summary:${tier}:${paper.paperSlug}:${inputHash.slice(0, 16)}`,
        paperSlug: paper.paperSlug,
        paperId: paper.paperId,
        title: paper.title,
        tier,
        summarySlug,
        sourceSlug: source.sourceSlug,
        sourceHash: source.sourceHash ?? "",
        sectionMapHash: source.sectionMapHash ?? "",
        promptVersion,
        modelId,
        generationSettings,
        inputHash,
        triggeredBy: [...new Set(tierRequests.map((request) => request.trigger))],
        staleReason: existing ? staleReason : undefined,
        sourceQualityScore: source.quality.score,
        evidence: sourceEvidence(paper, source),
      });

      provenanceRecords.push(summaryRecord({
        id: `summary:${tier}:${paper.paperSlug}:queued:${inputHash.slice(0, 16)}`,
        paperSlug: paper.paperSlug,
        occurredAt: generatedAt,
        actor,
        tier,
        summarySlug,
        sourceSlug: source.sourceSlug,
        status: "queued",
        inputHash,
        message: `Queued corpus ${tier} summary generation.`,
        details: {
          destination,
          projectPolicy,
          triggers: [...new Set(tierRequests.map((request) => request.trigger))],
        },
      }));
    }

    return {
      ...paper,
      summaries,
    };
  });

  return {
    manifest: PaperIngestManifestSchema.parse({
      ...input.manifest,
      papers,
      warnings,
      updatedAt: generatedAt,
    }),
    jobs,
    provenanceRecords,
    warnings,
  };
}

export function completePaperSummaryJob(
  input: CompletePaperSummaryJobInput,
): CompletePaperSummaryJobResult {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const generatedBy = input.generatedBy ?? "ScienceSwarm corpus";
  const summaryMarkdown = input.summaryMarkdown.trim();
  const outputHash = sha256(summaryMarkdown);
  const evidence = input.evidence ?? input.job.evidence;
  const summary = PaperSummaryArtifactSchema.parse({
    paperSlug: input.job.paperSlug,
    sourceSlug: input.job.sourceSlug,
    summarySlug: input.job.summarySlug,
    tier: input.job.tier,
    status: "current",
    sourceHash: input.job.sourceHash,
    sectionMapHash: input.job.sectionMapHash,
    promptVersion: input.job.promptVersion,
    modelId: input.job.modelId,
    generationSettings: input.job.generationSettings,
    createdAt: generatedAt,
    updatedAt: generatedAt,
    generatedAt,
    generatedBy,
    summaryMarkdown,
    evidence,
    warnings: input.warnings ?? [],
  });

  return {
    summary,
    provenanceRecord: summaryRecord({
      id: `summary:${input.job.tier}:${input.job.paperSlug}:succeeded:${outputHash.slice(0, 16)}`,
      paperSlug: input.job.paperSlug,
      occurredAt: generatedAt,
      actor: generatedBy,
      tier: input.job.tier,
      summarySlug: input.job.summarySlug,
      sourceSlug: input.job.sourceSlug,
      status: "succeeded",
      inputHash: input.job.inputHash,
      outputHash,
      message: `Generated corpus ${input.job.tier} summary.`,
      warnings: input.warnings ?? [],
      details: {
        modelId: input.job.modelId,
        promptVersion: input.job.promptVersion,
        generationSettings: input.job.generationSettings,
        triggers: input.job.triggeredBy,
      },
    }),
  };
}

export async function runPaperSummaryJobsWithConcurrency<Job, Result>(
  input: RunPaperSummaryJobsInput<Job, Result>,
): Promise<Result[]> {
  if (!Number.isInteger(input.concurrencyLimit) || input.concurrencyLimit < 1) {
    throw new Error("summary concurrency limit must be a positive integer.");
  }

  const results: Result[] = new Array(input.jobs.length);
  let nextIndex = 0;

  async function workerLoop(): Promise<void> {
    while (nextIndex < input.jobs.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await input.worker(input.jobs[index] as Job, index);
    }
  }

  const workerCount = Math.min(input.concurrencyLimit, input.jobs.length);
  await Promise.all(Array.from({ length: workerCount }, () => workerLoop()));
  return results;
}
