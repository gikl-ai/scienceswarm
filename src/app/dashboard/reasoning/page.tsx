"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useScienceSwarmLocalAuth } from "@/hooks/use-scienceswarm-local-auth";
import { getStructuredCritiqueDisplayError } from "@/lib/structured-critique-errors";
import {
  getScienceSwarmSignInUrl,
  SCIENCESWARM_CRITIQUE_CLOUD_DISCLAIMER,
  SCIENCESWARM_CRITIQUE_FRONTIER_MODELS_DISCLAIMER,
  SCIENCESWARM_CRITIQUE_SIGN_IN_REQUIRED_MESSAGE,
} from "@/lib/scienceswarm-auth";
import {
  normalizeStructuredCritiqueJobPayload,
  normalizeStructuredCritiqueResultPayload,
  tryNormalizeStructuredCritiqueJobPayload,
  type StructuredCritiqueFinding as Finding,
  type StructuredCritiqueJob,
  type StructuredCritiqueResult,
  type StructuredCritiqueStatus,
} from "@/lib/structured-critique-schema";

// ---------------------------------------------------------------------------
// Constants & Types
// ---------------------------------------------------------------------------

const STORAGE_KEY = "structured-critique-history.v1";
const POLL_INTERVAL_MS = 3000;
const MAX_POLLS = 120;
const POLL_TIMEOUT_MESSAGE =
  "Analysis is taking longer than expected. This run is still saved in Recent Reasoning Analyses so you can check back shortly.";
const QUEUED_POLL_TIMEOUT_MESSAGE =
  "ScienceSwarm's hosted reasoning queue has accepted this run but it has not started yet. This run is still saved in Recent Reasoning Analyses so you can check back shortly.";
const QUEUED_PROGRESS_RECOVERY_MESSAGE =
  "Queued in ScienceSwarm's hosted reasoning service. You can leave this page open or reopen the run from Recent Reasoning Analyses later.";
const DEFAULT_STYLE_PROFILE = "professional";
const SECTION_LABEL = "text-xs font-medium uppercase tracking-widest text-muted";
export const SUBMIT_BUTTON_LABEL = "Submit to Reasoning Engine";
const REASONING_AUDIT_LOADING_AUTH_MESSAGE =
  "Loading your ScienceSwarm account…";
const SCIENCESWARM_SIGN_IN_URL = getScienceSwarmSignInUrl();
const STRUCTURED_CRITIQUE_UNAVAILABLE_FALLBACK =
  "ScienceSwarm reasoning is temporarily unavailable. Try again in a few minutes.";

type HealthResponse = {
  features?: {
    structuredCritique?: boolean;
  };
  structuredCritique?: {
    ready?: boolean;
    detail?: string;
    status?: string;
  };
};

type StoredStructuredCritiqueJob = StructuredCritiqueJob & {
  saved_at: string;
};

type BrainArtifactPage = {
  slug: string;
  title: string;
  type: string;
  content: string;
  frontmatter: Record<string, unknown>;
};

type InputMode = "pdf" | "text";
type FilterKind = "critique" | "fallacy" | "gap";
type SubmittedReasoningInput =
  | { kind: "pdf"; name: string; size?: number }
  | { kind: "text"; charCount?: number; preview: string };
type BrainSaveStatus =
  | { state: "idle" }
  | { state: "saving" }
  | { state: "saved"; slug: string; url: string; projectUrl?: string }
  | { state: "error"; error: string };

type StructuredCritiqueFeedbackRecord = {
  job_id: string;
  finding_id: string;
  useful: boolean;
  would_revise: boolean;
  comment?: string;
  timestamp: string;
  user_id: string;
};

type StructuredCritiqueFeedbackSummary = {
  total: number;
  useful: number;
  notUseful: number;
  wouldRevise: number;
  wouldNotRevise: number;
  latestTimestamp: string | null;
  unresolvedConcerns: number;
};

type StructuredCritiqueFeedbackResponse = {
  records?: StructuredCritiqueFeedbackRecord[];
  record?: StructuredCritiqueFeedbackRecord;
  summary?: StructuredCritiqueFeedbackSummary;
};

type PersistCritiqueResponse = {
  brain_slug?: string;
  url?: string;
  project_url?: string;
  error?: string;
};

type PersistedCritiqueSummary = {
  brain_slug: string;
  parent_slug?: string;
  project_slug?: string;
  title: string;
  uploaded_at?: string;
  source_filename?: string;
  descartes_job_id?: string;
  finding_count?: number;
  url?: string;
  project_url?: string;
};

type BrainPageResponse = {
  slug?: string;
  title?: string;
  type?: string;
  content?: string;
  frontmatter?: Record<string, unknown>;
  error?: string;
};

type StructuredCritiqueProgressLike = Record<string, unknown> | null | undefined;

const EXAMPLE_REASONING_JOB: StructuredCritiqueJob = {
  id: "example-reasoning-report",
  status: "COMPLETED",
  pdf_filename: "example-manuscript.pdf",
  style_profile: DEFAULT_STYLE_PROFILE,
  result: {
    title: "Example Reasoning Report",
    report_markdown:
      "# Example Reasoning Report\n\nThis sample shows the structure of a completed ScienceSwarm reasoning analysis. Real reports include ranked findings, quoted evidence, impact notes, and suggested revisions.\n\n## Top issues\n\n1. The central claim depends on an unstated sampling assumption.\n2. The causal interpretation is stronger than the reported experiment supports.\n3. A key negative control is mentioned but not tied back to the conclusion.",
    findings: [
      {
        finding_id: "EX-001",
        severity: "error",
        finding_kind: "critique",
        flaw_type: "missing-assumption",
        description:
          "The conclusion depends on the sample being representative, but the manuscript never states or defends that assumption.",
        evidence_quote:
          "These results demonstrate that the intervention generalizes across the target population.",
        impact:
          "If the cohort is biased, the headline generalization may not hold.",
        suggested_fix:
          "State the sampling assumption explicitly and add either a representativeness argument or narrower claim language.",
        confidence: 0.86,
      },
      {
        finding_id: "EX-002",
        severity: "warning",
        finding_kind: "gap",
        flaw_type: "causal-leap",
        description:
          "The report moves from correlation to mechanism without ruling out a plausible confound.",
        evidence_quote:
          "The observed association indicates that pathway activation drives the phenotype.",
        impact:
          "Readers may treat a suggestive association as mechanistic proof.",
        suggested_fix:
          "Rephrase the claim as associative unless a control or intervention can distinguish the mechanism.",
        confidence: 0.78,
      },
      {
        finding_id: "EX-003",
        severity: "note",
        finding_kind: "fallacy",
        flaw_type: "weak-evidence-chain",
        description:
          "The negative control appears once in the methods but is not used in the argument that follows.",
        evidence_quote:
          "A vehicle-only control was included in each batch.",
        impact:
          "A useful control is present, but the reader cannot tell whether it supports the main inference.",
        suggested_fix:
          "Add a sentence explaining how the control constrains the interpretation of the main result.",
        confidence: 0.71,
      },
    ],
    author_feedback: {
      overall_summary:
        "The example report shows how ScienceSwarm separates high-impact reasoning breaks from lower-priority revision notes.",
      top_issues: [
        {
          title: "Unstated sampling assumption",
          summary:
            "The main claim generalizes beyond the evidence unless the cohort is representative.",
        },
        {
          title: "Mechanism claimed from association",
          summary:
            "The manuscript needs stronger evidence or narrower wording for the causal claim.",
        },
      ],
    },
  },
};

// ---------------------------------------------------------------------------
// Helpers (reused from original)
// ---------------------------------------------------------------------------

function isTerminalStatus(status: StructuredCritiqueStatus): boolean {
  return (
    status === "COMPLETED" ||
    status === "FAILED" ||
    status === "CANCELLED"
  );
}

function isErrorStatus(
  status: StructuredCritiqueStatus | null | undefined,
): boolean {
  return status === "FAILED" || status === "CANCELLED";
}

function readJobFailureMessage(
  job: Pick<StructuredCritiqueJob, "error" | "error_message"> | null | undefined,
): string | null {
  if (!job) return null;
  const errorMessage = job.error_message?.trim();
  if (errorMessage) return errorMessage;
  if (typeof job.error === "string" && job.error.trim().length > 0) {
    return job.error;
  }
  if (job.error && typeof job.error === "object") {
    const userFacingMessage = job.error.user_facing_message;
    if (
      typeof userFacingMessage === "string" &&
      userFacingMessage.trim().length > 0
    ) {
      return userFacingMessage;
    }
  }
  return null;
}

function readJobProgressStage(
  job: StructuredCritiqueProgressLike,
): string | null {
  const progressStage = job?.progress_stage;
  return typeof progressStage === "string" && progressStage.trim().length > 0
    ? progressStage.trim()
    : null;
}

function readJobProgressMessage(
  job: StructuredCritiqueProgressLike,
): string | null {
  const progressMessage = job?.progress_message;
  if (typeof progressMessage === "string" && progressMessage.trim().length > 0) {
    return progressMessage.trim();
  }
  return readJobProgressStage(job) === "queued"
    ? "High-compute paper analysis queued."
    : null;
}

function buildPendingStatusMessage(
  job: StructuredCritiqueProgressLike,
): string {
  return readJobProgressMessage(job) ?? "Analyzing your document for reasoning flaws...";
}

function buildPendingRecoveryMessage(
  job: StructuredCritiqueProgressLike,
): string | null {
  return readJobProgressStage(job) === "queued"
    ? QUEUED_PROGRESS_RECOVERY_MESSAGE
    : null;
}

function buildPollTimeoutMessage(
  job: StructuredCritiqueProgressLike,
): string {
  return readJobProgressStage(job) === "queued"
    ? QUEUED_POLL_TIMEOUT_MESSAGE
    : POLL_TIMEOUT_MESSAGE;
}

function formatTimestamp(value?: string): string {
  if (!value) return "Just now";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Just now";
  return date.toLocaleString();
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function buildSubmittedTextPreview(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= 96) return compact || "Pasted text block";
  return `${compact.slice(0, 96)}...`;
}

function buildSubmittedInputFromJob(
  job: StructuredCritiqueJob | null | undefined,
): SubmittedReasoningInput | null {
  if (!job) return null;
  const filename = job.pdf_filename?.trim();
  if (filename) {
    return { kind: "pdf", name: filename };
  }
  return { kind: "text", preview: "Pasted text submission" };
}

function formatSubmittedInputTitle(input: SubmittedReasoningInput): string {
  return input.kind === "pdf" ? input.name : "Pasted text block";
}

function formatSubmittedInputMeta(input: SubmittedReasoningInput): string {
  if (input.kind === "pdf") {
    return typeof input.size === "number" && input.size > 0
      ? `PDF · ${formatFileSize(input.size)}`
      : "PDF";
  }
  return typeof input.charCount === "number" && input.charCount > 0
    ? `${input.charCount.toLocaleString()} characters`
    : "Text submission";
}

function formatJobSourceName(job: StructuredCritiqueJob): string {
  return (
    job.pdf_filename?.trim() ||
    job.result?.title?.trim() ||
    "Pasted text submission"
  );
}

function buildReasoningWaitEstimate(
  input: SubmittedReasoningInput | null,
  job: StructuredCritiqueProgressLike,
): { label: string; detail: string } {
  const stage = readJobProgressStage(job);
  if (stage === "queued") {
    return {
      label: "Queued; not started yet",
      detail:
        "Hosted reasoning jobs can sit in the queue before compute begins. It is safe to leave this page and reopen the run from Recent Reasoning Analyses.",
    };
  }

  if (input?.kind === "text") {
    if (typeof input.charCount !== "number" || input.charCount <= 0) {
      return {
        label: "Often 20-60 minutes for pasted text",
        detail:
          "No live ETA is available yet. Longer excerpts may run longer when the hosted queue is busy.",
      };
    }
    if (input.charCount < 12_000) {
      return {
        label: "Usually 10-30 minutes for short text",
        detail:
          "No live ETA is available yet; this estimate is based only on the submitted input size.",
      };
    }
    return {
      label: "Often 20-60 minutes for longer pasted text",
      detail:
        "Large excerpts may run longer when the hosted queue is busy.",
    };
  }

  if (input?.kind === "pdf") {
    if (typeof input.size !== "number" || input.size <= 0) {
      return {
        label: "Often 30-120+ minutes for paper PDFs",
        detail:
          "No live ETA is available yet. Large PDFs can take over 1 hour to process, especially when the hosted queue is busy.",
      };
    }
    if (input.size < 5 * 1024 * 1024) {
      return {
        label: "Often 30-90 minutes for a paper PDF",
        detail:
          "Shorter or text-light PDFs may finish sooner; queue spikes and large papers can take over 1 hour to process.",
      };
    }
    return {
      label: "Plan for 45-120+ minutes for large PDFs",
      detail:
        "Large PDFs can take over 1 hour to process. This is a high-compute run without backend progress percentages yet, so long waits do not necessarily mean failure.",
    };
  }

  return {
    label: "Expect tens of minutes; full papers may exceed an hour",
    detail:
      "No live ETA is available yet. Keep this page open or return from Recent Reasoning Analyses later.",
  };
}

function loadStoredHistory(): StoredStructuredCritiqueJob[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .flatMap((item): StoredStructuredCritiqueJob[] => {
        if (typeof item?.saved_at !== "string") return [];
        const normalized = tryNormalizeStructuredCritiqueJobPayload(item);
        if (!normalized.ok) return [];
        return [{ ...normalized.job, saved_at: item.saved_at }];
      })
      .sort((left, right) => right.saved_at.localeCompare(left.saved_at));
  } catch {
    return [];
  }
}

function readHistoryTimestampCandidate(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function deriveStoredJobTimestamp(job: StructuredCritiqueProgressLike): string {
  return (
    readHistoryTimestampCandidate(job?.completed_at) ||
    readHistoryTimestampCandidate(job?.updated_at) ||
    readHistoryTimestampCandidate(job?.started_at) ||
    readHistoryTimestampCandidate(job?.created_at) ||
    readHistoryTimestampCandidate(job?.saved_at) ||
    new Date().toISOString()
  );
}

function saveStoredHistory(entries: StoredStructuredCritiqueJob[]): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
}

function upsertStoredJob(
  entries: StoredStructuredCritiqueJob[],
  job: StructuredCritiqueJob,
  options?: { savedAt?: string },
): StoredStructuredCritiqueJob[] {
  const nextEntry: StoredStructuredCritiqueJob = {
    ...job,
    saved_at: options?.savedAt ?? deriveStoredJobTimestamp(job),
  };
  return [nextEntry, ...entries.filter((entry) => entry.id !== job.id)]
    .sort((left, right) => right.saved_at.localeCompare(left.saved_at))
    .slice(0, 12);
}

function mergeStoredJobs(
  entries: StoredStructuredCritiqueJob[],
  jobs: StructuredCritiqueJob[],
): StoredStructuredCritiqueJob[] {
  return jobs.reduce(
    (currentEntries, job) => upsertStoredJob(currentEntries, job),
    entries,
  );
}

function statusBadgeClasses(status: StructuredCritiqueStatus): string {
  switch (status) {
    case "COMPLETED":
      return "bg-emerald-500/10 text-emerald-700 border-emerald-200";
    case "FAILED":
    case "CANCELLED":
      return "bg-rose-500/10 text-rose-700 border-rose-200";
    case "RUNNING":
      return "bg-amber-500/10 text-amber-700 border-amber-200";
    default:
      return "bg-surface text-muted border-border";
  }
}

async function readJob(
  jobId: string,
  headers: HeadersInit = {},
): Promise<StructuredCritiqueJob> {
  const response = await fetch(`/api/structured-critique?job_id=${encodeURIComponent(jobId)}`, {
    cache: "no-store",
    headers,
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(readErrorFromPayload(payload) || "Structured critique refresh failed");
  }
  return normalizeStructuredCritiqueJobPayload(payload);
}

function readErrorFromPayload(payload: unknown): string | null {
  if (payload && typeof payload === "object" && "error" in payload) {
    const error = (payload as { error?: unknown }).error;
    return typeof error === "string" ? error : null;
  }
  return null;
}

function normalizePersistedCritiqueSummaries(payload: unknown): PersistedCritiqueSummary[] {
  const rawEntries =
    payload && typeof payload === "object" && "audits" in payload
      ? (payload as { audits?: unknown }).audits
      : payload;
  if (!Array.isArray(rawEntries)) return [];
  return rawEntries.flatMap((entry): PersistedCritiqueSummary[] => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    if (typeof record.brain_slug !== "string" || record.brain_slug.trim().length === 0) {
      return [];
    }
    const title =
      typeof record.title === "string" && record.title.trim().length > 0
        ? record.title.trim()
        : record.brain_slug.trim();
    return [
      {
        brain_slug: record.brain_slug.trim(),
        parent_slug: typeof record.parent_slug === "string" ? record.parent_slug : undefined,
        project_slug: typeof record.project_slug === "string" ? record.project_slug : undefined,
        title,
        uploaded_at: typeof record.uploaded_at === "string" ? record.uploaded_at : undefined,
        source_filename:
          typeof record.source_filename === "string" ? record.source_filename : undefined,
        descartes_job_id:
          typeof record.descartes_job_id === "string" ? record.descartes_job_id : undefined,
        finding_count:
          typeof record.finding_count === "number" && Number.isFinite(record.finding_count)
            ? record.finding_count
            : undefined,
        url: typeof record.url === "string" ? record.url : undefined,
        project_url: typeof record.project_url === "string" ? record.project_url : undefined,
      },
    ];
  });
}

async function listPersistedCritiques(): Promise<PersistedCritiqueSummary[]> {
  const response = await fetch("/api/brain/critique?limit=50", { cache: "no-store" });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(readErrorFromPayload(payload) || "Failed to load saved reasoning analyses");
  }
  return normalizePersistedCritiqueSummaries(payload);
}

async function listHostedCritiqueHistory(
  headers: HeadersInit = {},
): Promise<StructuredCritiqueJob[]> {
  const response = await fetch("/api/structured-critique?history=1&limit=50", {
    cache: "no-store",
    headers,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      readErrorFromPayload(payload) || "Failed to load hosted reasoning analyses",
    );
  }
  const jobs =
    payload && typeof payload === "object" && "jobs" in payload
      ? (payload as { jobs?: unknown }).jobs
      : payload;
  if (!Array.isArray(jobs)) {
    throw new Error("Hosted reasoning history returned an invalid response");
  }
  return jobs.map((job) => normalizeStructuredCritiqueJobPayload(job));
}

async function readBrainPage(slug: string): Promise<BrainPageResponse> {
  const response = await fetch(`/api/brain/page?slug=${encodeURIComponent(slug)}`, {
    cache: "no-store",
  });
  const payload = (await response.json()) as BrainPageResponse;
  if (!response.ok) {
    throw new Error(payload.error || "brain read failed");
  }
  return payload;
}

function buildSavedBrainStatus(
  slug: string,
  page: { frontmatter?: Record<string, unknown> },
  summary?: PersistedCritiqueSummary,
): Extract<BrainSaveStatus, { state: "saved" }> {
  const projectSlug =
    summary?.project_slug ||
    (typeof page.frontmatter?.project === "string" ? page.frontmatter.project : undefined);
  const encodedSlug = encodeURIComponent(slug);
  return {
    state: "saved",
    slug,
    url: summary?.url || `/dashboard/reasoning?brain_slug=${encodedSlug}`,
    projectUrl:
      summary?.project_url ||
      (projectSlug
        ? `/dashboard/project?name=${encodeURIComponent(projectSlug)}&brain_slug=${encodedSlug}`
        : undefined),
  };
}

// Hydrate a persisted audit-revise critique page from gbrain
// into the same `StructuredCritiqueJob` shape the live-job path produces.
// The critique page body carries a fenced JSON block with the full
// Descartes response (plan principle 6 — verbatim persistence); we
// pull it out here so the existing rendering components stay untouched.
function brainPageToCritiqueJob(
  slug: string,
  payload: {
    slug?: string;
    title?: string;
    type?: string;
    content?: string;
    frontmatter?: Record<string, unknown>;
  },
): StructuredCritiqueJob | null {
  const fm = payload.frontmatter ?? {};
  if (fm.type !== "critique") return null;
  const body = payload.content ?? "";
  const match = body.match(/```json\s*\n([\s\S]*?)\n```/);
  if (!match) return null;
  let parsed: StructuredCritiqueResult;
  try {
    parsed = normalizeStructuredCritiqueResultPayload(JSON.parse(match[1]));
  } catch {
    return null;
  }
  const styleProfile =
    typeof fm.style_profile === "string"
      ? fm.style_profile
      : DEFAULT_STYLE_PROFILE;
  const parentSlug =
    typeof fm.parent === "string" && fm.parent.length > 0 ? fm.parent : slug;
  try {
    return normalizeStructuredCritiqueJobPayload({
      id: `brain:${slug}`,
      status: "COMPLETED",
      pdf_filename: `${parentSlug}.pdf`,
      style_profile: styleProfile,
      result: parsed,
    });
  } catch {
    return null;
  }
}

function brainPageToArtifact(
  requestedSlug: string,
  payload: {
    slug?: string;
    title?: string;
    type?: string;
    content?: string;
    frontmatter?: Record<string, unknown>;
  },
): BrainArtifactPage {
  const frontmatter = payload.frontmatter ?? {};
  const frontmatterType =
    typeof frontmatter.type === "string" && frontmatter.type.length > 0
      ? frontmatter.type
      : null;
  const titleFromFrontmatter =
    typeof frontmatter.title === "string" && frontmatter.title.length > 0
      ? frontmatter.title
      : null;
  return {
    slug: payload.slug ?? requestedSlug,
    title: payload.title ?? titleFromFrontmatter ?? requestedSlug,
    type: frontmatterType ?? payload.type ?? "page",
    content: payload.content ?? "",
    frontmatter,
  };
}

function formatArtifactType(type: string): string {
  return type.replace(/_/g, " ");
}

function formatArtifactValue(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Derived helpers for the workspace
// ---------------------------------------------------------------------------

const SEVERITY_ORDER: Record<string, number> = { error: 0, warning: 1, note: 2 };

function normalizeSeverity(s?: string): "error" | "warning" | "note" {
  if (!s) return "note";
  const lower = s.toLowerCase();
  if (lower === "error" || lower === "critical") return "error";
  if (lower === "warning") return "warning";
  return "note";
}

function severityDotClass(severity: "error" | "warning" | "note"): string {
  switch (severity) {
    case "error":
      return "bg-red-600";
    case "warning":
      return "bg-amber-500";
    case "note":
      return "bg-gray-400";
  }
}

function severityTextClass(severity: "error" | "warning" | "note"): string {
  switch (severity) {
    case "error":
      return "text-red-600";
    case "warning":
      return "text-amber-600";
    case "note":
      return "text-gray-500";
  }
}

function severityLabel(severity: "error" | "warning" | "note"): string {
  switch (severity) {
    case "error":
      return "Error";
    case "warning":
      return "Warning";
    case "note":
      return "Note";
  }
}

function findingKindChipClasses(kind?: string): string {
  switch (kind) {
    case "fallacy":
      return "bg-orange-100 text-orange-700";
    case "gap":
      return "bg-blue-100 text-blue-700";
    default:
      return "bg-gray-100 text-gray-700";
  }
}

function sortedFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    const aOrder = SEVERITY_ORDER[normalizeSeverity(a.severity)] ?? 2;
    const bOrder = SEVERITY_ORDER[normalizeSeverity(b.severity)] ?? 2;
    return aOrder - bOrder;
  });
}

type QualityLevel = "GOOD" | "FAIR" | "POOR";

function deriveQuality(findings: Finding[]): QualityLevel {
  const errorCount = findings.filter(
    (f) => normalizeSeverity(f.severity) === "error",
  ).length;
  if (errorCount === 0) return "GOOD";
  if (errorCount <= 2) return "FAIR";
  return "POOR";
}

function qualityBadgeClasses(level: QualityLevel): string {
  switch (level) {
    case "GOOD":
      return "bg-emerald-100 text-emerald-700";
    case "FAIR":
      return "bg-amber-100 text-amber-700";
    case "POOR":
      return "bg-red-100 text-red-700";
  }
}

function countBySeverity(findings: Finding[]): { errors: number; warnings: number; notes: number } {
  let errors = 0;
  let warnings = 0;
  let notes = 0;
  for (const f of findings) {
    const s = normalizeSeverity(f.severity);
    if (s === "error") errors++;
    else if (s === "warning") warnings++;
    else notes++;
  }
  return { errors, warnings, notes };
}

function slugifyFileStem(value: string): string {
  const stem = value
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return stem || "deep-reasoning-analysis";
}

function downloadTextFile(filename: string, content: string): void {
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function QualityBadge({ level }: { level: QualityLevel }) {
  return (
    <span
      className={`inline-flex items-center rounded px-2 py-0.5 text-sm font-semibold ${qualityBadgeClasses(level)}`}
    >
      {level}
    </span>
  );
}

function SeverityDot({ severity }: { severity: "error" | "warning" | "note" }) {
  return (
    <span
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${severityDotClass(severity)}`}
      aria-hidden="true"
    />
  );
}

function FindingKindChip({ kind }: { kind?: string }) {
  const label = kind || "critique";
  return (
    <span
      className={`px-2 py-0.5 rounded text-xs ${findingKindChipClasses(kind)}`}
      aria-label={`${label} finding type`}
    >
      {label}
    </span>
  );
}

function SkeletonRows() {
  return (
    <div className="space-y-1">
      {Array.from({ length: 7 }).map((_, i) => (
        <div key={i} className="flex items-center gap-2 py-2 px-3">
          <div className="h-2 w-2 rounded-full bg-gray-200 animate-pulse" />
          <div className="flex-1 space-y-1">
            <div className="h-3 w-24 rounded bg-gray-200 animate-pulse" />
            <div className="h-2.5 w-40 rounded bg-gray-100 animate-pulse" />
          </div>
        </div>
      ))}
    </div>
  );
}

function ElapsedTimer({ startTime }: { startTime: number }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTime) / 1000));
    }, 1000);
    return () => window.clearInterval(id);
  }, [startTime]);

  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  return (
    <span className="font-mono text-sm text-muted">
      {mins}:{secs.toString().padStart(2, "0")}
    </span>
  );
}

function SubmittedInputSummary({
  input,
  compact = false,
}: {
  input: SubmittedReasoningInput;
  compact?: boolean;
}) {
  return (
    <div
      className={`rounded-lg border border-emerald-200 bg-emerald-50/70 ${
        compact ? "px-3 py-2" : "px-4 py-3"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10px] font-medium uppercase tracking-widest text-emerald-700">
            Submitted
          </p>
          <p className="mt-0.5 truncate text-sm font-medium text-slate-900">
            {formatSubmittedInputTitle(input)}
          </p>
          {input.kind === "text" ? (
            <p className="mt-1 line-clamp-2 text-xs leading-5 text-slate-600">
              {input.preview}
            </p>
          ) : null}
        </div>
        <span className="shrink-0 rounded-full border border-emerald-200 bg-white px-2 py-1 text-[10px] font-medium text-emerald-700">
          received
        </span>
      </div>
      <p className="mt-1 text-xs text-slate-600">{formatSubmittedInputMeta(input)}</p>
    </div>
  );
}

function ReasoningWaitGuidance({
  input,
  job,
}: {
  input: SubmittedReasoningInput | null;
  job: StructuredCritiqueProgressLike;
}) {
  const estimate = buildReasoningWaitEstimate(input, job);
  return (
    <div className="max-w-md rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-left">
      <p className="text-xs font-semibold text-amber-900">{estimate.label}</p>
      <p className="mt-1 text-xs leading-5 text-amber-800">{estimate.detail}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Top Strip / Executive Summary
// ---------------------------------------------------------------------------

function TopStrip({
  findings,
  overallSummary,
  authControls,
}: {
  findings?: Finding[];
  overallSummary?: string;
  authControls?: React.ReactNode;
}) {
  const hasFindings = findings && findings.length > 0;
  const quality = hasFindings ? deriveQuality(findings) : null;
  const counts = hasFindings ? countBySeverity(findings) : null;

  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-gray-100 bg-white px-6 py-3">
      <Link
        href="/dashboard/project"
        className="text-sm font-medium text-muted hover:text-accent transition-colors mr-1"
      >
        ScienceSwarm
      </Link>
      <span className="text-2xl font-semibold">Deep Reasoning API</span>
      {quality ? <QualityBadge level={quality} /> : null}
      {hasFindings ? (
        <span className="text-sm text-muted">
          {findings.length} finding{findings.length !== 1 ? "s" : ""}
        </span>
      ) : null}
      {counts ? (
        <span className="text-sm text-muted">
          {counts.errors} error{counts.errors !== 1 ? "s" : ""}
          {" \u00b7 "}
          {counts.warnings} warning{counts.warnings !== 1 ? "s" : ""}
          {" \u00b7 "}
          {counts.notes} note{counts.notes !== 1 ? "s" : ""}
        </span>
      ) : null}
      {(overallSummary || authControls) ? (
        <div className="ml-auto flex items-center gap-3">
          {overallSummary ? (
            <span className="max-w-md truncate text-sm text-muted" title={overallSummary}>
              &ldquo;{overallSummary}&rdquo;
            </span>
          ) : null}
          {authControls}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Issue Queue Item
// ---------------------------------------------------------------------------

function IssueQueueItem({
  finding,
  isSelected,
  onSelect,
  onKeyDown,
}: {
  finding: Finding;
  isSelected: boolean;
  onSelect: () => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
}) {
  const severity = normalizeSeverity(finding.severity);
  const selectedBg = isSelected
    ? "bg-teal-50 border-l-[3px] border-l-teal-500"
    : "border-l-[3px] border-l-transparent hover:bg-gray-50";

  return (
    <button
      type="button"
      onClick={onSelect}
      onKeyDown={onKeyDown}
      tabIndex={0}
      aria-label={`${severityLabel(severity)} finding: ${finding.flaw_type || finding.description || finding.finding_id || "finding"}`}
      className={`w-full text-left py-2 px-3 transition-colors cursor-pointer ${selectedBg}`}
    >
      <div className="flex items-center gap-2">
        <SeverityDot severity={severity} />
        <span
          className={`text-xs font-medium uppercase ${severityTextClass(severity)}`}
          aria-label={`${severityLabel(severity)} severity`}
        >
          {severity === "error" ? "ERR" : severity === "warning" ? "WRN" : "NOTE"}
        </span>
        <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-mono text-gray-700">
          {finding.flaw_type || finding.finding_id || "finding"}
        </span>
      </div>
      {finding.description ? (
        <p className="text-xs text-muted truncate mt-0.5 pl-[18px]">
          {finding.description}
        </p>
      ) : null}
    </button>
  );
}

function ReportOverview({
  job,
  brainSaveStatus = { state: "idle" },
  onSaveToBrain,
}: {
  job: StructuredCritiqueJob;
  brainSaveStatus?: BrainSaveStatus;
  onSaveToBrain?: () => void;
}) {
  const title = job.result?.title || job.pdf_filename;
  const topIssues = job.result?.author_feedback?.top_issues ?? [];
  const reportMarkdown = job.result?.report_markdown?.trim() || "";
  const fileStem = slugifyFileStem(title || job.id);
  const canSaveToBrain =
    job.status === "COMPLETED" &&
    !!job.result &&
    typeof onSaveToBrain === "function";

  return (
    <div className="border-b border-gray-100 px-6 py-5 space-y-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-2">
          <div className={SECTION_LABEL}>Analysis overview</div>
          <h2 className="text-xl font-semibold text-foreground">{title}</h2>
        </div>
        {job.result ? (
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => {
                if (reportMarkdown) {
                  downloadTextFile(`${fileStem}.md`, reportMarkdown);
                }
              }}
              disabled={!reportMarkdown}
              className="rounded-lg border border-gray-200 px-3 py-2 text-xs font-medium text-foreground transition-colors hover:border-gray-300 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Export Markdown
            </button>
            <button
              type="button"
              onClick={() => window.print()}
              className="rounded-lg border border-gray-200 px-3 py-2 text-xs font-medium text-foreground transition-colors hover:border-gray-300"
            >
              Export PDF
            </button>
            {canSaveToBrain ? (
              <>
                <button
                  type="button"
                  onClick={onSaveToBrain}
                  disabled={brainSaveStatus.state === "saving"}
                  className="rounded-lg border border-gray-200 px-3 py-2 text-xs font-medium text-foreground transition-colors hover:border-gray-300 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {brainSaveStatus.state === "saving"
                    ? "Saving..."
                    : brainSaveStatus.state === "saved"
                      ? "Saved to brain"
                      : "Save to brain"}
                </button>
                {brainSaveStatus.state === "saved" ? (
                  <>
                    <Link
                      href={brainSaveStatus.projectUrl ?? brainSaveStatus.url}
                      className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-700 transition-colors hover:border-emerald-300"
                    >
                      Open in file tree
                    </Link>
                    <Link
                      href={brainSaveStatus.url}
                      className="rounded-lg border border-gray-200 px-3 py-2 text-xs font-medium text-foreground transition-colors hover:border-gray-300"
                    >
                      Analysis link
                    </Link>
                  </>
                ) : null}
              </>
            ) : null}
          </div>
        ) : null}
      </div>
      {brainSaveStatus.state === "error" ? (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
          {brainSaveStatus.error}
        </div>
      ) : null}

      {topIssues.length > 0 ? (
        <div className="space-y-2">
          <div className={SECTION_LABEL}>
            Top issues
          </div>
          <div className="grid gap-2 md:grid-cols-2">
            {topIssues.map((issue, index) => (
              <div key={`${issue.title || "issue"}-${index}`} className="rounded-lg border border-gray-100 bg-gray-50/70 p-3">
                <div className="text-sm font-medium text-foreground">
                  {index + 1}. {issue.title || "Issue"}
                </div>
                {issue.summary ? (
                  <p className="mt-1 text-sm text-muted">{issue.summary}</p>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {reportMarkdown ? (
        <details className="rounded-lg border border-gray-100 bg-gray-50/70 p-3">
          <summary className="cursor-pointer text-sm font-medium text-foreground">
            Report markdown
          </summary>
          <pre className="mt-3 whitespace-pre-wrap font-mono text-xs leading-6 text-foreground">
            {reportMarkdown}
          </pre>
        </details>
      ) : null}
    </div>
  );
}

function BrainArtifactViewer({ artifact }: { artifact: BrainArtifactPage }) {
  const status = formatArtifactValue(artifact.frontmatter.status);
  const parent = formatArtifactValue(artifact.frontmatter.parent);
  const critique = formatArtifactValue(artifact.frontmatter.critique);
  const plan = formatArtifactValue(artifact.frontmatter.plan);
  const source = formatArtifactValue(artifact.frontmatter.source_filename);
  const details = [
    status ? ["Status", status] : null,
    parent ? ["Parent", parent] : null,
    critique ? ["Critique", critique] : null,
    plan ? ["Plan", plan] : null,
    source ? ["Source", source] : null,
  ].filter((entry): entry is [string, string] => entry !== null);

  return (
    <article className="mx-auto flex min-h-full w-full max-w-5xl flex-col px-6 py-6">
      <div className="border-b border-gray-100 pb-5">
        <div className={SECTION_LABEL}>{formatArtifactType(artifact.type)}</div>
        <h1 className="mt-2 text-2xl font-semibold text-foreground">
          {artifact.title}
        </h1>
        <div className="mt-2 font-mono text-xs text-muted">{artifact.slug}</div>
        {details.length > 0 ? (
          <dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {details.map(([label, value]) => (
              <div key={label} className="border-l border-gray-200 pl-3">
                <dt className={SECTION_LABEL}>{label}</dt>
                <dd className="mt-1 break-words text-sm text-foreground">
                  {value}
                </dd>
              </div>
            ))}
          </dl>
        ) : null}
      </div>
      <pre className="mt-5 whitespace-pre-wrap font-mono text-sm leading-7 text-foreground">
        {artifact.content || "(empty page)"}
      </pre>
    </article>
  );
}

// ---------------------------------------------------------------------------
// Filter Chips
// ---------------------------------------------------------------------------

function FilterChips({
  active,
  onToggle,
}: {
  active: Set<FilterKind>;
  onToggle: (kind: FilterKind) => void;
}) {
  const chips: { kind: FilterKind; label: string }[] = [
    { kind: "critique", label: "Critique" },
    { kind: "fallacy", label: "Fallacy" },
    { kind: "gap", label: "Gap" },
  ];
  return (
    <div className="flex gap-2 px-3">
      {chips.map((c) => {
        const isActive = active.has(c.kind);
        return (
          <button
            key={c.kind}
            type="button"
            onClick={() => onToggle(c.kind)}
            className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${
              isActive
                ? "border-accent bg-accent/10 text-accent font-medium"
                : "border-gray-200 bg-white text-muted hover:border-gray-300"
            }`}
          >
            {c.label}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Finding Detail Panel
// ---------------------------------------------------------------------------

function FindingDetail({
  finding,
  jobId,
}: {
  finding: Finding;
  jobId: string;
}) {
  const severity = normalizeSeverity(finding.severity);
  const [useful, setUseful] = useState<boolean | null>(null);
  const [wouldRevise, setWouldRevise] = useState<boolean | null>(null);
  const [feedbackSent, setFeedbackSent] = useState(false);
  const [isSubmittingFeedback, setIsSubmittingFeedback] = useState(false);
  const [feedbackError, setFeedbackError] = useState<string | null>(null);
  const [feedbackComment, setFeedbackComment] = useState("");
  const [feedbackRecords, setFeedbackRecords] = useState<StructuredCritiqueFeedbackRecord[]>([]);
  const [feedbackSummary, setFeedbackSummary] = useState<StructuredCritiqueFeedbackSummary | null>(null);

  useEffect(() => {
    if (!finding.finding_id) {
      setFeedbackRecords([]);
      setFeedbackSummary(null);
      return;
    }
    const findingId = finding.finding_id;
    let cancelled = false;
    const loadFeedback = async () => {
      try {
        const params = new URLSearchParams({
          job_id: jobId,
          finding_id: findingId,
        });
        const response = await fetch(`/api/structured-critique/feedback?${params.toString()}`, {
          cache: "no-store",
        });
        if (!response.ok) return;
        const payload = (await response.json().catch(() => null)) as
          | StructuredCritiqueFeedbackResponse
          | null;
        if (!payload || cancelled) return;
        setFeedbackRecords(payload.records ?? []);
        setFeedbackSummary(payload.summary ?? null);
      } catch {
        // Feedback history is helpful but should not block reading the critique.
      }
    };
    void loadFeedback();
    return () => {
      cancelled = true;
    };
  }, [finding.finding_id, jobId]);

  const submitFeedback = async (nextUseful: boolean, nextWouldRevise: boolean) => {
    setIsSubmittingFeedback(true);
    setFeedbackError(null);
    try {
      const response = await fetch("/api/structured-critique/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          job_id: jobId,
          finding_id: finding.finding_id,
          useful: nextUseful,
          would_revise: nextWouldRevise,
          ...(feedbackComment.trim() ? { comment: feedbackComment.trim() } : {}),
        }),
      });
      const payload = (await response.json().catch(() => null)) as
        | (StructuredCritiqueFeedbackResponse & { error?: string })
        | null;
      if (!response.ok) {
        throw new Error(payload?.error || "Feedback could not be saved");
      }
      setFeedbackRecords(payload?.records ?? (payload?.record ? [payload.record] : []));
      setFeedbackSummary(payload?.summary ?? null);
      setFeedbackSent(true);
    } catch (err) {
      setFeedbackError(err instanceof Error ? err.message : "Feedback could not be saved");
    } finally {
      setIsSubmittingFeedback(false);
    }
  };

  const maybeSubmitFeedback = (nextUseful: boolean | null, nextWouldRevise: boolean | null) => {
    if (nextUseful === null || nextWouldRevise === null || feedbackSent || isSubmittingFeedback) {
      return;
    }
    void submitFeedback(nextUseful, nextWouldRevise);
  };

  const handleUseful = (value: boolean) => {
    setUseful(value);
    maybeSubmitFeedback(value, wouldRevise);
  };

  const handleWouldRevise = (value: boolean) => {
    setWouldRevise(value);
    maybeSubmitFeedback(useful, value);
  };

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-5">
      {/* Severity + type */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5">
          <SeverityDot severity={severity} />
          <span
            className={`text-sm font-medium ${severityTextClass(severity)}`}
            aria-label={`${severityLabel(severity)} severity`}
          >
            {severityLabel(severity)}
          </span>
        </span>
        {finding.flaw_type ? (
          <span className="bg-gray-100 text-gray-700 px-2 py-0.5 rounded text-xs font-mono">
            {finding.flaw_type}
          </span>
        ) : null}
        <FindingKindChip kind={finding.finding_kind} />
      </div>

      {/* Description */}
      {finding.description ? (
        <p className="text-sm leading-relaxed text-foreground">{finding.description}</p>
      ) : null}

      {/* Evidence quote */}
      {finding.evidence_quote ? (
        <blockquote className="text-sm italic border-l-2 border-gray-200 bg-gray-50 pl-4 py-3 text-muted">
          {finding.evidence_quote}
        </blockquote>
      ) : null}

      {/* Meta fields */}
      <div className="space-y-2">
        {finding.argument_id ? (
          <div className="text-xs">
            <span className="font-medium text-muted">Affected claim: </span>
            <span className="text-foreground font-mono">{finding.argument_id}</span>
          </div>
        ) : null}
        {finding.broken_link ? (
          <div className="text-xs">
            <span className="font-medium text-muted">Broken link: </span>
            <span className="text-foreground">{finding.broken_link}</span>
          </div>
        ) : null}
        {finding.impact ? (
          <div className="text-xs">
            <span className="font-medium text-muted">Impact: </span>
            <span className="text-foreground">{finding.impact}</span>
          </div>
        ) : null}
      </div>

      {/* Suggested fix */}
      {finding.suggested_fix ? (
        <div>
          <div className={`${SECTION_LABEL} mb-1`}>
            Suggested fix
          </div>
          <p className="text-sm leading-relaxed text-foreground bg-emerald-50 border border-emerald-100 rounded p-3">
            {finding.suggested_fix}
          </p>
        </div>
      ) : null}

      {/* Confidence */}
      {finding.confidence != null ? (
        <div className="text-xs text-muted">
          Confidence: {Math.round(finding.confidence * 100)}%
        </div>
      ) : null}

      {/* Feedback row — only show when finding has an ID the API can accept */}
      <div className="border-t border-gray-100 pt-4">
        {!finding.finding_id ? (
          <span className="text-xs text-muted">
            Feedback unavailable for this finding.
          </span>
        ) : (
          <div className="space-y-3">
            {feedbackSummary && feedbackSummary.total > 0 ? (
              <div className="rounded-lg border border-emerald-100 bg-emerald-50 px-3 py-2 text-xs text-emerald-900">
                <p className="font-semibold">Evaluation history for this output</p>
                <p className="mt-1">
                  {feedbackSummary.total} review{feedbackSummary.total === 1 ? "" : "s"}:
                  {" "}
                  {feedbackSummary.useful} helpful,
                  {" "}
                  {feedbackSummary.notUseful} not helpful,
                  {" "}
                  {feedbackSummary.wouldRevise} would revise.
                </p>
                <p className="mt-1">
                  Correction status: {feedbackSummary.unresolvedConcerns > 0
                    ? "concern recorded; no corrected successor is linked yet."
                    : "no unresolved concern recorded for this finding."}
                </p>
                {feedbackRecords[0]?.comment ? (
                  <p className="mt-1 text-emerald-800">
                    Latest note: {feedbackRecords[0].comment}
                  </p>
                ) : null}
              </div>
            ) : null}

            {feedbackSent ? (
              <span className="text-sm text-emerald-600 font-medium">
                Feedback recorded and added to this output&apos;s evaluation history.
              </span>
            ) : null}

            {!feedbackSent && (
              <>
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => handleUseful(true)}
                className="text-lg hover:scale-110 transition-transform disabled:cursor-not-allowed disabled:opacity-50"
                title="Useful"
                aria-pressed={useful === true}
                disabled={isSubmittingFeedback}
              >
                {"\ud83d\udc4d"}
              </button>
              <button
                type="button"
                onClick={() => handleUseful(false)}
                className="text-lg hover:scale-110 transition-transform disabled:cursor-not-allowed disabled:opacity-50"
                title="Not useful"
                aria-pressed={useful === false}
                disabled={isSubmittingFeedback}
              >
                {"\ud83d\udc4e"}
              </button>
              <span className="text-xs text-muted ml-2">Would you revise?</span>
              <button
                type="button"
                onClick={() => handleWouldRevise(true)}
                disabled={isSubmittingFeedback}
                className={`text-xs px-2 py-1 rounded border transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                  wouldRevise === true
                    ? "border-accent bg-accent/10 text-accent"
                    : "border-gray-200 text-muted hover:border-gray-300"
                }`}
              >
                yes
              </button>
              <button
                type="button"
                onClick={() => handleWouldRevise(false)}
                disabled={isSubmittingFeedback}
                className={`text-xs px-2 py-1 rounded border transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                  wouldRevise === false
                    ? "border-accent bg-accent/10 text-accent"
                    : "border-gray-200 text-muted hover:border-gray-300"
                }`}
              >
                no
              </button>
            </div>
            <label className="block text-xs text-muted">
              Optional note or friction
              <textarea
                value={feedbackComment}
                onChange={(event) => setFeedbackComment(event.target.value)}
                rows={2}
                className="mt-1 w-full rounded border border-gray-200 bg-white px-2 py-1 text-xs text-foreground"
                placeholder="What was helpful, wrong, confusing, or painful?"
                disabled={isSubmittingFeedback}
              />
            </label>
            {isSubmittingFeedback ? (
              <span className="text-xs text-muted">Saving feedback...</span>
            ) : feedbackError ? (
              <span className="text-xs text-rose-600">{feedbackError}</span>
            ) : useful !== null || wouldRevise !== null ? (
              <span className="text-xs text-muted">Choose the remaining answer to send feedback.</span>
            ) : null}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Skeleton fallback for Suspense
// ---------------------------------------------------------------------------

function StructuredCritiquePageSkeleton() {
  return (
    <div className="p-8 max-w-7xl">
      <div className="space-y-4">
        <div className="h-8 w-72 animate-pulse rounded bg-surface" />
        <div className="h-4 w-96 animate-pulse rounded bg-surface" />
      </div>
    </div>
  );
}

function EmptyWorkspacePanel({
  onShowExampleReport,
}: {
  onShowExampleReport: () => void;
}) {
  return (
    <div className="mx-auto flex min-h-full w-full max-w-3xl items-center justify-center px-6 py-10">
      <section className="w-full text-center">
        <p className={SECTION_LABEL}>Deep Reasoning</p>
        <h1 className="mt-3 text-3xl font-semibold text-foreground">
          Analyze a paper, memo, or argument for reasoning flaws.
        </h1>
        <p className="mx-auto mt-4 max-w-3xl text-sm leading-7 text-muted">
          Upload a PDF or paste text to deeply analyze the logic of a piece.
          The API focuses on weak evidence chains, hidden premises, causal
          leaps, and other structural problems that make an argument less
          trustworthy than it first appears.
        </p>
        <button
          type="button"
          onClick={onShowExampleReport}
          className="mt-5 rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-foreground transition-colors hover:border-gray-300 hover:bg-gray-50"
        >
          View example report
        </button>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Content Component
// ---------------------------------------------------------------------------

function StructuredCritiquePageContent() {
  const searchParams = useSearchParams();
  const {
    authDetail,
    beginSignIn,
    isLoaded: isAuthLoaded,
    isSignedIn,
    isSigningIn,
    signOut,
  } = useScienceSwarmLocalAuth();
  const requestedJobId = searchParams.get("job_id");
  const requestedBrainSlug = searchParams.get("brain_slug");
  const requestedBrainSlugRef = useRef<string | null>(null);

  // Core state (reused from original)
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [history, setHistory] = useState<StoredStructuredCritiqueJob[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [brainArtifact, setBrainArtifact] =
    useState<BrainArtifactPage | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isPolling, setIsPolling] = useState(false);
  const hydratedRef = useRef(false);
  const requestedJobRef = useRef<string | null>(null);
  const pollTokenRef = useRef(0);

  // New workspace state
  const [inputMode, setInputMode] = useState<InputMode>("pdf");
  const [pasteText, setPasteText] = useState("");
  const [selectedFindingIndex, setSelectedFindingIndex] = useState<number>(0);
  const [activeFilters, setActiveFilters] = useState<Set<FilterKind>>(new Set());
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [uploadAccepted, setUploadAccepted] = useState(false);
  const [submittedInput, setSubmittedInput] =
    useState<SubmittedReasoningInput | null>(null);
  const [showExampleReport, setShowExampleReport] = useState(false);
  const [pollStartTime, setPollStartTime] = useState<number | null>(null);
  const [structuredCritiqueAvailable, setStructuredCritiqueAvailable] = useState<boolean | null>(null);
  const [structuredCritiqueStatusDetail, setStructuredCritiqueStatusDetail] =
    useState<string | null>(null);
  const [brainSaveByJobId, setBrainSaveByJobId] = useState<Record<string, BrainSaveStatus>>({});
  const [persistedCritiques, setPersistedCritiques] = useState<PersistedCritiqueSummary[]>([]);
  const [isLoadingPersistedCritiques, setIsLoadingPersistedCritiques] = useState(true);

  const queueRef = useRef<HTMLDivElement>(null);
  const hostedHistoryHydratedRef = useRef(false);
  const autoSavedJobIdsRef = useRef<Set<string>>(new Set());
  const autoSaveAttemptCountsRef = useRef<Map<string, number>>(new Map());
  const getCritiqueHeaders = useCallback(async () => ({}), []);

  // ---------------------------------------------------------------------------
  // Reused core logic
  // ---------------------------------------------------------------------------

  const rememberJob = useCallback((job: StructuredCritiqueJob) => {
    setHistory((previous) => {
      const next = upsertStoredJob(previous, job);
      saveStoredHistory(next);
      return next;
    });
    setSelectedJobId(job.id);
  }, []);

  const mergeHostedHistory = useCallback((jobs: StructuredCritiqueJob[]) => {
    if (jobs.length === 0) return;
    setHistory((previous) => {
      const next = mergeStoredJobs(previous, jobs);
      saveStoredHistory(next);
      return next;
    });
  }, []);

  const pollJob = useCallback(
    async (initialJob: StructuredCritiqueJob): Promise<StructuredCritiqueJob> => {
      const token = ++pollTokenRef.current;
      let currentJob = initialJob;
      let pollCount = 0;

      if (isTerminalStatus(currentJob.status)) return currentJob;

      setIsPolling(true);
      setPollStartTime(Date.now());
      try {
        while (!isTerminalStatus(currentJob.status)) {
          if (pollCount >= MAX_POLLS) {
            throw new Error(buildPollTimeoutMessage(currentJob));
          }
          pollCount += 1;
          await new Promise((resolve) => window.setTimeout(resolve, POLL_INTERVAL_MS));
          if (pollTokenRef.current !== token) return currentJob;
          currentJob = await readJob(currentJob.id, await getCritiqueHeaders());
          rememberJob(currentJob);
        }
        return currentJob;
      } finally {
        if (pollTokenRef.current === token) {
          setIsPolling(false);
          setPollStartTime(null);
        }
      }
    },
    [getCritiqueHeaders, rememberJob],
  );

  const refreshJob = useCallback(
    async (jobId: string): Promise<StructuredCritiqueJob> => {
      const job = await readJob(jobId, await getCritiqueHeaders());
      rememberJob(job);
      if (!isTerminalStatus(job.status)) return pollJob(job);
      return job;
    },
    [getCritiqueHeaders, pollJob, rememberJob],
  );

  const loadBrainSlug = useCallback(
    async (slug: string, summary?: PersistedCritiqueSummary): Promise<void> => {
      const payload = await readBrainPage(slug);
      const job = brainPageToCritiqueJob(slug, payload);
      if (job) {
        setBrainArtifact(null);
        setShowExampleReport(false);
        setSubmittedInput(buildSubmittedInputFromJob(job));
        rememberJob(job);
        setBrainSaveByJobId((previous) => ({
          ...previous,
          [job.id]: buildSavedBrainStatus(slug, payload, summary),
        }));
        return;
      }
      setSelectedJobId(null);
      setError(null);
      setBrainArtifact(brainPageToArtifact(slug, payload));
    },
    [rememberJob],
  );

  // Hydrate history from localStorage
  useEffect(() => {
    const entries = loadStoredHistory();
    hydratedRef.current = true;
    setHistory(entries);
  }, []);

  // Load durable saved-audit history from gbrain. Browser localStorage is only
  // a cache; this list survives browser profiles and server restarts.
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      setIsLoadingPersistedCritiques(true);
      try {
        const entries = await listPersistedCritiques();
        if (!cancelled) {
          setPersistedCritiques(entries);
          if (entries.length > 0) {
            setHistoryExpanded(true);
          }
        }
      } catch {
        if (!cancelled) {
          setPersistedCritiques([]);
        }
      } finally {
        if (!cancelled) {
          setIsLoadingPersistedCritiques(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!isSignedIn) {
      hostedHistoryHydratedRef.current = false;
    }
  }, [isSignedIn]);

  useEffect(() => {
    if (
      hostedHistoryHydratedRef.current ||
      !isAuthLoaded ||
      !isSignedIn ||
      isLoadingPersistedCritiques
    ) {
      return;
    }

    hostedHistoryHydratedRef.current = true;
    let cancelled = false;

    void (async () => {
      try {
        const jobs = await listHostedCritiqueHistory(await getCritiqueHeaders());
        if (cancelled || jobs.length === 0) return;
        mergeHostedHistory(jobs);
        setHistoryExpanded(true);
      } catch {
        if (!cancelled) {
          hostedHistoryHydratedRef.current = false;
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    getCritiqueHeaders,
    isAuthLoaded,
    isLoadingPersistedCritiques,
    isSignedIn,
    mergeHostedHistory,
    persistedCritiques.length,
    requestedBrainSlug,
    requestedJobId,
    selectedJobId,
  ]);

  // Handle URL job_id param
  useEffect(() => {
    if (!hydratedRef.current || !requestedJobId || requestedJobRef.current === requestedJobId) return;
    requestedJobRef.current = requestedJobId;
    setSelectedJobId(requestedJobId);
    void refreshJob(requestedJobId).catch((err) => {
      setError(err instanceof Error ? err.message : "Structured critique refresh failed");
    });
  }, [refreshJob, requestedJobId]);

  // Handle URL brain_slug param — load a persisted critique from gbrain and
  // hydrate the same state the live-job path uses. Persists into localStorage
  // history so navigating back picks the same job up.
  useEffect(() => {
    if (
      !hydratedRef.current ||
      !requestedBrainSlug ||
      requestedBrainSlugRef.current === requestedBrainSlug
    ) {
      return;
    }
    requestedBrainSlugRef.current = requestedBrainSlug;
    let cancelled = false;
    void (async () => {
      try {
        if (cancelled) return;
        const summary = persistedCritiques.find(
          (entry) => entry.brain_slug === requestedBrainSlug,
        );
        await loadBrainSlug(requestedBrainSlug, summary);
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "brain critique load failed",
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadBrainSlug, persistedCritiques, requestedBrainSlug]);

  useEffect(() => {
    let cancelled = false;

    const loadHealth = async () => {
      try {
        const response = await fetch("/api/health", { cache: "no-store" });
        if (!response.ok) return;
        const payload = (await response.json()) as HealthResponse;
        if (!cancelled) {
          const detail =
            typeof payload.structuredCritique?.detail === "string" &&
            payload.structuredCritique.detail.trim().length > 0
              ? payload.structuredCritique.detail
              : null;
          const userFacingUnavailableDetail =
            detail && /strict local-only/i.test(detail) ? detail : null;
          const available =
            typeof payload.structuredCritique?.ready === "boolean"
              ? payload.structuredCritique.ready
              : typeof payload.features?.structuredCritique === "boolean"
                ? payload.features.structuredCritique
                : null;
          setStructuredCritiqueAvailable(
            available,
          );
          setStructuredCritiqueStatusDetail(
            available === false
              ? userFacingUnavailableDetail ?? STRUCTURED_CRITIQUE_UNAVAILABLE_FALLBACK
              : detail,
          );
        }
      } catch {
        if (!cancelled) {
          setStructuredCritiqueAvailable(null);
          setStructuredCritiqueStatusDetail(null);
        }
      }
    };

    void loadHealth();
    return () => {
      cancelled = true;
    };
  }, []);

  // Cleanup poll on unmount
  useEffect(() => {
    return () => {
      pollTokenRef.current += 1;
    };
  }, []);

  const selectedJob = history.find((entry) => entry.id === selectedJobId) ?? null;
  const structuredCritiqueUnavailableMessage =
    structuredCritiqueAvailable === false
      ? structuredCritiqueStatusDetail ?? STRUCTURED_CRITIQUE_UNAVAILABLE_FALLBACK
      : null;
  const localJobIds = new Set(history.map((entry) => entry.id));
  const persistedHistory = persistedCritiques.filter((entry) => {
    if (localJobIds.has(`brain:${entry.brain_slug}`)) return false;
    if (entry.descartes_job_id && localJobIds.has(entry.descartes_job_id)) return false;
    return true;
  });
  const exampleJob = showExampleReport ? EXAMPLE_REASONING_JOB : null;
  const activeJob = selectedJob ?? exampleJob;
  const activeSubmittedInput =
    submittedInput ?? buildSubmittedInputFromJob(activeJob);

  // ---------------------------------------------------------------------------
  // Derived data
  // ---------------------------------------------------------------------------

  const allFindings: Finding[] = activeJob?.result?.findings ?? [];
  const sorted = sortedFindings(allFindings);

  // Apply filters
  const filteredFindings =
    activeFilters.size === 0
      ? sorted
      : sorted.filter((f) => {
          const kind = (f.finding_kind || "critique") as FilterKind;
          return activeFilters.has(kind);
        });

  const selectedFinding = filteredFindings[selectedFindingIndex] ?? null;
  const hasCompletedResults = activeJob?.status === "COMPLETED" && allFindings.length > 0;
  const isPartialFailure =
    isErrorStatus(activeJob?.status) && allFindings.length > 0;
  const isFullFailure =
    isErrorStatus(activeJob?.status) && allFindings.length === 0;
  const zeroFindings =
    activeJob?.status === "COMPLETED" && allFindings.length === 0;
  const activeJobPendingStatusMessage = buildPendingStatusMessage(activeJob);
  const activeJobPendingRecoveryMessage = buildPendingRecoveryMessage(activeJob);
  const timedOutMessage = buildPollTimeoutMessage(selectedJob);
  const isTimedOutJob =
    !!selectedJob &&
    !isTerminalStatus(selectedJob.status) &&
    !(isSubmitting || isPolling) &&
    error === timedOutMessage;

  // Auto-select first finding when results arrive
  const prevFindingsLenRef = useRef(0);
  useEffect(() => {
    if (filteredFindings.length > 0 && prevFindingsLenRef.current === 0) {
      setSelectedFindingIndex(0);
    }
    prevFindingsLenRef.current = filteredFindings.length;
  }, [filteredFindings.length]);

  // Reset finding index when job changes
  useEffect(() => {
    setSelectedFindingIndex(0);
  }, [selectedJobId]);

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  const handleSelectHistoryJob = useCallback(
    (job: StoredStructuredCritiqueJob) => {
      setBrainArtifact(null);
      setShowExampleReport(false);
      setSelectedJobId(job.id);
      setError(null);
      setUploadAccepted(false);
      setSubmittedInput(buildSubmittedInputFromJob(job));
      setSelectedFindingIndex(0);
      if (!isTerminalStatus(job.status)) {
        void refreshJob(job.id).catch((err) => {
          setError(err instanceof Error ? err.message : "Structured critique refresh failed");
        });
      }
    },
    [refreshJob],
  );

  const handleSelectPersistedCritique = useCallback(
    (summary: PersistedCritiqueSummary) => {
      setError(null);
      setShowExampleReport(false);
      setUploadAccepted(false);
      setSubmittedInput(
        summary.source_filename
          ? { kind: "pdf", name: summary.source_filename, size: 0 }
          : { kind: "text", charCount: 0, preview: summary.title || "Saved reasoning analysis" },
      );
      setSelectedFindingIndex(0);
      void loadBrainSlug(summary.brain_slug, summary).catch((err) => {
        setError(err instanceof Error ? err.message : "brain critique load failed");
      });
    },
    [loadBrainSlug],
  );

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    if (!file) {
      setSelectedFile(null);
      setSubmittedInput(null);
      setUploadAccepted(false);
      return;
    }
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      setError("Only PDF files are supported for structured critique.");
      setSelectedFile(null);
      event.target.value = "";
      return;
    }
    setError(null);
    setSelectedFile(file);
    setSubmittedInput(null);
    setUploadAccepted(false);
    setShowExampleReport(false);
  };

  const handleAnalyze = async () => {
    const hasPdfInput = inputMode === "pdf" && selectedFile;
    const hasTextInput = inputMode === "text" && pasteText.trim().length > 0;
    if ((!hasPdfInput && !hasTextInput) || isSubmitting || isPolling) return;
    if (structuredCritiqueAvailable === false) {
      setError(
        structuredCritiqueUnavailableMessage
          ?? STRUCTURED_CRITIQUE_UNAVAILABLE_FALLBACK,
      );
      return;
    }
    if (!isAuthLoaded) {
      setError(REASONING_AUDIT_LOADING_AUTH_MESSAGE);
      return;
    }
    if (!isSignedIn) {
      setError(authDetail || SCIENCESWARM_CRITIQUE_SIGN_IN_REQUIRED_MESSAGE);
      return;
    }

    pollTokenRef.current += 1;
    setError(null);
    setBrainArtifact(null);
    setShowExampleReport(false);
    setSelectedJobId(null);
    setIsSubmitting(true);
    setUploadAccepted(false);
    setSelectedFindingIndex(0);
    setSubmittedInput(
      inputMode === "pdf" && selectedFile
        ? { kind: "pdf", name: selectedFile.name, size: selectedFile.size }
        : {
            kind: "text",
            charCount: pasteText.trim().length,
            preview: buildSubmittedTextPreview(pasteText),
          },
    );

    try {
      const formData = new FormData();
      if (inputMode === "pdf" && selectedFile) {
        formData.append("file", selectedFile);
      } else {
        formData.append("text", pasteText.trim());
      }
      formData.append("style_profile", DEFAULT_STYLE_PROFILE);

      const response = await fetch("/api/structured-critique", {
        method: "POST",
        headers: await getCritiqueHeaders(),
        body: formData,
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(readErrorFromPayload(payload) || "Structured critique failed");
      }

      const job = normalizeStructuredCritiqueJobPayload(payload);
      setUploadAccepted(true);
      rememberJob(job);
      await pollJob(job);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Structured critique failed");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRetry = () => {
    const hasPdfInput = inputMode === "pdf" && selectedFile;
    const hasTextInput = inputMode === "text" && pasteText.trim().length > 0;
    if (!hasPdfInput && !hasTextInput) {
      setError("No input available to retry. Please select a PDF or paste text to analyze.");
      return;
    }
    setError(null);
    void handleAnalyze();
  };

  const handleShowExampleReport = () => {
    setIsPolling(false);
    setPollStartTime(null);
    pollTokenRef.current += 1;
    setBrainArtifact(null);
    setSelectedJobId(null);
    setError(null);
    setUploadAccepted(false);
    setSubmittedInput(buildSubmittedInputFromJob(EXAMPLE_REASONING_JOB));
    setShowExampleReport(true);
    setSelectedFindingIndex(0);
  };

  const handleClearHistory = () => {
    pollTokenRef.current += 1;
    setIsPolling(false);
    setPollStartTime(null);
    setHistory([]);
    setSelectedJobId(null);
    setSubmittedInput(null);
    setShowExampleReport(false);
    saveStoredHistory([]);
  };

  const toggleFilter = (kind: FilterKind) => {
    setActiveFilters((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
    setSelectedFindingIndex(0);
  };

  const handleResumePolling = useCallback(() => {
    if (!selectedJobId) return;
    setError(null);
    void refreshJob(selectedJobId).catch((err) => {
      setError(err instanceof Error ? err.message : "Structured critique refresh failed");
    });
  }, [refreshJob, selectedJobId]);

  const persistJobToBrain = useCallback(
    async (job: StructuredCritiqueJob, options?: { silent?: boolean }) => {
      if (job.status !== "COMPLETED" || !job.result) return false;
      const silent = options?.silent === true;
      setBrainSaveByJobId((previous) => ({
        ...previous,
        [job.id]: { state: "saving" },
      }));
      try {
        const response = await fetch("/api/brain/critique", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            job,
            sourceFilename: job.pdf_filename || undefined,
          }),
        });
        const payload = (await response.json().catch(() => null)) as
          | PersistCritiqueResponse
          | null;
        if (!response.ok) {
          throw new Error(payload?.error || "Failed to save critique to gbrain");
        }
        const slug = payload?.brain_slug;
        const url = payload?.url;
        if (!slug || !url) {
          throw new Error("gbrain save returned an invalid response");
        }
        setBrainSaveByJobId((previous) => ({
          ...previous,
          [job.id]: { state: "saved", slug, url, projectUrl: payload?.project_url },
        }));
        setPersistedCritiques((previous) => {
          const nextSummary: PersistedCritiqueSummary = {
            brain_slug: slug,
            title: job.result?.title || job.pdf_filename || slug,
            uploaded_at: new Date().toISOString(),
            source_filename: job.pdf_filename || undefined,
            descartes_job_id: job.id,
            finding_count: job.result?.findings?.length,
            url,
            project_url: payload?.project_url,
          };
          return [
            nextSummary,
            ...previous.filter((entry) => entry.brain_slug !== slug),
          ].slice(0, 50);
        });
        return true;
      } catch (err) {
        setBrainSaveByJobId((previous) => ({
          ...previous,
          [job.id]: silent
            ? { state: "idle" }
            : {
                state: "error",
                error: err instanceof Error ? err.message : "Failed to save critique to gbrain",
              },
        }));
        return false;
      }
    },
    [],
  );

  const handleSaveToBrain = useCallback(
    async (job: StructuredCritiqueJob) => {
      await persistJobToBrain(job, { silent: false });
    },
    [persistJobToBrain],
  );

  // Completed live jobs are expensive. Persist the selected result to gbrain
  // automatically when possible so a browser-local history loss cannot lose it.
  useEffect(() => {
    if (
      !selectedJob ||
      selectedJob.id.startsWith("brain:") ||
      selectedJob.status !== "COMPLETED" ||
      !selectedJob.result ||
      isLoadingPersistedCritiques ||
      autoSavedJobIdsRef.current.has(selectedJob.id)
    ) {
      return;
    }
    const saveStatus = brainSaveByJobId[selectedJob.id];
    if (saveStatus?.state === "saved" || saveStatus?.state === "saving") return;

    const existingSavedAudit = persistedCritiques.find(
      (entry) => entry.descartes_job_id === selectedJob.id,
    );
    if (existingSavedAudit) {
      autoSavedJobIdsRef.current.add(selectedJob.id);
      setBrainSaveByJobId((previous) => ({
        ...previous,
        [selectedJob.id]: {
          state: "saved",
          slug: existingSavedAudit.brain_slug,
          url:
            existingSavedAudit.url ||
            `/dashboard/reasoning?brain_slug=${encodeURIComponent(existingSavedAudit.brain_slug)}`,
          projectUrl: existingSavedAudit.project_url,
        },
      }));
      return;
    }

    const attemptCount = autoSaveAttemptCountsRef.current.get(selectedJob.id) ?? 0;
    if (attemptCount >= 2) return;

    autoSaveAttemptCountsRef.current.set(selectedJob.id, attemptCount + 1);
    autoSavedJobIdsRef.current.add(selectedJob.id);
    void persistJobToBrain(selectedJob, { silent: true }).then((saved) => {
      if (!saved && (autoSaveAttemptCountsRef.current.get(selectedJob.id) ?? 0) < 2) {
        autoSavedJobIdsRef.current.delete(selectedJob.id);
      }
    });
  }, [
    brainSaveByJobId,
    isLoadingPersistedCritiques,
    persistedCritiques,
    persistJobToBrain,
    selectedJob,
  ]);

  const handleQueueKeyDown = (e: React.KeyboardEvent, index: number) => {
    if (e.key === "ArrowDown" && index < filteredFindings.length - 1) {
      e.preventDefault();
      setSelectedFindingIndex(index + 1);
      // Focus next item
      const container = queueRef.current;
      if (container) {
        const buttons = container.querySelectorAll<HTMLButtonElement>("[data-queue-item] > button");
        buttons[index + 1]?.focus();
      }
    } else if (e.key === "ArrowUp" && index > 0) {
      e.preventDefault();
      setSelectedFindingIndex(index - 1);
      const container = queueRef.current;
      if (container) {
        const buttons = container.querySelectorAll<HTMLButtonElement>("[data-queue-item] > button");
        buttons[index - 1]?.focus();
      }
    } else if (e.key === "Enter") {
      setSelectedFindingIndex(index);
    }
  };

  // ---------------------------------------------------------------------------
  // Determine what to show in center panel
  // ---------------------------------------------------------------------------

  const isAnalyzing = isSubmitting || isPolling;
  const showSummaryStrip = hasCompletedResults || isPartialFailure;

  const canAnalyze =
    inputMode === "pdf"
      ? !!selectedFile && !isAnalyzing && isAuthLoaded && isSignedIn === true && structuredCritiqueAvailable !== false
      : pasteText.trim().length > 0 &&
        !isAnalyzing &&
        isAuthLoaded &&
        isSignedIn === true &&
        structuredCritiqueAvailable !== false;

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="flex flex-col h-[calc(100vh-64px)] bg-gray-50/50">
      {/* Top strip */}
      <TopStrip
        findings={showSummaryStrip ? allFindings : undefined}
        overallSummary={showSummaryStrip ? activeJob?.result?.author_feedback?.overall_summary : undefined}
        authControls={(
          !isAuthLoaded ? (
            <span className="text-xs text-muted">Account…</span>
          ) : isSignedIn ? (
            <button
              type="button"
              onClick={() => void signOut()}
              className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:border-gray-300"
            >
              Sign out
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void beginSignIn()}
              className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:border-gray-300"
            >
              {isSigningIn ? "Connecting…" : "Sign in"}
            </button>
          )
        )}
      />

      {/* Error banner */}
      {error && !isFullFailure && !isTimedOutJob ? (
        <div className="border-b border-rose-200 bg-rose-50 px-6 py-3 text-sm text-rose-700">
          <strong className="font-semibold">Error:</strong> {error}
        </div>
      ) : null}

      {/* Main layout: left panel + center panel */}
      <div className="flex flex-1 min-h-0">
        {/* Left panel */}
        <div className="w-[280px] flex-shrink-0 border-r border-gray-100 bg-white flex flex-col overflow-y-auto">
          {/* Input section */}
          <div className="p-4 border-b border-gray-100">
            <div className={`${SECTION_LABEL} mb-3`}>
              Input
            </div>

            {/* PDF / Text toggle */}
            <div className="flex gap-1 mb-3 rounded bg-gray-100 p-0.5">
              <button
                type="button"
                onClick={() => {
                  setInputMode("pdf");
                  setShowExampleReport(false);
                }}
                className={`flex-1 text-xs py-1.5 rounded transition-colors ${
                  inputMode === "pdf"
                    ? "bg-white text-foreground font-medium shadow-sm"
                    : "text-muted hover:text-foreground"
                }`}
              >
                PDF
              </button>
              <button
                type="button"
                onClick={() => {
                  setInputMode("text");
                  setShowExampleReport(false);
                }}
                className={`flex-1 text-xs py-1.5 rounded transition-colors ${
                  inputMode === "text"
                    ? "bg-white text-foreground font-medium shadow-sm"
                    : "text-muted hover:text-foreground"
                }`}
              >
                Paste text
              </button>
            </div>

            {inputMode === "pdf" ? (
              <label className="flex cursor-pointer flex-col gap-1 rounded-lg border border-dashed border-gray-200 bg-gray-50/60 p-3 transition-colors hover:border-accent hover:bg-gray-50">
                {uploadAccepted && isAnalyzing ? (
                  <>
                    <span className="text-sm font-medium text-emerald-600">
                      Submitted PDF &#10003;
                    </span>
                    <span className="text-xs text-muted">
                      {submittedInput?.kind === "pdf"
                        ? submittedInput.name
                        : readJobProgressMessage(activeJob) ?? "Analysis in progress"}
                    </span>
                  </>
                ) : (
                  <>
                    <span className="text-sm font-medium text-foreground">
                      {selectedFile ? selectedFile.name : "Choose a PDF"}
                    </span>
                    <span className="text-xs text-muted">
                      {selectedFile
                        ? `${formatFileSize(selectedFile.size)} \u00b7 Ready`
                        : "Drop a manuscript here or browse"}
                    </span>
                  </>
                )}
                <input
                  type="file"
                  accept="application/pdf"
                  className="hidden"
                  onChange={handleFileChange}
                />
              </label>
            ) : (
              <textarea
                value={pasteText}
                onChange={(e) => {
                  setPasteText(e.target.value);
                  setSubmittedInput(null);
                  setUploadAccepted(false);
                  setShowExampleReport(false);
                }}
                placeholder="Paste the text you want deeply analyzed..."
                className="w-full rounded-lg border border-gray-200 bg-gray-50/60 p-3 text-sm resize-none h-24 focus:outline-none focus:border-accent"
              />
            )}

            {submittedInput && !showExampleReport ? (
              <div className="mt-3">
                <SubmittedInputSummary input={submittedInput} compact={true} />
              </div>
            ) : null}

            <details className="group mt-3 rounded-lg border border-gray-200 bg-gray-50/70 px-3 py-2 text-[11px] leading-5 text-slate-700">
              <summary className="cursor-pointer list-none font-semibold text-slate-900">
                What this checks
                <span className="float-right text-[10px] text-muted group-open:hidden">
                  Show
                </span>
                <span className="float-right hidden text-[10px] text-muted group-open:inline">
                  Hide
                </span>
              </summary>
              <p className="mt-2">
                Deeply analyzes a paper, draft, or argument for missing
                assumptions, weak evidence chains, causal leaps, and unsupported
                generalization.
              </p>
              <p className="mt-2">
                Best results come from a full paper PDF or the exact pasted
                section you want stress-tested.
              </p>
            </details>

            {/* Analyze button */}
            {!isAuthLoaded ? (
              <button
                type="button"
                disabled={true}
                className="mt-3 w-full rounded-lg bg-accent px-3 py-2.5 text-sm font-semibold text-white opacity-50"
              >
                Loading account…
              </button>
            ) : !isSignedIn ? (
              <button
                type="button"
                onClick={() => void beginSignIn()}
                className="mt-3 w-full rounded-lg bg-accent px-3 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-accent-hover"
              >
                {isSigningIn
                  ? "Waiting for ScienceSwarm sign-in…"
                  : "Create free account / Sign in"}
              </button>
            ) : (
              <button
                type="button"
                onClick={handleAnalyze}
                disabled={!canAnalyze}
                className="mt-3 w-full rounded-lg bg-accent px-3 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isSubmitting
                  ? "Submitting..."
                  : isPolling
                    ? "Analyzing..."
                    : SUBMIT_BUTTON_LABEL}
              </button>
            )}
            {!isAuthLoaded ? (
              <p className="mt-2 text-xs text-muted">
                {REASONING_AUDIT_LOADING_AUTH_MESSAGE}
              </p>
            ) : structuredCritiqueAvailable === false ? (
              <p className="mt-2 text-xs text-amber-700">
                {structuredCritiqueUnavailableMessage
                  ?? STRUCTURED_CRITIQUE_UNAVAILABLE_FALLBACK}
              </p>
            ) : !isSignedIn ? (
              <p className="mt-2 text-xs text-muted">
                Create a free account at{" "}
                <a
                  href={SCIENCESWARM_SIGN_IN_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium text-foreground underline underline-offset-2"
                >
                  scienceswarm.ai
                </a>{" "}
                to use Deep Reasoning API. Live runs send your PDF or pasted
                text to ScienceSwarm&apos;s cloud service and use frontier
                models from Google, Anthropic, and OpenAI.
              </p>
            ) : null}
            {!isSignedIn && authDetail ? (
              <p className="mt-2 text-xs text-amber-700">{authDetail}</p>
            ) : null}
            <details className="group mt-3 rounded-lg border border-sky-200 bg-sky-50/70 px-3 py-2 text-[11px] leading-5 text-slate-700">
              <summary className="cursor-pointer list-none font-semibold text-slate-900">
                Cloud and model notice
                <span className="float-right text-[10px] text-muted group-open:hidden">
                  Show
                </span>
                <span className="float-right hidden text-[10px] text-muted group-open:inline">
                  Hide
                </span>
              </summary>
              <p className="mt-2">
                By clicking {SUBMIT_BUTTON_LABEL}, you agree to send the
                selected PDF or pasted text to ScienceSwarm&apos;s cloud API and
                frontier LLM providers. {SCIENCESWARM_CRITIQUE_CLOUD_DISCLAIMER}
              </p>
              <p className="mt-2">
                <span className="font-semibold text-slate-900">Free for now:</span>{" "}
                {SCIENCESWARM_CRITIQUE_FRONTIER_MODELS_DISCLAIMER}
              </p>
            </details>
          </div>

          {/* Issue Queue */}
          <div className="flex-1 flex flex-col min-h-0">
            <div className="px-3 pt-3 pb-2">
              <div className={SECTION_LABEL}>
                Issue Queue
              </div>
            </div>

            {/* Issue list */}
            <div className="flex-1 overflow-y-auto" ref={queueRef}>
              {isAnalyzing && filteredFindings.length === 0 ? (
                <SkeletonRows />
              ) : filteredFindings.length > 0 ? (
                <div className="space-y-[1px]">
                  {filteredFindings.map((f, i) => (
                    <div key={f.finding_id ?? `f-${i}`} data-queue-item="">
                      <IssueQueueItem
                        finding={f}
                        isSelected={i === selectedFindingIndex}
                        onSelect={() => setSelectedFindingIndex(i)}
                        onKeyDown={(e) => handleQueueKeyDown(e, i)}
                      />
                    </div>
                  ))}
                </div>
              ) : activeJob && isTerminalStatus(activeJob.status) ? (
                <div className="px-3 py-4 text-xs text-muted">No findings to display.</div>
              ) : !isAnalyzing ? (
                <div className="px-3 py-4 text-xs text-muted">No analysis loaded.</div>
              ) : null}
            </div>

            {/* Filters */}
            {allFindings.length > 0 ? (
              <div className="border-t border-gray-100 py-2">
                <div className="px-3 pb-1">
                  <span className={SECTION_LABEL}>
                    Filter
                  </span>
                </div>
                <FilterChips active={activeFilters} onToggle={toggleFilter} />
              </div>
            ) : null}

            {/* Recent Reasoning Analyses */}
            <div className="border-t border-gray-100">
              <button
                type="button"
                onClick={() => setHistoryExpanded((v) => !v)}
                className={`w-full flex items-center justify-between px-3 py-2 ${SECTION_LABEL} hover:text-foreground transition-colors`}
              >
                <span>Recent Reasoning Analyses</span>
                <span className="text-[10px]">{historyExpanded ? "\u25B2" : "\u25BC"}</span>
              </button>
              {historyExpanded ? (
                <div className="pb-2 space-y-0.5">
                  {isLoadingPersistedCritiques && history.length === 0 ? (
                    <div className="px-3 py-2 text-xs text-muted">Loading saved reasoning analyses...</div>
                  ) : history.length === 0 && persistedHistory.length === 0 ? (
                    <div className="px-3 py-2 text-xs text-muted">No history yet.</div>
                  ) : (
                    <>
                      {history.map((job) => (
                        <button
                          key={job.id}
                          type="button"
                          onClick={() => handleSelectHistoryJob(job)}
                          className={`w-full text-left px-3 py-1.5 text-xs transition-colors ${
                            selectedJobId === job.id
                              ? "bg-teal-50 text-foreground"
                              : "text-muted hover:bg-gray-50 hover:text-foreground"
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="truncate font-medium">
                              {formatJobSourceName(job)}
                            </span>
                            <span
                              className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${statusBadgeClasses(job.status)}`}
                            >
                              {job.status === "COMPLETED" ? "\u2713" : job.status}
                            </span>
                          </div>
                          <div className="text-[10px] text-muted mt-0.5">
                            {formatTimestamp(job.saved_at)}
                          </div>
                        </button>
                      ))}
                      {persistedHistory.map((entry) => (
                        <button
                          key={entry.brain_slug}
                          type="button"
                          onClick={() => handleSelectPersistedCritique(entry)}
                          className={`w-full text-left px-3 py-1.5 text-xs transition-colors ${
                            selectedJobId === `brain:${entry.brain_slug}`
                              ? "bg-teal-50 text-foreground"
                              : "text-muted hover:bg-gray-50 hover:text-foreground"
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="truncate font-medium">
                              {entry.source_filename || entry.title || entry.brain_slug}
                            </span>
                            <span className="shrink-0 rounded-full border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">
                              brain
                            </span>
                          </div>
                          <div className="text-[10px] text-muted mt-0.5">
                            {formatTimestamp(entry.uploaded_at)}
                          </div>
                        </button>
                      ))}
                      <button
                        type="button"
                        onClick={handleClearHistory}
                        className="px-3 py-1 text-[10px] text-muted hover:text-rose-600 transition-colors"
                      >
                        Clear local history
                      </button>
                    </>
                  )}
                </div>
              ) : null}
            </div>
          </div>
        </div>

        {/* Center panel */}
        <div className="flex-1 min-h-0 overflow-y-auto bg-white">
          {brainArtifact ? (
            <BrainArtifactViewer artifact={brainArtifact} />
          ) : (
            <>
          {/* State: analyzing (no results yet) */}
          {isAnalyzing && !hasCompletedResults && !isPartialFailure ? (
            <div className="flex flex-col items-center justify-center h-full gap-4 px-6">
              {activeSubmittedInput ? (
                <div className="w-full max-w-md">
                  <SubmittedInputSummary input={activeSubmittedInput} />
                </div>
              ) : null}
              <div className="w-64 h-2 rounded-full bg-gray-100 overflow-hidden">
                <div className="h-full w-[60%] bg-accent rounded-full animate-pulse" />
              </div>
              <p className="text-sm text-muted">
                {activeJobPendingStatusMessage}
              </p>
              <ReasoningWaitGuidance
                input={activeSubmittedInput}
                job={activeJob}
              />
              {activeJobPendingRecoveryMessage ? (
                <p className="max-w-md text-center text-xs text-amber-700">
                  {activeJobPendingRecoveryMessage}
                </p>
              ) : null}
              {pollStartTime ? <ElapsedTimer startTime={pollStartTime} /> : null}
            </div>
          ) : null}

          {/* State: partial failure */}
          {isPartialFailure ? (
            <div className="px-6 pt-4">
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700 mb-4">
                Analysis partially completed. {allFindings.length} finding
                {allFindings.length !== 1 ? "s were" : " was"} generated before an error occurred.
              </div>
              {selectedFinding && activeJob ? (
                <div className="flex h-full flex-col">
                  <ReportOverview job={activeJob} />
                  <FindingDetail
                    key={`${activeJob.id}:${selectedFinding.finding_id ?? selectedFindingIndex}`}
                    finding={selectedFinding}
                    jobId={activeJob.id}
                  />
                </div>
              ) : (
                <div className="flex items-center justify-center h-64 text-sm text-muted">
                  Select a finding from the queue to see details.
                </div>
              )}
            </div>
          ) : null}

          {/* State: full failure */}
          {isFullFailure && !isAnalyzing ? (
            <div className="flex flex-col items-center justify-center h-full gap-4 px-6">
              <p className="max-w-xl text-center text-sm text-rose-600 font-medium">
                {getStructuredCritiqueDisplayError(
                  readJobFailureMessage(selectedJob),
                )}
              </p>
              <button
                type="button"
                onClick={handleRetry}
                className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover transition-colors"
              >
                Retry
              </button>
            </div>
          ) : null}

          {/* State: zero findings */}
          {zeroFindings && !isAnalyzing ? (
            <div className="flex flex-col items-center justify-center h-full gap-3 px-6">
              <QualityBadge level="GOOD" />
              <p className="text-sm text-muted">
                No reasoning flaws detected in this document.
              </p>
              <p className="text-sm text-muted text-center max-w-md">
                This is unusual. Try re-running with a longer passage or the
                full document if you want a more exhaustive critique.
              </p>
            </div>
          ) : null}

          {/* State: completed with findings */}
          {hasCompletedResults && !isPartialFailure ? (
            selectedFinding && activeJob ? (
              <div className="flex h-full flex-col">
                <ReportOverview
                  job={activeJob}
                  brainSaveStatus={
                    brainSaveByJobId[activeJob.id] ?? { state: "idle" }
                  }
                  onSaveToBrain={
                    activeJob.id === EXAMPLE_REASONING_JOB.id
                      ? undefined
                      : () => void handleSaveToBrain(activeJob)
                  }
                />
                <FindingDetail
                  key={`${activeJob.id}:${selectedFinding.finding_id ?? selectedFindingIndex}`}
                  finding={selectedFinding}
                  jobId={activeJob.id}
                />
              </div>
            ) : (
              <div className="flex items-center justify-center h-full text-sm text-muted">
                Select a finding from the queue to see details.
              </div>
            )
          ) : null}

          {/* State: first visit / no selection */}
          {!activeJob && !isAnalyzing ? (
            <EmptyWorkspacePanel onShowExampleReport={handleShowExampleReport} />
          ) : null}

          {/* State: selected a non-terminal job that has no results yet and we are NOT polling */}
          {selectedJob &&
          !isTerminalStatus(selectedJob.status) &&
          !isAnalyzing &&
          allFindings.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
              {activeSubmittedInput ? (
                <div className="w-full max-w-md">
                  <SubmittedInputSummary input={activeSubmittedInput} />
                </div>
              ) : null}
              <p className={`text-sm ${isTimedOutJob ? "text-amber-700" : "text-muted"}`}>
                {isTimedOutJob ? timedOutMessage : buildPendingStatusMessage(selectedJob)}
              </p>
              <ReasoningWaitGuidance
                input={activeSubmittedInput}
                job={selectedJob}
              />
              {!isTimedOutJob && buildPendingRecoveryMessage(selectedJob) ? (
                <p className="max-w-md text-xs text-amber-700">
                  {buildPendingRecoveryMessage(selectedJob)}
                </p>
              ) : null}
              {isTimedOutJob ? (
                <button
                  type="button"
                  onClick={handleResumePolling}
                  className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-foreground transition-colors hover:border-gray-300"
                >
                  Resume polling
                </button>
              ) : null}
            </div>
          ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page export
// ---------------------------------------------------------------------------

export default function StructuredCritiquePage() {
  return (
    <Suspense fallback={<StructuredCritiquePageSkeleton />}>
      <StructuredCritiquePageContent />
    </Suspense>
  );
}
