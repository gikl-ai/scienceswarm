"use client";

import Link from "next/link";
import {
  Suspense,
  useState,
  useRef,
  useEffect,
  useCallback,
  useMemo,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  CaretDown,
  CaretUp,
  ChatCircleText,
  FileMagnifyingGlass,
  SidebarSimple,
  List,
  X,
} from "@phosphor-icons/react";
import type {
  CaptureKind,
  CaptureResult,
  ImportPreview,
  SourceRef,
} from "@/brain/types";
import { ProjectList } from "@/components/research/project-list";
import { type FileNode } from "@/components/research/file-tree";
import {
  ChatMentionInput,
  type MentionFile,
  type SlashCommandOption,
} from "@/components/research/chat-mention-input";
import { FileVisualizer } from "@/components/research/file-visualizer";
import type { CompiledPageRead } from "@/components/research/compiled-page-view";
import {
  useUnifiedChat,
  type ActiveFileContext,
  type Backend,
  type CaptureClarification,
  type ChatMode,
  type RuntimeSendOptions,
} from "@/hooks/use-unified-chat";
import type {
  RuntimeDataIncluded,
  TurnPreview,
} from "@/lib/runtime-hosts/contracts";
import { TurnPreviewSheet } from "@/components/runtime/turn-preview-sheet";
import { CompareResults } from "@/components/runtime/compare-results";
import { ComposerRuntimeSwitcher } from "@/components/runtime/composer-runtime-switcher";
import {
  useRuntimeHosts,
} from "@/hooks/use-runtime-hosts";
import { useProjectRuntimePreferences } from "@/hooks/use-project-runtime-preferences";
import { useVoiceChat, type VoiceState } from "@/hooks/use-voice-chat";
import { useFilePreviewLocation } from "@/hooks/use-file-preview-location";
import {
  useAutoRemediation,
  type AutoRemediationMessage,
} from "@/hooks/use-auto-remediation";
import { ChatMessage } from "@/components/research/chat-message";
import { WarmStartSection } from "@/components/setup/warm-start-section";
import {
  ImportDialog,
  type CompletedImportResult,
} from "@/components/research/import-dialog";
import {
  InlineChart,
  splitContentWithCharts,
} from "@/components/research/inline-chart";
import { SchedulerPanel } from "@/components/research/scheduler-panel";
import {
  buildPaperLibraryHrefForSlug,
  buildWorkspaceHrefForSlug,
  persistLastProjectSlug,
  readLastProjectSlug,
  safeProjectSlugOrNull,
} from "@/lib/project-navigation";
import {
  organizeFiles,
  organizeSummary,
  type OrganizedFile,
} from "@/lib/auto-organize";
import type { ArtifactProvenanceEntry } from "@/lib/artifact-provenance";
import {
  useProjectListResize,
  useVisualizerChatSplitResize,
} from "@/components/resizable-layout";
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
  type StructuredCritiqueJob,
  type StructuredCritiqueResult,
} from "@/lib/structured-critique-schema";
import { Spinner } from "@/components/spinner";
import {
  classifyFile,
  isRawRenderableKind,
  shouldLoadAsText,
  type FilePreviewState,
  type WorkspacePreviewSource,
} from "@/lib/file-visualization";
import {
  formatProjectOrganizerChatSummary,
  type ProjectOrganizerReadout,
} from "@/lib/project-organizer-summary";
import {
  buildOpenClawSlashCommands,
  looksLikeSlashCommandInput,
} from "@/lib/openclaw/slash-commands";
import { buildMirroredBrainPagePath } from "@/lib/brain-artifact-path";

// ── Types ──────────────────────────────────────────────────────
interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: Date;
  chatMode?: ChatMode;
  captureClarification?: CaptureClarification;
}

interface LatestImportSummary {
  name: string;
  preparedFiles: number;
  detectedItems?: number;
  detectedBytes?: number;
  duplicateGroups?: number;
  generatedAt: string;
  source: string;
}

interface ProjectImportSummaryResponse {
  project: string;
  lastImport: LatestImportSummary | null;
}

interface MultimodalInterpretationResponse {
  response?: string;
  savePath?: string;
  filesConsidered?: string[];
  unsupportedInputs?: string[];
  error?: string;
}

interface SlashCommandCatalogResponse {
  commands?: SlashCommandOption[];
  error?: string;
}

type SlashCommandStatus = "idle" | "loading" | "ready" | "error";

const DEFAULT_CHAT_SLASH_COMMANDS: SlashCommandOption[] =
  buildOpenClawSlashCommands([]);

// Radar runner freshness (Phase C / TODO #2). The skill runner writes
// a `.radar-last-run.json` pointer into the brain root every cycle;
// /api/brain/status reads it and returns this shape so the dashboard
// can show a "Radar last run: N minutes ago" line plus a warning chip
// when the run is older than 2x the schedule interval.
type BrainRadarStatus = {
  last_run: string;
  concepts_processed: number;
  errors: number;
  age_ms: number;
  stale: boolean;
  schedule_interval_ms: number;
  briefing_slug?: string;
  journal_slug?: string;
};

type BrainBootstrapState =
  | { status: "loading" }
  | { status: "missing"; message?: string }
  | {
      status: "ready";
      pageCount: number;
      backend?: string;
      radar?: BrainRadarStatus | null;
    }
  | { status: "error"; message: string };

type ImportSummaryState = "loading" | "ready" | "empty" | "error";
const SCIENCESWARM_SIGN_IN_URL = getScienceSwarmSignInUrl();

interface ExplicitCaptureIntent {
  content: string;
  kind?: CaptureKind;
  mode?: "capture" | "decision-update";
}

interface DecisionPreviewTarget {
  slug: string;
  path: string;
  title: string;
}

interface NextExperimentPlanIntent {
  updateExisting: boolean;
}

interface PendingRuntimeSend {
  prompt: string;
  activeFile?: ActiveFileContext;
  preview: TurnPreview;
  options: RuntimeSendOptions;
  label: string;
}

type Tab =
  | "chat"
  | "papers"
  | "experiments"
  | "results"
  | "data"
  | "editor"
  | "scheduler";

const STRUCTURED_CRITIQUE_POLL_MS = 3000;
const STRUCTURED_CRITIQUE_MAX_POLLS = 120;
const WEB_CAPTURE_USER_STORAGE_KEY = "scienceswarm.capture.web-user-id";
const MAX_PROMPT_HISTORY = 100;
const PROJECT_TAB_AUTO_REFRESH_MS = 15000;
const COMPOSER_HEIGHT_OPTIONS = [
  { px: 44, className: "h-11" },
  { px: 72, className: "h-[72px]" },
  { px: 96, className: "h-24" },
  { px: 128, className: "h-32" },
  { px: 160, className: "h-40" },
  { px: 192, className: "h-48" },
] as const;
const COMPOSER_DEFAULT_HEIGHT_INDEX = 1;
const CHAT_PLACEHOLDER_PROMPTS = [
  "Summarize the latest paper I uploaded",
  "What's the status of my experiments?",
  "What's still open from last week?",
  "Show me unfinished tasks",
  "Run the failing test and tell me why",
] as const;
const CHAT_PLACEHOLDER_ROTATE_MS = 4000;
const PROJECT_TREE_VISIBILITY_STORAGE_KEY =
  "scienceswarm:project-tree-visibility";
type ProjectTreeVisibilityMode = "auto" | "open" | "closed";

function runtimeTextBytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

function buildComposerRuntimeDataIncluded(
  prompt: string,
  activeFile?: ActiveFileContext,
): RuntimeDataIncluded[] {
  const data: RuntimeDataIncluded[] = [
    {
      kind: "prompt",
      label: "User prompt",
      bytes: runtimeTextBytes(prompt),
    },
  ];

  if (activeFile) {
    data.push({
      kind: "workspace-file",
      label: activeFile.path,
      bytes: runtimeTextBytes(activeFile.content),
    });
  }

  return data;
}

function readProjectTreeVisibilityMode(): ProjectTreeVisibilityMode | null {
  if (typeof window === "undefined") return null;
  try {
    const value = window.localStorage.getItem(
      PROJECT_TREE_VISIBILITY_STORAGE_KEY,
    );
    return value === "open" || value === "closed" || value === "auto"
      ? value
      : null;
  } catch {
    return null;
  }
}

function storeProjectTreeVisibilityMode(
  value: ProjectTreeVisibilityMode,
): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PROJECT_TREE_VISIBILITY_STORAGE_KEY, value);
  } catch {
    // Ignore storage failures; visibility still updates for this session.
  }
}

function normalizeChatContextPath(value?: string): string {
  return (value || "").trim().replace(/^\/+/, "");
}

function getChatContextKey(value?: string): string {
  const normalized = normalizeChatContextPath(value);
  const gbrainIndex = normalized.indexOf("gbrain:");
  if (gbrainIndex >= 0) {
    return normalized.slice(gbrainIndex).toLowerCase();
  }
  return normalized.toLowerCase();
}

function getChatContextLabel(pathOrName: string): string {
  return pathOrName.split("/").pop() || pathOrName;
}

function normalizePromptMatchKey(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function buildMessageArtifactState(
  messages: Array<{
    id: string;
    role: "user" | "assistant" | "system";
    content: string;
    channel?: string;
    timestamp: Date;
  }>,
  artifactProvenance: ArtifactProvenanceEntry[],
): {
  relatedArtifactsByMessageId: Map<string, ArtifactProvenanceEntry[]>;
  unresolvedPromptMessageIds: Set<string>;
} {
  const promptOccurrences = messages
    .filter(
      (message) =>
        message.role === "user" && (message.channel ?? "web") === "web",
    )
    .map((message) => ({
      id: message.id,
      promptKey: normalizePromptMatchKey(message.content),
      timestampMs: message.timestamp.getTime(),
    }))
    .filter((message) => message.promptKey.length > 0);

  const nextPromptTimestampByMessageId = new Map<string, number>();
  const nextPromptTimestampByKey = new Map<string, number>();
  for (let index = promptOccurrences.length - 1; index >= 0; index -= 1) {
    const occurrence = promptOccurrences[index];
    nextPromptTimestampByMessageId.set(
      occurrence.id,
      nextPromptTimestampByKey.get(occurrence.promptKey) ??
        Number.POSITIVE_INFINITY,
    );
    nextPromptTimestampByKey.set(occurrence.promptKey, occurrence.timestampMs);
  }

  const promptOccurrencesByKey = new Map<
    string,
    Array<{ id: string; timestampMs: number; nextPromptTimestampMs: number }>
  >();
  for (const occurrence of promptOccurrences) {
    const bucket = promptOccurrencesByKey.get(occurrence.promptKey) ?? [];
    bucket.push({
      id: occurrence.id,
      timestampMs: occurrence.timestampMs,
      nextPromptTimestampMs:
        nextPromptTimestampByMessageId.get(occurrence.id) ??
        Number.POSITIVE_INFINITY,
    });
    promptOccurrencesByKey.set(occurrence.promptKey, bucket);
  }

  const artifactsByPromptMessageId = new Map<
    string,
    ArtifactProvenanceEntry[]
  >();
  for (const artifact of [...artifactProvenance].sort(
    (left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt),
  )) {
    const promptKey = normalizePromptMatchKey(artifact.prompt);
    if (promptKey.length === 0) {
      continue;
    }

    const occurrences = promptOccurrencesByKey.get(promptKey);
    if (!occurrences || occurrences.length === 0) {
      continue;
    }

    const artifactTimestampMs = Date.parse(artifact.createdAt);
    const matchingOccurrence =
      occurrences.find((occurrence) => {
        if (Number.isNaN(artifactTimestampMs)) {
          return false;
        }
        return (
          artifactTimestampMs >= occurrence.timestampMs &&
          artifactTimestampMs < occurrence.nextPromptTimestampMs
        );
      }) ?? occurrences[occurrences.length - 1];

    const bucket = artifactsByPromptMessageId.get(matchingOccurrence.id) ?? [];
    bucket.push(artifact);
    artifactsByPromptMessageId.set(matchingOccurrence.id, bucket);
  }

  const relatedArtifactsByMessageId = new Map<
    string,
    ArtifactProvenanceEntry[]
  >();
  const unresolvedPromptMessageIds = new Set<string>();
  let pendingUserMessageId: string | null = null;
  const resolvedPromptMessageIds = new Set<string>();

  for (const message of messages) {
    if (message.role === "user" && (message.channel ?? "web") === "web") {
      const promptKey = normalizePromptMatchKey(message.content);
      pendingUserMessageId = promptKey.length > 0 ? message.id : null;
      continue;
    }

    if (message.role !== "assistant" || !pendingUserMessageId) {
      continue;
    }

    const bucket = artifactsByPromptMessageId.get(pendingUserMessageId);
    if (bucket && bucket.length > 0) {
      relatedArtifactsByMessageId.set(message.id, bucket);
      resolvedPromptMessageIds.add(pendingUserMessageId);
    }
    pendingUserMessageId = null;
  }

  for (const occurrence of promptOccurrences) {
    const bucket = artifactsByPromptMessageId.get(occurrence.id);
    if (
      !bucket ||
      bucket.length === 0 ||
      resolvedPromptMessageIds.has(occurrence.id)
    ) {
      continue;
    }
    relatedArtifactsByMessageId.set(occurrence.id, bucket);
    unresolvedPromptMessageIds.add(occurrence.id);
  }

  return {
    relatedArtifactsByMessageId,
    unresolvedPromptMessageIds,
  };
}

type ComposerHeightOption = (typeof COMPOSER_HEIGHT_OPTIONS)[number];

function getComposerHeightOption(index: number): ComposerHeightOption {
  return (
    COMPOSER_HEIGHT_OPTIONS[index] ??
    COMPOSER_HEIGHT_OPTIONS[COMPOSER_DEFAULT_HEIGHT_INDEX]
  );
}

function getNearestComposerHeightIndex(height: number): number {
  let nearestIndex = COMPOSER_DEFAULT_HEIGHT_INDEX;
  let nearestDistance = Number.POSITIVE_INFINITY;
  COMPOSER_HEIGHT_OPTIONS.forEach((option, index) => {
    const distance = Math.abs(option.px - height);
    if (distance < nearestDistance) {
      nearestIndex = index;
      nearestDistance = distance;
    }
  });
  return nearestIndex;
}

// ── Initial State (empty — no sample data) ───────────────────
const initialFiles: FileNode[] = [];

function buildStructuredCritiqueMessage(
  result: StructuredCritiqueResult,
): string {
  const summary =
    result.author_feedback?.overall_summary || "Structured critique complete.";
  const topIssues = (result.author_feedback?.top_issues || [])
    .slice(0, 3)
    .map(
      (issue, index) =>
        `${index + 1}. ${issue.title || "Issue"}\n${issue.summary || ""}`,
    )
    .join("\n\n");
  const findings = (result.findings || [])
    .slice(0, 3)
    .map((finding) => {
      const id = finding.finding_id || "Issue";
      const severity = finding.severity || "note";
      const description = finding.description || "";
      return `- ${id} (${severity}): ${description}`;
    })
    .join("\n");

  return [
    `**Structured critique**${result.title ? `: ${result.title}` : ""}`,
    "",
    summary,
    topIssues ? `Top issues\n\n${topIssues}` : "",
    findings ? `Findings\n${findings}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function readStructuredCritiqueError(payload: unknown): string | null {
  if (payload && typeof payload === "object" && "error" in payload) {
    const error = (payload as { error?: unknown }).error;
    return typeof error === "string" ? error : null;
  }
  return null;
}

function readStructuredCritiqueJobError(job: {
  error?: string | { user_facing_message?: string } | null;
  error_message?: string | null;
}): string | null {
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

function makeLocalMessageId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function buildCaptureTitle(content: string): string {
  const firstLine = content
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);

  if (!firstLine) {
    return "Untitled capture";
  }

  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
}

function parseExplicitCaptureIntent(
  text: string,
): ExplicitCaptureIntent | null {
  const patterns: Array<{
    pattern: RegExp;
    kind?: CaptureKind;
    mode?: "capture" | "decision-update";
  }> = [
    {
      pattern: /^\s*(?:decision\s+update|update\s+decision|amend\s+decision)\s*:\s*([\s\S]+)$/i,
      kind: "decision",
      mode: "decision-update",
    },
    { pattern: /^\s*remember(?:\s+this)?\s*:\s*([\s\S]+)$/i, kind: "note" },
    { pattern: /^\s*note\s*:\s*([\s\S]+)$/i, kind: "note" },
    { pattern: /^\s*observation\s*:\s*([\s\S]+)$/i, kind: "observation" },
    { pattern: /^\s*decision\s*:\s*([\s\S]+)$/i, kind: "decision" },
    { pattern: /^\s*hypothesis\s*:\s*([\s\S]+)$/i, kind: "hypothesis" },
    { pattern: /^\s*(?:task|todo)\s*:\s*([\s\S]+)$/i, kind: "task" },
    { pattern: /^\s*survey\s*:\s*([\s\S]+)$/i, kind: "survey" },
    { pattern: /^\s*method\s*:\s*([\s\S]+)$/i, kind: "method" },
    {
      pattern: /^\s*(?:original\s+synthesis|synthesis)\s*:\s*([\s\S]+)$/i,
      kind: "original_synthesis",
    },
    {
      pattern: /^\s*(?:research\s+packet|packet)\s*:\s*([\s\S]+)$/i,
      kind: "research_packet",
    },
    {
      pattern: /^\s*(?:overnight\s+journal|journal)\s*:\s*([\s\S]+)$/i,
      kind: "overnight_journal",
    },
  ];

  for (const { pattern, kind, mode } of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const content = match[1]?.trim();
    if (!content) return null;
    return { content, kind, mode: mode ?? "capture" };
  }

  return null;
}

function looksLikeMultimodalInterpretRequest(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return false;

  const analysisIntent =
    /\b(interpret|analy[sz]e|synthesi[sz]e|summari[sz]e|explain|readout|read out)\b/.test(
      normalized,
    );
  if (!analysisIntent) {
    return false;
  }

  const explicitPacketHint =
    /\b(multimodal|mixed|packet)\b/.test(normalized) ||
    /\b(combined|together|across)\b/.test(normalized);
  const modalityHint =
    /\b(results?|experiment|assay|readout|note|caption|table|csv|figure|image|plot|upload(?:ed)?|inputs?|files?)\b/.test(
      normalized,
    );

  return explicitPacketHint && modalityHint;
}

function parseNextExperimentPlanIntent(
  text: string,
): NextExperimentPlanIntent | null {
  const normalized = text.trim().toLowerCase();
  const asksForPlanner =
    /\b(next experiment|next experiments|experiment plan|best experiment|best next experiment)\b/i.test(normalized)
    || (
      /\b(rank|prioritize|distinguish|separate|what should we do next)\b/i.test(normalized)
      && /\b(experiment|assay|readout|control)\b/i.test(normalized)
    );

  if (!asksForPlanner) {
    return null;
  }

  return {
    updateExisting:
      /\b(update|revise|rerank|re-rank|change|after this result|based on the new result|new result)\b/i.test(normalized),
  };
}

function formatCaptureKind(kind: CaptureKind): string {
  const labels: Record<CaptureKind, string> = {
    note: "Note",
    observation: "Observation",
    decision: "Decision",
    hypothesis: "Hypothesis",
    task: "Task",
    survey: "Survey",
    method: "Method",
    original_synthesis: "Original synthesis",
    research_packet: "Research packet",
    overnight_journal: "Overnight journal",
  };

  return labels[kind];
}

function isCaretOnFirstLine(element: HTMLTextAreaElement): boolean {
  const selectionStart = element.selectionStart ?? 0;
  const selectionEnd = element.selectionEnd ?? selectionStart;
  if (selectionStart !== selectionEnd) return false;
  return !element.value.slice(0, selectionStart).includes("\n");
}

function isCaretOnLastLine(element: HTMLTextAreaElement): boolean {
  const selectionStart = element.selectionStart ?? element.value.length;
  const selectionEnd = element.selectionEnd ?? selectionStart;
  if (selectionStart !== selectionEnd) return false;
  return !element.value.slice(selectionStart).includes("\n");
}

function buildCaptureConfirmationMessage(
  result: CaptureResult,
  capturedContent: string,
): string {
  const lines = [
    result.requiresClarification
      ? "**Brain capture saved unlinked**"
      : "**Brain capture saved**",
    `Title: ${buildCaptureTitle(capturedContent)}`,
    `Kind: ${formatCaptureKind(result.kind)}`,
    result.project ? `Project: ${result.project}` : "Project: unlinked",
    `Path: ${result.materializedPath ?? result.rawPath}`,
  ];

  if (result.extractedTasks && result.extractedTasks.length > 0) {
    lines.push("Tasks:");
    lines.push(...result.extractedTasks.map((taskPath) => `- ${taskPath}`));
  }

  if (result.requiresClarification) {
    lines.push(
      result.clarificationQuestion ??
        "Which project should I link this capture to?",
    );
  }

  return lines.join("\n");
}

// ── Voice Button ──────────────────────────────────────────────

const VOICE_LABELS: Record<VoiceState, string> = {
  idle: "Voice",
  recording: "Listening…",
  transcribing: "Transcribing…",
  speaking: "Mute",
};

const VOICE_ARIA: Record<VoiceState, string> = {
  idle: "Start voice input",
  recording: "Listening. Click to stop recording.",
  transcribing: "Transcribing speech, please wait.",
  speaking: "Mute voice response",
};

const VOICE_TITLES: Record<VoiceState, string> = {
  idle: "Click to speak (voice chat)",
  recording: "Click to stop recording",
  transcribing: "Processing speech…",
  speaking: "Click to stop playback",
};

const VOICE_STYLES: Record<VoiceState, string> = {
  idle: "bg-surface border-2 border-border text-muted hover:text-accent hover:border-accent",
  recording: "bg-red-500 border-2 border-red-500 text-white",
  transcribing: "bg-amber-100 border-2 border-amber-300 text-amber-700",
  speaking: "bg-accent/10 border-2 border-accent text-accent",
};

const VOICE_ERROR_STYLE = "bg-red-50 border-2 border-red-500 text-red-700";

function MicIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className ?? "w-4 h-4"}
    >
      <rect x="9" y="3" width="6" height="12" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <line x1="12" y1="19" x2="12" y2="22" />
    </svg>
  );
}

function PulsingDot() {
  return (
    <span aria-hidden="true" className="relative inline-flex h-2.5 w-2.5">
      <span className="absolute inline-flex h-full w-full rounded-full bg-white opacity-75 animate-ping" />
      <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-white" />
    </span>
  );
}

function VoiceButton({
  voiceState,
  voiceError,
  onClearError,
  disabled,
  onStart,
  onStop,
}: {
  voiceState: VoiceState;
  voiceError: string | null;
  onClearError: () => void;
  disabled: boolean;
  onStart: () => void;
  onStop: () => void;
}) {
  const isActive = voiceState !== "idle";
  const isBusy = voiceState === "transcribing";

  // Brief, friendly error message derived from underlying error.
  const errorMessage = useMemo(() => {
    if (!voiceError) return null;
    const lower = voiceError.toLowerCase();
    if (
      lower.includes("permission") ||
      lower.includes("denied") ||
      lower.includes("notallowed")
    ) {
      return "Mic blocked";
    }
    if (lower.includes("no speech") || lower.includes("empty")) {
      return "No speech detected";
    }
    if (lower.includes("not supported") || lower.includes("unsupported")) {
      return "Not supported";
    }
    return "Voice error";
  }, [voiceError]);

  // Auto-clear error after 3s so the button returns to idle.
  useEffect(() => {
    if (!voiceError) return;
    const t = window.setTimeout(() => onClearError(), 3000);
    return () => window.clearTimeout(t);
  }, [voiceError, onClearError]);

  const showError = Boolean(voiceError) && voiceState === "idle";
  const appliedStyle = showError ? VOICE_ERROR_STYLE : VOICE_STYLES[voiceState];
  const ariaLabel = showError
    ? `Voice error: ${errorMessage}`
    : VOICE_ARIA[voiceState];

  return (
    <div className="flex-shrink-0 flex flex-col items-start">
      <button
        type="button"
        onClick={isActive ? onStop : onStart}
        disabled={disabled || isBusy}
        title={
          showError ? (errorMessage ?? "Voice error") : VOICE_TITLES[voiceState]
        }
        aria-label={ariaLabel}
        aria-live={voiceState === "recording" ? "polite" : undefined}
        aria-busy={isBusy || undefined}
        className={`inline-flex items-center gap-2 rounded-xl px-3 py-3 text-sm font-medium transition-colors disabled:opacity-50 ${appliedStyle}`}
      >
        {voiceState === "recording" ? (
          <PulsingDot />
        ) : voiceState === "transcribing" ? (
          <Spinner />
        ) : (
          <MicIcon />
        )}
        <span>
          {showError
            ? (errorMessage ?? "Voice error")
            : VOICE_LABELS[voiceState]}
        </span>
      </button>
      {/* Accessible, polite announcement for transient errors. */}
      <div role="status" aria-live="polite" className="sr-only">
        {showError ? `Voice error: ${errorMessage}` : ""}
      </div>
    </div>
  );
}

function getImportSummaryStorageKey(projectName: string): string {
  return `scienceswarm.project.importSummary.${encodeURIComponent(projectName || "__global__")}`;
}

function normalizeBrainArtifactSlug(
  slug: string | null | undefined,
): string | null {
  const trimmed = slug?.trim().replace(/^gbrain:/, "");
  if (!trimmed) return null;
  return trimmed.replace(/\.md$/i, "");
}

interface GbrainPreviewTarget {
  path: string;
  slug: string;
  fallbackName: string;
  readPath: string;
}

function extractGbrainPreviewTarget(
  path: string,
): GbrainPreviewTarget | null {
  const normalized = path.trim();
  const markerIndex = normalized.lastIndexOf("gbrain:");
  if (markerIndex < 0) {
    return null;
  }

  const slug = normalized
    .slice(markerIndex + "gbrain:".length)
    .trim()
    .replace(/^\/+/, "");
  if (!slug) {
    return null;
  }

  const fallbackName = slug.split("/").pop() || slug;
  return {
    path: normalized,
    slug,
    fallbackName,
    readPath: slug,
  };
}

function buildSyntheticGbrainFileNode(path: string): FileNode | null {
  const target = extractGbrainPreviewTarget(path);
  if (!target) {
    return null;
  }

  return {
    name: target.fallbackName,
    type: "file",
    source: "gbrain",
    slug: target.slug,
    icon: "\uD83E\uDDE0",
  };
}

function buildGbrainPreviewTarget(
  path: string,
  node?: FileNode | null,
): GbrainPreviewTarget | null {
  const slug = node?.slug?.trim().replace(/^gbrain:/, "").replace(/^\/+/, "");
  if (!slug) {
    return extractGbrainPreviewTarget(path);
  }

  return {
    path,
    slug,
    fallbackName: node?.name?.trim() || path.split("/").pop() || slug,
    readPath: buildMirroredBrainPagePath(slug, node?.pageType) ?? slug,
  };
}

async function loadGbrainPreviewState(
  target: GbrainPreviewTarget,
  signal?: AbortSignal,
): Promise<FilePreviewState> {
  try {
    const readRes = await fetch(
      `/api/brain/read?path=${encodeURIComponent(target.readPath)}`,
      { signal },
    );
    if (readRes.ok) {
      const compiledPage = (await readRes.json()) as CompiledPageRead;
      const hasCompiledPayload =
        typeof compiledPage.path === "string" &&
        (typeof compiledPage.compiled_truth === "string" ||
          compiledPage.frontmatter !== undefined ||
          Array.isArray(compiledPage.timeline) ||
          Array.isArray(compiledPage.links) ||
          Array.isArray(compiledPage.backlinks));
      if (hasCompiledPayload) {
        const compiledContent =
          compiledPage.compiled_truth ?? compiledPage.content ?? "";
        return {
          status: "ready",
          path: target.path,
          source: "gbrain",
          kind: "markdown",
          content: compiledContent,
          mime: "text/markdown",
          editable: false,
          compiledPage,
        };
      }

      if (
        typeof compiledPage.path === "string" &&
        typeof compiledPage.content === "string"
      ) {
        return {
          status: "ready",
          path: target.path,
          source: "gbrain",
          kind: "markdown",
          content: compiledPage.content,
          mime: "text/markdown",
          editable: false,
        };
      }
    }
  } catch (error: unknown) {
    if (error instanceof Error && error.name === "AbortError") {
      throw error;
    }
    // Fall through to file-ref rendering.
  }

  const brainFileUrl = `/api/brain/file?slug=${encodeURIComponent(target.slug)}`;

  try {
    const metaRes = await fetch(`${brainFileUrl}&metadata=1`, { signal });
    if (metaRes.ok) {
      const meta = (await metaRes.json()) as {
        mime?: string;
        source_filename?: string;
        size?: number;
      };
      const kind = classifyFile(
        meta.source_filename ?? target.fallbackName,
        meta.mime,
      );

      if (isRawRenderableKind(kind)) {
        return {
          status: "ready",
          path: target.path,
          source: "gbrain",
          kind,
          rawUrl: brainFileUrl,
          mime: meta.mime,
          sizeBytes: meta.size,
          editable: false,
        };
      }

      if (shouldLoadAsText(kind)) {
        const rawRes = await fetch(brainFileUrl, { signal });
        if (rawRes.ok) {
          return {
            status: "ready",
            path: target.path,
            source: "gbrain",
            kind,
            content: await rawRes.text(),
            mime: meta.mime,
            sizeBytes: meta.size,
            editable: false,
          };
        }
      }
    }
  } catch (error: unknown) {
    if (error instanceof Error && error.name === "AbortError") {
      throw error;
    }
    // Fall through to page content.
  }

  try {
    const pageRes = await fetch(
      `/api/brain/page?slug=${encodeURIComponent(target.slug)}`,
      { signal },
    );
    if (pageRes.ok) {
      const pageData = (await pageRes.json()) as { content?: string };
      if (typeof pageData.content === "string") {
        return {
          status: "ready",
          path: target.path,
          source: "gbrain",
          kind: "markdown",
          content: pageData.content,
          mime: "text/markdown",
          editable: false,
        };
      }
    }
  } catch (error: unknown) {
    if (error instanceof Error && error.name === "AbortError") {
      throw error;
    }
    // Fall through.
  }

  return {
    status: "error",
    path: target.path,
    source: "gbrain",
    message: `Failed to load ${target.slug}.`,
    retryable: true,
  };
}

function captureSourceRefFromPath(path: string): SourceRef | null {
  const trimmed = path.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("gbrain:")) {
    const slug = normalizeBrainArtifactSlug(trimmed);
    return slug ? { kind: "artifact", ref: slug } : null;
  }
  return { kind: "artifact", ref: trimmed };
}

function buildDecisionPreviewTarget(
  node: FileNode | null | undefined,
): DecisionPreviewTarget | null {
  const slug = normalizeBrainArtifactSlug(node?.slug);
  if (!slug || node?.pageType?.trim().toLowerCase() !== "decision") {
    return null;
  }

  const path = buildMirroredBrainPagePath(slug, "decision");
  if (!path) {
    return null;
  }

  return {
    slug,
    path,
    title: node?.name ?? slug,
  };
}

function buildActiveCompiledPageContext(
  preview: FilePreviewState,
): string | null {
  if (preview.status !== "ready" || typeof preview.content !== "string") {
    return null;
  }

  const content = preview.content.trim();
  if (!content) {
    return null;
  }

  const page = preview.compiledPage;
  if (!page) {
    return content;
  }

  const contextParts = [content];
  const sourceLines = [
    ...(page.timeline ?? []).map((entry) =>
      [
        "Timeline source:",
        entry.source ?? "timeline",
        entry.summary,
        entry.detail ?? "",
      ]
        .filter(Boolean)
        .join(" "),
    ),
    ...(page.links ?? []).map(
      (link) =>
        `Linked source: ${link.kind} ${link.title || link.slug} (${link.slug})${link.context ? ` - ${link.context}` : ""}`,
    ),
    ...(page.backlinks ?? []).map(
      (link) =>
        `Backlink source: ${link.kind} ${link.title || link.slug} (${link.slug})${link.context ? ` - ${link.context}` : ""}`,
    ),
  ];

  if (sourceLines.length > 0) {
    contextParts.push("Visible source context:");
    contextParts.push(...sourceLines);
  }

  return contextParts.join("\n");
}

function artifactSlugFromFilename(filename: string): string {
  const base = filename.replace(/\.[^.]+$/, "");
  return (
    base
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/-+/g, "-") || "upload"
  );
}

function normalizeImportSummary(value: unknown): LatestImportSummary | null {
  if (!value || typeof value !== "object") return null;

  const candidate = value as Partial<LatestImportSummary>;
  if (
    typeof candidate.name !== "string" ||
    typeof candidate.preparedFiles !== "number" ||
    typeof candidate.generatedAt !== "string" ||
    typeof candidate.source !== "string"
  ) {
    return null;
  }

  return {
    name: candidate.name,
    preparedFiles: candidate.preparedFiles,
    detectedItems:
      typeof candidate.detectedItems === "number"
        ? candidate.detectedItems
        : undefined,
    detectedBytes:
      typeof candidate.detectedBytes === "number"
        ? candidate.detectedBytes
        : undefined,
    duplicateGroups:
      typeof candidate.duplicateGroups === "number"
        ? candidate.duplicateGroups
        : undefined,
    generatedAt: candidate.generatedAt,
    source: candidate.source,
  };
}

function formatImportWarningForChat(
  warning: ImportPreview["warnings"][number],
): string {
  const labels: Record<string, string> = {
    "source-fallback-unsupported": "Saved without typed conversion",
    "source-fallback-recovered": "Recovered after typed conversion failed",
    "source-attachment-failed": "Source attachment unavailable",
    "empty-import": "No importable files",
    "file-limit": "Preview limit",
    "scan-limit": "Scan limit",
    "indexing-failed": "Indexing warning",
  };

  const label = labels[warning.code];
  return label
    ? `${label}: ${warning.message}`
    : `${warning.code}: ${warning.message}`;
}

// ── LazyFileCard ────────────────────────────────────────────────
/**
 * Renders a persisted `__FILE_STATIC__` card. On a fresh page load the
 * in-memory `staticPreviewsRef` is empty, so this component fetches the
 * file content on-demand via the workspace API and renders the result.
 */
function LazyFileCard({
  path: filePath,
  messageId,
  staticPreviewsRef,
  projectSlug,
  onRetry,
  onSaveContent,
  onNavigateBrainPage,
}: {
  path: string;
  messageId: string;
  staticPreviewsRef: React.RefObject<Map<string, FilePreviewState>>;
  projectSlug: string | null;
  onRetry: () => void;
  onSaveContent: (content: string) => Promise<void>;
  onNavigateBrainPage: (slug: string) => void;
}) {
  const gbrainTarget = extractGbrainPreviewTarget(filePath);
  const [preview, setPreview] = useState<FilePreviewState>({
    status: "loading",
    path: filePath,
    source: gbrainTarget ? "gbrain" : "workspace",
  });

  useEffect(() => {
    // If snapshot already exists in the ref (same-session navigation),
    // use it directly instead of re-fetching.
    const cached = staticPreviewsRef.current.get(messageId);
    if (cached) {
      setPreview(cached);
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    setPreview({
      status: "loading",
      path: filePath,
      source: gbrainTarget ? "gbrain" : "workspace",
    });

    if (gbrainTarget) {
      void loadGbrainPreviewState(gbrainTarget, controller.signal)
        .then((nextPreview) => {
          if (cancelled) return;
          setPreview(nextPreview);
        })
        .catch((error: unknown) => {
          if (error instanceof Error && error.name === "AbortError") {
            return;
          }
          if (cancelled) return;
          setPreview({
            status: "error",
            path: filePath,
            source: "gbrain",
            message: "Unexpected error loading preview.",
            retryable: true,
          });
        });
      return () => {
        cancelled = true;
        controller.abort();
      };
    }

    const kind = classifyFile(filePath);

    // For raw-renderable files (images, PDFs), we can resolve immediately
    // without fetching content — just supply the raw URL.
    if (isRawRenderableKind(kind)) {
      const params = new URLSearchParams({ action: "raw", file: filePath });
      if (projectSlug) params.set("projectId", projectSlug);
      setPreview({
        status: "ready",
        path: filePath,
        source: "workspace",
        kind,
        rawUrl: `/api/workspace?${params.toString()}`,
        editable: false,
      });
      return;
    }

    if (!shouldLoadAsText(kind)) {
      setPreview({
        status: "error",
        path: filePath,
        source: "workspace",
        message: "Cannot preview this file type.",
        retryable: false,
      });
      return;
    }

    const params = new URLSearchParams({ action: "file", file: filePath });
    if (projectSlug) params.set("projectId", projectSlug);

    fetch(`/api/workspace?${params.toString()}`)
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          setPreview({
            status: "error",
            path: filePath,
            source: "workspace",
            message:
              res.status === 404
                ? "File no longer exists."
                : "Failed to load file.",
            retryable: res.status !== 404,
          });
          return;
        }
        const data = (await res.json()) as { content?: string; size?: number };
        if (cancelled) return;
        setPreview({
          status: "ready",
          path: filePath,
          source: "workspace",
          kind,
          content: typeof data.content === "string" ? data.content : "",
          sizeBytes: data.size,
          mime: "text/plain",
          editable: false,
        });
      })
      .catch(() => {
        if (cancelled) return;
        setPreview({
          status: "error",
          path: filePath,
          source: "workspace",
          message: "Failed to load file.",
          retryable: true,
        });
      });

    return () => {
      cancelled = true;
    };
  }, [filePath, messageId, projectSlug, staticPreviewsRef]);

  return (
    <div className="rounded-2xl border border-border bg-white shadow-sm overflow-hidden h-[66vh]">
      <FileVisualizer
        preview={preview}
        onRetry={onRetry}
        onSaveContent={onSaveContent}
        onNavigateBrainPage={onNavigateBrainPage}
        extraActions={
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex h-8 items-center gap-1 rounded border border-border bg-white px-2.5 text-[11px] font-semibold text-foreground transition-colors hover:border-accent hover:text-accent"
          >
            Edit
          </button>
        }
      />
    </div>
  );
}

// ── Component ──────────────────────────────────────────────────
function ProjectPageContent() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const {
    authDetail,
    beginSignIn,
    isLoaded: isAuthLoaded,
    isSignedIn,
    isSigningIn,
    signOut,
  } = useScienceSwarmLocalAuth();
  const { projectListWidth, onProjectListResizeMouseDown } =
    useProjectListResize();
  const projectSlugFromUrl = searchParams.get("name");
  const activeProjectSlug = safeProjectSlugOrNull(projectSlugFromUrl);
  const projectName = activeProjectSlug ?? "";
  const requestedBrainSlug = searchParams.get("brain_slug");
  // Accept both `?onboarding=continue` (the post-save handoff from
  // `/setup`) and the legacy `?onboarding=1` flag so links already in
  // the wild still work.
  const onboardingFlag = searchParams.get("onboarding");
  const onboardingRequested =
    onboardingFlag === "continue" || onboardingFlag === "1";

  const [activeTab, setActiveTab] = useState<Tab>("chat");
  const [input, setInput] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [slashCommandsStatus, setSlashCommandsStatus] =
    useState<SlashCommandStatus>("idle");
  const [slashCommands, setSlashCommands] = useState<SlashCommandOption[]>(
    DEFAULT_CHAT_SLASH_COMMANDS,
  );
  const [chatInputFocused, setChatInputFocused] = useState(false);
  const [chatInputDragOver, setChatInputDragOver] = useState(false);
  const [composerHeightIndex, setComposerHeightIndex] = useState(
    COMPOSER_DEFAULT_HEIGHT_INDEX,
  );
  const [placeholderIndex, setPlaceholderIndex] = useState(0);
  const composerHeightOption = getComposerHeightOption(composerHeightIndex);
  const [projectTreeVisibilityMode, setProjectTreeVisibilityMode] =
    useState<ProjectTreeVisibilityMode>("auto");
  const [projectTreeMatchesDesktop, setProjectTreeMatchesDesktop] =
    useState(true);
  const projectTreeIsVisible =
    projectTreeVisibilityMode === "open" ||
    (projectTreeVisibilityMode === "auto" && projectTreeMatchesDesktop);
  const projectTreeDisplayClass =
    projectTreeVisibilityMode === "closed"
      ? "hidden"
      : projectTreeVisibilityMode === "open"
        ? "block"
        : "hidden md:block";
  const projectTreeToggleLabel = projectTreeIsVisible
    ? "Hide project tree"
    : "Show project tree";

  useEffect(() => {
    const storedMode = readProjectTreeVisibilityMode();
    if (storedMode !== null) {
      setProjectTreeVisibilityMode(storedMode);
    }
  }, []);

  useEffect(() => {
    if (
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    )
      return;
    const mediaQuery = window.matchMedia("(min-width: 768px)");
    const sync = (event?: MediaQueryListEvent) => {
      setProjectTreeMatchesDesktop(event?.matches ?? mediaQuery.matches);
    };
    sync();
    mediaQuery.addEventListener?.("change", sync);
    return () => mediaQuery.removeEventListener?.("change", sync);
  }, []);

  const handleProjectTreeToggle = useCallback(() => {
    setProjectTreeVisibilityMode((currentMode) => {
      const currentlyVisible =
        currentMode === "open" ||
        (currentMode === "auto" && projectTreeMatchesDesktop);
      const nextMode: ProjectTreeVisibilityMode = currentlyVisible
        ? "closed"
        : "open";
      storeProjectTreeVisibilityMode(nextMode);
      return nextMode;
    });
  }, [projectTreeMatchesDesktop]);

  // ── Chat draft persistence ──
  // Persist the in-progress chat draft to localStorage per project so it
  // survives reloads and tab switches. Restored once on mount (post-hydration
  // to avoid SSR mismatch), debounced write on change, cleared on send.
  const chatDraftStorageKey = `scienceswarm.chat.draft.${activeProjectSlug ?? "__global__"}`;
  const chatDraftRestoredRef = useRef(false);
  const previousChatDraftStorageKeyRef = useRef(chatDraftStorageKey);
  useEffect(() => {
    let syncDraftFrame: number | null = null;
    // Reset restore flag when the active project changes, then re-hydrate.
    const storageKeyChanged = previousChatDraftStorageKeyRef.current !== chatDraftStorageKey;
    previousChatDraftStorageKeyRef.current = chatDraftStorageKey;
    chatDraftRestoredRef.current = false;
    if (typeof window === "undefined") return;
    try {
      const stored = window.localStorage.getItem(chatDraftStorageKey);
      const restoredDraft = stored && stored.length > 0 ? stored : "";
      setInput((currentDraft) => {
        // A fast user or e2e run can type before this post-hydration restore
        // lands. Keep that live text unless the project draft key changed.
        return !storageKeyChanged && currentDraft.length > 0
          ? currentDraft
          : restoredDraft;
      });
      // Keep prompt-history restore aligned with the destination project draft
      // even before React commits the new textarea value.
      draftInputRef.current = restoredDraft;
      syncDraftFrame = window.requestAnimationFrame(() => {
        const domValue = inputRef.current?.value;
        if (domValue !== undefined && domValue.length > 0) {
          draftInputRef.current = domValue;
        }
      });
      promptHistoryIndexRef.current = null;
    } catch {
      // localStorage unavailable (private mode, disabled, etc.) — ignore.
    } finally {
      chatDraftRestoredRef.current = true;
    }

    return () => {
      if (syncDraftFrame !== null) {
        window.cancelAnimationFrame(syncDraftFrame);
      }
    };
  }, [chatDraftStorageKey]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    // Avoid clobbering storage before the mount-time restore has run.
    if (!chatDraftRestoredRef.current) return;
    const handle = window.setTimeout(() => {
      try {
        if (input.length === 0) {
          window.localStorage.removeItem(chatDraftStorageKey);
        } else {
          window.localStorage.setItem(chatDraftStorageKey, input);
        }
      } catch {
        // ignore storage failures
      }
    }, 300);
    return () => window.clearTimeout(handle);
  }, [input, chatDraftStorageKey]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [selectedFileNode, setSelectedFileNode] = useState<FileNode | null>(
    null,
  );
  const [lastExperimentPlanSlug, setLastExperimentPlanSlug] = useState<string | null>(null);
  const [isPlanningExperiments, setIsPlanningExperiments] = useState(false);
  const [filePreview, setFilePreview] = useState<FilePreviewState>({
    status: "idle",
  });
  const staticPreviewsRef = useRef<Map<string, FilePreviewState>>(new Map());
  const [paneMode, setPaneMode] = useState<
    "both" | "chat-only" | "visualizer-only"
  >("chat-only");
  const [filePreviewLocation] = useFilePreviewLocation();
  const [latestPdfFile, setLatestPdfFile] = useState<File | null>(null);
  const [isCritiquing, setIsCritiquing] = useState(false);
  const [critiqueJob, setCritiqueJob] = useState<StructuredCritiqueJob | null>(
    null,
  );
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [importDialogInitialPath, setImportDialogInitialPath] = useState<
    string | null
  >(null);
  const [mobileProjectListOpen, setMobileProjectListOpen] = useState(false);
  const [isAutoAnalyzing, setIsAutoAnalyzing] = useState(false);
  const [latestImportSummary, setLatestImportSummary] =
    useState<LatestImportSummary | null>(null);
  const [importSummaryState, setImportSummaryState] =
    useState<ImportSummaryState>("loading");
  const [hasImportedArchive, setHasImportedArchive] = useState(false);
  const [brainBootstrapState, setBrainBootstrapState] =
    useState<BrainBootstrapState>({ status: "loading" });
  const [isCapturing, setIsCapturing] = useState(false);
  const [isInterpretingPacket, setIsInterpretingPacket] = useState(false);
  const [, setProjectFiles] = useState<FileNode[]>(initialFiles);
  const [, setOrganizeBadge] = useState<string | null>(null);
  const [gbrainNodes, setGbrainNodes] = useState<FileNode[]>([]);
  const [gbrainNodesLoaded, setGbrainNodesLoaded] = useState(!activeProjectSlug);
  const [hasPaperLibraryActivity, setHasPaperLibraryActivity] = useState(false);
  const [paperLibraryActivityLoaded, setPaperLibraryActivityLoaded] =
    useState(!activeProjectSlug);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const slashCommandsRequestControllerRef = useRef<AbortController | null>(
    null,
  );
  const rightWorkspaceRef = useRef<HTMLDivElement>(null);
  const filePreviewRef = useRef<FilePreviewState>({ status: "idle" });
  const filePreviewLocationRef = useRef(filePreviewLocation);
  const gbrainArtifactRefreshControllerRef = useRef<AbortController | null>(
    null,
  );
  const lastViewedDecisionRef = useRef<DecisionPreviewTarget | null>(null);
  const previewRequestSeqRef = useRef(0);
  const isMountedRef = useRef(true);
  const autoOnboardingHandledRef = useRef(false);
  const workspaceWatchPrimedRef = useRef(false);
  const wasStreamingRef = useRef(false);
  const promptHistoryRef = useRef<string[]>([]);
  const promptHistoryIndexRef = useRef<number | null>(null);
  const draftInputRef = useRef("");
  const getCritiqueHeaders = useCallback(async () => ({}), []);
  const {
    visualizerHeight,
    onVisualizerChatResizeMouseDown,
    onVisualizerChatResizeKeyDown,
  } = useVisualizerChatSplitResize(rightWorkspaceRef);

  useEffect(() => {
    filePreviewRef.current = filePreview;
  }, [filePreview]);

  useEffect(() => {
    filePreviewLocationRef.current = filePreviewLocation;
  }, [filePreviewLocation]);

  useEffect(() => {
    setMobileProjectListOpen(false);
  }, [activeProjectSlug]);

  useEffect(() => {
    setGbrainNodesLoaded(!activeProjectSlug);
    setHasPaperLibraryActivity(false);
    setPaperLibraryActivityLoaded(!activeProjectSlug);
    setImportSummaryState("loading");
  }, [activeProjectSlug]);

  useEffect(() => {
    if (activeProjectSlug) {
      persistLastProjectSlug(activeProjectSlug);
      return;
    }

    const lastProjectSlug = readLastProjectSlug();
    if (!lastProjectSlug) {
      return;
    }
    router.replace(buildWorkspaceHrefForSlug(lastProjectSlug));
  }, [activeProjectSlug, router]);

  // ── Unified chat hook ──
  const {
    messages,
    setMessages,
    sendMessage,
    isStreaming,
    error,
    crossChannelMessages,
    uploadedFiles,
    workspaceTree,
    handleFiles,
    addWorkspaceFileToChatContext,
    removeFileFromChatContext,
    clearChatContext,
    checkChanges,
    refreshWorkspace,
    recordGeneratedArtifacts,
    setError,
    clearError,
    conversationId,
    artifactProvenance,
    runtimeCompareResult,
    clearRuntimeCompareResult,
  } = useUnifiedChat(projectName);
  const runtimeHosts = useRuntimeHosts();
  const {
    projectPolicy: runtimeProjectPolicy,
    mode: runtimeMode,
    selectedHostId: selectedRuntimeHostId,
    compareHostIds,
    setProjectPolicy: setRuntimeProjectPolicy,
    setMode: setRuntimeMode,
    setSelectedHostId: setSelectedRuntimeHostId,
    setCompareHostIds: setRuntimeCompareHostIds,
  } = useProjectRuntimePreferences(activeProjectSlug, runtimeHosts.hosts);
  const [runtimeSwitcherOpen, setRuntimeSwitcherOpen] = useState(false);
  const [pendingRuntimeSend, setPendingRuntimeSend] =
    useState<PendingRuntimeSend | null>(null);
  const [runtimePreviewBusy, setRuntimePreviewBusy] = useState(false);
  const [runtimePreviewError, setRuntimePreviewError] = useState<string | null>(null);
  useEffect(() => {
    if (runtimeMode !== "compare") {
      clearRuntimeCompareResult();
    }
  }, [clearRuntimeCompareResult, runtimeMode]);
  const activeAssistantMessageId = isStreaming
    ? [...messages].reverse().find((message) => message.role === "assistant")?.id ?? null
    : null;
  // Merge workspace files with gbrain-backed artifact nodes.
  const mergedFileTree: FileNode[] = useMemo(() => {
    if (gbrainNodes.length === 0) return workspaceTree as FileNode[];
    const brainDir: FileNode = {
      name: "Brain Artifacts",
      type: "directory",
      icon: "\uD83E\uDDE0",
      source: "gbrain",
      children: gbrainNodes,
    };
    return [...(workspaceTree as FileNode[]), brainDir];
  }, [workspaceTree, gbrainNodes]);
  // Flatten the workspace tree into mention-ready entries for @-autocomplete.
  const mentionFiles = useMemo<MentionFile[]>(() => {
    const out: MentionFile[] = [];
    const walk = (nodes: FileNode[], prefix: string) => {
      for (const node of nodes) {
        const path =
          node.source === "gbrain" && node.slug
            ? `gbrain:${node.slug}`
            : prefix
              ? `${prefix}/${node.name}`
              : node.name;
        if (node.type === "file") {
          out.push({
            name: node.name,
            path,
            source: node.source === "gbrain" ? "gbrain" : "workspace",
            brainSlug: node.slug,
          });
        } else if (Array.isArray(node.children)) {
          walk(node.children, path);
        }
      }
    };
    walk(mergedFileTree, "");
    return out;
  }, [mergedFileTree]);
  const chatContextItems = useMemo(
    () =>
      uploadedFiles
        .map((file) => {
          const path =
            typeof file.brainSlug === "string" &&
            file.brainSlug.trim().length > 0
              ? `gbrain:${file.brainSlug.trim()}`
              : normalizeChatContextPath(file.workspacePath || file.name);
          return {
            key: getChatContextKey(path),
            label: file.name || getChatContextLabel(path),
            path,
          };
        })
        .filter((file) => file.path.length > 0),
    [uploadedFiles],
  );
  const visibleChatContextItems = chatContextItems.slice(-2);
  const hiddenChatContextItemCount = Math.max(
    0,
    chatContextItems.length - visibleChatContextItems.length,
  );
  const { relatedArtifactsByMessageId, unresolvedPromptMessageIds } = useMemo(
    () => buildMessageArtifactState(messages, artifactProvenance),
    [artifactProvenance, messages],
  );
  const selectedFileInChatContext = useMemo(() => {
    const selectedKey = getChatContextKey(selectedFile || undefined);
    return (
      selectedKey.length > 0 &&
      chatContextItems.some((file) => file.key === selectedKey)
    );
  }, [chatContextItems, selectedFile]);
  const activePreviewFile = useMemo<ActiveFileContext | null>(() => {
    if (filePreview.status !== "ready") {
      return null;
    }
    const content = buildActiveCompiledPageContext(filePreview);
    if (!content) {
      return null;
    }
    return {
      path: filePreview.compiledPage?.path ?? filePreview.path,
      content: content.slice(0, 8_000),
    };
  }, [filePreview]);
  const handleMentionSelect = useCallback(
    (file: MentionFile) => {
      addWorkspaceFileToChatContext({
        path: file.path,
        name: file.name,
        source: file.source,
        brainSlug: file.brainSlug,
        displayPath: file.path,
      });
    },
    [addWorkspaceFileToChatContext],
  );

  // ── Voice chat hook ──
  const {
    voiceState,
    error: voiceError,
    startRecording,
    stopRecording,
    speakText,
    stopPlayback,
    clearError: clearVoiceError,
    isSupported: voiceSupported,
  } = useVoiceChat({
    mode: "converse",
    onTranscript: (text) => {
      // Inject the user's spoken message into chat
      setMessages((prev) => [
        ...prev,
        {
          id: Date.now().toString() + Math.random().toString(36).slice(2),
          role: "user" as const,
          content: text,
          timestamp: new Date(),
          channel: "web",
        },
      ]);
    },
    onResponse: (text) => {
      // Inject the voice response into the chat messages
      setMessages((prev) => [
        ...prev,
        {
          id: Date.now().toString() + Math.random().toString(36).slice(2),
          role: "assistant" as const,
          content: text,
          timestamp: new Date(),
        },
      ]);
    },
  });

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "end",
    });
  }, [activeTab, messages]);

  useEffect(() => {
    if (filePreview.status !== "idle") {
      messagesEndRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "end",
      });
      if (
        typeof window.matchMedia === "function" &&
        window.matchMedia("(max-width: 767px)").matches
      ) {
        rightWorkspaceRef.current?.scrollIntoView({
          behavior: "smooth",
          block: "start",
        });
      }
    }
  }, [filePreview]);

  const loadImportSummary = useCallback(
    async (signal?: AbortSignal) => {
      setImportSummaryState("loading");

      const readCachedSummary = () => {
        try {
          const raw = window.localStorage.getItem(
            getImportSummaryStorageKey(projectName),
          );
          if (!raw) return null;
          const parsed = JSON.parse(raw) as { lastImport?: unknown };
          return normalizeImportSummary(parsed.lastImport);
        } catch {
          return null;
        }
      };

      const safeProject = safeProjectSlugOrNull(projectName);
      if (!safeProject) {
        setLatestImportSummary(null);
        setImportSummaryState("empty");
        try {
          window.localStorage.removeItem(
            getImportSummaryStorageKey(projectName),
          );
        } catch {
          // best effort
        }
        return;
      }

      try {
        const res = await fetch(
          `/api/projects/${encodeURIComponent(safeProject)}/import-summary`,
          {
            signal,
          },
        );

        if (!res.ok) {
          throw new Error(`Import summary lookup failed (${res.status})`);
        }

        const data = (await res
          .json()
          .catch(() => ({}))) as Partial<ProjectImportSummaryResponse>;
        const summary = normalizeImportSummary(data.lastImport);
        if (summary) {
          setLatestImportSummary(summary);
          setImportSummaryState("ready");
          try {
            window.localStorage.setItem(
              getImportSummaryStorageKey(projectName),
              JSON.stringify({ project: projectName, lastImport: summary }),
            );
          } catch {
            // best effort
          }
          return;
        }
        setLatestImportSummary(null);
        setImportSummaryState("empty");
        try {
          window.localStorage.removeItem(
            getImportSummaryStorageKey(projectName),
          );
        } catch {
          // best effort
        }
      } catch (error) {
        if (!(error instanceof Error && error.name === "AbortError")) {
          const cached = readCachedSummary();
          if (cached) {
            setLatestImportSummary(cached);
            setImportSummaryState("ready");
            return;
          }
          setLatestImportSummary(null);
          setImportSummaryState("error");
        }
      }
    },
    [projectName],
  );

  const appendProjectOrganizerSummary = useCallback(
    async (projectSlug: string, signal?: AbortSignal) => {
      try {
        const res = await fetch(
          `/api/brain/project-organizer?project=${encodeURIComponent(projectSlug)}`,
          { signal },
        );
        if (!res.ok) {
          return;
        }

        const readout = (await res.json()) as ProjectOrganizerReadout;
        if (!isMountedRef.current) return;
        setMessages((prev) => [
          ...prev,
          {
            id: makeLocalMessageId(),
            role: "assistant",
            content: formatProjectOrganizerChatSummary(readout),
            timestamp: new Date(),
          },
        ]);
      } catch (error: unknown) {
        if (!(error instanceof Error && error.name === "AbortError")) {
          // Silent degrade — imports still succeed even if organizer summary fails.
        }
      }
    },
    [setMessages],
  );

  const loadBrainStatus = useCallback(async () => {
    try {
      const response = await fetch("/api/brain/status");
      const data = await response.json().catch(() => ({}));

      if (response.status === 503) {
        setBrainBootstrapState({
          status: "missing",
          message: typeof data.error === "string" ? data.error : undefined,
        });
        return;
      }

      if (!response.ok) {
        throw new Error(
          typeof data.error === "string"
            ? data.error
            : "Brain status check failed",
        );
      }

      // Radar freshness pointer (TODO #2). The status route returns
      // `radar: null` when the skill runner has never executed; we
      // forward null verbatim so the brain card simply omits the line.
      let radar: BrainRadarStatus | null = null;
      if (data.radar && typeof data.radar === "object") {
        const r = data.radar as Partial<BrainRadarStatus>;
        if (
          typeof r.last_run === "string" &&
          typeof r.concepts_processed === "number" &&
          typeof r.errors === "number" &&
          typeof r.age_ms === "number" &&
          typeof r.stale === "boolean" &&
          typeof r.schedule_interval_ms === "number"
        ) {
          radar = {
            last_run: r.last_run,
            concepts_processed: r.concepts_processed,
            errors: r.errors,
            age_ms: r.age_ms,
            stale: r.stale,
            schedule_interval_ms: r.schedule_interval_ms,
          };
        }
      }

      setBrainBootstrapState({
        status: "ready",
        pageCount: typeof data.pageCount === "number" ? data.pageCount : 0,
        backend: typeof data.backend === "string" ? data.backend : undefined,
        radar,
      });
    } catch (error) {
      setBrainBootstrapState({
        status: "error",
        message:
          error instanceof Error ? error.message : "Brain status check failed",
      });
    }
  }, []);

  const loadGbrainNodes = useCallback(
    async (signal?: AbortSignal) => {
      if (!activeProjectSlug) {
        setGbrainNodes([]);
        setGbrainNodesLoaded(true);
        return;
      }

      try {
        const res = await fetch(
          `/api/brain/list?project=${encodeURIComponent(activeProjectSlug)}`,
          { signal },
        );
        if (!res.ok || signal?.aborted) {
          setGbrainNodes([]);
          if (!signal?.aborted) {
            setGbrainNodesLoaded(true);
          }
          return;
        }
        const pages = (await res.json()) as Array<{
          slug: string;
          title: string;
          type: unknown;
          frontmatter: Record<string, unknown>;
        }>;
        const GBRAIN_ICON: Record<string, string> = {
          paper: "\uD83D\uDCC4", // page facing up
          critique: "\uD83D\uDD0D", // magnifying glass
          revision_plan: "\uD83D\uDCCB", // clipboard
          revision: "\u270F\uFE0F", // pencil
          cover_letter: "\u2709\uFE0F", // envelope
        };
        const nodes: FileNode[] = pages
          .map((p) => {
            const pageType = typeof p.type === "string" ? p.type.trim() : "";
            const normalizedType = pageType.toLowerCase();
            return {
              page: p,
              pageType,
              normalizedType,
            };
          })
          .filter(({ normalizedType }) => normalizedType !== "project")
          .map(({ page, pageType, normalizedType }) => ({
            name: page.title || page.slug,
            type: "file" as const,
            source: "gbrain" as const,
            slug: page.slug,
            pageType: pageType || undefined,
            icon: GBRAIN_ICON[normalizedType] ?? "\uD83E\uDDE0",
          }));
        if (!signal?.aborted) {
          setGbrainNodes(nodes);
          setGbrainNodesLoaded(true);
        }
      } catch {
        // Silently degrade — gbrain may not be initialized yet.
        if (!signal?.aborted) {
          setGbrainNodes([]);
          setGbrainNodesLoaded(true);
        }
      }
    },
    [activeProjectSlug],
  );

  const loadPaperLibraryActivity = useCallback(
    async (signal?: AbortSignal) => {
      if (!activeProjectSlug) {
        setHasPaperLibraryActivity(false);
        setPaperLibraryActivityLoaded(true);
        return;
      }

      try {
        const res = await fetch(
          `/api/brain/paper-library/scan?project=${encodeURIComponent(activeProjectSlug)}&latest=1`,
          { signal },
        );
        if (signal?.aborted) {
          return;
        }
        if (res.status === 404) {
          setHasPaperLibraryActivity(false);
          setPaperLibraryActivityLoaded(true);
          return;
        }
        if (!res.ok) {
          throw new Error(`Paper library lookup failed (${res.status})`);
        }

        const payload = (await res.json().catch(() => ({}))) as {
          scan?: unknown;
        };
        setHasPaperLibraryActivity(
          typeof payload === "object" &&
            payload !== null &&
            "scan" in payload &&
            Boolean(payload.scan),
        );
        setPaperLibraryActivityLoaded(true);
      } catch (error) {
        if (!(error instanceof Error && error.name === "AbortError")) {
          setHasPaperLibraryActivity(false);
          setPaperLibraryActivityLoaded(true);
        }
      }
    },
    [activeProjectSlug],
  );

  const refreshProjectState = useCallback(
    async (signal?: AbortSignal) => {
      await Promise.all([
        loadBrainStatus(),
        loadGbrainNodes(signal),
        loadPaperLibraryActivity(signal),
        loadImportSummary(signal),
        checkChanges(signal),
      ]);
    },
    [
      checkChanges,
      loadBrainStatus,
      loadGbrainNodes,
      loadPaperLibraryActivity,
      loadImportSummary,
    ],
  );

  useEffect(() => {
    if (!activeProjectSlug || typeof window === "undefined") {
      return;
    }

    let cancelled = false;
    let inFlight = false;
    let intervalId: number | null = null;
    let currentController: AbortController | null = null;

    const runRefresh = async () => {
      if (cancelled || inFlight || document.visibilityState === "hidden") {
        return;
      }

      inFlight = true;
      currentController?.abort();
      const controller = new AbortController();
      currentController = controller;

      try {
        const changed = await checkChanges(controller.signal);
        if (!changed || cancelled || controller.signal.aborted) {
          return;
        }

        await Promise.all([
          loadBrainStatus(),
          loadGbrainNodes(controller.signal),
          loadPaperLibraryActivity(controller.signal),
          loadImportSummary(controller.signal),
        ]);
      } finally {
        if (currentController === controller) {
          currentController = null;
        }
        inFlight = false;
      }
    };

    const handleFocus = () => {
      void runRefresh();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void runRefresh();
      }
    };

    intervalId = window.setInterval(() => {
      void runRefresh();
    }, PROJECT_TAB_AUTO_REFRESH_MS);
    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      cancelled = true;
      if (intervalId !== null) {
        window.clearInterval(intervalId);
      }
      currentController?.abort();
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [
    activeProjectSlug,
    checkChanges,
    loadBrainStatus,
    loadGbrainNodes,
    loadPaperLibraryActivity,
    loadImportSummary,
  ]);

  useEffect(() => {
    void loadBrainStatus();
  }, [loadBrainStatus]);

  // ── Fetch gbrain pages for the current project ──
  useEffect(() => {
    const controller = new AbortController();
    void loadGbrainNodes(controller.signal);
    return () => controller.abort();
  }, [loadGbrainNodes]);

  useEffect(() => {
    const controller = new AbortController();
    void loadPaperLibraryActivity(controller.signal);
    return () => controller.abort();
  }, [loadPaperLibraryActivity]);

  useEffect(() => {
    if (!activeProjectSlug || typeof window === "undefined") return;
    const handleGbrainArtifactsUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{ project?: string }>).detail;
      if (detail?.project && detail.project !== activeProjectSlug) return;
      gbrainArtifactRefreshControllerRef.current?.abort();
      const controller = new AbortController();
      gbrainArtifactRefreshControllerRef.current = controller;
      void Promise.all([
        loadGbrainNodes(controller.signal),
        loadPaperLibraryActivity(controller.signal),
        loadImportSummary(controller.signal),
      ]);
    };
    window.addEventListener(
      "scienceswarm:gbrain-artifacts-updated",
      handleGbrainArtifactsUpdated,
    );
    return () => {
      gbrainArtifactRefreshControllerRef.current?.abort();
      gbrainArtifactRefreshControllerRef.current = null;
      window.removeEventListener(
        "scienceswarm:gbrain-artifacts-updated",
        handleGbrainArtifactsUpdated,
      );
    };
  }, [activeProjectSlug, loadGbrainNodes, loadPaperLibraryActivity, loadImportSummary]);

  useEffect(() => {
    const controller = new AbortController();
    void loadImportSummary(controller.signal);
    return () => controller.abort();
  }, [loadImportSummary]);

  // Auto-remediation: detect missing services and start them automatically.
  // Replaces the old passive "services are offline" banner with active
  // self-healing that starts OpenClaw, Ollama, and pulls Gemma4 as needed.
  // Status updates appear as system messages in chat. Each remediation
  // step fires at most once per mount to prevent loops.
  const pushRemediationMessage = useCallback(
    (msg: AutoRemediationMessage) => {
      setMessages((prev) => [...prev, { ...msg, channel: "web" as const }]);
    },
    [setMessages],
  );
  useAutoRemediation(pushRemediationMessage);

  useEffect(() => {
    workspaceWatchPrimedRef.current = false;
  }, [projectName]);

  useEffect(() => {
    if (!activeProjectSlug) {
      return;
    }

    if (!workspaceWatchPrimedRef.current) {
      workspaceWatchPrimedRef.current = true;
      return;
    }

    // `useUnifiedChat` only replaces workspaceTree when its signature changes,
    // so this refresh follows real project tree changes without refetching
    // gbrain pages on every watch poll.
    const controller = new AbortController();
    void loadImportSummary(controller.signal);
    void loadGbrainNodes(controller.signal);
    return () => controller.abort();
  }, [
    activeProjectSlug,
    loadGbrainNodes,
    loadImportSummary,
    workspaceTree,
  ]);

  const openImportDialog = useCallback((initialPath?: string | null) => {
    setImportDialogInitialPath(initialPath ?? null);
    setImportDialogOpen(true);
  }, []);

  const clearOnboardingQuery = useCallback(() => {
    if (!onboardingRequested) return;

    const nextParams = new URLSearchParams(searchParams.toString());
    nextParams.delete("onboarding");

    router.replace(
      nextParams.toString() ? `${pathname}?${nextParams.toString()}` : pathname,
    );
  }, [onboardingRequested, pathname, router, searchParams]);

  useEffect(() => {
    if (!onboardingRequested || autoOnboardingHandledRef.current) return;
    if (brainBootstrapState.status !== "ready") {
      return;
    }

    autoOnboardingHandledRef.current = true;
    openImportDialog();
    clearOnboardingQuery();
  }, [
    onboardingRequested,
    brainBootstrapState.status,
    clearOnboardingQuery,
    openImportDialog,
  ]);

  // Redirect to /setup when the brain isn't bootstrapped. This is the
  // canonical recovery path — we never show a half-working dashboard.
  // The new simple-onboarding flow initializes .env + BRAIN_ROOT atomically,
  // so "missing" means the user hasn't completed /setup yet.
  useEffect(() => {
    if (brainBootstrapState.status === "missing") {
      router.replace("/setup");
    }
  }, [brainBootstrapState.status, router]);

  // Named after the old FirstRunGuide, but now gates the empty-state
  // WarmStartSection card. Only render when the brain is actually
  // ready — `!== "loading"` also matched `"error"` and `"missing"`,
  // which is wrong: `missing` now redirects via the effect above and
  // `error` should show the error UI, not a warm-start prompt.
  const hasProjectContent =
    workspaceTree.length > 0 ||
    uploadedFiles.length > 0 ||
    Boolean(latestImportSummary) ||
    gbrainNodes.length > 0 ||
    hasPaperLibraryActivity;

  const showEmptyStateImport =
    !!activeProjectSlug &&
    brainBootstrapState.status === "ready" &&
    !hasImportedArchive &&
    importSummaryState !== "loading" &&
    gbrainNodesLoaded &&
    paperLibraryActivityLoaded &&
    !hasProjectContent;

  // ── Auto-organize uploaded files into the project tree ──
  const handleProjectUpload = useCallback(
    async (files: File[]) => {
      // Upload to the project workspace (disk) and track in chat context.
      // Awaited so the subsequent refreshWorkspace() sees the new files.
      await handleFiles(files);
      void refreshWorkspace();

      // Read text content from text-readable files so organizeFiles can apply
      // content-based categorization rules (e.g. distinguishing academic PDFs
      // from figure/poster PDFs when extracted text is available).
      const toOrganize = await Promise.all(
        files.map(async (f) => {
          let content: string | undefined;
          const isText =
            /\.(txt|md|rst|csv|tsv|json|ya?ml|toml|ini|cfg|py|js|ts|tsx|jsx|r|jl|tex|bib)$/i.test(
              f.name,
            );
          if (isText) {
            try {
              content = await f.text();
            } catch {
              // best-effort
            }
          }
          return {
            name: f.name,
            path:
              (f as unknown as { webkitRelativePath?: string })
                .webkitRelativePath || undefined,
            content,
          };
        }),
      );
      const organized = organizeFiles(toOrganize);
      const summary = organizeSummary(organized);
      setOrganizeBadge(summary);
      setTimeout(() => setOrganizeBadge(null), 5000);

      // Build tree nodes from organised paths
      const buildTree = (items: OrganizedFile[]): FileNode[] => {
        const root: Record<string, FileNode> = {};
        for (const item of items) {
          const parts = item.organizedPath.split("/");
          const current = root;
          let parentNode: FileNode | null = null;
          for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            if (i === parts.length - 1) {
              // Leaf file
              const fileNode: FileNode = { name: part, type: "file" };
              if (parentNode && parentNode.children) {
                if (!parentNode.children.find((c) => c.name === part)) {
                  parentNode.children.push(fileNode);
                }
              } else {
                if (!current[part]) {
                  current[part] = fileNode;
                }
              }
            } else {
              // Directory
              if (parentNode && parentNode.children) {
                let existing: FileNode | undefined = parentNode.children.find(
                  (c) => c.name === part && c.type === "directory",
                );
                if (!existing) {
                  existing = { name: part, type: "directory", children: [] };
                  parentNode.children.push(existing);
                }
                parentNode = existing;
              } else {
                if (!current[part]) {
                  current[part] = {
                    name: part,
                    type: "directory",
                    children: [],
                  };
                }
                parentNode = current[part];
              }
            }
          }
        }
        return Object.values(root);
      };

      const newNodes = buildTree(organized);

      // Merge new nodes into existing tree
      const mergeNodes = (
        existing: FileNode[],
        incoming: FileNode[],
      ): FileNode[] => {
        const merged = [...existing];
        for (const node of incoming) {
          const idx = merged.findIndex(
            (n) => n.name === node.name && n.type === node.type,
          );
          if (idx >= 0 && node.type === "directory") {
            merged[idx] = {
              ...merged[idx],
              children: mergeNodes(
                merged[idx].children || [],
                node.children || [],
              ),
            };
          } else if (idx < 0) {
            merged.push(node);
          }
        }
        return merged;
      };

      setProjectFiles((prev) => mergeNodes(prev, newNodes));

      // Track PDF for critique
      const pdfFile = files.find((f) => f.name.toLowerCase().endsWith(".pdf"));
      if (pdfFile) setLatestPdfFile(pdfFile);
    },
    [handleFiles, refreshWorkspace, setLatestPdfFile],
  );

  // ── Structured Critique (kept from original, not in hook) ──
  // OLD CHAT LOGIC REMOVED — now handled by useUnifiedChat hook
  // sendViaAgent, pollAgentEvents, sendViaChat, streamResponse, handleFiles
  // are all provided by the hook

  const handleStructuredCritique = async () => {
    if (!latestPdfFile || isCritiquing || isStreaming) return;
    if (!isAuthLoaded) {
      setError("Loading your ScienceSwarm account…");
      return;
    }
    if (!isSignedIn) {
      setError(authDetail || SCIENCESWARM_CRITIQUE_SIGN_IN_REQUIRED_MESSAGE);
      return;
    }

    setIsCritiquing(true);
    setError(null);
    setCritiqueJob(null);
    setActiveTab("chat");

    const startedMsg: Message = {
      id: Date.now().toString(),
      role: "system",
      content: `📋 Running structured critique on ${latestPdfFile.name}...`,
      timestamp: new Date(),
    };
    setMessages((prev) => [...prev, startedMsg]);

    try {
      const formData = new FormData();
      formData.append("file", latestPdfFile);
      formData.append("style_profile", "professional");
      formData.append("fallacy_profile", "scientific");

      const res = await fetch("/api/structured-critique", {
        method: "POST",
        headers: await getCritiqueHeaders(),
        body: formData,
      });
      const queuedPayload = await res.json();
      if (!res.ok) {
        throw new Error(
          readStructuredCritiqueError(queuedPayload) ||
            "Structured critique failed",
        );
      }
      const queuedJob = normalizeStructuredCritiqueJobPayload(queuedPayload);
      if (!isMountedRef.current) return;

      setCritiqueJob(queuedJob);

      let currentJob = queuedJob;
      let pollCount = 0;
      while (
        currentJob.status === "PENDING" ||
        currentJob.status === "RUNNING"
      ) {
        if (pollCount >= STRUCTURED_CRITIQUE_MAX_POLLS) {
          throw new Error(
            "Structured critique timed out while polling for completion",
          );
        }
        pollCount += 1;
        await new Promise((resolve) =>
          setTimeout(resolve, STRUCTURED_CRITIQUE_POLL_MS),
        );
        if (!isMountedRef.current) return;
        const statusRes = await fetch(
          `/api/structured-critique?job_id=${encodeURIComponent(currentJob.id)}`,
          { headers: await getCritiqueHeaders() },
        );
        const refreshedPayload = await statusRes.json();
        if (!statusRes.ok) {
          throw new Error(
            readStructuredCritiqueError(refreshedPayload) ||
              "Structured critique polling failed",
          );
        }
        const refreshedJob =
          normalizeStructuredCritiqueJobPayload(refreshedPayload);
        if (!isMountedRef.current) return;
        currentJob = refreshedJob;
        setCritiqueJob(currentJob);
      }

      if (currentJob.status === "FAILED" || currentJob.status === "CANCELLED") {
        throw new Error(
          getStructuredCritiqueDisplayError(
            readStructuredCritiqueJobError(currentJob),
          ),
        );
      }
      if (!currentJob.result) {
        throw new Error(
          "Structured critique completed without a result payload",
        );
      }

      let persistedLink = "";
      try {
        const saveRes = await fetch("/api/brain/critique", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            job: currentJob,
            parentSlug: artifactSlugFromFilename(latestPdfFile.name),
            sourceFilename: latestPdfFile.name,
          }),
        });
        const saved = (await saveRes.json().catch(() => null)) as {
          brain_slug?: string;
          url?: string;
          finding_count?: number;
          severity_counts?: Record<string, number>;
        } | null;
        if (saveRes.ok && saved?.brain_slug && saved.url) {
          persistedLink = [
            "",
            `Saved critique: [[${saved.brain_slug}]]`,
            `Full rendering: ${saved.url}`,
          ].join("\n");
          await refreshProjectState();
        } else if (saved && "error" in saved) {
          throw new Error(String((saved as { error?: unknown }).error));
        }
      } catch (error) {
        persistedLink = [
          "",
          `Critique completed, but saving it to gbrain failed: ${
            error instanceof Error ? error.message : "unknown error"
          }`,
        ].join("\n");
      }

      const content = `${buildStructuredCritiqueMessage(currentJob.result)}${persistedLink}`;

      const assistantMsg: Message = {
        id: (Date.now() + 1).toString(),
        role: "assistant",
        content,
        timestamp: new Date(),
      };
      if (!isMountedRef.current) return;
      setMessages((prev) => [...prev, assistantMsg]);
    } catch (err) {
      if (isMountedRef.current) {
        setError(
          err instanceof Error ? err.message : "Structured critique failed",
        );
      }
    } finally {
      if (isMountedRef.current) {
        setIsCritiquing(false);
      }
    }
  };

  const handleFileSelect = useCallback(
    async (
      path: string,
      node?: FileNode,
      options: { forceReload?: boolean; appendPreviewMessage?: boolean } = {},
    ) => {
      const resolvedNode =
        node ?? buildSyntheticGbrainFileNode(path) ?? undefined;
      const decisionTarget = buildDecisionPreviewTarget(resolvedNode);
      if (decisionTarget) {
        lastViewedDecisionRef.current = decisionTarget;
      }
      const source: WorkspacePreviewSource =
        resolvedNode?.source === "gbrain" ? "gbrain" : "workspace";
      const requestSeq = previewRequestSeqRef.current + 1;
      previewRequestSeqRef.current = requestSeq;
      const appendPreviewMessage = options.appendPreviewMessage !== false;

      const applyPreview = (next: FilePreviewState) => {
        if (
          !isMountedRef.current ||
          previewRequestSeqRef.current !== requestSeq
        )
          return;
        setFilePreview(next);
      };

      setSelectedFileNode(resolvedNode ?? null);
      const renderFilePreviewInChat =
        filePreviewLocationRef.current === "chat-pane";

      if (renderFilePreviewInChat) {
        // If this file is already the active preview, just scroll to it.
        const isAlreadyActive = document.querySelector(
          `[data-file-preview-path="${CSS.escape(path)}"]`,
        );
        if (isAlreadyActive && !options.forceReload) {
          isAlreadyActive.scrollIntoView({
            behavior: "smooth",
            block: "nearest",
          });
          return;
        }
      }

      setSelectedFile(path);

      if (renderFilePreviewInChat) {
        // Snapshot current preview (only if fully loaded) before converting to static.
        const currentPreview = filePreviewRef.current;
        const currentPreviewSnapshot =
          currentPreview.status === "ready" ? { ...currentPreview } : null;
        const previewMsgId = `file-preview-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        if (appendPreviewMessage) {
          setMessages((prev) => {
            for (const m of prev) {
              if (
                m.content.startsWith("__FILE_PREVIEW__:") &&
                currentPreviewSnapshot
              ) {
                staticPreviewsRef.current.set(m.id, currentPreviewSnapshot);
              }
            }
            return [
              ...prev.map((m) =>
                m.content.startsWith("__FILE_PREVIEW__:")
                  ? {
                      ...m,
                      content: m.content.replace(
                        "__FILE_PREVIEW__:",
                        "__FILE_STATIC__:",
                      ),
                    }
                  : m,
              ),
              {
                id: previewMsgId,
                role: "system" as const,
                content: `__FILE_PREVIEW__:${path}`,
                timestamp: new Date(),
              },
            ];
          });
        }
        setPaneMode("chat-only");
      } else {
        setPaneMode((current) =>
          current === "visualizer-only" ? "visualizer-only" : "both",
        );
      }

      setFilePreview({ status: "loading", path, source });
      setActiveTab("editor");

      // ── gbrain-sourced nodes: prefer compiled-page read, then raw file refs ──
      if (resolvedNode?.source === "gbrain") {
        const gbrainTarget = buildGbrainPreviewTarget(path, resolvedNode);
        if (!gbrainTarget) {
          applyPreview({
            status: "error",
            path,
            source: "gbrain",
            message: `Failed to load ${resolvedNode.slug ?? path}.`,
            retryable: true,
          });
          return;
        }

        applyPreview(await loadGbrainPreviewState(gbrainTarget));
        return;
      }

      const safeProjectSlug = safeProjectSlugOrNull(projectName);
      const buildWorkspaceUrl = (action: "file" | "read" | "raw") => {
        const params = new URLSearchParams({ action, file: path });
        if (safeProjectSlug) {
          params.set("projectId", safeProjectSlug);
        }
        return `/api/workspace?${params.toString()}`;
      };
      const kind = classifyFile(path);

      if (isRawRenderableKind(kind)) {
        applyPreview({
          status: "ready",
          path,
          source: "workspace",
          kind,
          rawUrl: buildWorkspaceUrl("raw"),
          editable: false,
        });
        return;
      }

      if (shouldLoadAsText(kind)) {
        try {
          const res = await fetch(buildWorkspaceUrl("file"));
          if (res.ok) {
            const data = (await res.json()) as {
              content?: string;
              size?: number;
            };
            if (typeof data.content === "string") {
              applyPreview({
                status: "ready",
                path,
                source: "workspace",
                kind,
                content: data.content,
                sizeBytes: data.size,
                editable: Boolean(safeProjectSlug),
              });
              return;
            }
          } else if (res.status === 413) {
            applyPreview({
              status: "error",
              path,
              source: "workspace",
              message: "File too large to preview.",
              retryable: false,
            });
            return;
          }
        } catch (error) {
          applyPreview({
            status: "error",
            path,
            source: "workspace",
            message:
              error instanceof Error ? error.message : "File preview failed.",
            retryable: true,
          });
          return;
        }
      }

      try {
        const res = await fetch(buildWorkspaceUrl("read"));
        if (res.ok) {
          const data = (await res.json()) as {
            content?: string;
            size?: number;
            binary?: boolean;
            tooLarge?: boolean;
            maxBytes?: number;
          };
          if (typeof data.content === "string") {
            applyPreview({
              status: "ready",
              path,
              source: "workspace",
              kind,
              content: data.content,
              sizeBytes: data.size,
              editable: false,
            });
            return;
          }
          if (data.binary) {
            applyPreview({
              status: "error",
              path,
              source: "workspace",
              message: `Binary file preview is not supported${typeof data.size === "number" ? ` (${data.size} bytes)` : ""}.`,
              retryable: false,
            });
            return;
          }
          if (data.tooLarge) {
            applyPreview({
              status: "error",
              path,
              source: "workspace",
              message: `File too large to preview (${data.size} bytes, max ${data.maxBytes}).`,
              retryable: false,
            });
            return;
          }
        } else {
          const data = await res.json().catch(() => ({}));
          const message =
            typeof data.error === "string" ? data.error : `HTTP ${res.status}`;
          applyPreview({
            status: "error",
            path,
            source: "workspace",
            message: `Failed to load: ${message}`,
            retryable: true,
          });
          return;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "Read failed";
        applyPreview({
          status: "error",
          path,
          source: "workspace",
          message,
          retryable: true,
        });
      }
    },
    [projectName, setMessages],
  );

  useEffect(() => {
    if (isStreaming) {
      wasStreamingRef.current = true;
      return;
    }

    if (!wasStreamingRef.current) {
      return;
    }

    wasStreamingRef.current = false;
    const controller = new AbortController();
    void (async () => {
      await refreshProjectState(controller.signal);
      if (controller.signal.aborted || !selectedFile) {
        return;
      }
      await handleFileSelect(selectedFile, selectedFileNode ?? undefined, {
        forceReload: true,
        appendPreviewMessage: false,
      });
    })();

    return () => controller.abort();
  }, [
    handleFileSelect,
    isStreaming,
    refreshProjectState,
    selectedFile,
    selectedFileNode,
  ]);

  useEffect(() => {
    const requested = normalizeBrainArtifactSlug(requestedBrainSlug);
    if (!requested || gbrainNodes.length === 0) return;

    const node = gbrainNodes.find(
      (candidate) => normalizeBrainArtifactSlug(candidate.slug) === requested,
    );
    if (!node?.slug) return;

    const treePath = `Brain Artifacts/gbrain:${node.slug}`;
    if (selectedFile === treePath) return;
    void handleFileSelect(treePath, node);
  }, [gbrainNodes, handleFileSelect, requestedBrainSlug, selectedFile]);

  const handleAddSelectedFileToChatContext = useCallback(() => {
    if (!selectedFile) return;
    if (selectedFileNode?.source === "gbrain" && selectedFileNode.slug) {
      addWorkspaceFileToChatContext({
        path: `gbrain:${selectedFileNode.slug}`,
        name: selectedFileNode.name,
        source: "gbrain",
        brainSlug: selectedFileNode.slug,
        displayPath: `gbrain:${selectedFileNode.slug}`,
      });
      return;
    }
    addWorkspaceFileToChatContext({
      path: selectedFile,
      name: selectedFile.split("/").pop() || selectedFile,
      source: "workspace",
      displayPath: selectedFile,
    });
  }, [addWorkspaceFileToChatContext, selectedFile, selectedFileNode]);

  const handleRetrySelectedFilePreview = useCallback(() => {
    if (!selectedFile) return;
    void handleFileSelect(selectedFile, selectedFileNode ?? undefined);
  }, [handleFileSelect, selectedFile, selectedFileNode]);

  const handleSaveSelectedFileContent = useCallback(
    async (content: string) => {
      if (!selectedFile || !activeProjectSlug) return;
      const res = await fetch("/api/workspace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "write-file",
          projectId: activeProjectSlug,
          file: selectedFile,
          content,
        }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error ?? res.statusText);
      }
      setFilePreview((current) =>
        current.status === "ready" && current.path === selectedFile
          ? { ...current, content }
          : current,
      );
      await refreshProjectState();
    },
    [activeProjectSlug, refreshProjectState, selectedFile],
  );

  const handleNavigateBrainPage = useCallback(
    (slug: string) => {
      const normalizedSlug = slug.replace(/^gbrain:/, "");
      const findNode = (nodes: FileNode[]): FileNode | null => {
        for (const candidate of nodes) {
          if (
            candidate.source === "gbrain" &&
            candidate.slug === normalizedSlug
          ) {
            return candidate;
          }
          if (candidate.children) {
            const found = findNode(candidate.children);
            if (found) return found;
          }
        }
        return null;
      };
      const existingNode = findNode(gbrainNodes);
      const node =
        existingNode ??
        ({
          name: normalizedSlug.split("/").pop() || normalizedSlug,
          type: "file",
          source: "gbrain",
          slug: normalizedSlug,
          icon: "\uD83E\uDDE0",
        } satisfies FileNode);
      const treePath = existingNode
        ? `Brain Artifacts/gbrain:${existingNode.slug ?? normalizedSlug}`
        : `gbrain:${normalizedSlug}`;
      void handleFileSelect(treePath, node);
    },
    [gbrainNodes, handleFileSelect],
  );

  // ── Feature 1: Import Local Project ──
  const handleImportProject = useCallback(
    async (importedFolder: CompletedImportResult) => {
      const importedProjectSlug = safeProjectSlugOrNull(
        importedFolder.projectSlug,
      );
      const latestImport: LatestImportSummary = {
        name: importedFolder.name,
        preparedFiles: importedFolder.totalFiles,
        detectedItems: importedFolder.detectedItems,
        detectedBytes: importedFolder.detectedBytes,
        duplicateGroups: importedFolder.duplicateGroups,
        generatedAt: new Date().toISOString(),
        source: importedFolder.source || "background-local-import",
      };

      try {
        if (importedProjectSlug) {
          window.localStorage.setItem(
            getImportSummaryStorageKey(importedProjectSlug),
            JSON.stringify({
              project: importedProjectSlug,
              lastImport: latestImport,
            }),
          );
        }
      } catch {
        // best effort
      }

      if (importedProjectSlug && importedProjectSlug !== activeProjectSlug) {
        persistLastProjectSlug(importedProjectSlug);
        router.replace(buildWorkspaceHrefForSlug(importedProjectSlug));
        return;
      }

      setActiveTab("chat");
      setHasImportedArchive(true);
      const detectedScope =
        importedFolder.detectedItems &&
        importedFolder.detectedItems > importedFolder.totalFiles
          ? ` from ${importedFolder.detectedItems.toLocaleString("en-US")} detected items`
          : "";
      const sysMessages: Message[] = [
        {
          id: Date.now().toString(),
          role: "system",
          content: `Imported project "${importedFolder.name}" (${importedFolder.totalFiles.toLocaleString("en-US")} files${detectedScope}). Refreshing the organizer summary and project brief...`,
          timestamp: new Date(),
        },
      ];
      const postImportWarnings = (importedFolder.warnings ?? []).filter(
        (warning) => warning.code !== "duplicates",
      );
      if (postImportWarnings.length > 0) {
        sysMessages.push({
          id: `${Date.now()}-warnings`,
          role: "system",
          content: [
            `Import warnings for "${importedFolder.name}":`,
            ...postImportWarnings.map(
              (warning) => `- ${formatImportWarningForChat(warning)}`,
            ),
          ].join("\n"),
          timestamp: new Date(),
        });
      }
      setMessages((prev) => [...prev, ...sysMessages]);

      setIsAutoAnalyzing(true);
      try {
        setLatestImportSummary(latestImport);
        setImportSummaryState("ready");
        window.localStorage.setItem(
          getImportSummaryStorageKey(projectName),
          JSON.stringify({ project: projectName, lastImport: latestImport }),
        );
      } catch {
        // best effort
      }
      try {
        await refreshProjectState();
        if (activeProjectSlug) {
          await appendProjectOrganizerSummary(activeProjectSlug);
        }
      } finally {
        setIsAutoAnalyzing(false);
      }
    },
    [
      activeProjectSlug,
      appendProjectOrganizerSummary,
      projectName,
      router,
      refreshProjectState,
      setMessages,
    ],
  );

  const getWebCaptureUserId = useCallback((): string => {
    if (typeof window === "undefined") {
      return "dashboard-web";
    }

    try {
      const existing = window.localStorage.getItem(
        WEB_CAPTURE_USER_STORAGE_KEY,
      );
      if (existing && existing.trim()) {
        return existing;
      }

      const browserCrypto = window.crypto;
      const randomId =
        typeof browserCrypto?.randomUUID === "function"
          ? browserCrypto.randomUUID()
          : makeLocalMessageId();
      const generated = `web-${randomId}`;
      window.localStorage.setItem(WEB_CAPTURE_USER_STORAGE_KEY, generated);
      return generated;
    } catch {
      return "dashboard-web";
    }
  }, []);

  const applyCaptureReply = useCallback(
    (
      messageId: string,
      content: string,
      captureClarification?: CaptureClarification,
    ) => {
      setMessages((prev) =>
        prev.map((message) =>
          message.id === messageId
            ? {
                ...message,
                content,
                timestamp: new Date(),
                captureClarification,
              }
            : message,
        ),
      );
    },
    [setMessages],
  );

  const removeCaptureReply = useCallback(
    (messageId: string) => {
      setMessages((prev) => prev.filter((message) => message.id !== messageId));
    },
    [setMessages],
  );

  const clearCaptureClarification = useCallback(
    (messageId: string) => {
      setMessages((prev) =>
        prev.map((message) =>
          message.id === messageId
            ? { ...message, captureClarification: undefined }
            : message,
        ),
      );
    },
    [setMessages],
  );

  const buildVisibleCaptureSourceRefs = useCallback((): SourceRef[] => {
    const sourceRefs: SourceRef[] = [];
    const currentSelection = selectedFileNode?.source === "gbrain" && selectedFileNode.slug
      ? captureSourceRefFromPath(`gbrain:${selectedFileNode.slug}`)
      : selectedFile
        ? captureSourceRefFromPath(selectedFile)
        : activePreviewFile?.path
          ? captureSourceRefFromPath(activePreviewFile.path)
          : null;
    if (currentSelection) {
      sourceRefs.push(currentSelection);
    }

    for (const item of chatContextItems) {
      const ref = captureSourceRefFromPath(item.path);
      if (ref) {
        sourceRefs.push(ref);
      }
    }

    const deduped = new Map<string, SourceRef>();
    for (const ref of sourceRefs) {
      deduped.set(`${ref.kind}:${ref.ref}:${ref.hash ?? ""}`, ref);
    }
    return Array.from(deduped.values());
  }, [activePreviewFile, chatContextItems, selectedFile, selectedFileNode]);

  const handleCaptureIntent = useCallback(
    async (text: string, intent: ExplicitCaptureIntent) => {
      if (isCapturing || isStreaming) return;

      const trimmed = text.trim();
      const userMessageId = makeLocalMessageId();
      const replyMessageId = makeLocalMessageId();
      const userId = getWebCaptureUserId();
      const decisionTarget = lastViewedDecisionRef.current;
      const sourceRefs: SourceRef[] = [
        ...(conversationId
          ? [{ kind: "conversation", ref: conversationId } satisfies SourceRef]
          : []),
        ...buildVisibleCaptureSourceRefs(),
      ].filter((ref) =>
        intent.mode === "decision-update" && decisionTarget
          ? !(ref.kind === "artifact" && ref.ref === decisionTarget.slug)
          : true,
      );

      setMessages((prev) => [
        ...prev,
        {
          id: userMessageId,
          role: "user",
          content: trimmed,
          timestamp: new Date(),
          channel: "web",
        },
        {
          id: replyMessageId,
          role: "assistant",
          content: "Saving to brain...",
          timestamp: new Date(),
        },
      ]);
      setInput("");
      clearError();

      if (intent.mode === "decision-update" && !decisionTarget) {
        applyCaptureReply(
          replyMessageId,
          "No decision selected. Open a decision from Brain Artifacts first, then use `decision update:` to amend it.",
        );
        return;
      }

      setIsCapturing(true);

      try {
        const response = await fetch(
          intent.mode === "decision-update"
            ? "/api/brain/decision-update"
            : "/api/brain/capture",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(
              intent.mode === "decision-update"
                ? {
                    slug: decisionTarget?.slug,
                    project: activeProjectSlug ?? null,
                    content: intent.content,
                    sourceRefs,
                  }
                : {
                    content: intent.content,
                    kind: intent.kind,
                    channel: "web",
                    userId,
                    project: activeProjectSlug ?? null,
                    sourceRefs,
                  },
            ),
          },
        );

        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(
            typeof data.error === "string" ? data.error : "Capture failed",
          );
        }

        if (intent.mode === "decision-update") {
          applyCaptureReply(
            replyMessageId,
            [
              "**Decision updated**",
              `Decision: ${decisionTarget?.title ?? "Current decision"}`,
              `Path: ${typeof data.path === "string" ? data.path : decisionTarget?.path ?? "unknown"}`,
            ].join("\n"),
          );
          await refreshProjectState();
          return;
        }

        const result = data as CaptureResult;
        if (result.requiresClarification) {
          applyCaptureReply(
            replyMessageId,
            buildCaptureConfirmationMessage(result, intent.content),
            {
              captureId: result.captureId,
              rawPath: result.rawPath,
              question:
                result.clarificationQuestion ??
                "Which project should I link this capture to?",
              choices: result.choices,
              capturedContent: intent.content,
            },
          );
        } else {
          applyCaptureReply(
            replyMessageId,
            buildCaptureConfirmationMessage(result, intent.content),
          );
        }

        await refreshProjectState();
      } catch (error) {
        removeCaptureReply(replyMessageId);
        setError(error instanceof Error ? error.message : "Capture failed");
      } finally {
        setIsCapturing(false);
      }
    },
    [
      activeProjectSlug,
      applyCaptureReply,
      buildVisibleCaptureSourceRefs,
      clearError,
      conversationId,
      getWebCaptureUserId,
      isCapturing,
      isStreaming,
      refreshProjectState,
      removeCaptureReply,
      setError,
      setMessages,
    ],
  );

  const handleResolveCaptureClarification = useCallback(
    async (
      messageId: string,
      clarification: CaptureClarification,
      project: string,
    ) => {
      if (isCapturing) return;

      const userMessageId = makeLocalMessageId();
      const replyMessageId = makeLocalMessageId();

      setMessages((prev) => [
        ...prev,
        {
          id: userMessageId,
          role: "user",
          content: project,
          timestamp: new Date(),
          channel: "web",
        },
        {
          id: replyMessageId,
          role: "assistant",
          content: "Linking capture...",
          timestamp: new Date(),
        },
      ]);
      setIsCapturing(true);
      clearError();

      try {
        const response = await fetch("/api/brain/capture/resolve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            captureId: clarification.captureId,
            project,
            rawPath: clarification.rawPath,
          }),
        });

        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(
            typeof data.error === "string"
              ? data.error
              : "Capture resolution failed",
          );
        }

        const result = data as CaptureResult;
        applyCaptureReply(
          replyMessageId,
          buildCaptureConfirmationMessage(
            result,
            clarification.capturedContent,
          ),
        );
        clearCaptureClarification(messageId);
        await refreshProjectState();
      } catch (error) {
        removeCaptureReply(replyMessageId);
        setError(
          error instanceof Error ? error.message : "Capture resolution failed",
        );
      } finally {
        setIsCapturing(false);
      }
    },
    [
      applyCaptureReply,
      clearError,
      clearCaptureClarification,
      isCapturing,
      refreshProjectState,
      removeCaptureReply,
      setError,
      setMessages,
    ],
  );

  const handleMultimodalInterpretation = useCallback(
    async (text: string) => {
      if (!activeProjectSlug || isInterpretingPacket || isStreaming) return;

      const trimmed = text.trim();
      const userMessageId = makeLocalMessageId();
      const replyMessageId = makeLocalMessageId();

      setMessages((prev) => [
        ...prev,
        {
          id: userMessageId,
          role: "user",
          content: trimmed,
          timestamp: new Date(),
          channel: "web",
        },
        {
          id: replyMessageId,
          role: "assistant",
          content: "Interpreting mixed project evidence...",
          timestamp: new Date(),
        },
      ]);
      setInput("");
      setIsInterpretingPacket(true);
      clearError();

      try {
        const response = await fetch("/api/brain/multimodal-interpret", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            project: activeProjectSlug,
            prompt: trimmed,
            files: uploadedFiles.map((file) => ({
              workspacePath: file.workspacePath,
              displayPath: file.displayPath,
            })),
          }),
        });

        const payload = (await response
          .json()
          .catch(() => ({}))) as MultimodalInterpretationResponse;
        if (!response.ok || typeof payload.response !== "string") {
          throw new Error(
            typeof payload.error === "string"
              ? payload.error
              : "Multimodal interpretation failed",
          );
        }

        setMessages((prev) =>
          prev.map((message) =>
            message.id === replyMessageId
              ? { ...message, content: payload.response! }
              : message,
          ),
        );

        if (typeof payload.savePath === "string" && payload.savePath.length > 0) {
          recordGeneratedArtifacts([payload.savePath]);
        }
        await refreshWorkspace();
      } catch (error) {
        setInput((current) => current || trimmed);
        setMessages((prev) =>
          prev.map((message) =>
            message.id === replyMessageId
              ? {
                  ...message,
                  content:
                    error instanceof Error
                      ? error.message
                      : "Multimodal interpretation failed",
                }
              : message,
          ),
        );
      } finally {
        setIsInterpretingPacket(false);
      }
    },
    [
      activeProjectSlug,
      clearError,
      isInterpretingPacket,
      isStreaming,
      recordGeneratedArtifacts,
      refreshWorkspace,
      setMessages,
      uploadedFiles,
    ],
  );

  const handleNextExperimentPlannerIntent = useCallback(
    async (text: string, intent: NextExperimentPlanIntent) => {
      if (!activeProjectSlug || isPlanningExperiments || isStreaming) return;

      const trimmed = text.trim();
      const userMessageId = makeLocalMessageId();
      const replyMessageId = makeLocalMessageId();

      setMessages((prev) => [
        ...prev,
        {
          id: userMessageId,
          role: "user",
          content: trimmed,
          timestamp: new Date(),
          channel: "web",
        },
        {
          id: replyMessageId,
          role: "assistant",
          content: "Planning the next experiments...",
          timestamp: new Date(),
        },
      ]);
      setInput("");
      setIsPlanningExperiments(true);
      clearError();

      try {
        const response = await fetch("/api/brain/next-experiment-plan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            project: activeProjectSlug,
            prompt: trimmed,
            previousPlanSlug:
              intent.updateExisting && lastExperimentPlanSlug
                ? lastExperimentPlanSlug
                : null,
            focusBrainSlug:
              selectedFileNode?.source === "gbrain" && selectedFileNode.slug
                ? selectedFileNode.slug
                : null,
          }),
        });

        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(
            typeof data.error === "string"
              ? data.error
              : "Next experiment planning failed",
          );
        }

        const plannerResponse = data as {
          artifactPage: string;
          artifactTitle: string;
          responseMarkdown: string;
        };

        applyCaptureReply(replyMessageId, plannerResponse.responseMarkdown);
        setLastExperimentPlanSlug(plannerResponse.artifactPage);
        await refreshProjectState();
        void handleFileSelect(
          `Brain Artifacts/gbrain:${plannerResponse.artifactPage}`,
          {
            name: plannerResponse.artifactTitle,
            type: "file",
            source: "gbrain",
            slug: plannerResponse.artifactPage,
            pageType: "artifact",
            icon: "🧠",
          },
          { appendPreviewMessage: false },
        );
      } catch (error) {
        removeCaptureReply(replyMessageId);
        setError(
          error instanceof Error
            ? error.message
            : "Next experiment planning failed",
        );
      } finally {
        setIsPlanningExperiments(false);
      }
    },
    [
      activeProjectSlug,
      applyCaptureReply,
      clearError,
      handleFileSelect,
      isPlanningExperiments,
      isStreaming,
      lastExperimentPlanSlug,
      refreshProjectState,
      removeCaptureReply,
      selectedFileNode,
      setError,
      setMessages,
    ],
  );

  const isChatBusy = isCapturing || isInterpretingPacket || isPlanningExperiments || runtimePreviewBusy;
  const filesRenderInChat = filePreviewLocation === "chat-pane";

  const sendRuntimePrompt = useCallback(
    async (
      prompt: string,
      options: RuntimeSendOptions,
      clearInputAfterSend = true,
    ) => {
      if (clearInputAfterSend) {
        setInput("");
      }
      try {
        await sendMessage(prompt, options);
      } catch (error) {
        if (clearInputAfterSend) {
          setInput((current) => (current.length === 0 ? prompt : current));
        }
        throw error;
      }
    },
    [sendMessage],
  );

  const prepareRuntimePreviewAndSend = useCallback(
    async (prompt: string, activeFile?: ActiveFileContext) => {
      const mode = runtimeMode;
      const runtimeHostId = selectedRuntimeHostId as Backend;
      const sendChatDirect = mode === "chat" && runtimeHostId === "openclaw";
      const dataIncluded = buildComposerRuntimeDataIncluded(prompt, activeFile);
      const selectedHostIds = mode === "compare"
        ? compareHostIds.length > 0 ? compareHostIds : ["openclaw"]
        : undefined;
      const options: RuntimeSendOptions = {
        activeFile,
        runtimeHostId,
        runtimeMode: mode,
        projectPolicy: runtimeProjectPolicy,
        approvalState: "not-required",
        selectedHostIds,
        synthesisHostId: mode === "compare" ? selectedRuntimeHostId : undefined,
        dataIncluded,
      };

      if (sendChatDirect) {
        await sendRuntimePrompt(prompt, options);
        return;
      }

      setRuntimePreviewBusy(true);
      setRuntimePreviewError(null);
      try {
        const response = await fetch("/api/runtime/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            hostId: runtimeHostId,
            selectedHostIds,
            mode,
            projectId: activeProjectSlug,
            projectPolicy: runtimeProjectPolicy,
            dataIncluded,
            prompt,
          }),
        });
        const payload = await response.json().catch(() => null) as
          | { preview?: TurnPreview; error?: string }
          | null;
        if (!response.ok || !payload?.preview) {
          throw new Error(payload?.error || `Runtime preview failed: ${response.status}`);
        }
        const previewOptions: RuntimeSendOptions = {
          ...options,
          approvalState: payload.preview.requiresUserApproval ? "approved" : "not-required",
        };
        if (mode === "chat" && payload.preview.allowed && !payload.preview.requiresUserApproval) {
          await sendRuntimePrompt(prompt, previewOptions);
          return;
        }
        setPendingRuntimeSend({
          prompt,
          activeFile,
          preview: payload.preview,
          options: previewOptions,
          label: `${mode} via ${payload.preview.destinations.map((item) => item.label).join(", ")}`,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Runtime preview failed.";
        setRuntimePreviewError(message);
        setError(message);
      } finally {
        setRuntimePreviewBusy(false);
      }
    },
    [
      activeProjectSlug,
      compareHostIds,
      runtimeMode,
      runtimeProjectPolicy,
      selectedRuntimeHostId,
      sendRuntimePrompt,
      setError,
    ],
  );

  const handleApproveRuntimePreview = useCallback(async () => {
    if (!pendingRuntimeSend) return;
    setRuntimePreviewBusy(true);
    setRuntimePreviewError(null);
    try {
      await sendRuntimePrompt(pendingRuntimeSend.prompt, pendingRuntimeSend.options);
      setPendingRuntimeSend(null);
    } catch (err) {
      setRuntimePreviewError(err instanceof Error ? err.message : "Runtime send failed.");
    } finally {
      setRuntimePreviewBusy(false);
    }
  }, [pendingRuntimeSend, sendRuntimePrompt]);

  const moveInputCursorToEnd = useCallback((value: string) => {
    requestAnimationFrame(() => {
      if (inputRef.current && document.activeElement === inputRef.current) {
        inputRef.current.setSelectionRange(value.length, value.length);
      }
    });
  }, []);

  const recordPromptHistory = useCallback((value: string) => {
    promptHistoryRef.current = [...promptHistoryRef.current, value].slice(
      -MAX_PROMPT_HISTORY,
    );
    promptHistoryIndexRef.current = null;
    draftInputRef.current = "";
  }, []);

  const navigatePromptHistory = useCallback(
    (direction: "previous" | "next") => {
      const history = promptHistoryRef.current;
      if (history.length === 0) {
        return;
      }

      const currentIndex = promptHistoryIndexRef.current;
      if (currentIndex === null) {
        if (direction !== "previous") {
          return;
        }

        const nextValue = history[history.length - 1];
        promptHistoryIndexRef.current = history.length - 1;
        setInput(nextValue);
        moveInputCursorToEnd(nextValue);
        return;
      }

      if (direction === "previous") {
        if (currentIndex === 0) {
          return;
        }
        const nextIndex = currentIndex - 1;
        const nextValue = history[nextIndex];
        promptHistoryIndexRef.current = nextIndex;
        setInput(nextValue);
        moveInputCursorToEnd(nextValue);
        return;
      }

      if (currentIndex >= history.length - 1) {
        promptHistoryIndexRef.current = null;
        setInput(draftInputRef.current);
        moveInputCursorToEnd(draftInputRef.current);
        return;
      }

      const nextIndex = currentIndex + 1;
      const nextValue = history[nextIndex];
      promptHistoryIndexRef.current = nextIndex;
      setInput(nextValue);
      moveInputCursorToEnd(nextValue);
    },
    [moveInputCursorToEnd],
  );

  const handleChatInputChange = useCallback((value: string) => {
    if (promptHistoryIndexRef.current === null) {
      draftInputRef.current = value;
    }
    setInput(value);
  }, []);

  useEffect(() => {
    if (!looksLikeSlashCommandInput(input) || slashCommandsStatus !== "idle") {
      return;
    }

    const controller = new AbortController();
    slashCommandsRequestControllerRef.current = controller;
    setSlashCommandsStatus("loading");

    fetch("/api/openclaw/slash-commands", { signal: controller.signal })
      .then(async (response) => {
        const payload = (await response
          .json()
          .catch(() => ({}))) as SlashCommandCatalogResponse;
        if (!response.ok) {
          throw new Error(
            payload.error || "Failed to load OpenClaw slash commands.",
          );
        }
        setSlashCommands(
          payload.commands?.length
            ? payload.commands
            : DEFAULT_CHAT_SLASH_COMMANDS,
        );
        setSlashCommandsStatus("ready");
        if (slashCommandsRequestControllerRef.current === controller) {
          slashCommandsRequestControllerRef.current = null;
        }
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setSlashCommands(DEFAULT_CHAT_SLASH_COMMANDS);
        setSlashCommandsStatus("error");
        if (slashCommandsRequestControllerRef.current === controller) {
          slashCommandsRequestControllerRef.current = null;
        }
      });
  }, [input, slashCommandsStatus]);

  useEffect(() => {
    return () => {
      slashCommandsRequestControllerRef.current?.abort();
      slashCommandsRequestControllerRef.current = null;
    };
  }, []);

  // Rotate chat placeholder every ~4s when input is empty + unfocused.
  useEffect(() => {
    if (chatInputFocused || input.length > 0) return;
    const id = setInterval(() => {
      setPlaceholderIndex((i) => (i + 1) % CHAT_PLACEHOLDER_PROMPTS.length);
    }, CHAT_PLACEHOLDER_ROTATE_MS);
    return () => clearInterval(id);
  }, [chatInputFocused, input]);

  // ── Feature 4: Quick Chart Command Detection ──
  const handleSendWithChartDetection = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || isChatBusy) return;

      recordPromptHistory(trimmed);

      const captureIntent = parseExplicitCaptureIntent(trimmed);
      if (captureIntent) {
        void handleCaptureIntent(trimmed, captureIntent);
        return;
      }

      const experimentPlanIntent = parseNextExperimentPlanIntent(trimmed);
      if (experimentPlanIntent && activeProjectSlug) {
        void handleNextExperimentPlannerIntent(trimmed, experimentPlanIntent);
        return;
      }

      if (activeProjectSlug && looksLikeMultimodalInterpretRequest(trimmed)) {
        void handleMultimodalInterpretation(trimmed);
        return;
      }

      // The preview pane is part of the visible scientist workflow. If a user
      // opens a report item and asks "what next?", attach that current view as
      // active-file context without requiring a separate context-chip action.
      void prepareRuntimePreviewAndSend(trimmed, activePreviewFile ?? undefined);
    },
    [
      activePreviewFile,
      activeProjectSlug,
      handleCaptureIntent,
      handleMultimodalInterpretation,
      handleNextExperimentPlannerIntent,
      isChatBusy,
      prepareRuntimePreviewAndSend,
      recordPromptHistory,
    ],
  );

  const handleSend = useCallback(() => {
    handleSendWithChartDetection(input);
  }, [handleSendWithChartDetection, input]);

  const handleChatInputKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        handleSend();
        return;
      }

      if (
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        event.nativeEvent.isComposing
      ) {
        return;
      }

      if (event.key === "ArrowUp" && isCaretOnFirstLine(event.currentTarget)) {
        if (promptHistoryRef.current.length > 0) {
          event.preventDefault();
          navigatePromptHistory("previous");
        }
        return;
      }

      if (event.key === "ArrowDown" && isCaretOnLastLine(event.currentTarget)) {
        if (
          promptHistoryRef.current.length > 0 &&
          promptHistoryIndexRef.current !== null
        ) {
          event.preventDefault();
          navigatePromptHistory("next");
        }
      }
    },
    [handleSend, navigatePromptHistory],
  );

  const handleComposerResizePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      event.preventDefault();
      const startY = event.clientY;
      const startHeight =
        inputRef.current?.getBoundingClientRect().height ??
        composerHeightOption.px;
      const previousCursor = document.body.style.cursor;
      const previousUserSelect = document.body.style.userSelect;

      document.body.style.cursor = "ns-resize";
      document.body.style.userSelect = "none";

      const handlePointerMove = (moveEvent: PointerEvent) => {
        const upwardDelta = startY - moveEvent.clientY;
        const nextHeight = Math.max(
          COMPOSER_HEIGHT_OPTIONS[0].px,
          Math.min(
            COMPOSER_HEIGHT_OPTIONS[COMPOSER_HEIGHT_OPTIONS.length - 1].px,
            startHeight + upwardDelta,
          ),
        );
        setComposerHeightIndex(getNearestComposerHeightIndex(nextHeight));
      };

      const handlePointerUp = () => {
        document.removeEventListener("pointermove", handlePointerMove);
        document.removeEventListener("pointerup", handlePointerUp);
        document.body.style.cursor = previousCursor;
        document.body.style.userSelect = previousUserSelect;
      };

      document.addEventListener("pointermove", handlePointerMove);
      document.addEventListener("pointerup", handlePointerUp, { once: true });
    },
    [composerHeightOption.px],
  );

  return (
    <div className="flex h-full min-w-0">
      {/* Left: Project list */}
      <div
        data-testid="project-tree-panel"
        data-project-tree-mode={projectTreeVisibilityMode}
        className={`${projectTreeDisplayClass} flex-shrink-0 overflow-hidden border-r-2 border-border bg-white`}
        style={{ width: projectListWidth }}
        suppressHydrationWarning
      >
        <ProjectList
          activeSlug={activeProjectSlug}
          files={mergedFileTree}
          onSelect={handleFileSelect}
          selectedPath={selectedFile}
          onUpload={() => fileInputRef.current?.click()}
          onUploadFolder={
            brainBootstrapState.status === "missing"
              ? undefined
              : () => openImportDialog()
          }
          onCheckChanges={checkChanges}
          onDropFiles={(droppedFiles) => {
            void handleProjectUpload(droppedFiles);
          }}
          onDeleteFile={async (filePath, node) => {
            if (!activeProjectSlug) return;
            const label = node.type === "directory" ? "folder" : "file";
            if (
              !confirm(
                `Delete ${label} "${filePath}"? This removes it from disk.`,
              )
            )
              return;
            try {
              const res = await fetch("/api/workspace", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  action: "delete-file",
                  projectId: activeProjectSlug,
                  file: filePath,
                }),
              });
              if (!res.ok) {
                const err = (await res.json().catch(() => ({}))) as {
                  error?: string;
                };
                alert(`Delete failed: ${err.error ?? res.statusText}`);
                return;
              }
              await refreshProjectState();
            } catch (err) {
              alert(
                `Delete failed: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }}
        />
      </div>

      {/* Drag handle: project list <-> chat */}
      <div
        className={`${projectTreeDisplayClass} w-1 flex-shrink-0 cursor-col-resize bg-border transition-colors hover:bg-accent/40`}
        onMouseDown={onProjectListResizeMouseDown}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize project list"
        tabIndex={0}
      />

      {mobileProjectListOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/35 md:hidden"
          onClick={() => setMobileProjectListOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Project navigation"
            className="absolute inset-y-0 left-0 w-[min(24rem,85vw)] overflow-hidden border-r border-border bg-white shadow-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <div className="min-w-0">
                <p className="text-xs font-bold uppercase tracking-[0.16em] text-muted">
                  Projects
                </p>
                {activeProjectSlug && (
                  <p className="mt-1 truncate text-sm font-semibold text-foreground">
                    {activeProjectSlug}
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={() => setMobileProjectListOpen(false)}
                className="inline-flex h-8 w-8 items-center justify-center rounded border border-border bg-white text-muted transition-colors hover:border-accent hover:text-foreground"
                aria-label="Close projects"
                title="Close projects"
              >
                <X size={14} />
              </button>
            </div>
            <ProjectList
              activeSlug={activeProjectSlug}
              files={mergedFileTree}
              onSelect={(path, node) => {
                setMobileProjectListOpen(false);
                void handleFileSelect(path, node);
              }}
              selectedPath={selectedFile}
              onUpload={() => fileInputRef.current?.click()}
              onUploadFolder={
                brainBootstrapState.status === "missing"
                  ? undefined
                  : () => openImportDialog()
              }
              onCheckChanges={checkChanges}
              onDropFiles={(droppedFiles) => {
                void handleProjectUpload(droppedFiles);
              }}
              onDeleteFile={async (filePath, node) => {
                if (!activeProjectSlug) return;
                const label = node.type === "directory" ? "folder" : "file";
                if (
                  !confirm(
                    `Delete ${label} "${filePath}"? This removes it from disk.`,
                  )
                )
                  return;
                try {
                  const res = await fetch("/api/workspace", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      action: "delete-file",
                      projectId: activeProjectSlug,
                      file: filePath,
                    }),
                  });
                  if (!res.ok) {
                    const err = (await res.json().catch(() => ({}))) as {
                      error?: string;
                    };
                    alert(`Delete failed: ${err.error ?? res.statusText}`);
                    return;
                  }
                  await refreshProjectState();
                } catch (err) {
                  alert(
                    `Delete failed: ${err instanceof Error ? err.message : String(err)}`,
                  );
                }
              }}
              onProjectNavigate={() => setMobileProjectListOpen(false)}
            />
          </div>
        </div>
      )}

      {/* Right: Main workspace */}
      <div className="flex min-w-0 flex-1 flex-col overflow-x-hidden overflow-y-auto md:overflow-hidden">
        {/* Tab bar */}
        <div className="flex items-center gap-2 border-b-2 border-border bg-white px-2 flex-shrink-0">
          <button
            type="button"
            onClick={handleProjectTreeToggle}
            className={`inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded border transition-colors ${
              projectTreeIsVisible
                ? "border-border bg-white text-muted hover:border-accent hover:text-foreground"
                : "border-accent/30 bg-accent/10 text-accent hover:bg-accent/15"
            }`}
            title={projectTreeToggleLabel}
            aria-label={projectTreeToggleLabel}
            aria-pressed={projectTreeIsVisible}
          >
            <SidebarSimple size={16} />
          </button>
          <div className="flex min-w-0 items-center gap-2 md:hidden">
            <button
              type="button"
              onClick={() => setMobileProjectListOpen(true)}
              className="inline-flex h-8 items-center gap-1.5 rounded border border-border bg-white px-3 text-xs font-semibold text-foreground transition-colors hover:border-accent hover:text-accent"
              aria-label="Open projects"
              title="Open projects"
            >
              <List size={15} />
              <span>Projects</span>
            </button>
            {activeProjectSlug && (
              <span className="min-w-0 truncate text-xs font-semibold text-foreground">
                {activeProjectSlug}
              </span>
            )}
          </div>
          <div className="ml-auto flex items-center gap-3 px-3">
            {/* Cross-channel indicator */}
            {crossChannelMessages.length > 0 && (
              <span
                className="text-[10px] text-muted bg-surface px-2 py-0.5 rounded border border-border"
                title="Messages from other channels (Telegram, Slack, etc.)"
              >
                {crossChannelMessages.length} cross-channel
              </span>
            )}

            {(isStreaming || isCritiquing || isAutoAnalyzing || isInterpretingPacket || isPlanningExperiments) && (
              <div className="flex items-center gap-2 text-xs font-medium text-accent">
                <Spinner size="h-3.5 w-3.5" testId="chat-activity-spinner" />
                {isCritiquing
                  ? critiqueJob?.status === "PENDING"
                    ? "Critique queued..."
                    : critiqueJob?.status === "RUNNING"
                      ? "Critiquing..."
                      : "Critiquing..."
                  : isInterpretingPacket
                    ? "Interpreting packet..."
                  : isPlanningExperiments
                    ? "Planning experiments..."
                  : isAutoAnalyzing
                    ? "Analyzing..."
                    : "Thinking..."}
              </div>
            )}
            {latestPdfFile ? (
              !isAuthLoaded ? (
                <button
                  type="button"
                  disabled={true}
                  className="text-[11px] font-medium bg-white border border-border rounded px-2.5 py-1.5 text-foreground opacity-50"
                >
                  Loading account
                </button>
              ) : isSignedIn ? (
                <>
                  <button
                    onClick={handleStructuredCritique}
                    disabled={isCritiquing || isStreaming}
                    className="text-[11px] font-medium bg-white border border-border rounded px-2.5 py-1.5 text-foreground hover:border-accent hover:text-accent transition-colors disabled:opacity-50"
                  >
                    {isCritiquing ? "Running Critique" : "Structured Critique"}
                  </button>
                  <button
                    type="button"
                    onClick={() => void signOut()}
                    className="text-[11px] font-medium bg-white border border-border rounded px-2.5 py-1.5 text-foreground hover:border-accent hover:text-accent transition-colors"
                  >
                    Sign out
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => void beginSignIn()}
                  className="text-[11px] font-medium bg-white border border-border rounded px-2.5 py-1.5 text-foreground hover:border-accent hover:text-accent transition-colors"
                >
                  {isSigningIn ? "Connecting…" : "Create Account / Sign In"}
                </button>
              )
            ) : null}
            {uploadedFiles.length > 0 && (
              <span className="text-[10px] text-muted bg-surface px-2 py-0.5 rounded border border-border">
                {uploadedFiles.length} files
              </span>
            )}
            {activeProjectSlug && (
              <Link
                href={buildPaperLibraryHrefForSlug(activeProjectSlug)}
                className="inline-flex h-8 items-center rounded border border-border bg-white px-3 text-[11px] font-medium text-foreground transition-colors hover:border-accent hover:text-accent"
              >
                Paper Library
              </Link>
            )}
          </div>
        </div>

        {brainBootstrapState.status === "error" && (
          <section
            role="alert"
            className="border-b border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
          >
            <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
              <div>
                <p className="font-semibold">Research brain is unavailable.</p>
                <p className="mt-1 text-xs leading-5 text-red-700">
                  {brainBootstrapState.message}
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  void loadBrainStatus();
                }}
                className="inline-flex h-8 shrink-0 items-center justify-center rounded border border-red-300 bg-white px-3 text-xs font-semibold text-red-800 transition-colors hover:border-red-500 hover:text-red-900"
              >
                Retry brain status
              </button>
            </div>
          </section>
        )}

        <div
          ref={rightWorkspaceRef}
          className="relative min-h-[80vh] flex-1 overflow-hidden bg-surface/30 md:min-h-0"
        >
          <div className="flex h-full min-h-0 flex-col">
            {latestPdfFile ? (
              <div className="border-b border-border bg-sky-50 px-3 py-2 text-[11px] leading-5 text-slate-700">
                <span className="font-semibold text-slate-900">
                  Hosted critique:
                </span>{" "}
                {SCIENCESWARM_CRITIQUE_CLOUD_DISCLAIMER}{" "}
                {!isSignedIn ? (
                  <>
                    Create a free account at{" "}
                    <a
                      href={SCIENCESWARM_SIGN_IN_URL}
                      target="_blank"
                      rel="noreferrer"
                      className="font-medium text-slate-900 underline underline-offset-2"
                    >
                      scienceswarm.ai
                    </a>{" "}
                    to use it with a free account.
                  </>
                ) : null}{" "}
                {SCIENCESWARM_CRITIQUE_FRONTIER_MODELS_DISCLAIMER}
              </div>
            ) : null}
            {!isSignedIn && authDetail ? (
              <div className="border-b border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-5 text-amber-800">
                {authDetail}
              </div>
            ) : null}
            {paneMode !== "chat-only" && (
              <div
                className={`min-h-0 shrink-0 overflow-hidden bg-white ${
                  paneMode === "visualizer-only"
                    ? "h-full"
                    : visualizerHeight === null
                      ? "h-1/2"
                      : ""
                }`}
                style={
                  paneMode === "both" && visualizerHeight !== null
                    ? { height: visualizerHeight }
                    : undefined
                }
              >
                <FileVisualizer
                  preview={filePreview}
                  inChatContext={selectedFileInChatContext}
                  onUseInChat={handleAddSelectedFileToChatContext}
                  onClose={() => setPaneMode("chat-only")}
                  onRetry={handleRetrySelectedFilePreview}
                  onSaveContent={handleSaveSelectedFileContent}
                  onNavigateBrainPage={handleNavigateBrainPage}
                />
              </div>
            )}

            {paneMode === "both" && (
              <div
                className="h-1 shrink-0 cursor-row-resize bg-border transition-colors hover:bg-accent/40"
                onMouseDown={onVisualizerChatResizeMouseDown}
                onKeyDown={onVisualizerChatResizeKeyDown}
                role="separator"
                aria-orientation="horizontal"
                aria-label="Resize visualizer and chat panes"
                tabIndex={0}
              />
            )}

            {paneMode !== "visualizer-only" && (
              <div className="flex min-h-0 flex-1 flex-col bg-white">
                <div className="flex shrink-0 items-center justify-between border-b border-border/70 bg-white/95 px-4 py-3 backdrop-blur-sm">
                  <div className="flex items-center gap-2 text-xs font-semibold text-muted">
                    <ChatCircleText size={15} />
                    Chat
                  </div>
                  <div className="flex items-center gap-2">
                    <Link
                      href={
                        activeProjectSlug
                          ? `/dashboard/settings?project=${encodeURIComponent(activeProjectSlug)}`
                          : "/dashboard/settings"
                      }
                      className="inline-flex min-h-8 items-center rounded border border-border bg-white px-2.5 text-[11px] font-semibold text-muted transition-colors hover:border-accent hover:text-foreground"
                    >
                      Runtime settings
                    </Link>
                    <button
                      type="button"
                      onClick={() => setPaneMode("visualizer-only")}
                      className="inline-flex h-8 w-8 items-center justify-center rounded border border-border bg-white text-muted transition-colors hover:border-accent hover:text-foreground"
                      title="Close chat"
                      aria-label="Close chat"
                    >
                      <X size={14} />
                    </button>
                  </div>
                </div>
                <div
                  data-testid="project-chat-canvas"
                  className="min-h-0 flex-1 overflow-y-auto bg-white px-6 py-8 select-text"
                >
                  <div
                    data-testid="project-chat-column"
                    className="mx-auto flex w-full max-w-[60rem] flex-col gap-6"
                  >
                  {!activeProjectSlug && messages.length === 0 && (
                    <section className="rounded-[28px] border-2 border-border bg-white p-8 shadow-sm">
                      <div className="flex flex-col items-center text-center">
                        <h2 className="text-lg font-semibold">
                          No project selected
                        </h2>
                        <p className="mt-2 text-sm text-muted max-w-md">
                          Create a new project and start importing your
                          research, or select an existing project from the
                          project list.
                        </p>
                        <Link
                          href="/dashboard?new=1"
                          className="mt-6 inline-flex items-center gap-1 bg-accent text-white text-sm font-medium px-6 py-2.5 rounded-lg hover:bg-accent-hover transition-colors"
                        >
                          + New Project
                        </Link>
                      </div>
                    </section>
                  )}
                  {activeProjectSlug && (
                    <section className="rounded-[28px] border border-border bg-white p-6 shadow-sm">
                      <div className="flex flex-col gap-3 border-b border-border pb-4 sm:flex-row sm:items-start sm:justify-between">
                        <div>
                          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">
                            Automation & Reruns
                          </p>
                          <h2 className="mt-1 text-lg font-semibold text-foreground">
                            Schedule repeatable project checks
                          </h2>
                          <p className="mt-1 max-w-2xl text-sm text-muted">
                            Keep recurring validation tied to the project, the
                            command that will run, the next run time, and the
                            output path where results should appear.
                          </p>
                        </div>
                      </div>
                      <div className="mt-4 min-h-[420px] overflow-hidden rounded-2xl border border-border bg-white">
                        <SchedulerPanel
                          projectId={activeProjectSlug}
                          defaultJobName="Nightly project rerun"
                          defaultJobType="recurring"
                          defaultSchedule="0 0 * * *"
                          defaultActionType="run-script"
                          defaultOutputPath="results/nightly-rerun-result.md"
                        />
                      </div>
                    </section>
                  )}
                  {showEmptyStateImport && (
                    <section className="rounded-[28px] border-2 border-border bg-white p-8 shadow-sm">
                      <div className="flex flex-col items-center text-center">
                        <h2 className="text-lg font-semibold">
                          Your workspace is empty
                        </h2>
                        <p className="mt-1 text-xs text-muted">
                          Import notes to seed your brain, or start chatting.
                        </p>
                        <div className="mt-6 flex flex-wrap items-center justify-center gap-4">
                          <button
                            type="button"
                            onClick={() => openImportDialog()}
                            className="bg-accent text-white text-base font-medium px-6 py-3 rounded-lg shadow-sm hover:opacity-90 transition"
                          >
                            Import project
                          </button>
                          <Link
                            href="/dashboard?new=1"
                            className="text-sm text-muted underline hover:text-foreground"
                          >
                            Create empty project
                          </Link>
                        </div>
                      </div>
                      <div className="mt-6">
                        <WarmStartSection
                          disabled={false}
                          projectSlug={activeProjectSlug}
                        />
                      </div>
                    </section>
                  )}
                  {messages.map((msg, _msgIdx) => {
                    const relatedArtifacts =
                      relatedArtifactsByMessageId.get(msg.id) ?? [];
                    const isUnresolvedPrompt = unresolvedPromptMessageIds.has(
                      msg.id,
                    );
                    const relatedArtifactsPanel =
                      relatedArtifacts.length > 0 ? (
                        <div className="mt-3 rounded-xl border border-border bg-white p-3">
                          <div className="flex items-center justify-between gap-3">
                            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted">
                              {isUnresolvedPrompt
                                ? "Saved for This Request"
                                : "Generated files"}
                            </p>
                            <span className="text-[10px] text-muted">
                              {isUnresolvedPrompt
                                ? "Open the file below to continue from this interrupted workflow."
                                : msg.content.trim().length === 0
                                  ? "Saved while this task is still running."
                                  : "From this reply"}
                            </span>
                          </div>
                          <div className="mt-3 flex flex-wrap gap-2">
                            {relatedArtifacts.map((artifact) => (
                              <button
                                key={`${msg.id}-${artifact.projectPath}`}
                                type="button"
                                onClick={() => {
                                  setPaneMode("both");
                                  void handleFileSelect(artifact.projectPath);
                                }}
                                className="inline-flex items-center gap-1 rounded-full border border-border bg-surface px-3 py-1.5 text-xs font-semibold text-foreground transition-colors hover:border-accent hover:text-accent"
                                aria-label={`Open generated file ${artifact.projectPath}`}
                                title={artifact.projectPath}
                              >
                                <span>
                                  {artifact.projectPath.split("/").pop() ||
                                    artifact.projectPath}
                                </span>
                              </button>
                            ))}
                          </div>
                        </div>
                      ) : null;

                    if (msg.content.startsWith("__FILE_PREVIEW__:")) {
                      if (!filesRenderInChat) return null;
                      const previewPath = msg.content.replace(
                        "__FILE_PREVIEW__:",
                        "",
                      );
                      return filePreview.status !== "idle" ? (
                        <div
                          key={msg.id}
                          data-file-preview-path={previewPath}
                          className="rounded-2xl border-2 border-border bg-white shadow-sm overflow-hidden h-[66vh]"
                        >
                          <FileVisualizer
                            preview={filePreview}
                            onRetry={handleRetrySelectedFilePreview}
                            onSaveContent={handleSaveSelectedFileContent}
                            onNavigateBrainPage={handleNavigateBrainPage}
                            extraActions={
                              <button
                                type="button"
                                onClick={() => setPaneMode("both")}
                                className="inline-flex h-8 items-center gap-1 rounded border border-border bg-white px-2.5 text-[11px] font-semibold text-foreground transition-colors hover:border-accent hover:text-accent"
                                title="Open in split view"
                              >
                                Split view
                              </button>
                            }
                          />
                        </div>
                      ) : null;
                    }
                    if (msg.content.startsWith("__FILE_STATIC__:")) {
                      if (!filesRenderInChat) return null;
                      const staticPath = msg.content.replace(
                        "__FILE_STATIC__:",
                        "",
                      );
                      return (
                        <LazyFileCard
                          key={msg.id}
                          path={staticPath}
                          messageId={msg.id}
                          staticPreviewsRef={staticPreviewsRef}
                          projectSlug={activeProjectSlug}
                          onRetry={() => {
                            void handleFileSelect(staticPath);
                          }}
                          onSaveContent={handleSaveSelectedFileContent}
                          onNavigateBrainPage={handleNavigateBrainPage}
                        />
                      );
                    }
                    // Check if message contains inline SVG charts
                    const parts = splitContentWithCharts(msg.content);
                    const hasCharts = parts.some((p) => p.type === "chart");
                    const firstRenderedBubbleIndex = parts.findIndex(
                      (part) => part.type === "chart" || part.type === "text",
                    );

                    if (hasCharts && msg.role === "assistant") {
                      return (
                        <div key={msg.id}>
                          {parts.map((part, i) =>
                            part.type === "chart" ? (
                              <InlineChart
                                key={`${msg.id}-chart-${i}`}
                                svgs={[part.content]}
                                description=""
                                taskPhases={
                                  firstRenderedBubbleIndex === i
                                    ? msg.taskPhases
                                    : undefined
                                }
                              />
                            ) : (
                              <ChatMessage
                                key={`${msg.id}-text-${i}`}
                                role={msg.role}
                                content={part.content}
                                thinking={
                                  firstRenderedBubbleIndex === i
                                    ? msg.thinking
                                    : undefined
                                }
                                activityLog={
                                  firstRenderedBubbleIndex === i
                                    ? msg.activityLog
                                    : undefined
                                }
                                progressLog={
                                  firstRenderedBubbleIndex === i
                                    ? msg.progressLog
                                    : undefined
                                }
                                channel={msg.channel}
                                userName={msg.userName}
                                timestamp={msg.timestamp}
                                isStreaming={
                                  msg.role === "assistant"
                                  && msg.id === activeAssistantMessageId
                                  && firstRenderedBubbleIndex === i
                                }
                                projectId={projectName}
                                taskPhases={
                                  firstRenderedBubbleIndex === i
                                    ? msg.taskPhases
                                    : undefined
                                }
                              />
                            ),
                          )}
                          {relatedArtifactsPanel}
                        </div>
                      );
                    }

                    return (
                      <div key={msg.id}>
                        <div className="group relative">
                          <ChatMessage
                            role={msg.role}
                            content={msg.content}
                            thinking={msg.thinking}
                            activityLog={msg.activityLog}
                            progressLog={msg.progressLog}
                            channel={msg.channel}
                            userName={msg.userName}
                            timestamp={msg.timestamp}
                            isStreaming={msg.role === "assistant" && msg.id === activeAssistantMessageId}
                            steps={msg.steps}
                            taskPhases={msg.taskPhases}
                            projectId={projectName}
                          />
                          {voiceSupported &&
                            msg.role === "assistant" &&
                            msg.content.length > 0 && (
                              <button
                                onClick={() => speakText(msg.content)}
                                disabled={voiceState !== "idle"}
                                className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity text-[10px] text-muted hover:text-accent px-1.5 py-0.5 rounded border border-transparent hover:border-border bg-white/80 disabled:opacity-30"
                                title="Listen to this response"
                              >
                                Listen
                              </button>
                            )}
                          {msg.captureClarification && (
                            <div className="mt-3 rounded-xl border border-border bg-white p-3">
                              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted">
                                Choose project
                              </p>
                              <p className="mt-1 text-xs text-foreground">
                                {msg.captureClarification.question}
                              </p>
                              <div className="mt-3 flex flex-wrap gap-2">
                                {msg.captureClarification.choices.map(
                                  (choice) => (
                                    <button
                                      key={choice}
                                      type="button"
                                      onClick={() => {
                                        void handleResolveCaptureClarification(
                                          msg.id,
                                          msg.captureClarification!,
                                          choice,
                                        );
                                      }}
                                      disabled={isCapturing}
                                      className="rounded-full border border-border bg-white px-3 py-1.5 text-xs font-semibold text-foreground transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
                                    >
                                      {choice}
                                    </button>
                                  ),
                                )}
                              </div>
                            </div>
                          )}
                          {relatedArtifactsPanel}
                        </div>
                      </div>
                    );
                  })}
                  <div ref={messagesEndRef} />
                  </div>
                </div>

                {(error || voiceError) && (
                  <div className="border-t border-red-200 bg-red-50/95 px-6 py-3 text-red-700 backdrop-blur-sm">
                    <div className="mx-auto flex w-full max-w-[60rem] items-center justify-between gap-4 text-sm">
                      <span>
                        <strong>Error:</strong> {error || voiceError}
                      </span>
                      <button
                        onClick={() => {
                          clearError();
                          clearVoiceError();
                        }}
                        className="ml-4 text-red-400 hover:text-red-600"
                      >
                        x
                      </button>
                    </div>
                  </div>
                )}

                <div className="flex-shrink-0 border-t border-border/70 bg-white/95 px-6 py-4 backdrop-blur-sm">
                  <div className="mx-auto w-full max-w-[60rem]">
                  {chatContextItems.length > 0 && (
                    <div className="mb-2 flex items-center justify-between gap-3 text-xs">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="shrink-0 font-semibold text-muted">
                          Context: {chatContextItems.length} file
                          {chatContextItems.length === 1 ? "" : "s"}
                        </span>
                        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                          {visibleChatContextItems.map((file) => (
                            <span
                              key={file.key}
                              className="inline-flex max-w-[15rem] items-center gap-1 rounded-full border border-border bg-surface px-2 py-0.5 text-[11px] text-foreground"
                              title={file.path}
                            >
                              <span className="truncate">{file.label}</span>
                              <button
                                type="button"
                                onClick={() =>
                                  removeFileFromChatContext(file.path)
                                }
                                className="text-muted transition-colors hover:text-foreground"
                                aria-label={`Remove ${file.path} from chat context`}
                              >
                                ×
                              </button>
                            </span>
                          ))}
                          {hiddenChatContextItemCount > 0 && (
                            <span className="rounded-full border border-border bg-surface px-2 py-0.5 text-[11px] text-muted">
                              +{hiddenChatContextItemCount} more
                            </span>
                          )}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={clearChatContext}
                        className="shrink-0 text-[11px] font-semibold text-muted transition-colors hover:text-foreground"
                      >
                        Clear
                      </button>
                    </div>
                  )}
                  <div className="flex gap-2 items-end">
                    <div className="relative flex-1">
                      <ChatMentionInput
                        ref={inputRef}
                        value={input}
                        onValueChange={handleChatInputChange}
                        onKeyDown={handleChatInputKeyDown}
                        onFocus={() => setChatInputFocused(true)}
                        onBlur={() => setChatInputFocused(false)}
                        onDragEnter={(e) => {
                          if (isChatBusy) return;
                          if (!e.dataTransfer.types.includes("Files")) return;
                          e.preventDefault();
                          setChatInputDragOver(true);
                        }}
                        onDragOver={(e) => {
                          if (isChatBusy) return;
                          if (!e.dataTransfer.types.includes("Files")) return;
                          e.preventDefault();
                          e.dataTransfer.dropEffect = "copy";
                          if (!chatInputDragOver) setChatInputDragOver(true);
                        }}
                        onDragLeave={(e) => {
                          if (
                            e.currentTarget.contains(
                              e.relatedTarget as Node | null,
                            )
                          )
                            return;
                          setChatInputDragOver(false);
                        }}
                        onDrop={(e) => {
                          // Always consume the drop on the chat textarea so the
                          // browser's default drop behavior (navigate to a dropped
                          // file's URL, insert filename as text) never fires.
                          e.preventDefault();
                          setChatInputDragOver(false);
                          if (isChatBusy) return;
                          const dropped = Array.from(
                            e.dataTransfer.files || [],
                          );
                          if (dropped.length === 0) return;
                          void handleProjectUpload(dropped);
                        }}
                        aria-label="Chat with your project"
                        mentionFiles={mentionFiles}
                        slashCommands={slashCommands}
                        slashCommandsLoading={slashCommandsStatus === "loading"}
                        onMentionSelect={handleMentionSelect}
                        data-testid="chat-input"
                        placeholder={
                          isChatBusy
                            ? "Processing..."
                            : CHAT_PLACEHOLDER_PROMPTS[placeholderIndex]
                        }
                        disabled={isChatBusy}
                        rows={2}
                        className={`w-full ${composerHeightOption.className} min-h-11 max-h-48 bg-surface border-2 rounded-xl px-4 py-2 text-sm focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 transition-colors resize-none overflow-auto disabled:opacity-50 leading-5 ${
                          chatInputDragOver
                            ? "border-accent ring-2 ring-accent/30"
                            : "border-border"
                        }`}
                      />
                      <button
                        type="button"
                        onPointerDown={handleComposerResizePointerDown}
                        className="absolute right-2 top-1 z-10 flex h-5 w-5 cursor-ns-resize items-center justify-center rounded text-muted transition-colors hover:bg-surface-hover hover:text-foreground focus:outline-none focus:ring-2 focus:ring-accent/30"
                        aria-label="Resize message composer"
                        title="Drag up to resize"
                      >
                        <span
                          aria-hidden="true"
                          className="text-[13px] leading-none"
                        >
                          ↕
                        </span>
                      </button>
                    </div>
                    {voiceSupported && (
                      <VoiceButton
                        voiceState={voiceState}
                        voiceError={voiceError}
                        onClearError={clearVoiceError}
                        disabled={isChatBusy}
                        onStart={startRecording}
                        onStop={() => {
                          if (voiceState === "recording") stopRecording();
                          else if (voiceState === "speaking") stopPlayback();
                        }}
                      />
                    )}
                    <ComposerRuntimeSwitcher
                      hosts={runtimeHosts.hosts}
                      selectedHostId={selectedRuntimeHostId}
                      projectPolicy={runtimeProjectPolicy}
                      mode={runtimeMode}
                      compareHostIds={compareHostIds}
                      loading={runtimeHosts.loading}
                      error={runtimeHosts.error}
                      open={runtimeSwitcherOpen}
                      onOpenChange={setRuntimeSwitcherOpen}
                      onSelectedHostIdChange={setSelectedRuntimeHostId}
                      onProjectPolicyChange={setRuntimeProjectPolicy}
                      onModeChange={setRuntimeMode}
                      onCompareHostIdsChange={setRuntimeCompareHostIds}
                    />
                    <button
                      onClick={handleSend}
                      disabled={isChatBusy || !input.trim()}
                      className="flex-shrink-0 h-11 inline-flex items-center bg-accent text-white px-6 rounded-xl text-sm font-semibold hover:bg-accent-hover transition-colors disabled:opacity-40"
                    >
                      Send
                    </button>
                  </div>
                  </div>
                </div>
                <CompareResults result={runtimeCompareResult} />
              </div>
            )}
          </div>

          {paneMode === "chat-only" && (
            <button
              type="button"
              onClick={() => setPaneMode("both")}
              className="absolute right-3 top-3 z-20 inline-flex h-9 w-9 items-center justify-center rounded border border-border bg-white text-muted shadow-sm transition-colors hover:border-accent hover:text-foreground"
              aria-label="Show visualizer"
              title="Show visualizer"
            >
              <FileMagnifyingGlass size={16} />
              <CaretDown size={11} className="-ml-1" />
            </button>
          )}

          {paneMode === "visualizer-only" && (
            <button
              type="button"
              onClick={() => setPaneMode("both")}
              className="absolute bottom-3 right-3 z-20 inline-flex h-9 w-9 items-center justify-center rounded border border-border bg-white text-muted shadow-sm transition-colors hover:border-accent hover:text-foreground"
              aria-label="Show chat"
              title="Show chat"
            >
              <ChatCircleText size={16} />
              <CaretUp size={11} className="-ml-1" />
            </button>
          )}
        </div>
      </div>

      <TurnPreviewSheet
        open={Boolean(pendingRuntimeSend)}
        preview={pendingRuntimeSend?.preview ?? null}
        pendingLabel={pendingRuntimeSend?.label ?? ""}
        busy={runtimePreviewBusy}
        error={runtimePreviewError}
        onApprove={() => void handleApproveRuntimePreview()}
        onCancel={() => {
          setPendingRuntimeSend(null);
          setRuntimePreviewError(null);
        }}
        onChangeHost={() => {
          setPendingRuntimeSend(null);
          setRuntimePreviewError(null);
          setRuntimeSwitcherOpen(true);
          inputRef.current?.focus();
        }}
      />

      {/* Import Local Project Dialog */}
      <ImportDialog
        open={importDialogOpen}
        initialPath={importDialogInitialPath}
        projectSlug={activeProjectSlug}
        onClose={() => {
          setImportDialogOpen(false);
          setImportDialogInitialPath(null);
        }}
        onImport={handleImportProject}
      />
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files)
            void handleProjectUpload(Array.from(e.target.files));
          e.target.value = "";
        }}
      />
    </div>
  );
}

export default function ProjectPage() {
  return (
    <Suspense fallback={<div className="flex h-full bg-surface/30" />}>
      <ProjectPageContent />
    </Suspense>
  );
}
