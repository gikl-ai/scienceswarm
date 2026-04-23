"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useScienceSwarmLocalAuth } from "@/hooks/use-scienceswarm-local-auth";
import { getStructuredCritiqueDisplayError } from "@/lib/structured-critique-errors";
import {
  buildCritiqueDisplayModel,
  type CritiqueDisplayItem,
} from "@/lib/structured-critique-display";
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
import { SUBMIT_BUTTON_LABEL } from "@/lib/reasoning-page-constants";

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
type SubmittedReasoningInput =
  | { kind: "pdf"; name: string; size?: number }
  | { kind: "text"; charCount?: number; preview: string };
type BrainSaveStatus =
  | { state: "idle" }
  | { state: "saving" }
  | {
      state: "saved";
      slug: string;
      url: string;
      projectUrl?: string;
      projectSlugs?: string[];
      projectUrls?: Record<string, string>;
    }
  | { state: "error"; error: string };

type PersistCritiqueResponse = {
  brain_slug?: string;
  project_slug?: string;
  project_slugs?: string[];
  url?: string;
  project_url?: string;
  project_urls?: Record<string, string>;
  error?: string;
};

type PersistedCritiqueSummary = {
  brain_slug: string;
  parent_slug?: string;
  project_slug?: string;
  project_slugs?: string[];
  title: string;
  uploaded_at?: string;
  source_filename?: string;
  descartes_job_id?: string;
  finding_count?: number;
  url?: string;
  project_url?: string;
  project_urls?: Record<string, string>;
};

type ProjectOption = {
  slug: string;
  name: string;
  description?: string;
};

type ProjectListStatus = "idle" | "loading" | "loaded" | "error";

type SaveDestinationControls = {
  isOpen: boolean;
  projects: ProjectOption[];
  projectStatus: ProjectListStatus;
  selectedProjectSlugs: string[];
  newProjectName: string;
  newProjectDescription: string;
  error: string | null;
  isCreatingProject: boolean;
  onOpen: () => void;
  onClose: () => void;
  onReloadProjects: () => void;
  onToggleProjectSlug: (slug: string) => void;
  onNewProjectNameChange: (value: string) => void;
  onNewProjectDescriptionChange: (value: string) => void;
  onSave: () => void;
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
type FindingFilterOption = {
  value: string;
  label: string;
  count: number;
};

const FALLBACK_FINDING_TYPE = "uncategorized";

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
        if (normalized.job.id.startsWith("brain:")) return [];
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

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function readProjectUrls(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>).flatMap(
    ([projectSlug, url]): Array<[string, string]> =>
      typeof url === "string" && url.trim().length > 0
        ? [[projectSlug, url.trim()]]
        : [],
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function projectSlugsFromRecord(record: Record<string, unknown>): string[] {
  return Array.from(
    new Set([
      ...(typeof record.project_slug === "string" && record.project_slug.trim()
        ? [record.project_slug.trim()]
        : []),
      ...readStringArray(record.project_slugs),
      ...(typeof record.project === "string" && record.project.trim()
        ? [record.project.trim()]
        : []),
      ...readStringArray(record.projects),
    ]),
  );
}

function buildProjectUrlsForBrainSlug(
  projectSlugs: string[],
  brainSlug: string,
): Record<string, string> | undefined {
  if (projectSlugs.length === 0) return undefined;
  const encodedSlug = encodeURIComponent(brainSlug);
  return Object.fromEntries(
    projectSlugs.map((projectSlug) => [
      projectSlug,
      `/dashboard/project?name=${encodeURIComponent(projectSlug)}&brain_slug=${encodedSlug}`,
    ]),
  );
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
    const projectSlugs = projectSlugsFromRecord(record);
    const projectUrls =
      readProjectUrls(record.project_urls) ??
      buildProjectUrlsForBrainSlug(projectSlugs, record.brain_slug.trim());
    return [
      {
        brain_slug: record.brain_slug.trim(),
        parent_slug: typeof record.parent_slug === "string" ? record.parent_slug : undefined,
        project_slug: projectSlugs[0],
        project_slugs: projectSlugs.length > 0 ? projectSlugs : undefined,
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
        project_url:
          typeof record.project_url === "string"
            ? record.project_url
            : projectSlugs[0] && projectUrls
              ? projectUrls[projectSlugs[0]]
              : undefined,
        project_urls: projectUrls,
      },
    ];
  });
}

function normalizeProjectOptions(payload: unknown): ProjectOption[] {
  const rawProjects =
    payload && typeof payload === "object" && "projects" in payload
      ? (payload as { projects?: unknown }).projects
      : payload;
  if (!Array.isArray(rawProjects)) return [];
  return rawProjects.flatMap((entry): ProjectOption[] => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    const slug =
      typeof record.slug === "string" && record.slug.trim().length > 0
        ? record.slug.trim()
        : typeof record.id === "string" && record.id.trim().length > 0
          ? record.id.trim()
          : null;
    if (!slug) return [];
    return [
      {
        slug,
        name:
          typeof record.name === "string" && record.name.trim().length > 0
            ? record.name.trim()
            : slug,
        description:
          typeof record.description === "string" && record.description.trim().length > 0
            ? record.description.trim()
            : undefined,
      },
    ];
  });
}

async function listProjectOptions(): Promise<ProjectOption[]> {
  const response = await fetch("/api/projects", { cache: "no-store" });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(readErrorFromPayload(payload) || "Failed to load projects");
  }
  return normalizeProjectOptions(payload);
}

async function createProjectOption(input: {
  name: string;
  description?: string;
}): Promise<ProjectOption> {
  const response = await fetch("/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "create",
      name: input.name,
      description: input.description,
    }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(readErrorFromPayload(payload) || "Failed to create project");
  }
  const projects = normalizeProjectOptions([payload && typeof payload === "object" ? (payload as { project?: unknown }).project : null]);
  const project = projects[0];
  if (!project) {
    throw new Error("Project creation returned an invalid response");
  }
  return project;
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
  const projectSlugs = Array.from(
    new Set([
      ...(summary?.project_slugs ?? []),
      ...(summary?.project_slug ? [summary.project_slug] : []),
      ...projectSlugsFromRecord(page.frontmatter ?? {}),
    ]),
  );
  const projectUrls =
    summary?.project_urls ??
    buildProjectUrlsForBrainSlug(projectSlugs, slug);
  const projectSlug = projectSlugs[0];
  const encodedSlug = encodeURIComponent(slug);
  return {
    state: "saved",
    slug,
    url: summary?.url || `/dashboard/reasoning?brain_slug=${encodedSlug}`,
    projectUrl:
      summary?.project_url ||
      (projectSlug && projectUrls ? projectUrls[projectSlug] : undefined),
    projectSlugs: projectSlugs.length > 0 ? projectSlugs : undefined,
    projectUrls,
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
  const sourceFilename =
    typeof fm.source_filename === "string" && fm.source_filename.trim().length > 0
      ? fm.source_filename.trim()
      : "";
  try {
    return normalizeStructuredCritiqueJobPayload({
      id: `brain:${slug}`,
      status: "COMPLETED",
      pdf_filename: sourceFilename,
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

function normalizeFindingTypeValue(value?: string): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
    .replace(/_+/g, "_");
}

function getFindingTypeKey(finding: Finding): string {
  return (
    normalizeFindingTypeValue(finding.flaw_type) ??
    normalizeFindingTypeValue(finding.finding_kind) ??
    FALLBACK_FINDING_TYPE
  );
}

function humanizeFindingType(value?: string): string {
  const normalized = normalizeFindingTypeValue(value) ?? FALLBACK_FINDING_TYPE;
  return normalized
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function getFindingTypeLabel(finding: Finding): string {
  return humanizeFindingType(
    finding.flaw_type || finding.finding_kind || FALLBACK_FINDING_TYPE,
  );
}

function getFindingTitle(finding: Finding): string {
  const typeLabel = getFindingTypeLabel(finding);
  return typeLabel === humanizeFindingType(FALLBACK_FINDING_TYPE)
    ? "Reasoning issue"
    : typeLabel;
}

function formatConfidence(value?: number): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return `${Math.round(value * 100)}%`;
}

function buildFindingFilterOptions(findings: Finding[]): FindingFilterOption[] {
  const byKey = new Map<string, FindingFilterOption>();
  for (const finding of findings) {
    const value = getFindingTypeKey(finding);
    const existing = byKey.get(value);
    if (existing) {
      existing.count += 1;
      continue;
    }
    byKey.set(value, {
      value,
      label: getFindingTypeLabel(finding),
      count: 1,
    });
  }
  return [...byKey.values()].sort((left, right) => {
    if (right.count !== left.count) return right.count - left.count;
    return left.label.localeCompare(right.label);
  });
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

function projectLabel(slug: string, projects: ProjectOption[]): string {
  return projects.find((project) => project.slug === slug)?.name || slug;
}

function formatSavedProjectLabel(
  slugs: string[],
  projects: ProjectOption[],
): string {
  if (slugs.length === 0) return "project";
  if (slugs.length === 1 && slugs[0]) return projectLabel(slugs[0], projects);
  return `${slugs.length} projects`;
}

function dedupeStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.trim().length > 0)));
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
  const label = humanizeFindingType(kind || "critique");
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
  const title = getFindingTitle(finding);
  const confidence = formatConfidence(finding.confidence);
  const rawType = finding.flaw_type?.trim();
  const selectedBg = isSelected
    ? "bg-teal-50 border-l-[3px] border-l-teal-500"
    : "border-l-[3px] border-l-transparent hover:bg-gray-50";

  return (
    <button
      type="button"
      onClick={onSelect}
      onKeyDown={onKeyDown}
      tabIndex={0}
      aria-label={`${severityLabel(severity)} ${title}: ${finding.description || finding.finding_id || "finding"}`}
      className={`w-full text-left px-3 py-2.5 transition-colors cursor-pointer ${selectedBg}`}
    >
      <div className="flex items-start gap-2">
        <SeverityDot severity={severity} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
            <span
              className={`text-xs font-semibold ${severityTextClass(severity)}`}
              aria-label={`${severityLabel(severity)} severity`}
            >
              {severityLabel(severity)}
            </span>
            <span className="text-xs font-medium leading-5 text-foreground">
              {title}
            </span>
          </div>
          {finding.description ? (
            <p className="mt-0.5 line-clamp-2 text-xs leading-5 text-muted">
              {finding.description}
            </p>
          ) : null}
          {finding.impact ? (
            <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-slate-500">
              <span className="font-medium text-slate-600">Impact: </span>
              {finding.impact}
            </p>
          ) : null}
          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            {finding.argument_id ? (
              <span className="rounded bg-white px-1.5 py-0.5 text-[10px] font-mono text-gray-600 ring-1 ring-gray-100">
                {finding.argument_id}
              </span>
            ) : null}
            {rawType ? (
              <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-mono text-gray-600">
                {rawType}
              </span>
            ) : null}
            {confidence ? (
              <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-600">
                {confidence}
              </span>
            ) : null}
          </div>
        </div>
      </div>
    </button>
  );
}

function CritiqueMarkdownBlock({
  content,
  className = "",
}: {
  content: string;
  className?: string;
}) {
  return (
    <div className={`file-markdown bg-transparent p-0 ${className}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} disallowedElements={["img"]}>
        {content}
      </ReactMarkdown>
    </div>
  );
}

function FindingIdList({ findingIds }: { findingIds?: string[] }) {
  if (!findingIds || findingIds.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1">
      {findingIds.map((findingId) => (
        <span
          key={findingId}
          className="rounded bg-white px-1.5 py-0.5 font-mono text-[10px] text-gray-600 ring-1 ring-gray-100"
        >
          {findingId}
        </span>
      ))}
    </div>
  );
}

function DisplayItemCard({
  item,
  index,
}: {
  item: CritiqueDisplayItem;
  index?: number;
}) {
  return (
    <div className="rounded-lg border border-gray-100 bg-gray-50/70 p-3">
      <div className="text-sm font-medium text-foreground">
        {typeof index === "number" ? `${index + 1}. ` : null}
        {item.title}
      </div>
      <CritiqueMarkdownBlock
        content={item.bodyMarkdown}
        className="mt-1 text-sm leading-6 text-muted"
      />
      <FindingIdList findingIds={item.findingIds} />
    </div>
  );
}

function ProjectSavePanel({
  controls,
  isSaving,
}: {
  controls: SaveDestinationControls;
  isSaving: boolean;
}) {
  const selected = new Set(controls.selectedProjectSlugs);
  const hasNewProject = controls.newProjectName.trim().length > 0;
  const canSave =
    !isSaving &&
    !controls.isCreatingProject &&
    (selected.size > 0 || hasNewProject);

  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50/80 p-3">
      <div className="flex items-center justify-between gap-3">
        <div className={SECTION_LABEL}>Destination projects</div>
        <button
          type="button"
          onClick={controls.onClose}
          className="rounded border border-gray-200 bg-white px-2 py-1 text-[11px] font-medium text-muted transition-colors hover:text-foreground"
        >
          Close
        </button>
      </div>

      {controls.projectStatus === "loading" ? (
        <div className="mt-3 text-xs text-muted">Loading projects...</div>
      ) : controls.projectStatus === "error" ? (
        <div className="mt-3 flex items-center gap-2">
          <span className="text-xs text-rose-700">Projects unavailable.</span>
          <button
            type="button"
            onClick={controls.onReloadProjects}
            className="rounded border border-gray-200 bg-white px-2 py-1 text-[11px] font-medium text-foreground transition-colors hover:border-gray-300"
          >
            Retry
          </button>
        </div>
      ) : controls.projects.length > 0 ? (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {controls.projects.map((project) => (
            <label
              key={project.slug}
              className={`flex cursor-pointer items-start gap-2 rounded border bg-white p-2 text-xs transition-colors ${
                selected.has(project.slug)
                  ? "border-emerald-300 text-emerald-800"
                  : "border-gray-200 text-foreground hover:border-gray-300"
              }`}
            >
              <input
                type="checkbox"
                checked={selected.has(project.slug)}
                onChange={() => controls.onToggleProjectSlug(project.slug)}
                className="mt-0.5 h-3.5 w-3.5 accent-emerald-600"
              />
              <span className="min-w-0">
                <span className="block truncate font-medium">{project.name}</span>
                <span className="block truncate text-[11px] text-muted">{project.slug}</span>
              </span>
            </label>
          ))}
        </div>
      ) : (
        <div className="mt-3 text-xs text-muted">No projects yet.</div>
      )}

      <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <label className="text-xs font-medium text-foreground">
          New project
          <input
            value={controls.newProjectName}
            onChange={(event) => controls.onNewProjectNameChange(event.target.value)}
            placeholder="Project name"
            className="mt-1 w-full rounded border border-gray-200 bg-white px-2 py-1.5 text-xs font-normal text-foreground outline-none transition-colors focus:border-accent"
          />
        </label>
        <label className="text-xs font-medium text-foreground">
          Description
          <input
            value={controls.newProjectDescription}
            onChange={(event) => controls.onNewProjectDescriptionChange(event.target.value)}
            placeholder="Optional"
            className="mt-1 w-full rounded border border-gray-200 bg-white px-2 py-1.5 text-xs font-normal text-foreground outline-none transition-colors focus:border-accent"
          />
        </label>
      </div>

      {controls.error ? (
        <div className="mt-3 rounded border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
          {controls.error}
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={controls.onSave}
          disabled={!canSave}
          className="rounded-lg bg-emerald-600 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isSaving || controls.isCreatingProject ? "Saving..." : "Save critique"}
        </button>
        <span className="text-[11px] text-muted">
          {selected.size + (hasNewProject ? 1 : 0)} selected
        </span>
      </div>
    </div>
  );
}

function ReportOverview({
  job,
  brainSaveStatus = { state: "idle" },
  saveControls,
}: {
  job: StructuredCritiqueJob;
  brainSaveStatus?: BrainSaveStatus;
  saveControls?: SaveDestinationControls;
}) {
  const saveStatus = brainSaveStatus;
  const destinationControls = saveControls;
  const title = job.result?.title || job.pdf_filename;
  const displayModel = job.result
    ? buildCritiqueDisplayModel(job.result)
    : null;
  const topIssues = displayModel?.topIssues ?? [];
  const sectionFeedback = displayModel?.sectionFeedback ?? [];
  const questionsForAuthors = displayModel?.questionsForAuthors ?? [];
  const reportMarkdown = job.result?.report_markdown?.trim() || "";
  const fileStem = slugifyFileStem(title || job.id);
  const canSaveToBrain =
    job.status === "COMPLETED" &&
    !!job.result &&
    !!destinationControls;
  const savedProjectSlugs =
    saveStatus.state === "saved"
      ? saveStatus.projectSlugs ?? []
      : [];
  const savedProjectUrls =
    saveStatus.state === "saved"
      ? saveStatus.projectUrls ??
        buildProjectUrlsForBrainSlug(savedProjectSlugs, saveStatus.slug)
      : undefined;
  const savedProjectLinks =
    saveStatus.state === "saved"
      ? savedProjectSlugs.flatMap((projectSlug) => {
          const href =
            savedProjectUrls?.[projectSlug] ||
            saveStatus.projectUrl ||
            saveStatus.url;
          return href
            ? [{ projectSlug, href, label: projectLabel(projectSlug, destinationControls?.projects ?? []) }]
            : [];
        })
      : [];

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
                {saveStatus.state === "saved" ? (
                  <>
                    <span className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-700">
                      Saved in {formatSavedProjectLabel(savedProjectSlugs, destinationControls?.projects ?? [])}
                    </span>
                    {savedProjectLinks.length === 1 ? (
                      <Link
                        href={savedProjectLinks[0]?.href ?? saveStatus.url}
                        className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-700 transition-colors hover:border-emerald-300"
                      >
                        Open in file tree
                      </Link>
                    ) : savedProjectLinks.length > 1 ? (
                      savedProjectLinks.map((link) => (
                        <Link
                          key={link.projectSlug}
                          href={link.href}
                          className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-700 transition-colors hover:border-emerald-300"
                        >
                          Open {link.label}
                        </Link>
                      ))
                    ) : null}
                    <Link
                      href={saveStatus.url}
                      title="Open the durable saved analysis URL"
                      className="rounded-lg border border-gray-200 px-3 py-2 text-xs font-medium text-foreground transition-colors hover:border-gray-300"
                    >
                      Open saved analysis
                    </Link>
                    <button
                      type="button"
                      onClick={destinationControls?.onOpen}
                      className="rounded-lg border border-gray-200 px-3 py-2 text-xs font-medium text-foreground transition-colors hover:border-gray-300 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Manage projects
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={destinationControls?.onOpen}
                    disabled={saveStatus.state === "saving"}
                    className="rounded-lg border border-gray-200 px-3 py-2 text-xs font-medium text-foreground transition-colors hover:border-gray-300 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {saveStatus.state === "saving" ? "Saving..." : "Save to project..."}
                  </button>
                )}
              </>
            ) : null}
          </div>
        ) : null}
      </div>
      {destinationControls?.isOpen ? (
        <ProjectSavePanel
          controls={destinationControls}
          isSaving={saveStatus.state === "saving"}
        />
      ) : null}
      {saveStatus.state === "error" ? (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
          {saveStatus.error}
        </div>
      ) : null}

      {displayModel?.summaryMarkdown ? (
        <div className="space-y-2">
          <div className={SECTION_LABEL}>Summary</div>
          <CritiqueMarkdownBlock
            content={displayModel.summaryMarkdown}
            className="max-w-4xl text-sm leading-7 text-foreground"
          />
          {displayModel.atAGlance ? (
            <p className="max-w-4xl rounded-lg border border-gray-100 bg-gray-50 px-3 py-2 text-sm text-muted">
              {displayModel.atAGlance}
            </p>
          ) : null}
        </div>
      ) : null}

      {topIssues.length > 0 ? (
        <div className="space-y-2">
          <div className={SECTION_LABEL}>
            Top issues
          </div>
          <div className="grid gap-2 md:grid-cols-2">
            {topIssues.map((issue, index) => (
              <DisplayItemCard
                key={`${issue.title || "issue"}-${index}`}
                item={issue}
                index={index}
              />
            ))}
          </div>
        </div>
      ) : null}

      {sectionFeedback.length > 0 ? (
        <div className="space-y-2">
          <div className={SECTION_LABEL}>Section-by-section feedback</div>
          <div className="grid gap-2 xl:grid-cols-2">
            {sectionFeedback.map((section, index) => (
              <DisplayItemCard
                key={`${section.title || "section"}-${index}`}
                item={section}
              />
            ))}
          </div>
        </div>
      ) : null}

      {questionsForAuthors.length > 0 ? (
        <details className="rounded-lg border border-gray-100 bg-gray-50/70 p-3">
          <summary className="cursor-pointer text-sm font-medium text-foreground">
            Questions for authors
          </summary>
          <div className="mt-3 grid gap-2 xl:grid-cols-2">
            {questionsForAuthors.map((question, index) => (
              <DisplayItemCard
                key={`${question.title || "question"}-${index}`}
                item={question}
              />
            ))}
          </div>
        </details>
      ) : null}

      {displayModel?.referencesFeedbackMarkdown ? (
        <details className="rounded-lg border border-gray-100 bg-gray-50/70 p-3">
          <summary className="cursor-pointer text-sm font-medium text-foreground">
            Reference and methods notes
          </summary>
          <CritiqueMarkdownBlock
            content={displayModel.referencesFeedbackMarkdown}
            className="mt-3 text-sm leading-6 text-muted"
          />
        </details>
      ) : null}

      {reportMarkdown ? (
        <details className="rounded-lg border border-gray-100 bg-gray-50/70 p-3">
          <summary className="cursor-pointer text-sm font-medium text-foreground">
            Report markdown
          </summary>
          <CritiqueMarkdownBlock
            content={reportMarkdown}
            className="mt-3 max-h-[32rem] overflow-auto rounded border border-gray-100 bg-white px-3 py-2 text-sm leading-6 text-foreground"
          />
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
  options,
  totalCount,
  onClear,
  onToggle,
}: {
  active: Set<string>;
  options: FindingFilterOption[];
  totalCount: number;
  onClear: () => void;
  onToggle: (kind: string) => void;
}) {
  const allActive = active.size === 0;
  return (
    <div className="flex max-h-28 flex-wrap gap-2 overflow-y-auto px-3">
      <button
        type="button"
        onClick={onClear}
        aria-pressed={allActive}
        className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
          allActive
            ? "border-accent bg-accent/10 font-medium text-accent"
            : "border-gray-200 bg-white text-muted hover:border-gray-300"
        }`}
      >
        All {totalCount}
      </button>
      {options.map((option) => {
        const isActive = active.has(option.value);
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onToggle(option.value)}
            aria-pressed={isActive}
            aria-label={`Filter issue queue by ${option.label} (${option.count} finding${option.count !== 1 ? "s" : ""})`}
            className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
              isActive
                ? "border-accent bg-accent/10 font-medium text-accent"
                : "border-gray-200 bg-white text-muted hover:border-gray-300"
            }`}
          >
            {option.label} {option.count}
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
}: {
  finding: Finding;
}) {
  const severity = normalizeSeverity(finding.severity);
  const title = getFindingTitle(finding);
  const confidence = formatConfidence(finding.confidence);
  const rawType = finding.flaw_type?.trim();
  const kind = finding.finding_kind?.trim();
  const detailRows = [
    finding.argument_id
      ? { label: "Affected claim", value: finding.argument_id, mono: true }
      : null,
    finding.broken_link
      ? { label: "Broken link", value: finding.broken_link, mono: false }
      : null,
    rawType ? { label: "Raw issue type", value: rawType, mono: true } : null,
    kind
      ? { label: "Broad group", value: humanizeFindingType(kind), mono: false }
      : null,
    confidence ? { label: "Confidence", value: confidence, mono: false } : null,
    finding.finding_id
      ? { label: "Finding ID", value: finding.finding_id, mono: true }
      : null,
  ].filter(
    (row): row is { label: string; value: string; mono: boolean } => row !== null,
  );

  return (
    <article className="border-b border-gray-100 px-6 py-5">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className={SECTION_LABEL}>Selected issue</div>
          <h2 className="mt-1 text-2xl font-semibold text-foreground">
            {title}
          </h2>
        </div>
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
          {rawType ? (
            <span className="rounded bg-gray-100 px-2 py-0.5 font-mono text-xs text-gray-700">
              {rawType}
            </span>
          ) : null}
          <FindingKindChip kind={finding.finding_kind} />
        </div>
      </div>

      <div className="mt-5 grid gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(280px,0.8fr)]">
        <div className="space-y-4">
          <section>
            <div className={`${SECTION_LABEL} mb-1`}>What is wrong</div>
            <p className="text-sm leading-7 text-foreground">
              {finding.description || "No description supplied for this finding."}
            </p>
          </section>

          {finding.evidence_quote ? (
            <section>
              <div className={`${SECTION_LABEL} mb-1`}>Evidence quoted</div>
              <blockquote className="border-l-2 border-gray-200 bg-gray-50 px-4 py-3 text-sm leading-7 text-muted">
                {finding.evidence_quote}
              </blockquote>
            </section>
          ) : null}

          {finding.impact ? (
            <section>
              <div className={`${SECTION_LABEL} mb-1`}>Why it matters</div>
              <p className="rounded border border-amber-100 bg-amber-50/70 p-3 text-sm leading-7 text-amber-900">
                {finding.impact}
              </p>
            </section>
          ) : null}

          {finding.suggested_fix ? (
            <section>
              <div className={`${SECTION_LABEL} mb-1`}>Suggested fix</div>
              <p className="rounded border border-emerald-100 bg-emerald-50 p-3 text-sm leading-7 text-emerald-950">
                {finding.suggested_fix}
              </p>
            </section>
          ) : null}
        </div>

        {detailRows.length > 0 ? (
          <dl className="grid content-start gap-3 rounded-lg border border-gray-100 bg-gray-50/70 p-4 sm:grid-cols-2 xl:grid-cols-1">
            {detailRows.map((row) => (
              <div key={row.label}>
                <dt className={SECTION_LABEL}>{row.label}</dt>
                <dd
                  className={`mt-1 break-words text-sm text-foreground ${
                    row.mono ? "font-mono" : ""
                  }`}
                >
                  {row.value}
                </dd>
              </div>
            ))}
          </dl>
        ) : null}
      </div>
    </article>
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
  const [loadedBrainJob, setLoadedBrainJob] = useState<StructuredCritiqueJob | null>(null);
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
  const [activeFilters, setActiveFilters] = useState<Set<string>>(new Set());
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
  const [projectOptions, setProjectOptions] = useState<ProjectOption[]>([]);
  const [projectListStatus, setProjectListStatus] =
    useState<ProjectListStatus>("idle");
  const [savePanelJobId, setSavePanelJobId] = useState<string | null>(null);
  const [selectedSaveProjectSlugs, setSelectedSaveProjectSlugs] = useState<string[]>([]);
  const [newProjectName, setNewProjectName] = useState("");
  const [newProjectDescription, setNewProjectDescription] = useState("");
  const [savePanelError, setSavePanelError] = useState<string | null>(null);
  const [isCreatingProjectForSave, setIsCreatingProjectForSave] = useState(false);

  const queueRef = useRef<HTMLDivElement>(null);
  const hostedHistoryHydratedRef = useRef(false);
  const getCritiqueHeaders = useCallback(async () => ({}), []);

  // ---------------------------------------------------------------------------
  // Reused core logic
  // ---------------------------------------------------------------------------

  const rememberJob = useCallback((job: StructuredCritiqueJob) => {
    setLoadedBrainJob(null);
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
        setLoadedBrainJob(job);
        setSelectedJobId(job.id);
        setBrainSaveByJobId((previous) => ({
          ...previous,
          [job.id]: buildSavedBrainStatus(slug, payload, summary),
        }));
        return;
      }
      setSelectedJobId(null);
      setError(null);
      setLoadedBrainJob(null);
      setBrainArtifact(brainPageToArtifact(slug, payload));
    },
    [],
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

  // Handle URL brain_slug param: load a persisted critique from gbrain without
  // turning that saved page into a browser-local hosted-run history entry.
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

  const selectedHistoryJob = history.find((entry) => entry.id === selectedJobId) ?? null;
  const selectedJob =
    selectedHistoryJob ??
    (loadedBrainJob?.id === selectedJobId ? loadedBrainJob : null);
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
  const findingFilterOptions = buildFindingFilterOptions(sorted);

  // Apply filters
  const filteredFindings =
    activeFilters.size === 0
      ? sorted
      : sorted.filter((f) => {
          return activeFilters.has(getFindingTypeKey(f));
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
  const activeBrainSaveStatus: BrainSaveStatus = activeJob
    ? brainSaveByJobId[activeJob.id] ?? { state: "idle" }
    : { state: "idle" };

  // Auto-select first finding when results arrive
  const prevFindingsLenRef = useRef(0);
  useEffect(() => {
    if (filteredFindings.length > 0 && prevFindingsLenRef.current === 0) {
      setSelectedFindingIndex(0);
    }
    prevFindingsLenRef.current = filteredFindings.length;
  }, [filteredFindings.length]);

  // Reset selected finding and filters when the visible analysis changes.
  useEffect(() => {
    setSelectedFindingIndex(0);
    setActiveFilters(new Set());
  }, [selectedJobId, showExampleReport]);

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  const handleSelectHistoryJob = useCallback(
    (job: StoredStructuredCritiqueJob) => {
      setLoadedBrainJob(null);
      setBrainArtifact(null);
      setShowExampleReport(false);
      setSelectedJobId(job.id);
      setError(null);
      setUploadAccepted(false);
      setSubmittedInput(buildSubmittedInputFromJob(job));
      setSelectedFindingIndex(0);
      setActiveFilters(new Set());
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
      setActiveFilters(new Set());
      void loadBrainSlug(summary.brain_slug, summary).catch((err) => {
        setError(err instanceof Error ? err.message : "brain critique load failed");
      });
    },
    [loadBrainSlug],
  );

  const loadProjectsForSave = useCallback(async () => {
    setProjectListStatus("loading");
    try {
      const projects = await listProjectOptions();
      setProjectOptions(projects);
      setProjectListStatus("loaded");
      setSavePanelError(null);
    } catch (err) {
      setProjectListStatus("error");
      setSavePanelError(err instanceof Error ? err.message : "Failed to load projects");
    }
  }, []);

  const handleOpenSavePanel = useCallback(
    (job: StructuredCritiqueJob, status: BrainSaveStatus) => {
      setSavePanelJobId(job.id);
      setSavePanelError(null);
      setNewProjectName("");
      setNewProjectDescription("");
      if (status.state === "saved") {
        setSelectedSaveProjectSlugs(status.projectSlugs ?? []);
      } else {
        const existingSavedAudit = persistedCritiques.find(
          (entry) => entry.descartes_job_id === job.id,
        );
        setSelectedSaveProjectSlugs(existingSavedAudit?.project_slugs ?? []);
      }
      if (projectListStatus === "idle" || projectListStatus === "error") {
        void loadProjectsForSave();
      }
    },
    [loadProjectsForSave, persistedCritiques, projectListStatus],
  );

  const handleToggleSaveProjectSlug = useCallback((slug: string) => {
    setSelectedSaveProjectSlugs((previous) =>
      previous.includes(slug)
        ? previous.filter((candidate) => candidate !== slug)
        : [...previous, slug],
    );
  }, []);

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    if (!file) {
      setSelectedFile(null);
      setSubmittedInput(null);
      setLoadedBrainJob(null);
      setUploadAccepted(false);
      return;
    }
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      setError("Only PDF files are supported for structured critique.");
      setSelectedFile(null);
      setLoadedBrainJob(null);
      event.target.value = "";
      return;
    }
    setError(null);
    setSelectedFile(file);
    setSubmittedInput(null);
    setLoadedBrainJob(null);
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
    setLoadedBrainJob(null);
    setShowExampleReport(false);
    setSelectedJobId(null);
    setIsSubmitting(true);
    setUploadAccepted(false);
    setSelectedFindingIndex(0);
    setActiveFilters(new Set());
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
    setLoadedBrainJob(null);
    setSelectedJobId(null);
    setError(null);
    setUploadAccepted(false);
    setSubmittedInput(buildSubmittedInputFromJob(EXAMPLE_REASONING_JOB));
    setShowExampleReport(true);
    setSelectedFindingIndex(0);
    setActiveFilters(new Set());
  };

  const handleClearHistory = () => {
    pollTokenRef.current += 1;
    setIsPolling(false);
    setPollStartTime(null);
    setHistory([]);
    setSelectedJobId(null);
    setSubmittedInput(null);
    setLoadedBrainJob(null);
    setShowExampleReport(false);
    setActiveFilters(new Set());
    saveStoredHistory([]);
  };

  const clearFilters = () => {
    setActiveFilters(new Set());
    setSelectedFindingIndex(0);
  };

  const toggleFilter = (kind: string) => {
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
    async (
      job: StructuredCritiqueJob,
      options: { projectSlugs: string[]; silent?: boolean },
    ): Promise<{ saved: true } | { saved: false; error?: string }> => {
      if (job.status !== "COMPLETED" || !job.result) return { saved: false };
      const silent = options?.silent === true;
      const projectSlugs = dedupeStrings(options.projectSlugs.map((slug) => slug.trim()));
      if (projectSlugs.length === 0) {
        const message = "Choose at least one project before saving a critique";
        setBrainSaveByJobId((previous) => ({
          ...previous,
          [job.id]: {
            state: "error",
            error: message,
          },
        }));
        return { saved: false, error: message };
      }
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
            projectSlugs,
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
        const savedProjectSlugs =
          payload?.project_slugs && payload.project_slugs.length > 0
            ? payload.project_slugs
            : payload?.project_slug
              ? [payload.project_slug]
              : projectSlugs;
        const savedProjectUrls =
          payload?.project_urls ??
          buildProjectUrlsForBrainSlug(savedProjectSlugs, slug);
        setBrainSaveByJobId((previous) => ({
          ...previous,
          [job.id]: {
            state: "saved",
            slug,
            url,
            projectUrl:
              payload?.project_url ||
              (savedProjectSlugs[0] && savedProjectUrls
                ? savedProjectUrls[savedProjectSlugs[0]]
                : undefined),
            projectSlugs: savedProjectSlugs,
            projectUrls: savedProjectUrls,
          },
        }));
        setPersistedCritiques((previous) => {
          const nextSummary: PersistedCritiqueSummary = {
            brain_slug: slug,
            project_slug: savedProjectSlugs[0],
            project_slugs: savedProjectSlugs,
            title: job.result?.title || job.pdf_filename || slug,
            uploaded_at: new Date().toISOString(),
            source_filename: job.pdf_filename || undefined,
            descartes_job_id: job.id,
            finding_count: job.result?.findings?.length,
            url,
            project_url: payload?.project_url,
            project_urls: savedProjectUrls,
          };
          return [
            nextSummary,
            ...previous.filter(
              (entry) =>
                entry.brain_slug !== slug && entry.descartes_job_id !== job.id,
            ),
          ].slice(0, 50);
        });
        return { saved: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to save critique to gbrain";
        setBrainSaveByJobId((previous) => ({
          ...previous,
          [job.id]: silent
            ? { state: "idle" }
            : {
                state: "error",
                error: message,
              },
        }));
        return { saved: false, error: message };
      }
    },
    [],
  );

  const handleSaveToSelectedProjects = useCallback(
    async (job: StructuredCritiqueJob) => {
      setSavePanelError(null);
      let projectSlugs = dedupeStrings(selectedSaveProjectSlugs);
      const requestedProjectName = newProjectName.trim();
      if (requestedProjectName) {
        setIsCreatingProjectForSave(true);
        try {
          const created = await createProjectOption({
            name: requestedProjectName,
            description: newProjectDescription.trim() || undefined,
          });
          setProjectOptions((previous) => {
            const withoutDuplicate = previous.filter(
              (project) => project.slug !== created.slug,
            );
            return [created, ...withoutDuplicate];
          });
          projectSlugs = dedupeStrings([...projectSlugs, created.slug]);
          setSelectedSaveProjectSlugs(projectSlugs);
          setNewProjectName("");
          setNewProjectDescription("");
          setProjectListStatus("loaded");
        } catch (err) {
          setSavePanelError(
            err instanceof Error ? err.message : "Failed to create project",
          );
          setIsCreatingProjectForSave(false);
          return;
        }
        setIsCreatingProjectForSave(false);
      }

      if (projectSlugs.length === 0) {
        setSavePanelError("Choose at least one project before saving a critique");
        return;
      }

      const result = await persistJobToBrain(job, {
        projectSlugs,
        silent: false,
      });
      if (result.saved) {
        setSavePanelJobId(null);
      } else if (result.error) {
        setSavePanelError(result.error);
      }
    },
    [
      newProjectDescription,
      newProjectName,
      persistJobToBrain,
      selectedSaveProjectSlugs,
    ],
  );

  // If this hosted job was already saved, reflect that durable state without
  // issuing another write.
  useEffect(() => {
    if (
      !selectedJob ||
      selectedJob.id.startsWith("brain:") ||
      selectedJob.status !== "COMPLETED" ||
      !selectedJob.result ||
      isLoadingPersistedCritiques
    ) {
      return;
    }
    const saveStatus = brainSaveByJobId[selectedJob.id];
    if (saveStatus?.state === "saved" || saveStatus?.state === "saving") return;

    const existingSavedAudit = persistedCritiques.find(
      (entry) => entry.descartes_job_id === selectedJob.id,
    );
    if (existingSavedAudit) {
      setBrainSaveByJobId((previous) => ({
        ...previous,
        [selectedJob.id]: {
          state: "saved",
          slug: existingSavedAudit.brain_slug,
          url:
            existingSavedAudit.url ||
            `/dashboard/reasoning?brain_slug=${encodeURIComponent(existingSavedAudit.brain_slug)}`,
          projectUrl: existingSavedAudit.project_url,
          projectSlugs: existingSavedAudit.project_slugs,
          projectUrls: existingSavedAudit.project_urls,
        },
      }));
    }
  }, [
    brainSaveByJobId,
    isLoadingPersistedCritiques,
    persistedCritiques,
    selectedJob,
  ]);

  const activeSaveControls: SaveDestinationControls | undefined =
    activeJob && activeJob.id !== EXAMPLE_REASONING_JOB.id
      ? {
          isOpen: savePanelJobId === activeJob.id,
          projects: projectOptions,
          projectStatus: projectListStatus,
          selectedProjectSlugs: selectedSaveProjectSlugs,
          newProjectName,
          newProjectDescription,
          error: savePanelError,
          isCreatingProject: isCreatingProjectForSave,
          onOpen: () => handleOpenSavePanel(activeJob, activeBrainSaveStatus),
          onClose: () => {
            setSavePanelJobId(null);
            setSavePanelError(null);
          },
          onReloadProjects: () => void loadProjectsForSave(),
          onToggleProjectSlug: handleToggleSaveProjectSlug,
          onNewProjectNameChange: setNewProjectName,
          onNewProjectDescriptionChange: setNewProjectDescription,
          onSave: () => void handleSaveToSelectedProjects(activeJob),
        }
      : undefined;

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
                    Filter by issue type
                  </span>
                </div>
                <FilterChips
                  active={activeFilters}
                  options={findingFilterOptions}
                  totalCount={allFindings.length}
                  onClear={clearFilters}
                  onToggle={toggleFilter}
                />
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
                      {history.length > 0 ? (
                        <div className="px-3 pb-1 pt-1 text-[10px] font-medium uppercase tracking-widest text-muted">
                          Run history
                        </div>
                      ) : null}
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
                      {persistedHistory.length > 0 ? (
                        <div className="px-3 pb-1 pt-2 text-[10px] font-medium uppercase tracking-widest text-muted">
                          Saved in brain
                        </div>
                      ) : null}
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
                  <FindingDetail
                    key={`${activeJob.id}:${selectedFinding.finding_id ?? selectedFindingIndex}`}
                    finding={selectedFinding}
                  />
                  <ReportOverview job={activeJob} />
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
                <FindingDetail
                  key={`${activeJob.id}:${selectedFinding.finding_id ?? selectedFindingIndex}`}
                  finding={selectedFinding}
                />
                <ReportOverview
                  job={activeJob}
                  brainSaveStatus={activeBrainSaveStatus}
                  saveControls={activeSaveControls}
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
