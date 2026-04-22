"use client";

import {
  useState,
  useRef,
  useEffect,
  useLayoutEffect,
  useCallback,
  type SetStateAction,
} from "react";
import {
  mergeArtifactProvenanceEntries,
  normalizeArtifactProvenanceEntries,
  type ArtifactProvenanceEntry,
} from "@/lib/artifact-provenance";
import { shouldForceOpenClawToolExecution } from "@/lib/openclaw/execution-intent";
import { sanitizeOpenClawUserVisibleResponse } from "@/lib/openclaw/response-sanitizer";
import { looksLikeSlashCommandInput } from "@/lib/openclaw/slash-commands";

import type { Step } from "@/components/research/step-cards";

// ── Types ──────────────────────────────────────────────────────

export interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  thinking?: string;
  activityLog?: string[];
  progressLog?: MessageProgressEntry[];
  timestamp: Date;
  chatMode?: ChatMode;
  channel?: string;
  userName?: string;
  captureClarification?: CaptureClarification;
  taskPhases?: ChatTaskPhase[];
  /** Optional backend-emitted agent "step" trail rendered above the message body. */
  steps?: Step[];
}

export interface CaptureClarification {
  captureId: string;
  rawPath?: string;
  question: string;
  choices: string[];
  capturedContent: string;
}

export interface ChatTaskPhase {
  id: string;
  label: string;
  status: "pending" | "active" | "completed" | "failed";
}

export interface MessageProgressEntry {
  kind: "thinking" | "activity";
  text: string;
}

export interface GeneratedArtifact {
  path: string;
  name: string;
  createdAt: string;
}

interface UploadedFile {
  name: string;
  size: string;
  type: string;
  folder?: string;
  workspacePath?: string;
  source?: "workspace" | "gbrain";
  brainSlug?: string;
  displayPath?: string;
  content?: string;
}

interface WorkspaceChatContextFile {
  path: string;
  name?: string;
  source?: "workspace" | "gbrain";
  brainSlug?: string;
  displayPath?: string;
}

interface WorkspaceTreeNode {
  name: string;
  type: "file" | "directory";
  size?: string;
  hasCompanion?: boolean;
  changed?: boolean;
  children?: WorkspaceTreeNode[];
}

function workspaceTreeSignature(nodes: WorkspaceTreeNode[]): string {
  return JSON.stringify(nodes);
}

interface PolledOpenClawMessage {
  id?: string;
  role?: string;
  content?: string;
  channel?: string;
  userId?: string;
  userName?: string;
  timestamp?: string;
}

export type Backend = "openclaw";
export type ChatMode = "reasoning" | "openclaw-tools";

interface StoredMessage {
  id: string;
  role: Message["role"];
  content: string;
  thinking?: string;
  activityLog?: string[];
  progressLog?: MessageProgressEntry[];
  timestamp: string;
  chatMode?: ChatMode;
  channel?: string;
  userName?: string;
  captureClarification?: CaptureClarification;
  taskPhases?: ChatTaskPhase[];
}

interface StoredChatState {
  version: 1;
  conversationId: string | null;
  conversationBackend?: Backend | null;
  messages: StoredMessage[];
  artifactProvenance?: ArtifactProvenanceEntry[];
}

/**
 * A file the user is currently viewing/previewing in the workspace.
 * Sent alongside the chat message so the LLM knows what "it" or "this file"
 * refers to, without polluting the displayed chat bubble.
 */
export interface ActiveFileContext {
  /** Display path shown to the user, e.g. "results.md" */
  path: string;
  /** Raw text content of the file (callers should cap at ~8 000 chars). */
  content: string;
}

export interface UseUnifiedChat {
  messages: Message[];
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  sendMessage: (content: string, activeFile?: ActiveFileContext) => Promise<void>;
  isStreaming: boolean;
  error: string | null;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
  backend: Backend;
  setBackend: React.Dispatch<React.SetStateAction<Backend>>;
  chatMode: ChatMode;
  setChatMode: React.Dispatch<React.SetStateAction<ChatMode>>;
  crossChannelMessages: Message[];
  uploadedFiles: UploadedFile[];
  workspaceTree: WorkspaceTreeNode[];
  generatedArtifacts: GeneratedArtifact[];
  handleFiles: (files: File[]) => Promise<void>;
  addWorkspaceFileToChatContext: (file: WorkspaceChatContextFile) => boolean;
  removeFileFromChatContext: (pathOrName: string) => void;
  clearChatContext: () => void;
  refreshWorkspace: (signal?: AbortSignal) => Promise<void>;
  checkChanges: (signal?: AbortSignal) => Promise<boolean>;
  recordGeneratedArtifacts: (paths: string[]) => void;
  clearGeneratedArtifacts: () => void;
  clearError: () => void;
  conversationId: string | null;
  artifactProvenance: ArtifactProvenanceEntry[];
  /**
   * true = confirmed reachable, false = confirmed disconnected,
   * null = unknown (first probe still in flight).
   */
  openClawConnected: boolean | null;
}

// ── Helpers ────────────────────────────────────────────────────

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function normalizeGeneratedArtifactPath(value: string): string | null {
  const normalized = value.trim().replace(/^\/+/, "");
  return normalized.length > 0 ? normalized : null;
}

function buildGeneratedArtifact(path: string, createdAt: string): GeneratedArtifact {
  return {
    path,
    name: path.split("/").pop() || path,
    createdAt,
  };
}

function mergeGeneratedArtifacts(
  existing: GeneratedArtifact[],
  paths: string[],
  createdAt = new Date().toISOString(),
): GeneratedArtifact[] {
  const normalizedPaths = Array.from(new Set(
    paths
      .map((path) => normalizeGeneratedArtifactPath(path))
      .filter((path): path is string => path !== null),
  ));
  if (normalizedPaths.length === 0) {
    return existing;
  }

  const merged = new Map(existing.map((artifact) => [artifact.path, artifact]));
  for (const path of normalizedPaths) {
    merged.set(path, buildGeneratedArtifact(path, createdAt));
  }

  return Array.from(merged.values())
    .sort((left, right) => {
      const timeDelta = Date.parse(right.createdAt) - Date.parse(left.createdAt);
      return timeDelta !== 0 ? timeDelta : left.path.localeCompare(right.path);
    })
    .slice(0, MAX_GENERATED_ARTIFACTS);
}

function dispatchGbrainArtifactsUpdated(projectName: string, slugs: string[]): void {
  if (typeof window === "undefined" || slugs.length === 0) return;
  window.dispatchEvent(new CustomEvent("scienceswarm:gbrain-artifacts-updated", {
    detail: { project: projectName, slugs },
  }));
}

function makeId(): string {
  return Date.now().toString() + Math.random().toString(36).slice(2);
}

function getBasename(filePath: string): string {
  const segments = filePath.split(/[\\/]+/).filter(Boolean);
  return segments.at(-1) || filePath;
}

function hasProjectScope(projectName: string): boolean {
  return projectName.trim().length > 0;
}

function getFolderLabel(filePath: string): string {
  const normalized = filePath.replace(/^\/+/, "");
  const [folder] = normalized.split("/");
  return folder || "other";
}

/**
 * Mirror the server-side `assertSafeProjectSlug` regex so we never pass a
 * malformed projectName to APIs that gate on it. If the URL `?name=` value
 * contains uppercase letters, spaces, or any character outside [a-z0-9-],
 * those endpoints would otherwise return 400 and the calling .catch() blocks
 * would silently swallow it, leaving the user with an empty workspace tree
 * and no visible error. Returning null lets callers fall back to the
 * unscoped path or skip the request entirely.
 */
function safeSlugOrNull(value: string | null | undefined): string | null {
  if (!value) return null;
  return /^[a-z0-9-]+$/.test(value) ? value : null;
}

function normalizeProjectChatError(message: string, projectName: string): string {
  if (/has no privacy manifest; remote chat is blocked\./i.test(message)) {
    return (
      `Project ${projectName} is not ready for remote chat yet. ` +
      "Use Create empty project or Import project in the workspace panel to generate its privacy manifest, then retry."
    );
  }

  if (/is local-only; remote chat is blocked for this project\./i.test(message)) {
    return (
      `Project ${projectName} is set to local-only chat. ` +
      "Use the visible project setup flow to enable remote chat before retrying this slash command."
    );
  }

  return message;
}

function removeEmptyAssistantPlaceholder(messages: Message[], assistantId: string): Message[] {
  const msg = messages.find((m) => m.id === assistantId);
  if (
    msg
    && !msg.content
    && !msg.thinking
    && !msg.activityLog?.length
    && !msg.progressLog?.length
    && !msg.taskPhases?.length
  ) {
    return messages.filter((m) => m.id !== assistantId);
  }
  return messages;
}

// Accepts legacy "agent"/"direct" values from persisted threads so old local
// storage and server-side thread JSON replay correctly. All non-null legacy
// values are collapsed to "openclaw" because the chat pipeline now routes
// every turn through OpenClaw; delegation to OpenHands/Ollama happens inside
// OpenClaw, not at the hook boundary.
function normalizeBackend(value: unknown): Backend | null {
  if (value === "openclaw" || value === "agent" || value === "direct") {
    return "openclaw";
  }
  return null;
}

function normalizeChatMode(value: unknown): ChatMode | null {
  return value === "reasoning" || value === "openclaw-tools" ? value : null;
}

// Derives the restored ChatMode from the most recent persisted message that
// recorded one. Necessary because the Backend union collapsed to a single
// member ("openclaw") and can no longer encode reasoning vs tools mode.
function deriveChatModeFromMessages(messages: Message[]): ChatMode | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const candidate = normalizeChatMode(messages[i]?.chatMode);
    if (candidate) {
      return candidate;
    }
  }
  return null;
}

// The server's X-Chat-Backend header can include diagnostic values
// ("brain-setup", "slash-commands", "none") alongside "openclaw". Since the
// hook's Backend union is now "openclaw" only, every server-reported value
// that indicates a real chat response collapses to "openclaw". Non-chat
// diagnostics return null so the hook preserves its existing backend.
function mapResponseBackend(value: string | null): Backend | null {
  if (
    value === "openclaw"
    || value === "openhands"
    || value === "agent"
    || value === "nanoclaw"
    || value === "hermes"
    || value === "direct"
  ) {
    return "openclaw";
  }
  return null;
}

function inferPolledMessageRole(message: PolledOpenClawMessage): "user" | "assistant" | "system" {
  if (message.role === "assistant" || message.role === "system") {
    return message.role;
  }
  const userId = typeof message.userId === "string" ? message.userId.toLowerCase() : "";
  if (userId === "assistant" || userId === "agent" || userId === "openclaw") {
    return "assistant";
  }
  if (userId === "system") {
    return "system";
  }
  return "user";
}

function isLikelyDuplicatePolledUserMessage(
  existingMessages: Message[],
  candidate: Message,
): boolean {
  if (candidate.role !== "user") {
    return false;
  }

  const candidateContent = candidate.content.trim();
  if (candidateContent.length === 0) {
    return false;
  }

  const candidateTimestamp = candidate.timestamp.getTime();
  return existingMessages.some((message) => {
    if (message.role !== "user") {
      return false;
    }
    const existingContent = message.content.trim();
    if (existingContent !== candidateContent) {
      return false;
    }
    if (message.channel && message.channel !== "web") {
      return false;
    }
    return Math.abs(message.timestamp.getTime() - candidateTimestamp) <= 30_000;
  });
}

function latestTimestampCursor(seed: string, messages: PolledOpenClawMessage[]): string {
  return messages.reduce((latest, message) => {
    if (typeof message.timestamp !== "string") {
      return latest;
    }
    const candidateTime = Date.parse(message.timestamp);
    const latestTime = Date.parse(latest);
    if (Number.isNaN(candidateTime)) {
      return latest;
    }
    if (Number.isNaN(latestTime) || candidateTime > latestTime) {
      return message.timestamp;
    }
    return latest;
  }, seed);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? value as Record<string, unknown>
    : null;
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

function collapseProgressWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function summarizeProgressValue(value: unknown, maxChars = 240): string {
  let raw = "";
  if (typeof value === "string") {
    raw = value;
  } else if (typeof value === "number" || typeof value === "boolean") {
    raw = String(value);
  } else if (value !== undefined) {
    try {
      raw = JSON.stringify(value);
    } catch {
      raw = String(value);
    }
  }

  const normalized = collapseProgressWhitespace(raw);
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars - 1)}…`;
}

function summarizeProgressText(value: string, maxChars = 96): string {
  const normalized = collapseProgressWhitespace(value);
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars - 1)}…`;
}

function inferOpenClawDisplayWorkspacePath(value: string): string | null {
  const normalized = collapseProgressWhitespace(value.replaceAll("\\", "/"));
  const canvasMatch = normalized.match(
    /\/(?:\.scienceswarm\/openclaw|\.openclaw)\/canvas\/documents\/(.+)$/,
  );
  if (canvasMatch?.[1]) {
    return `figures/${canvasMatch[1]}`;
  }

  const mediaMatch = normalized.match(
    /\/(?:\.scienceswarm\/openclaw|\.openclaw)\/media\/[^/]+\/([^/]+)$/,
  );
  if (mediaMatch?.[1]) {
    return `figures/${mediaMatch[1]}`;
  }

  return null;
}

function normalizeProgressCommandText(value: string, maxChars = 160): string {
  let normalized = collapseProgressWhitespace(value);
  normalized = normalized.replace(
    /(^|\s)\/usr\/local\/Caskroom\/miniforge\/base\/bin\/python3(?=\s|$)/g,
    "$1python3",
  );
  normalized = normalized.replace(
    /\/(?:Users|home)\/[^/\s]+\/\.scienceswarm\/projects\/[^/\s]+\/[^\s"'`]+/g,
    (match) => formatProgressPath(match),
  );
  normalized = normalized.replace(
    /\/(?:Users|home)\/[^/\s]+\/(?:\.scienceswarm\/openclaw|\.openclaw)\/(?:media|canvas\/documents)\/[^\s"'`]+/g,
    (match) => formatProgressPath(match),
  );
  return summarizeProgressText(normalized, maxChars);
}

function formatProgressPath(value: string): string {
  const normalized = collapseProgressWhitespace(value.replaceAll("\\", "/"));
  const openClawDisplayPath = inferOpenClawDisplayWorkspacePath(normalized);
  if (openClawDisplayPath) {
    return openClawDisplayPath;
  }

  const projectMatch = normalized.match(/\/\.scienceswarm\/projects\/[^/]+\/(.+)$/);
  if (projectMatch?.[1]) {
    return projectMatch[1];
  }

  const homeMatch = normalized.match(/^\/(?:Users|home)\/[^/]+(\/.*)$/);
  if (homeMatch?.[1]) {
    return `~${homeMatch[1]}`;
  }

  if (normalized.length <= 96) {
    return normalized;
  }

  const parts = normalized.split("/").filter(Boolean);
  if (parts.length <= 4) {
    return normalized;
  }
  return `…/${parts.slice(-4).join("/")}`;
}

function parsePositiveInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return null;
}

function formatImageGenerateLabel(detail: unknown): string {
  const detailRecord = asRecord(detail);
  const filename = firstNonEmptyString(
    detailRecord?.filename,
    detailRecord?.fileName,
    detailRecord?.output,
    detailRecord?.path,
  );
  const size = firstNonEmptyString(
    detailRecord?.size,
    detailRecord?.dimensions,
    detailRecord?.resolution,
  );
  const prompt = firstNonEmptyString(
    detailRecord?.prompt,
    detailRecord?.description,
    detailRecord?.caption,
  );
  const count = parsePositiveInteger(detailRecord?.count);

  let label = filename ? `Generate image ${filename}` : "Generate image";
  const qualifiers: string[] = [];

  if (size) {
    qualifiers.push(size);
  }
  if (count !== null && count > 1) {
    qualifiers.push(`${count} images`);
  }

  if (qualifiers.length > 0) {
    label += ` (${qualifiers.join(", ")})`;
  }

  if (!filename && prompt) {
    label += `: ${summarizeProgressText(prompt, 96)}`;
  }

  return label;
}

function formatWriteLabel(detail: unknown): string {
  const detailRecord = asRecord(detail);
  const path = firstNonEmptyString(
    detailRecord?.path,
    detailRecord?.file,
    detailRecord?.filepath,
    detailRecord?.target,
  );
  return path ? `Write ${formatProgressPath(path)}` : "Write file";
}

function formatEditLabel(detail: unknown): string {
  const detailRecord = asRecord(detail);
  const path = firstNonEmptyString(
    detailRecord?.path,
    detailRecord?.file,
    detailRecord?.filepath,
    detailRecord?.target,
  );
  return path ? `Edit ${formatProgressPath(path)}` : "Edit file";
}

function formatUpdatePlanLabel(detail: unknown): string {
  const detailRecord = asRecord(detail);
  const rawPlan = Array.isArray(detailRecord?.plan)
    ? detailRecord.plan
    : Array.isArray(detail)
      ? detail
      : null;

  if (!rawPlan) {
    return "Update plan";
  }

  const steps = rawPlan
    .map((entry) => {
      const record = asRecord(entry);
      return firstNonEmptyString(record?.step, record?.label, record?.title);
    })
    .filter((step): step is string => typeof step === "string" && step.trim().length > 0);

  if (steps.length === 0) {
    return "Update plan";
  }

  return `Plan: ${steps.join(" -> ")}`;
}

function formatExecLabel(detail: unknown): string {
  const detailRecord = asRecord(detail);
  const cmd = firstNonEmptyString(
    detailRecord?.cmd,
    detailRecord?.command,
    detailRecord?.name,
  );
  return cmd ? `Run ${normalizeProgressCommandText(cmd)}` : "Run command";
}

function formatToolActivitySummary(
  name: string | undefined,
  detail: unknown,
): string | null {
  const normalizedToolName = name?.trim().toLowerCase();
  const summary = summarizeProgressValue(detail);
  const detailRecord = asRecord(detail);
  const path = firstNonEmptyString(
    detailRecord?.path,
    detailRecord?.file,
    detailRecord?.filepath,
    detailRecord?.target,
  );
  switch (normalizedToolName) {
    case "read":
    case "read_file":
    case "open_file":
      return path ? formatProgressPath(path) : summary || "file";
    case "write":
    case "write_file":
    case "create_file":
      return formatWriteLabel(detail).replace(/^Write\s*/i, "").trim() || "file";
    case "edit":
    case "apply_patch":
    case "replace_in_file":
      return formatEditLabel(detail).replace(/^Edit\s*/i, "").trim() || "file";
    case "image_generate":
    case "generate_image":
    case "image_generation":
    case "tool-image-generation": {
      const label = formatImageGenerateLabel(detail);
      return label.replace(/^Generate image\s*/i, "").trim() || "image request";
    }
    case "exec":
    case "exec_command":
    case "process": {
      const label = formatExecLabel(detail);
      return label.replace(/^Run\s*/i, "").trim() || "command";
    }
    case "update_plan": {
      const label = formatUpdatePlanLabel(detail);
      return label.replace(/^Plan:\s*/i, "").trim() || "plan updated";
    }
    default:
      return null;
  }
}

function mergeStreamingText(existing: string | undefined, next: string): string {
  const current = existing ?? "";
  if (!next) return current;
  if (!current) return next;
  if (next.startsWith(current)) return next;
  if (current.endsWith(next)) return current;
  if (next.length > 8 && current.includes(next)) return current;
  return current + next;
}

function extractOpenClawThinkingTextFromPart(value: unknown): string | null {
  const candidate = asRecord(value);
  if (!candidate) {
    return null;
  }

  if (candidate.type === "thinking" && typeof candidate.thinking === "string") {
    return candidate.thinking;
  }

  if (
    (candidate.type === "reasoning" || candidate.type === "reasoning_text")
    && typeof candidate.text === "string"
  ) {
    return candidate.text;
  }

  if (
    (candidate.type === "reasoning" || candidate.type === "reasoning_text")
    && typeof candidate.reasoning === "string"
  ) {
    return candidate.reasoning;
  }

  return null;
}

function inferConversationBackend(
  conversationId: string | null,
  conversationBackend?: unknown,
): Backend | null {
  const explicitBackend = normalizeBackend(conversationBackend);
  if (explicitBackend) {
    return explicitBackend;
  }
  if (!conversationId) {
    return null;
  }
  // Any legacy/unknown conversationId that the hook has recorded comes from an
  // OpenClaw-routed turn (since that is now the only chat path).
  return "openclaw";
}

function getScopedConversationId(
  conversationId: string | null,
  conversationBackend: Backend | null,
  backend: Backend,
): string | null {
  if (!conversationId) {
    return null;
  }
  const resolvedBackend = inferConversationBackend(conversationId, conversationBackend);
  if (!resolvedBackend) {
    return backend === "openclaw" ? conversationId : null;
  }
  return resolvedBackend === backend ? conversationId : null;
}

const CHAT_STORAGE_PREFIX = "scienceswarm.chat";
const CHAT_STORAGE_VERSION = 1;
const MAX_PERSISTED_MESSAGES = 200;
const MAX_KEEPALIVE_MESSAGES = 50;
const WORKSPACE_TREE_REFRESH_MS = 15000;
const WORKSPACE_WATCH_POLL_MS = 5000;
const MAX_GENERATED_ARTIFACTS = 50;
const MAX_ACTIVITY_LOG_LINES = 48;
const MAX_PROGRESS_LOG_ENTRIES = 64;
const LOCAL_DIRECT_CHAT_HISTORY_MAX_MESSAGES = 8;
const LOCAL_DIRECT_CHAT_HISTORY_MAX_CHARS = 8_000;
const SLASH_COMMAND_START_TIMEOUT_MS = 15_000;
const SLASH_COMMAND_TIMEOUT_MESSAGE =
  "ScienceSwarm slash command did not start within 15 seconds. Check OpenClaw in Settings and retry.";
const QUEUED_ASSISTANT_CONTENT = "Queued...";
const INTERNAL_SYSTEM_NOISE_PREFIXES = [
  "[User opened file:",
  "__FILE_PREVIEW__:",
  "__FILE_STATIC__:",
  "new files synced:",
  "updated since import:",
  "missing from source:",
  "changed since import:",
  "Starting OpenClaw",
  "OpenClaw is running.",
  "OpenClaw is starting up.",
  "Could not auto-start OpenClaw:",
  "Starting Ollama",
  "Ollama is running.",
  "Ollama is starting up.",
  "Could not auto-start Ollama:",
];

/**
 * Prefixes that are internal system noise (not sent to AI) but MUST survive
 * persistence so the UI can restore inline file-preview cards after refresh.
 */
const PERSISTABLE_NOISE_PREFIXES = [
  "__FILE_PREVIEW__:",
  "__FILE_STATIC__:",
];

function appendActivityLog(
  existing: string[] | undefined,
  nextLines: string[],
): string[] | undefined {
  const merged = existing ? [...existing] : [];
  for (const rawLine of nextLines) {
    const line = collapseProgressWhitespace(rawLine);
    if (!line) continue;
    if (merged.at(-1) === line) continue;
    merged.push(line);
  }
  return merged.length > 0 ? merged.slice(-MAX_ACTIVITY_LOG_LINES) : existing;
}

function splitProgressText(value: string): string[] {
  return value
    .replace(/\r\n/g, "\n")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function appendProgressLog(
  existing: MessageProgressEntry[] | undefined,
  nextEntries: MessageProgressEntry[],
): MessageProgressEntry[] | undefined {
  const merged = existing ? [...existing] : [];

  for (const entry of nextEntries) {
    const text = entry.text.trim();
    if (!text) continue;
    const normalizedEntry: MessageProgressEntry = {
      kind: entry.kind,
      text,
    };
    const last = merged.at(-1);
    if (shouldSuppressProgressEntry(last, normalizedEntry)) {
      continue;
    }
    if (last && last.kind === normalizedEntry.kind && last.text === normalizedEntry.text) {
      continue;
    }
    merged.push(normalizedEntry);
  }

  return merged.length > 0 ? merged.slice(-MAX_PROGRESS_LOG_ENTRIES) : existing;
}

function buildThinkingProgressEntries(value: string): MessageProgressEntry[] {
  return splitProgressText(value).map((text) => ({
    kind: "thinking" as const,
    text,
  }));
}

function buildThinkingProgressDeltaEntries(
  previousThinking: string | undefined,
  nextThinking: string,
  replaceThinking: boolean,
): MessageProgressEntry[] {
  const previous = previousThinking ?? "";
  if (!nextThinking.trim()) {
    return [];
  }

  if (!replaceThinking) {
    return buildThinkingProgressEntries(nextThinking);
  }

  if (!previous) {
    return buildThinkingProgressEntries(nextThinking);
  }

  if (nextThinking === previous) {
    return [];
  }

  if (nextThinking.startsWith(previous)) {
    return buildThinkingProgressEntries(nextThinking.slice(previous.length));
  }

  return buildThinkingProgressEntries(nextThinking);
}

function buildActivityProgressEntries(lines: string[]): MessageProgressEntry[] {
  return lines
    .map((line) => collapseProgressWhitespace(line))
    .filter((line) => line.length > 0)
    .map((text) => ({
      kind: "activity" as const,
      text,
    }));
}

function buildOptionalActivityProgressEntries(
  lines: Array<string | null | undefined>,
): MessageProgressEntry[] {
  return buildActivityProgressEntries(
    lines.filter((line): line is string => typeof line === "string" && line.trim().length > 0),
  );
}

function isConcreteActionWithPrefix(text: string, prefix: string, generic: string): boolean {
  return text.startsWith(prefix) && text !== generic;
}

function shouldSuppressProgressEntry(
  previous: MessageProgressEntry | undefined,
  next: MessageProgressEntry,
): boolean {
  if (next.kind !== "activity") {
    return false;
  }

  if (next.text === "Turn started" || next.text === "Turn finished") {
    return true;
  }

  const previousText = previous?.kind === "activity" ? previous.text : undefined;
  if (!previousText) {
    return false;
  }

  return (
    (next.text === "Run command" && isConcreteActionWithPrefix(previousText, "Run ", "Run command")) ||
    (next.text === "Write file" && isConcreteActionWithPrefix(previousText, "Write ", "Write file")) ||
    (next.text === "Edit file" && isConcreteActionWithPrefix(previousText, "Edit ", "Edit file")) ||
    (next.text === "List files" && isConcreteActionWithPrefix(previousText, "List ", "List files")) ||
    (next.text === "Search code" && isConcreteActionWithPrefix(previousText, "Search ", "Search code"))
  );
}

function formatToolActivityLine(
  phase: string | undefined,
  name: string | undefined,
  detail: unknown,
): string {
  const toolName = name?.trim() || "tool";
  const summary = formatToolActivitySummary(name, detail) ?? summarizeProgressValue(detail);

  if (phase === "result" || phase === "done" || phase === "end") {
    return summary
      ? `Tool ${toolName} result: ${summary}`
      : `Tool ${toolName} finished`;
  }

  if (phase === "error" || phase === "failed") {
    return summary
      ? `Tool ${toolName} failed: ${summary}`
      : `Tool ${toolName} failed`;
  }

  return summary
    ? `Tool ${toolName}: ${summary}`
    : `Tool ${toolName} started`;
}

function formatToolProgressEntry(
  phase: string | undefined,
  name: string | undefined,
  detail: unknown,
): string | null {
  const toolName = name?.trim() || "tool";
  const normalizedToolName = toolName.toLowerCase();
  const detailRecord = asRecord(detail);
  const path = firstNonEmptyString(
    detailRecord?.path,
    detailRecord?.file,
    detailRecord?.filepath,
    detailRecord?.target,
  );
  const pattern = firstNonEmptyString(
    detailRecord?.pattern,
    detailRecord?.query,
    detailRecord?.q,
    detailRecord?.search,
  );
  const summary = summarizeProgressValue(detail, 320);

  let action: string;
  switch (normalizedToolName) {
    case "read":
    case "read_file":
    case "open_file":
      action = path ? `Read ${formatProgressPath(path)}` : "Read file";
      break;
    case "write":
    case "write_file":
    case "create_file":
      action = formatWriteLabel(detail);
      break;
    case "edit":
    case "apply_patch":
    case "replace_in_file":
      action = formatEditLabel(detail);
      break;
    case "image_generate":
    case "generate_image":
    case "image_generation":
    case "tool-image-generation":
      action = formatImageGenerateLabel(detail);
      break;
    case "search":
    case "grep":
    case "rg":
    case "search_code":
      action = path && pattern
        ? `Search ${pattern} in ${formatProgressPath(path)}`
        : pattern
          ? `Search ${pattern}`
          : path
            ? `Search in ${formatProgressPath(path)}`
            : "Search code";
      break;
    case "exec":
    case "exec_command":
    case "process":
      action = formatExecLabel(detail);
      break;
    case "list_dir":
    case "ls":
      action = path ? `List ${formatProgressPath(path)}` : "List files";
      break;
    case "update_plan":
      action = formatUpdatePlanLabel(detail);
      break;
    default:
      action = summary
        ? `Use ${toolName}: ${summary}`
        : `Use ${toolName}`;
      break;
  }

  if (normalizedToolName === "update_plan") {
    if (phase === "error" || phase === "failed") {
      return summary && !action.includes(summary)
        ? `${action} failed: ${summary}`
        : `${action} failed`;
    }
    return action === "Update plan" ? null : action;
  }

  if (phase === "result" || phase === "done" || phase === "end") {
    return null;
  }

  if (phase === "error" || phase === "failed") {
    return summary && !action.includes(summary)
      ? `${action} failed: ${summary}`
      : `${action} failed`;
  }

  return action;
}

function formatLifecycleActivityLine(
  phase: string | undefined,
  detail: unknown,
): string | null {
  const summary = summarizeProgressValue(detail);
  switch (phase) {
    case "start":
      return summary ? `Turn started: ${summary}` : "Turn started";
    case "end":
      return summary ? `Turn finished: ${summary}` : "Turn finished";
    case "error":
    case "failed":
      return summary ? `Turn failed: ${summary}` : "Turn failed";
    default:
      return summary ? `Lifecycle ${phase || "update"}: ${summary}` : null;
  }
}

function formatLifecycleProgressLine(
  phase: string | undefined,
  detail: unknown,
): string | null {
  const summary = summarizeProgressValue(detail);
  switch (phase) {
    case "error":
    case "failed":
      return summary ? `Turn failed: ${summary}` : "Turn failed";
    default:
      return null;
  }
}

type OpenClawProgressUpdate = {
  thinking?: string;
  assistantText?: string;
  activityLines: string[];
  progressEntries: MessageProgressEntry[];
};

function mergeOpenClawProgressUpdate(
  left: OpenClawProgressUpdate,
  right: OpenClawProgressUpdate,
): OpenClawProgressUpdate {
  return {
    thinking: right.thinking
      ? mergeStreamingText(left.thinking, right.thinking)
      : left.thinking,
    assistantText: right.assistantText
      ? mergeStreamingText(left.assistantText, right.assistantText)
      : left.assistantText,
    activityLines: [...left.activityLines, ...right.activityLines],
    progressEntries: [...left.progressEntries, ...right.progressEntries],
  };
}

function extractSessionMessageProgressUpdate(
  payload: Record<string, unknown>,
): OpenClawProgressUpdate {
  const message = asRecord(payload.message);
  const content = Array.isArray(message?.content) ? message.content : null;
  const messageRole = typeof message?.role === "string" ? message.role.toLowerCase() : "";
  if (!content || messageRole === "user" || messageRole === "system") {
    return { activityLines: [], progressEntries: [] };
  }

  const update: OpenClawProgressUpdate = { activityLines: [], progressEntries: [] };

  if (messageRole === "toolresult" || messageRole === "tool_result") {
    const toolName = firstNonEmptyString(message?.toolName, message?.tool_name, message?.name);
    const textParts = content
      .map((entry) => {
        const part = asRecord(entry);
        return firstNonEmptyString(part?.text, part?.message, part?.content);
      })
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
    const detail = textParts.length > 0 ? textParts.join("\n") : (message?.details ?? undefined);

    if (detail || toolName) {
      update.activityLines.push(
        formatToolActivityLine("result", toolName, detail),
      );
      update.progressEntries.push(
        ...buildOptionalActivityProgressEntries([
          formatToolProgressEntry("result", toolName, detail),
        ]),
      );
    }

    return update;
  }

  for (const entry of content) {
    const part = asRecord(entry);
    if (!part) {
      continue;
    }

    const thinkingText = extractOpenClawThinkingTextFromPart(part);
    if (thinkingText) {
      update.thinking = mergeStreamingText(update.thinking, thinkingText);
      update.progressEntries.push(...buildThinkingProgressEntries(thinkingText));
      continue;
    }

    const type = typeof part.type === "string" ? part.type : "";
    if (type === "text" && typeof part.text === "string") {
      update.assistantText = mergeStreamingText(update.assistantText, part.text);
      continue;
    }

    if (/tool/i.test(type)) {
      const toolPhase = /result|output/i.test(type) ? "result" : undefined;
      const toolName = firstNonEmptyString(part.name, part.tool, part.tool_name);
      const detail =
        /result|output/i.test(type)
          ? (part.output ?? part.result ?? part.content ?? part.text)
          : (part.input ?? part.args ?? part.arguments ?? part.text ?? part.content);
      update.activityLines.push(
        formatToolActivityLine(
          toolPhase,
          toolName,
          detail,
        ),
      );
      update.progressEntries.push(
        ...buildOptionalActivityProgressEntries([
          formatToolProgressEntry(toolPhase, toolName, detail),
        ]),
      );
      continue;
    }

    const genericText = firstNonEmptyString(part.text, part.message, part.content);
    if (genericText) {
      const activityLine = type ? `${type}: ${genericText}` : genericText;
      update.activityLines.push(activityLine);
      update.progressEntries.push(...buildActivityProgressEntries([activityLine]));
    }
  }

  return update;
}

function extractOpenClawProgressUpdate(progress: {
  method?: string;
  payload?: unknown;
}): OpenClawProgressUpdate {
  const payload = asRecord(progress.payload);
  if (!payload) {
    return { activityLines: [], progressEntries: [] };
  }

  let update: OpenClawProgressUpdate = {
    activityLines: [],
    progressEntries: [],
  };

  if (progress.method === "session.message") {
    update = mergeOpenClawProgressUpdate(
      update,
      extractSessionMessageProgressUpdate(payload),
    );
  }

  const stream = firstNonEmptyString(payload.stream);
  const data = asRecord(payload.data);

  if (stream === "thinking" || stream === "reasoning" || stream === "reasoning_text") {
    const nextThinking = firstNonEmptyString(data?.delta, data?.text, data?.reasoning);
    if (nextThinking) {
      update.thinking = mergeStreamingText(update.thinking, nextThinking);
      update.progressEntries.push(...buildThinkingProgressEntries(nextThinking));
    }
  } else if (stream === "assistant") {
    const nextAssistantText = firstNonEmptyString(data?.delta, data?.text);
    if (nextAssistantText) {
      update.assistantText = mergeStreamingText(update.assistantText, nextAssistantText);
    }
  } else if (stream === "tool") {
    const toolPhase = firstNonEmptyString(data?.phase);
    const toolName = firstNonEmptyString(data?.name);
    const toolDetail =
      data?.phase === "result" || data?.phase === "done"
        ? (data?.output ?? data?.result ?? data?.text)
        : (data?.args ?? data?.input ?? data?.text);
    const activityLine = formatToolActivityLine(
      toolPhase,
      toolName,
      toolDetail,
    );
    update.activityLines.push(activityLine);
    update.progressEntries.push(
      ...buildOptionalActivityProgressEntries([
        formatToolProgressEntry(toolPhase, toolName, toolDetail),
      ]),
    );
  } else if (stream === "lifecycle") {
    const lifecyclePhase = firstNonEmptyString(data?.phase);
    const lifecycleDetail = firstNonEmptyString(data?.text, data?.message, payload.text, payload.content);
    const lifecycleLine = formatLifecycleActivityLine(
      lifecyclePhase,
      lifecycleDetail,
    );
    if (lifecycleLine) {
      update.activityLines.push(lifecycleLine);
    }
    const lifecycleProgressLine = formatLifecycleProgressLine(
      lifecyclePhase,
      lifecycleDetail,
    );
    if (lifecycleProgressLine) {
      update.progressEntries.push(...buildActivityProgressEntries([lifecycleProgressLine]));
    }
  }

  const payloadNarration = firstNonEmptyString(
    payload.text,
    payload.content,
    typeof payload.message === "string" ? payload.message : undefined,
  );
  if (payloadNarration) {
    update.activityLines.push(payloadNarration);
    update.progressEntries.push(...buildActivityProgressEntries([payloadNarration]));
  }

  return update;
}

type RestoredChatState = {
  messages: Message[];
  conversationId: string | null;
  conversationBackend: Backend | null;
  artifactProvenance: ArtifactProvenanceEntry[];
  hasStoredState: boolean;
};

type SendContext = {
  backend: Backend;
  chatMode: ChatMode;
  projectName: string;
  projectVersion: number;
  userBackendOverrideVersion: number;
};

type QueuedSend = {
  content: string;
  activeFile?: ActiveFileContext;
  assistantId: string;
  context: SendContext;
  resolve: () => void;
};

function buildInitialMessages(projectName: string): Message[] {
  if (!hasProjectScope(projectName)) {
    return [];
  }

  return [
    {
      id: "1",
      role: "system",
      content: `Project **${projectName}** loaded.`,
      timestamp: new Date(),
    },
    {
      id: "2",
      role: "assistant",
      content: `Research workspace ready for **${projectName}**.\n\n` +
        "Import a research archive or upload files to start organizing papers, code, data, and notes.\n\n" +
        "Once your materials are in place, ask me to \"organize this project\" and I can cluster likely project threads, surface possible duplicate papers and stale exports, and suggest the next pages or tasks worth creating.",
      timestamp: new Date(),
    },
  ];
}

function getChatStorageKey(projectName: string): string {
  return `${CHAT_STORAGE_PREFIX}.${encodeURIComponent(projectName || "__no-project__")}`;
}

function folderLabelForIngestType(type: string | undefined): string {
  switch (type) {
    case "paper":
      return "papers";
    case "dataset":
      return "data";
    case "code":
      return "code";
    case "artifact":
      return "docs";
    case "source":
      return "sources";
    default:
      return "other";
  }
}

function isPersistableMessage(message: Message): boolean {
  if (message.role === "assistant" && message.content === QUEUED_ASSISTANT_CONTENT) {
    return false;
  }

  if (
    message.role === "assistant"
    && message.content.trim().length === 0
    && !message.thinking?.trim().length
    && !message.activityLog?.length
    && !message.progressLog?.length
    && !message.taskPhases?.length
  ) {
    return false;
  }

  return !isInternalSystemNoise(message) || isPersistableNoise(message);
}

function sanitizeMessagesForPersistence(messages: Message[]): Message[] {
  return messages.filter((message) => isPersistableMessage(message));
}

async function fetchWithTimeout(
  input: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  let settled = false;

  return new Promise<Response>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      controller.abort();
      reject(new Error(SLASH_COMMAND_TIMEOUT_MESSAGE));
    }, timeoutMs);

    fetch(input, { ...init, signal: controller.signal })
      .then((response) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        resolve(response);
      })
      .catch((error) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        reject(error);
      });
  });
}

function isInternalSystemNoise(message: Message): boolean {
  if (message.role !== "system") return false;
  const content = message.content.trim();
  if (!content) return false;
  const lines = content.split("\n").map((line) => line.trim()).filter(Boolean);

  return lines.length > 0
    && lines.every((line) =>
      INTERNAL_SYSTEM_NOISE_PREFIXES.some((prefix) => line.startsWith(prefix)),
    );
}

/** File-preview markers are internal noise but must survive persistence. */
function isPersistableNoise(message: Message): boolean {
  if (message.role !== "system") return false;
  const content = message.content.trim();
  return PERSISTABLE_NOISE_PREFIXES.some((prefix) => content.startsWith(prefix));
}

/**
 * On restore, any `__FILE_PREVIEW__:` becomes `__FILE_STATIC__:` because
 * there is no active preview state after a page reload.
 */
function demoteRestoredPreviews(messages: Message[]): Message[] {
  return messages.map((m) =>
    m.role === "system" && m.content.startsWith("__FILE_PREVIEW__:")
      ? { ...m, content: m.content.replace("__FILE_PREVIEW__:", "__FILE_STATIC__:") }
      : m,
  );
}

function buildQueuedHistory(messages: Message[], assistantId: string): Message[] {
  const assistantIndex = messages.findIndex((message) => message.id === assistantId);
  return assistantIndex >= 0 ? messages.slice(0, assistantIndex) : messages;
}

function restoreMessage(value: unknown): Message | null {
  if (!value || typeof value !== "object") return null;

  const candidate = value as Partial<StoredMessage>;
  if (
    typeof candidate.id !== "string"
    || (candidate.role !== "system" && candidate.role !== "assistant" && candidate.role !== "user")
    || typeof candidate.content !== "string"
    || (candidate.thinking !== undefined && typeof candidate.thinking !== "string")
    || (candidate.activityLog !== undefined && !Array.isArray(candidate.activityLog))
    || (
      candidate.progressLog !== undefined
      && !Array.isArray(candidate.progressLog)
    )
    || typeof candidate.timestamp !== "string"
  ) {
    return null;
  }

  const timestamp = new Date(candidate.timestamp);
  if (Number.isNaN(timestamp.getTime())) {
    return null;
  }

  return {
    id: candidate.id,
    role: candidate.role,
    content:
      candidate.role === "user"
        ? candidate.content
        : sanitizeOpenClawUserVisibleResponse(candidate.content),
    thinking:
      typeof candidate.thinking === "string"
        ? sanitizeOpenClawUserVisibleResponse(candidate.thinking)
        : undefined,
    activityLog: restoreActivityLog(candidate.activityLog),
    progressLog: restoreProgressLog(candidate.progressLog),
    timestamp,
    chatMode: normalizeChatMode(candidate.chatMode) ?? undefined,
    channel: typeof candidate.channel === "string" ? candidate.channel : undefined,
    userName: typeof candidate.userName === "string" ? candidate.userName : undefined,
    captureClarification: restoreCaptureClarification(candidate.captureClarification),
    taskPhases: restoreTaskPhases(candidate.taskPhases),
  };
}

function restoreCaptureClarification(value: unknown): CaptureClarification | undefined {
  if (!value || typeof value !== "object") return undefined;

  const candidate = value as Partial<CaptureClarification>;
  if (
    typeof candidate.captureId !== "string"
    || typeof candidate.question !== "string"
    || !Array.isArray(candidate.choices)
    || !candidate.choices.every((choice) => typeof choice === "string")
    || typeof candidate.capturedContent !== "string"
  ) {
    return undefined;
  }

  return {
    captureId: candidate.captureId,
    rawPath: typeof candidate.rawPath === "string" ? candidate.rawPath : undefined,
    question: candidate.question,
    choices: candidate.choices,
    capturedContent: candidate.capturedContent,
  };
}

function restoreActivityLog(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const lines = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => collapseProgressWhitespace(entry))
    .filter(Boolean);

  return lines.length > 0 ? lines : undefined;
}

function restoreProgressLog(value: unknown): MessageProgressEntry[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const entries = value
    .filter(
      (entry): entry is Partial<MessageProgressEntry> =>
        Boolean(entry && typeof entry === "object"),
    )
    .map((entry) => {
      if (
        (entry.kind !== "thinking" && entry.kind !== "activity")
        || typeof entry.text !== "string"
      ) {
        return null;
      }

      const text = entry.text.trim();
      if (!text) {
        return null;
      }

      return {
        kind: entry.kind,
        text,
      } satisfies MessageProgressEntry;
    })
    .filter((entry): entry is MessageProgressEntry => entry !== null);

  return entries.length > 0 ? entries : undefined;
}

function restoreTaskPhases(value: unknown): ChatTaskPhase[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const phases = value
    .filter(
      (entry): entry is Partial<ChatTaskPhase> =>
        Boolean(entry && typeof entry === "object"),
    )
    .map((entry) => {
      if (
        typeof entry.id !== "string"
        || typeof entry.label !== "string"
        || (
          entry.status !== "pending"
          && entry.status !== "active"
          && entry.status !== "completed"
          && entry.status !== "failed"
        )
      ) {
        return null;
      }

      return {
        id: entry.id,
        label: entry.label,
        status: entry.status,
      } satisfies ChatTaskPhase;
    })
    .filter((phase): phase is ChatTaskPhase => phase !== null);

  return phases.length > 0 ? phases : undefined;
}

function loadStoredChat(projectName: string): RestoredChatState {
  if (!projectName) {
    return {
      messages: [],
      conversationId: null,
      conversationBackend: null,
      artifactProvenance: [],
      hasStoredState: false,
    };
  }

  if (typeof window === "undefined") {
    return {
      messages: [],
      conversationId: null,
      conversationBackend: null,
      artifactProvenance: [],
      hasStoredState: false,
    };
  }

  try {
    const raw = window.localStorage.getItem(getChatStorageKey(projectName));
    if (!raw) {
      return {
        messages: [],
        conversationId: null,
        conversationBackend: null,
        artifactProvenance: [],
        hasStoredState: false,
      };
    }

    const parsed = JSON.parse(raw) as Partial<StoredChatState>;
    if (parsed.version !== CHAT_STORAGE_VERSION || !Array.isArray(parsed.messages)) {
      return {
        messages: [],
        conversationId: null,
        conversationBackend: null,
        artifactProvenance: [],
        hasStoredState: false,
      };
    }

    const restoredMessages = demoteRestoredPreviews(
      sanitizeMessagesForPersistence(
        parsed.messages
        .map((entry) => restoreMessage(entry))
        .filter((entry): entry is Message => entry !== null),
      ),
    );
    const conversationId = typeof parsed.conversationId === "string" ? parsed.conversationId : null;
    const conversationBackend = inferConversationBackend(conversationId, parsed.conversationBackend);
    const artifactProvenance = normalizeArtifactProvenanceEntries(parsed.artifactProvenance);

    return {
      messages: restoredMessages,
      conversationId,
      conversationBackend,
      artifactProvenance,
      hasStoredState:
        restoredMessages.length > 0 || conversationId !== null || artifactProvenance.length > 0,
    };
  } catch {
    return {
      messages: [],
      conversationId: null,
      conversationBackend: null,
      artifactProvenance: [],
      hasStoredState: false,
    };
  }
}

function persistChat(
  projectName: string,
  messages: Message[],
  conversationId: string | null,
  conversationBackend: Backend | null,
  artifactProvenance: ArtifactProvenanceEntry[],
): void {
  if (typeof window === "undefined") return;
  if (!projectName) return;

  try {
    const persistedMessages = sanitizeMessagesForPersistence(messages);
    const stored: StoredChatState = {
      version: CHAT_STORAGE_VERSION,
      conversationId,
      conversationBackend,
      messages: persistedMessages.slice(-MAX_PERSISTED_MESSAGES).map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        thinking: message.thinking,
        activityLog: message.activityLog,
        progressLog: message.progressLog,
        timestamp: message.timestamp.toISOString(),
        chatMode: message.chatMode,
        channel: message.channel,
        userName: message.userName,
        captureClarification: message.captureClarification,
        taskPhases: message.taskPhases,
      })),
      artifactProvenance,
    };
    window.localStorage.setItem(
      getChatStorageKey(projectName),
      JSON.stringify(stored),
    );
  } catch {
    // Ignore storage quota and private-browsing failures.
  }
}

function getLatestMessageTimestamp(messages: Message[]): number {
  return messages.reduce((max, message) => {
    const value = message.timestamp.getTime();
    return Number.isNaN(value) ? max : Math.max(max, value);
  }, 0);
}

function getPollCursorSeed(messages: Message[]): string {
  const latestTimestamp = getLatestMessageTimestamp(messages);
  return latestTimestamp > 0 ? new Date(latestTimestamp).toISOString() : new Date().toISOString();
}

function extractPromptSourceFiles(content: string): string[] {
  const matches = new Set<string>();
  const fileReferencePattern =
    /(?:^|[\s("'`])((?:~\/|\/)?[A-Za-z0-9._-][A-Za-z0-9._\-\/]*\.[A-Za-z0-9]{1,8})(?=$|[\s)"'`,.:;!?])/g;
  let match: RegExpExecArray | null = null;

  while ((match = fileReferencePattern.exec(content)) !== null) {
    const candidate = match[1]?.trim().replace(/^['"`]+|['"`]+$/g, "");
    if (!candidate || candidate.includes("://")) {
      continue;
    }
    matches.add(candidate.replace(/^\.?\//, ""));
  }

  return Array.from(matches);
}

function getUploadedFileReference(file: Pick<UploadedFile, "workspacePath" | "name" | "brainSlug">): string {
  if (typeof file.brainSlug === "string" && file.brainSlug.trim().length > 0) {
    return `gbrain:${file.brainSlug.trim()}`;
  }
  if (typeof file.workspacePath === "string" && file.workspacePath.trim().length > 0) {
    return file.workspacePath.trim();
  }
  return typeof file.name === "string" ? file.name.trim() : "";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeReferenceAlias(value: string): string {
  return value.trim().replace(/^\/+/, "");
}

function buildFileReferenceAliases(file: {
  name?: string;
  displayPath?: string;
  workspacePath?: string;
  brainSlug?: string;
}): string[] {
  const aliases = new Set<string>();
  const rawValues = [
    file.name,
    file.displayPath,
    file.workspacePath,
    file.brainSlug,
    typeof file.brainSlug === "string" && file.brainSlug.trim().length > 0
      ? `gbrain:${file.brainSlug.trim()}`
      : "",
  ];

  for (const rawValue of rawValues) {
    if (typeof rawValue !== "string") {
      continue;
    }
    const normalized = normalizeReferenceAlias(rawValue);
    if (!normalized) {
      continue;
    }
    aliases.add(normalized);
    aliases.add(getBasename(normalized));
  }

  return Array.from(aliases);
}

function contentExplicitlyReferencesFile(content: string, aliases: string[]): boolean {
  return aliases.some((alias) => {
    const escaped = escapeRegExp(alias);
    const pattern = new RegExp(`(^|[^A-Za-z0-9_])@?${escaped}(?=$|[^A-Za-z0-9_])`, "i");
    return pattern.test(content);
  });
}

function shouldIncludeAllExplicitFiles(content: string): boolean {
  return /\b(attached|uploaded|selected|mentioned)\s+files?\b|\b(these|those)\s+files\b|\ball\s+(attached|uploaded|selected|mentioned)\s+files\b/i.test(content);
}

function selectExplicitRequestFiles(
  content: string,
  files: UploadedFile[],
): UploadedFile[] {
  if (files.length === 0) {
    return [];
  }

  if (shouldIncludeAllExplicitFiles(content)) {
    return files;
  }

  return files.filter((file) =>
    contentExplicitlyReferencesFile(content, buildFileReferenceAliases(file)),
  );
}

function shouldAttachActiveFileContext(
  content: string,
  activeFile?: ActiveFileContext,
): activeFile is ActiveFileContext {
  if (!activeFile) {
    return false;
  }

  if (/\b(this|current|selected|open|shown|visible)\s+file\b/i.test(content)) {
    return true;
  }

  return contentExplicitlyReferencesFile(
    content,
    buildFileReferenceAliases({
      name: getBasename(activeFile.path),
      displayPath: activeFile.path,
      workspacePath: activeFile.path,
    }),
  );
}

function isLocalDirectContext(_context: Pick<SendContext, "backend" | "chatMode">): boolean {
  // The local-direct fallback has been removed. Every chat turn is routed
  // through OpenClaw, which owns any internal delegation to local models.
  return false;
}

function trimLocalChatHistory(
  history: Array<{ role: Message["role"]; content: string }>,
): Array<{ role: Message["role"]; content: string }> {
  const selected: Array<{ role: Message["role"]; content: string }> = [];
  let totalChars = 0;
  let retainedAssistantTurns = 0;

  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index];
    const content = entry?.content ?? "";
    if (!content) {
      continue;
    }

    // Keep the most recent assistant turn for short follow-up questions like
    // "why?" or "compare that to the last answer", while still trimming older
    // assistant prose that tends to re-impose stale agendas in local mode.
    if (entry.role === "assistant") {
      if (retainedAssistantTurns >= 1) {
        continue;
      }
    } else if (entry.role !== "user") {
      continue;
    }

    const nextChars = totalChars + content.length;
    if (
      selected.length >= LOCAL_DIRECT_CHAT_HISTORY_MAX_MESSAGES ||
      nextChars > LOCAL_DIRECT_CHAT_HISTORY_MAX_CHARS
    ) {
      break;
    }

    selected.push(entry);
    totalChars = nextChars;
    if (entry.role === "assistant") {
      retainedAssistantTurns += 1;
    }
  }

  return selected.reverse();
}

function buildFallbackArtifactProvenance(
  generatedFiles: string[],
  prompt: string,
  sourceFiles: string[],
  tool: string,
  createdAt: string,
): ArtifactProvenanceEntry[] {
  return generatedFiles.map((projectPath) => ({
    projectPath,
    sourceFiles,
    prompt,
    tool,
    createdAt,
  }));
}

function materializeMessages(projectName: string, state: RestoredChatState): Message[] {
  return state.messages.length > 0 ? state.messages : buildInitialMessages(projectName);
}

function sameMessages(left: Message[], right: Message[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((message, index) => {
    const candidate = right[index];
    return Boolean(candidate)
      && message.id === candidate.id
      && message.role === candidate.role
      && message.content === candidate.content
      && message.thinking === candidate.thinking
      && message.timestamp.getTime() === candidate.timestamp.getTime()
      && message.chatMode === candidate.chatMode
      && message.channel === candidate.channel
      && message.userName === candidate.userName
      && sameCaptureClarification(message.captureClarification, candidate.captureClarification)
      && sameTaskPhases(message.taskPhases, candidate.taskPhases);
  });
}

function sameCaptureClarification(
  left: CaptureClarification | undefined,
  right: CaptureClarification | undefined,
): boolean {
  if (!left && !right) return true;
  if (!left || !right) return false;
  return left.captureId === right.captureId
    && left.rawPath === right.rawPath
    && left.question === right.question
    && left.capturedContent === right.capturedContent
    && left.choices.length === right.choices.length
    && left.choices.every((choice, index) => choice === right.choices[index]);
}

function sameTaskPhases(
  left: ChatTaskPhase[] | undefined,
  right: ChatTaskPhase[] | undefined,
): boolean {
  if (!left && !right) return true;
  if (!left || !right) return false;
  if (left.length !== right.length) return false;

  return left.every((phase, index) => {
    const candidate = right[index];
    return Boolean(candidate)
      && phase.id === candidate.id
      && phase.label === candidate.label
      && phase.status === candidate.status;
  });
}

function choosePreferredChatState(localState: RestoredChatState, remoteState: RestoredChatState): RestoredChatState {
  if (localState.hasStoredState && !remoteState.hasStoredState) {
    return localState;
  }
  if (remoteState.hasStoredState && !localState.hasStoredState) {
    return remoteState;
  }

  const localLatest = getLatestMessageTimestamp(localState.messages);
  const remoteLatest = getLatestMessageTimestamp(remoteState.messages);

  if (remoteLatest > localLatest) {
    return remoteState;
  }
  if (localLatest > remoteLatest) {
    return localState;
  }
  if (remoteState.messages.length > localState.messages.length) {
    return remoteState;
  }
  if (remoteState.artifactProvenance.length > localState.artifactProvenance.length) {
    return remoteState;
  }
  if (!localState.conversationId && remoteState.conversationId) {
    return remoteState;
  }
  return localState;
}

async function loadStoredChatFromServer(projectName: string): Promise<RestoredChatState | null> {
  if (!safeSlugOrNull(projectName)) return null;

  try {
    const res = await fetch(`/api/chat/thread?project=${encodeURIComponent(projectName)}`);
    if (!res.ok) return null;
    const raw = await res.json() as Partial<StoredChatState> & { project?: string };
    if (raw.version !== CHAT_STORAGE_VERSION || !Array.isArray(raw.messages)) {
      return null;
    }
    const restoredMessages = demoteRestoredPreviews(
      sanitizeMessagesForPersistence(
        raw.messages
        .map((entry) => restoreMessage(entry))
        .filter((entry): entry is Message => entry !== null),
      ),
    );
    const conversationId = typeof raw.conversationId === "string" ? raw.conversationId : null;
    const conversationBackend = inferConversationBackend(
      conversationId,
      (raw as Partial<StoredChatState>).conversationBackend,
    );
    const artifactProvenance = normalizeArtifactProvenanceEntries(raw.artifactProvenance);

    return {
      messages: restoredMessages,
      conversationId,
      conversationBackend,
      artifactProvenance,
      hasStoredState:
        restoredMessages.length > 0 || conversationId !== null || artifactProvenance.length > 0,
    };
  } catch {
    return null;
  }
}

async function persistChatToServer(
  projectName: string,
  messages: Message[],
  conversationId: string | null,
  conversationBackend: Backend | null,
  artifactProvenance: ArtifactProvenanceEntry[],
  keepalive = false,
): Promise<void> {
  if (!safeSlugOrNull(projectName)) return;

  const messageLimit = keepalive ? MAX_KEEPALIVE_MESSAGES : MAX_PERSISTED_MESSAGES;
  const persistedMessages = sanitizeMessagesForPersistence(messages);
  const payload = {
    project: projectName,
    conversationId,
    conversationBackend,
    messages: persistedMessages.slice(-messageLimit).map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      thinking: message.thinking,
      timestamp: message.timestamp.toISOString(),
      chatMode: message.chatMode,
      channel: message.channel,
      userName: message.userName,
      captureClarification: message.captureClarification,
      taskPhases: message.taskPhases,
    })),
    artifactProvenance,
  };

  try {
    await fetch("/api/chat/thread", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      keepalive,
    });
  } catch {
    // Keep local cache authoritative when the local route is temporarily unavailable.
  }
}

// ── Hook ───────────────────────────────────────────────────────

export function useUnifiedChat(
  projectName: string,
): UseUnifiedChat {
  const [messages, setMessagesState] = useState<Message[]>(() => buildInitialMessages(projectName));
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [backend, setBackendState] = useState<Backend>("openclaw");
  const [chatMode, setChatModeState] = useState<ChatMode>("reasoning");
  const [crossChannelMessages, setCrossChannelMessages] = useState<Message[]>(
    []
  );
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([]);
  const [workspaceTree, setWorkspaceTree] = useState<WorkspaceTreeNode[]>([]);
  const [generatedArtifacts, setGeneratedArtifacts] = useState<GeneratedArtifact[]>([]);
  const [conversationId, setConversationIdState] = useState<string | null>(null);
  const [conversationBackend, setConversationBackendState] = useState<Backend | null>(null);
  const [openClawConnected, setOpenClawConnected] = useState<boolean | null>(null);
  const [artifactProvenance, setArtifactProvenanceState] = useState<ArtifactProvenanceEntry[]>([]);
  // Tracks whether hydration from localStorage/server has committed. The
  // cross-channel poll effect uses this to avoid registering a setInterval
  // whose closure captures a stale `scopedConversationId = null` on the
  // very first render. Before the Backend-union was narrowed to "openclaw"
  // the initial backend was "direct", which naturally deferred polling
  // until the health probe flipped it to "openclaw"; that side-effect is
  // what we preserve here.
  const [hasHydratedChat, setHasHydratedChat] = useState(false);

  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastPollRef = useRef<string>(new Date().toISOString());
  const hydratedChatKeyRef = useRef<string | null>(null);
  const pendingHydrationKeyRef = useRef<string | null>(null);
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unloadPersistedRef = useRef(false);
  const liveMessagesRef = useRef<Message[]>(messages);
  const liveConversationIdRef = useRef<string | null>(conversationId);
  const liveConversationBackendRef = useRef<Backend | null>(conversationBackend);
  const liveArtifactProvenanceRef = useRef<ArtifactProvenanceEntry[]>(artifactProvenance);
  const liveUploadedFilesRef = useRef<UploadedFile[]>(uploadedFiles);
  const liveBackendRef = useRef<Backend>(backend);
  const liveChatModeRef = useRef<ChatMode>(chatMode);
  const liveProjectNameRef = useRef(projectName);
  const workspaceTreeSignatureRef = useRef<string>(workspaceTreeSignature([]));
  const workspaceWatchRevisionRef = useRef<string | null>(null);
  const workspaceWatchAvailableRef = useRef(false);
  const projectVersionRef = useRef(0);
  const initialBackendSetRef = useRef(false);
  const localProviderActiveRef = useRef(false);
  const userBackendOverrideVersionRef = useRef(0);
  const sendQueueRef = useRef<QueuedSend[]>([]);
  const sendQueueProcessingRef = useRef(false);
  const scopedConversationId = getScopedConversationId(conversationId, conversationBackend, backend);

  // These updater callbacks must stay pure. We mirror the computed next value
  // into live refs so unload persistence can read the latest state
  // synchronously, and the StrictMode regression tests rely on same prev =>
  // same next remaining idempotent.
  const setMessages = useCallback((updater: SetStateAction<Message[]>) => {
    setMessagesState((prev) => {
      const next =
        typeof updater === "function"
          ? (updater as (messages: Message[]) => Message[])(prev)
          : updater;
      liveMessagesRef.current = next;
      return next;
    });
  }, []);

  const setBackend = useCallback((updater: SetStateAction<Backend>) => {
    setBackendState((prev) => {
      const next =
        typeof updater === "function"
          ? (updater as (value: Backend) => Backend)(prev)
          : updater;
      liveBackendRef.current = next;
      return next;
    });
  }, []);

  const setChatMode = useCallback((updater: SetStateAction<ChatMode>) => {
    setChatModeState((prev) => {
      const next =
        typeof updater === "function"
          ? (updater as (value: ChatMode) => ChatMode)(prev)
          : updater;
      liveChatModeRef.current = next;
      return next;
    });
  }, []);

  const setConversationId = useCallback((updater: SetStateAction<string | null>) => {
    setConversationIdState((prev) => {
      const next =
        typeof updater === "function"
          ? (updater as (value: string | null) => string | null)(prev)
          : updater;
      liveConversationIdRef.current = next;
      return next;
    });
  }, []);

  const setConversationBackend = useCallback((updater: SetStateAction<Backend | null>) => {
    setConversationBackendState((prev) => {
      const next =
        typeof updater === "function"
          ? (updater as (value: Backend | null) => Backend | null)(prev)
          : updater;
      liveConversationBackendRef.current = next;
      return next;
    });
  }, []);

  const setArtifactProvenance = useCallback((updater: SetStateAction<ArtifactProvenanceEntry[]>) => {
    setArtifactProvenanceState((prev) => {
      const next =
        typeof updater === "function"
          ? (updater as (value: ArtifactProvenanceEntry[]) => ArtifactProvenanceEntry[])(prev)
          : updater;
      liveArtifactProvenanceRef.current = next;
      return next;
    });
  }, []);

  const applyMessagesUpdate = useCallback((updater: (messages: Message[]) => Message[]) => {
    const next = updater(liveMessagesRef.current);
    liveMessagesRef.current = next;
    setMessagesState(next);
  }, []);

  useLayoutEffect(() => {
    liveMessagesRef.current = messages;
    liveConversationIdRef.current = conversationId;
    liveConversationBackendRef.current = conversationBackend;
    liveArtifactProvenanceRef.current = artifactProvenance;
    liveUploadedFilesRef.current = uploadedFiles;
    liveBackendRef.current = backend;
    liveChatModeRef.current = chatMode;
    liveProjectNameRef.current = projectName;
  }, [
    artifactProvenance,
    backend,
    chatMode,
    conversationBackend,
    conversationId,
    messages,
    projectName,
    uploadedFiles,
  ]);

  useLayoutEffect(() => {
    const storageKey = getChatStorageKey(projectName);
    if (pendingHydrationKeyRef.current !== storageKey) {
      return;
    }

    // The hydration effect only seeds the restored thread into state. Do not
    // allow persistence or unmount cleanup to treat that thread as durable
    // until this render has actually committed for the current project.
    pendingHydrationKeyRef.current = null;
    hydratedChatKeyRef.current = storageKey;
  }, [
    artifactProvenance,
    conversationBackend,
    conversationId,
    messages,
    projectName,
  ]);

  useEffect(() => {
    workspaceTreeSignatureRef.current = workspaceTreeSignature(workspaceTree);
  }, [workspaceTree]);

  useEffect(() => {
    setGeneratedArtifacts([]);
  }, [projectName]);

  const recordGeneratedArtifacts = useCallback((paths: string[]) => {
    setGeneratedArtifacts((prev) => mergeGeneratedArtifacts(prev, paths));
  }, []);

  useEffect(() => {
    const storageKey = getChatStorageKey(projectName);
    setHasHydratedChat(false);
    const restored = loadStoredChat(projectName);
    projectVersionRef.current += 1;
    hydratedChatKeyRef.current = null;
    pendingHydrationKeyRef.current = storageKey;
    const hydratedMessages = materializeMessages(projectName, restored);
    const restoredBackend: Backend = "openclaw";
    const restoredChatMode: ChatMode =
      deriveChatModeFromMessages(hydratedMessages) ?? "reasoning";
    lastPollRef.current = getPollCursorSeed(hydratedMessages);
    setIsStreaming(false);
    setError(null);
    setMessages(hydratedMessages);
    setBackend(restoredBackend);
    setChatMode(restoredChatMode);
    setConversationId(restored.conversationId);
    setConversationBackend(restored.conversationBackend);
    liveBackendRef.current = restoredBackend;
    liveChatModeRef.current = restoredChatMode;
    initialBackendSetRef.current = restored.conversationBackend === "openclaw";
    setArtifactProvenance(restored.artifactProvenance);
    setCrossChannelMessages(
      hydratedMessages.filter((message) => message.channel && message.channel !== "web"),
    );
    setHasHydratedChat(true);

    if (safeSlugOrNull(projectName)) {
      void (async () => {
        const remoteState = await loadStoredChatFromServer(projectName);
        const activeHydrationKey = pendingHydrationKeyRef.current ?? hydratedChatKeyRef.current;
        if (!remoteState || activeHydrationKey !== storageKey) {
          return;
        }
        if (
          liveConversationIdRef.current !== restored.conversationId
          || !sameMessages(liveMessagesRef.current, hydratedMessages)
        ) {
          return;
        }
        const preferredState = choosePreferredChatState(restored, remoteState);
        const preferredMessages = materializeMessages(projectName, preferredState);
        lastPollRef.current = getPollCursorSeed(preferredMessages);
        setMessages(preferredMessages);
        // Only re-apply backend/chatMode when the preferred state actually has a
        // known conversationBackend. Otherwise we'd clobber a backend that the
        // auto-probe effect seeded in parallel (e.g. connected OpenClaw).
        if (preferredState.conversationBackend !== null) {
          const preferredBackend: Backend = "openclaw";
          const preferredChatMode: ChatMode =
            deriveChatModeFromMessages(preferredMessages)
            ?? liveChatModeRef.current;
          setBackend(preferredBackend);
          setChatMode(preferredChatMode);
          liveBackendRef.current = preferredBackend;
          liveChatModeRef.current = preferredChatMode;
          initialBackendSetRef.current = preferredState.conversationBackend === "openclaw";
        }
        setConversationId(preferredState.conversationId);
        setConversationBackend(preferredState.conversationBackend);
        setArtifactProvenance(preferredState.artifactProvenance);
        setCrossChannelMessages(
          preferredMessages.filter((message) => message.channel && message.channel !== "web"),
        );
      })();
    }
  }, [projectName]);

  useEffect(() => {
    workspaceWatchRevisionRef.current = null;
    workspaceWatchAvailableRef.current = false;
  }, [projectName]);

  useEffect(() => {
    const storageKey = getChatStorageKey(projectName);
    if (hydratedChatKeyRef.current !== storageKey) {
      return;
    }
    persistChat(projectName, messages, conversationId, conversationBackend, artifactProvenance);
    if (persistTimerRef.current) {
      clearTimeout(persistTimerRef.current);
    }
    persistTimerRef.current = setTimeout(() => {
      void persistChatToServer(
        projectName,
        messages,
        conversationId,
        conversationBackend,
        artifactProvenance,
      );
    }, 150);
  }, [artifactProvenance, conversationBackend, conversationId, messages, projectName]);

  useEffect(() => {
    const storageKey = getChatStorageKey(projectName);
    unloadPersistedRef.current = false;

    const flushChatThread = () => {
      if (hydratedChatKeyRef.current !== storageKey) {
        return;
      }
      if (unloadPersistedRef.current) {
        return;
      }
      unloadPersistedRef.current = true;
      // Route changes can interrupt the delayed server sync. Persist the live
      // thread to local storage first so a return to the project always
      // rehydrates from the newest in-memory state.
      persistChat(
        projectName,
        liveMessagesRef.current,
        liveConversationIdRef.current,
        liveConversationBackendRef.current,
        liveArtifactProvenanceRef.current,
      );
      void persistChatToServer(
        projectName,
        liveMessagesRef.current,
        liveConversationIdRef.current,
        liveConversationBackendRef.current,
        liveArtifactProvenanceRef.current,
        true,
      );
    };

    const resetUnloadFlag = () => {
      unloadPersistedRef.current = false;
    };

    window.addEventListener("pagehide", flushChatThread);
    window.addEventListener("pageshow", resetUnloadFlag);
    return () => {
      window.removeEventListener("pagehide", flushChatThread);
      window.removeEventListener("pageshow", resetUnloadFlag);
      flushChatThread();
    };
  }, [projectName]);

  useEffect(() => {
    return () => {
      if (persistTimerRef.current) {
        clearTimeout(persistTimerRef.current);
      }
    };
  }, []);

  // Backend detection is now folded into the agent-connectivity effect
  // further down so we only fire a single /api/chat/unified?action=health
  // probe on mount instead of two concurrent ~3s WebSocket handshakes.

  const applyWorkspaceTree = useCallback((nextTree: WorkspaceTreeNode[]): boolean => {
    const nextSignature = workspaceTreeSignature(nextTree);
    const changed = nextSignature !== workspaceTreeSignatureRef.current;

    if (changed) {
      workspaceTreeSignatureRef.current = nextSignature;
      setWorkspaceTree(nextTree);
    }

    return changed;
  }, []);

  const fetchWorkspaceTree = useCallback(async (signal?: AbortSignal) => {
    const safeProjectId = safeSlugOrNull(projectName);
    if (!safeProjectId) {
      return applyWorkspaceTree([]);
    }

    try {
      const params = new URLSearchParams({ action: "tree" });
      params.set("projectId", safeProjectId);
      const res = await fetch(`/api/workspace?${params}`, { signal });
      const data = await res.json().catch(() => ({}));
      if (signal?.aborted) {
        return false;
      }

      if (typeof data.watchRevision === "string" && data.watchRevision.length > 0) {
        workspaceWatchRevisionRef.current = data.watchRevision;
        workspaceWatchAvailableRef.current = true;
      }

      if (!Array.isArray(data.tree)) {
        return false;
      }

      return applyWorkspaceTree(data.tree as WorkspaceTreeNode[]);
    } catch {
      return false;
    }
  }, [applyWorkspaceTree, projectName]);

  const syncWorkspaceTreeAfterChat = useCallback(async () => {
    await fetchWorkspaceTree();
  }, [fetchWorkspaceTree]);

  // ── Cross-channel polling (only when openclaw backend is active) ──
  useEffect(() => {
    if (backend !== "openclaw") {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      return;
    }

    // Previously the initial backend was "direct", so this effect skipped
    // its first pass until the health probe flipped the backend to
    // "openclaw". Now that "openclaw" is the only Backend value, the effect
    // would otherwise fire on the very first render — before the hydration
    // effect sets conversationId — and register a setInterval whose closure
    // captures a null scopedConversationId. Gate registration on hydration
    // having committed so the captured closure sees the restored ids.
    if (!hasHydratedChat) {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      return;
    }

    pollTimerRef.current = setInterval(async () => {
      // Only poll when tab is visible
      if (document.hidden) return;

      try {
        const params = new URLSearchParams({
          action: "poll",
          since: lastPollRef.current,
        });
        const safeProjectId = safeSlugOrNull(projectName);
        if (safeProjectId) params.set("projectId", safeProjectId);
        if (scopedConversationId) params.set("conversationId", scopedConversationId);
        if (!safeProjectId && !scopedConversationId) return;

        const res = await fetch(`/api/chat/unified?${params}`);
        const data = await res.json();
        let polledMessages: Message[] = [];

        if (Array.isArray(data.messages) && data.messages.length > 0) {
          polledMessages = data.messages
            .filter((message: PolledOpenClawMessage) =>
              typeof message.content === "string"
              && typeof message.timestamp === "string"
              && !Number.isNaN(Date.parse(message.timestamp)),
            )
            .map((message: PolledOpenClawMessage) => {
              const role = inferPolledMessageRole(message);
              return {
                id: typeof message.id === "string" ? message.id : makeId(),
                role,
                content:
                  role === "user"
                    ? (message.content as string)
                    : sanitizeOpenClawUserVisibleResponse(
                      message.content as string,
                    ),
                chatMode: "openclaw-tools" as const,
                channel: typeof message.channel === "string" ? message.channel : undefined,
                userName: typeof message.userName === "string" ? message.userName : undefined,
                timestamp: new Date(message.timestamp as string),
              };
            });

          const crossChannelMessages = polledMessages.filter(
            (message: Message) => message.channel && message.channel !== "web",
          );

          if (crossChannelMessages.length > 0) {
            setCrossChannelMessages((prev) => {
              const existingIds = new Set(prev.map((m) => m.id));
              const unique = crossChannelMessages.filter(
                (m: Message) => !existingIds.has(m.id)
              );
              return [...prev, ...unique];
            });
          }

          setMessages((prev) => {
            const existingIds = new Set(prev.map((m) => m.id));
            const unique = polledMessages.filter(
              (message: Message) =>
                !existingIds.has(message.id)
                && !isLikelyDuplicatePolledUserMessage(prev, message),
            );
            return unique.length > 0 ? [...prev, ...unique] : prev;
          });

          // Advance cursor to the latest returned message timestamp
          // to avoid dropping messages due to clock skew
          const latestTimestamp = latestTimestampCursor(lastPollRef.current, data.messages as PolledOpenClawMessage[]);
          lastPollRef.current = latestTimestamp;
        }

        if (Array.isArray(data.generatedFiles) && data.generatedFiles.length > 0) {
          recordGeneratedArtifacts(data.generatedFiles as string[]);
          const latestUserPrompt = [...liveMessagesRef.current]
            .reverse()
            .find((message) => message.role === "user" && message.channel === "web")
            ?.content ?? "";
          const promptSourceFiles = Array.from(
            new Set([
              ...extractPromptSourceFiles(latestUserPrompt),
              ...liveUploadedFilesRef.current
                .map(getUploadedFileReference)
                .filter((value) => value.length > 0),
            ]),
          );
          const fallbackCreatedAt = polledMessages.at(-1)?.timestamp.toISOString() ?? new Date().toISOString();
          const generatedArtifacts = Array.isArray(data.generatedArtifacts)
            ? normalizeArtifactProvenanceEntries(data.generatedArtifacts)
            : [];
          const nextArtifacts = generatedArtifacts.length > 0
            ? generatedArtifacts.map((artifact) => ({
              ...artifact,
              prompt: artifact.prompt || latestUserPrompt,
              sourceFiles:
                artifact.sourceFiles.length > 0
                  ? artifact.sourceFiles
                  : promptSourceFiles,
            }))
            : buildFallbackArtifactProvenance(
              data.generatedFiles as string[],
              latestUserPrompt,
              promptSourceFiles,
              "OpenClaw CLI",
              fallbackCreatedAt,
            );
          setArtifactProvenance((prev) => mergeArtifactProvenanceEntries(prev, nextArtifacts));
          await syncWorkspaceTreeAfterChat();
        }
      } catch {
        // Polling is best-effort
      }
    }, 5000);

    return () => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [backend, hasHydratedChat, projectName, recordGeneratedArtifacts, scopedConversationId, syncWorkspaceTreeAfterChat]);

  const isSendContextCurrent = useCallback(
    (context: SendContext): boolean =>
      projectVersionRef.current === context.projectVersion
      && liveProjectNameRef.current === context.projectName
      && liveChatModeRef.current === context.chatMode
      && userBackendOverrideVersionRef.current === context.userBackendOverrideVersion,
    [],
  );

  const isSendProjectCurrent = useCallback(
    (context: SendContext): boolean =>
      projectVersionRef.current === context.projectVersion
      && liveProjectNameRef.current === context.projectName,
    [],
  );

  // ── Unified send path ──
  // ── SSE stream consumer ──
  const consumeSSEStream = useCallback(async (
    res: Response,
    assistantId: string,
    context: SendContext,
    requestContent: string,
    requestFiles: UploadedFile[],
  ) => {
    const reader = res.body?.getReader();
    if (!reader) throw new Error("No response stream");

    const decoder = new TextDecoder();
    let buffer = "";
    let streamDone = false;
    // When the WS gateway streams progress events, the assistant content is
    // built up incrementally from text deltas + tool/lifecycle progress
    // lines. The final `text` payload then carries the complete response, so
    // we replace the streamed scratchpad with the canonical text. Without
    // any progress (CLI fallback path), we keep the existing append-only
    // semantics so older tests / clients keep working.
    let sawProgressEvent = false;

    while (!streamDone) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6);
          if (data === "[DONE]") {
            streamDone = true;
            break;
          }

          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(data) as Record<string, unknown>;
          } catch {
            /* skip malformed SSE chunks */
            continue;
          }

          if (typeof parsed.error === "string" && parsed.error.trim().length > 0) {
            await reader.cancel().catch(() => undefined);
            throw new Error(parsed.error);
          }

          // Handle gateway WebSocket progress events — intermediate agent
          // activity forwarded as { progress: { type, method, payload } }.
          // The CLI fallback never emits these, so older clients keep the
          // existing append-only behaviour below.
          if (
            parsed.progress
            && typeof parsed.progress === "object"
            && !Array.isArray(parsed.progress)
            && isSendContextCurrent(context)
          ) {
            const progress = parsed.progress as {
              type?: string;
              method?: string;
              payload?: {
                stream?: string;
                data?: {
                  text?: string;
                  delta?: string;
                  phase?: string;
                  name?: string;
                  toolCallId?: string;
                  args?: string;
                  input?: unknown;
                  output?: string;
                };
                text?: string;
                content?: string;
                message?: string;
              };
            };
            sawProgressEvent = true;
            const progressUpdate = extractOpenClawProgressUpdate(progress);
            if (
              progressUpdate.thinking
              || progressUpdate.assistantText
              || progressUpdate.activityLines.length > 0
              || progressUpdate.progressEntries.length > 0
            ) {
              applyMessagesUpdate((prev) =>
                prev.map((m) =>
                  m.id === assistantId
                    ? {
                        ...m,
                        thinking: progressUpdate.thinking
                          ? mergeStreamingText(m.thinking, progressUpdate.thinking)
                          : m.thinking,
                        content: progressUpdate.assistantText
                          ? mergeStreamingText(m.content, progressUpdate.assistantText)
                          : m.content,
                        activityLog: progressUpdate.activityLines.length > 0
                          ? appendActivityLog(m.activityLog, progressUpdate.activityLines)
                          : m.activityLog,
                        progressLog: progressUpdate.progressEntries.length > 0
                          ? appendProgressLog(m.progressLog, progressUpdate.progressEntries)
                          : m.progressLog,
                      }
                    : m,
                ),
              );
            }
          }

          const taskPhases = restoreTaskPhases(parsed.taskPhases);
          if (taskPhases && isSendContextCurrent(context)) {
            applyMessagesUpdate((prev) =>
              prev.map((m) =>
                m.id === assistantId
                  ? { ...m, taskPhases }
                  : m
              )
            );
          }

          const generatedFiles = Array.isArray(parsed.generatedFiles)
            ? parsed.generatedFiles.filter((entry: unknown): entry is string => typeof entry === "string")
            : [];
          if (generatedFiles.length > 0 && isSendContextCurrent(context)) {
            recordGeneratedArtifacts(generatedFiles);
            const promptSourceFiles = Array.from(
              new Set([
                ...extractPromptSourceFiles(requestContent),
                ...requestFiles
                  .map(getUploadedFileReference)
                  .filter((value) => value.length > 0),
              ]),
            );
            const generatedArtifacts = Array.isArray(parsed.generatedArtifacts)
              ? normalizeArtifactProvenanceEntries(parsed.generatedArtifacts)
              : [];
            const nextArtifacts = generatedArtifacts.length > 0
              ? generatedArtifacts
              : buildFallbackArtifactProvenance(
                generatedFiles,
                requestContent,
                promptSourceFiles,
                "OpenClaw CLI",
                new Date().toISOString(),
              );
            setArtifactProvenance((prev) => mergeArtifactProvenanceEntries(prev, nextArtifacts));
          }

          if (
            isSendContextCurrent(context)
            && (
              (typeof parsed.text === "string" && parsed.text.length > 0)
              || (typeof parsed.thinking === "string" && parsed.thinking.length > 0)
            )
          ) {
            const finalText =
              typeof parsed.text === "string" && parsed.text.length > 0
                ? sanitizeOpenClawUserVisibleResponse(parsed.text, {
                    trimEnd: false,
                  })
                : null;
            const nextThinking =
              typeof parsed.thinking === "string" && parsed.thinking.length > 0
                ? sanitizeOpenClawUserVisibleResponse(parsed.thinking, {
                    trimEnd: false,
                  })
                : null;
            const replaceThinking = parsed.replaceThinking === true;
            applyMessagesUpdate((prev) =>
              prev.map((m) =>
                m.id === assistantId
                  ? {
                      ...m,
                      content:
                        finalText !== null
                          ? sawProgressEvent
                            // The WS gateway has been streaming deltas + tool
                            // progress into m.content; replace the scratchpad
                            // with the canonical sanitized response.
                            ? finalText
                            : m.content + finalText
                          : m.content,
                      thinking:
                        nextThinking !== null && nextThinking.length > 0
                          ? replaceThinking
                            ? nextThinking
                            : (m.thinking || "") + nextThinking
                          : m.thinking,
                      progressLog:
                        nextThinking !== null && nextThinking.length > 0
                          ? appendProgressLog(
                            m.progressLog,
                            buildThinkingProgressDeltaEntries(
                              m.thinking,
                              nextThinking,
                              replaceThinking,
                            ),
                          )
                          : m.progressLog,
                    }
                  : m
              )
            );
          }

          if (typeof parsed.conversationId === "string" && parsed.conversationId.trim().length > 0 && isSendContextCurrent(context)) {
            liveConversationIdRef.current = parsed.conversationId;
            liveConversationBackendRef.current = context.backend;
            setConversationId(parsed.conversationId);
            setConversationBackend(context.backend);
          }
        }
      }
    }
  }, [applyMessagesUpdate, isSendContextCurrent, recordGeneratedArtifacts, setArtifactProvenance]);

  const sendViaUnifiedChat = useCallback(
    async (
      content: string,
      assistantId: string,
      context: SendContext,
      activeConversationId: string | null,
      historyMessages: Message[],
      activeFile?: ActiveFileContext,
    ) => {
      const baseHistory = historyMessages
        .filter((m) => m.role !== "system")
        .filter((m) => m.content !== QUEUED_ASSISTANT_CONTENT)
        .filter((m) => !(m.role === "assistant" && m.content.trim().length === 0))
        .map((m) => ({ role: m.role, content: m.content }));
      const useLocalDirectOptimizations =
        localProviderActiveRef.current && isLocalDirectContext(context);
      const chatHistory = useLocalDirectOptimizations
        ? trimLocalChatHistory(baseHistory)
        : baseHistory;
      const requestFiles = useLocalDirectOptimizations
        ? selectExplicitRequestFiles(
          content,
          liveUploadedFilesRef.current,
        )
        : liveUploadedFilesRef.current;
      const requestActiveFile = useLocalDirectOptimizations
        ? shouldAttachActiveFileContext(content, activeFile)
          ? activeFile
          : undefined
        : activeFile;

      if (!chatHistory.some((message) => message.role === "user" && message.content === content)) {
        chatHistory.push({ role: "user", content });
      }

      const requestBody = JSON.stringify({
        message: content,
        messages: chatHistory,
        backend: context.backend,
        mode: context.chatMode,
        files: requestFiles,
        ...(hasProjectScope(projectName) ? { projectId: projectName } : {}),
        conversationId: activeConversationId,
        streamPhases: true,
        ...(requestActiveFile ? { activeFile: requestActiveFile } : {}),
      });
      const sendChatRequest = (url: string, timeoutMs?: number) => {
        const init: RequestInit = {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: requestBody,
        };
        return typeof timeoutMs === "number"
          ? fetchWithTimeout(url, init, timeoutMs)
          : fetch(url, init);
      };

      let res: Response;
      if (looksLikeSlashCommandInput(content)) {
        res = await sendChatRequest("/api/chat/command", SLASH_COMMAND_START_TIMEOUT_MS);
      } else {
        res = await sendChatRequest("/api/chat/unified");
      }

      const contentType = res.headers.get("content-type") || "";
      const backendHeader = res.headers.get("X-Chat-Backend");
      const modeHeader = normalizeChatMode(res.headers.get("X-Chat-Mode"));

      if (contentType.includes("text/event-stream")) {
        const responseBackend = mapResponseBackend(backendHeader) ?? context.backend;
        await consumeSSEStream(res, assistantId, context, content, requestFiles);
        if (isSendProjectCurrent(context)) {
          liveBackendRef.current = responseBackend;
          setBackend(responseBackend);
          await syncWorkspaceTreeAfterChat();
        }
        return;
      }

      if (!res.ok) {
        const contentType = res.headers.get("content-type") || "";
        if (contentType.includes("application/json")) {
          const payload = await res.json().catch(() => null) as { error?: string } | null;
          const errorMessage =
            typeof payload?.error === "string" && payload.error.trim().length > 0
              ? normalizeProjectChatError(payload.error, context.projectName)
              : null;
          throw new Error(
            errorMessage ?? `Unified chat error: ${res.status}`,
          );
        }
        throw new Error((await res.text()) || `Unified chat error: ${res.status}`);
      }

      const data = await res.json();
      if (typeof data.response !== "string" || data.response.trim().length === 0) {
        throw new Error("OpenClaw returned an empty response. Check the agent logs.");
      }
      if (!isSendContextCurrent(context)) {
        return;
      }
      const responseMode = normalizeChatMode(data.mode) ?? modeHeader ?? context.chatMode;
      const responseBackend = mapResponseBackend(backendHeader) ?? context.backend;

      // Update assistant message with response
      applyMessagesUpdate((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? {
                ...m,
                content: sanitizeOpenClawUserVisibleResponse(data.response),
                thinking:
                  typeof data.thinking === "string"
                    ? sanitizeOpenClawUserVisibleResponse(data.thinking)
                    : m.thinking,
                chatMode: responseMode,
              }
            : m
        )
      );
      liveBackendRef.current = responseBackend;
      setBackend(responseBackend);

      if (data.conversationId) {
        liveConversationIdRef.current = data.conversationId;
        liveConversationBackendRef.current = responseBackend;
        setConversationId(data.conversationId);
        setConversationBackend(responseBackend);
      }

      const generatedFiles = Array.isArray(data.generatedFiles)
        ? data.generatedFiles.filter((entry: unknown): entry is string => typeof entry === "string")
        : [];
      const gbrainArtifacts = Array.isArray(data.gbrainArtifacts)
        ? data.gbrainArtifacts.filter((entry: unknown): entry is string => typeof entry === "string")
        : [];
      dispatchGbrainArtifactsUpdated(projectName, gbrainArtifacts);
      if (generatedFiles.length > 0) {
        recordGeneratedArtifacts(generatedFiles);
        const promptSourceFiles = Array.from(
          new Set([
            ...extractPromptSourceFiles(content),
            ...requestFiles
              .map(getUploadedFileReference)
              .filter((value) => value.length > 0),
          ]),
        );
        const generatedArtifacts = Array.isArray(data.generatedArtifacts)
          ? normalizeArtifactProvenanceEntries(data.generatedArtifacts)
          : [];
        const nextArtifacts = generatedArtifacts.length > 0
          ? generatedArtifacts
          : buildFallbackArtifactProvenance(
            generatedFiles,
            content,
            promptSourceFiles,
            "OpenClaw CLI",
            new Date().toISOString(),
          );
        setArtifactProvenance((prev) => mergeArtifactProvenanceEntries(prev, nextArtifacts));
      }

      // Process cross-channel messages
      if (data.messages && data.messages.length > 0) {
        const crossMsgs: Message[] = data.messages.map(
          (m: {
            id: string;
            role: string;
            content: string;
            channel: string;
            userName?: string;
            timestamp: string;
          }) => ({
            id: m.id || makeId(),
            role: m.role as "user" | "assistant",
            content: m.content,
            channel: m.channel,
            userName: m.userName,
            timestamp: new Date(m.timestamp),
            chatMode: responseMode,
          })
        );
        setCrossChannelMessages((prev) => {
          const existingIds = new Set(prev.map((msg) => msg.id));
          const unique = crossMsgs.filter(
            (msg: Message) => !existingIds.has(msg.id)
          );
          return [...prev, ...unique];
        });
      }

      if (isSendProjectCurrent(context)) {
        await syncWorkspaceTreeAfterChat();
      }
    },
    [
      consumeSSEStream,
      applyMessagesUpdate,
      isSendContextCurrent,
      isSendProjectCurrent,
      projectName,
      recordGeneratedArtifacts,
      setArtifactProvenance,
      syncWorkspaceTreeAfterChat,
    ]
  );

  // Single mount-effect that handles runtime detection off the same
  // /api/chat/unified?action=health response. Previously we ran two
  // parallel effects, each firing its own ~3s WebSocket handshake probe
  // on mount — halving the cold-start cost.
  useEffect(() => {
    async function probe() {
      try {
        const res = await fetch("/api/chat/unified?action=health");
        const data = await res.json() as Record<string, unknown>;

        const agentRecord =
          data.agent && typeof data.agent === "object"
            ? data.agent as { type?: unknown; status?: unknown }
            : null;
        const agentType = typeof agentRecord?.type === "string" ? agentRecord.type : null;
        const agentOk = agentRecord?.status === "connected";
        // Legacy-field fallback for older servers that don't return the
        // `agent` object yet.
        const legacyOpenClawOk = data.openclaw === "connected";
        const openClawReady = (agentType === "openclaw" && agentOk) || legacyOpenClawOk;
        localProviderActiveRef.current = false;

        // Chat always routes through OpenClaw. OpenClaw itself may delegate
        // to OpenHands or a local model internally, but that is not the
        // hook's concern — the hook only cares whether OpenClaw is reachable.
        const initialBackend: Backend = "openclaw";

        // Only seed the active backend on the very first probe. After
        // that we preserve whichever path the current thread last used.
        if (!initialBackendSetRef.current) {
          setBackend(initialBackend);
          liveBackendRef.current = initialBackend;
          initialBackendSetRef.current = true;
        }

        setOpenClawConnected(openClawReady);
      } catch {
        localProviderActiveRef.current = false;
        setOpenClawConnected(false);
      }
    }
    probe();
    const interval = setInterval(probe, 15_000);
    return () => clearInterval(interval);
  }, []);

  const drainSendQueue = useCallback(async () => {
    if (sendQueueProcessingRef.current) {
      return;
    }

    sendQueueProcessingRef.current = true;
    setIsStreaming(true);

    try {
      while (sendQueueRef.current.length > 0) {
        const queued = sendQueueRef.current.shift()!;
        if (!isSendProjectCurrent(queued.context)) {
          queued.resolve();
          continue;
        }

        applyMessagesUpdate((prev) =>
          prev.map((message) =>
            message.id === queued.assistantId
              ? { ...message, content: "" }
              : message,
          ),
        );

        try {
          const shouldReuseOpenClawConversation =
            queued.context.chatMode === "openclaw-tools" ||
            shouldForceOpenClawToolExecution(queued.content);
          const activeConversationId = shouldReuseOpenClawConversation
            ? getScopedConversationId(
              liveConversationIdRef.current,
              liveConversationBackendRef.current,
              "openclaw",
            )
            : null;
          const historyMessages = buildQueuedHistory(liveMessagesRef.current, queued.assistantId);

          await sendViaUnifiedChat(
            queued.content,
            queued.assistantId,
            queued.context,
            activeConversationId,
            historyMessages,
            queued.activeFile,
          );
        } catch (err) {
          if (err instanceof Error && err.name === "AbortError") {
            // A newer project/backend context superseded this request.
          } else if (isSendContextCurrent(queued.context)) {
            setError(
              err instanceof Error
                ? err.message
                : "OpenClaw and OpenHands are both unavailable. Run ./start.sh",
            );
          }
        } finally {
          if (isSendProjectCurrent(queued.context)) {
            applyMessagesUpdate((prev) => removeEmptyAssistantPlaceholder(prev, queued.assistantId));
          }
          queued.resolve();
        }
      }
    } finally {
      sendQueueProcessingRef.current = false;
      setIsStreaming(false);
    }
  }, [
    applyMessagesUpdate,
    isSendContextCurrent,
    isSendProjectCurrent,
    sendViaUnifiedChat,
  ]);

  // ── Unified send ──
  const sendMessageFn = useCallback(
    (content: string, activeFile?: ActiveFileContext): Promise<void> => {
      const requestContent = content.trim();
      if (!requestContent) return Promise.resolve();

      if (openClawConnected === false) {
        setError("OpenClaw is not reachable. Start it in Settings.");
        return Promise.resolve();
      }
      const requestedBackend: Backend = "openclaw";

      const userMsg: Message = {
        id: makeId(),
        role: "user",
        content: requestContent,
        timestamp: new Date(),
        chatMode,
        channel: "web",
      };
      const assistantId = makeId();
      const assistantMsg: Message = {
        id: assistantId,
        role: "assistant",
        content: sendQueueProcessingRef.current || sendQueueRef.current.length > 0
          ? QUEUED_ASSISTANT_CONTENT
          : "",
        timestamp: new Date(),
        chatMode,
      };
      const context: SendContext = {
        backend: requestedBackend,
        chatMode,
        projectName,
        projectVersion: projectVersionRef.current,
        userBackendOverrideVersion: userBackendOverrideVersionRef.current,
      };

      liveBackendRef.current = requestedBackend;
      liveChatModeRef.current = chatMode;
      setBackend(requestedBackend);
      applyMessagesUpdate((prev) => [...prev, userMsg, assistantMsg]);
      setError(null);

      const completion = new Promise<void>((resolve) => {
        const queued: QueuedSend = {
          content: requestContent,
          assistantId,
          context,
          resolve,
        };
        if (activeFile) {
          queued.activeFile = activeFile;
        }
        sendQueueRef.current.push(queued);
      });

      void drainSendQueue();
      return completion;
    },
    [
      applyMessagesUpdate,
      chatMode,
      drainSendQueue,
      openClawConnected,
      projectName,
    ]
  );

  // ── Workspace operations ──

  const refreshWorkspace = useCallback(async (signal?: AbortSignal) => {
    await fetchWorkspaceTree(signal);
  }, [fetchWorkspaceTree]);

  const checkChanges = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await fetch("/api/workspace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal,
        body: JSON.stringify({ action: "check-changes", projectId: safeSlugOrNull(projectName) }),
      });
      const data = await res.json();
      if (signal?.aborted) return false;
      const added = Array.isArray(data.added) ? data.added : [];
      const updated = Array.isArray(data.updated) ? data.updated : [];
      const missing = Array.isArray(data.missing) ? data.missing : [];
      const changed = Array.isArray(data.changed) ? data.changed : [];
      const hasChanges =
        added.length > 0 || updated.length > 0 || missing.length > 0 || changed.length > 0;

      if (added.length > 0) {
        recordGeneratedArtifacts(
          added
            .map((file: { workspacePath?: string }) => file.workspacePath)
            .filter((workspacePath: string | undefined): workspacePath is string => typeof workspacePath === "string"),
        );
      }

      // Refresh tree to reflect change indicators
      await refreshWorkspace(signal);
      return hasChanges;
    } catch {
      // Best effort
      return false;
    }
  }, [projectName, recordGeneratedArtifacts, refreshWorkspace]);

  // Fetch workspace tree on mount
  useEffect(() => {
    refreshWorkspace();
  }, [refreshWorkspace]);

  useEffect(() => {
    const safeProjectId = safeSlugOrNull(projectName);
    if (!safeProjectId) {
      return;
    }

    let disposed = false;
    let inFlight = false;
    const tick = async () => {
      if (disposed || document.hidden || inFlight) {
        return;
      }

      inFlight = true;
      try {
        const params = new URLSearchParams({ action: "watch", projectId: safeProjectId });
        const previousRevision = workspaceWatchRevisionRef.current;
        if (previousRevision) {
          params.set("since", previousRevision);
        }

        const res = await fetch(`/api/workspace?${params}`);
        const data = await res.json().catch(() => ({}));
        if (disposed || document.hidden) {
          return;
        }

        if (typeof data.revision !== "string" || data.revision.length === 0) {
          return;
        }

        workspaceWatchAvailableRef.current = true;
        workspaceWatchRevisionRef.current = data.revision;

        const changed = data.changed === true || (
          previousRevision !== null && previousRevision !== data.revision
        );
        if (changed) {
          await refreshWorkspace();
        }
      } catch {
        // Keep the slower tree poll active if the watch probe is unavailable.
      } finally {
        inFlight = false;
      }
    };

    const intervalId = window.setInterval(() => {
      void tick();
    }, WORKSPACE_WATCH_POLL_MS);
    const handleVisibilityChange = () => {
      if (!document.hidden) {
        void tick();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      disposed = true;
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [projectName, refreshWorkspace]);

  useEffect(() => {
    const safeProjectId = safeSlugOrNull(projectName);
    if (!safeProjectId) {
      return;
    }

    let disposed = false;
    let inFlight = false;
    const tick = async () => {
      if (disposed || document.hidden || inFlight || workspaceWatchAvailableRef.current) {
        return;
      }
      inFlight = true;
      try {
        await refreshWorkspace();
      } finally {
        inFlight = false;
      }
    };

    const intervalId = window.setInterval(() => {
      void tick();
    }, WORKSPACE_TREE_REFRESH_MS);
    const handleVisibilityChange = () => {
      if (!document.hidden) {
        void tick();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      disposed = true;
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [projectName, refreshWorkspace]);

  // ── File upload ──
  const handleFiles = useCallback(
    async (files: File[]) => {
      setMessages((prev) => [
        ...prev,
        { id: makeId(), role: "system", content: `Importing ${files.length} file${files.length !== 1 ? "s" : ""}...`, timestamp: new Date() },
      ]);

      const organized: Array<{ name: string; folder: string; size: string; type: string }> = [];
      let workspaceAvailable = false;

      const safeProjectId = safeSlugOrNull(projectName);
      const failures: Array<{ name: string; code: string; message: string }> = [];
      for (const file of files) {
        let uploadedBrainSlug: string | undefined;
        let uploadedSource: UploadedFile["source"] = "workspace";
        try {
          // Canonical audit-revise ingest route: writes a typed gbrain page
          // (paper/dataset/code) AND dual-writes the original bytes to the
          // workspace directory so the existing FileTree keeps rendering.
          const formData = new FormData();
          formData.append("files", file);
          if (safeProjectId) formData.append("projectId", safeProjectId);
          const res = await fetch("/api/workspace/upload", {
            method: "POST",
            body: formData,
          });
          const payload = (await res.json().catch(() => null)) as
            | {
                slugs?: Array<{ slug: string; type: string }>;
                errors?: Array<{ filename?: string; code?: string; message?: string }>;
                error?: string;
              }
            | null;
          if (res.ok && payload?.slugs && payload.slugs.length > 0) {
            workspaceAvailable = true;
            const entry = payload.slugs[0];
            uploadedBrainSlug = entry?.slug;
            uploadedSource = "gbrain";
            organized.push({
              name: file.name,
              folder: folderLabelForIngestType(entry?.type),
              size: formatFileSize(file.size),
              type: entry?.type || file.name.split(".").pop() || "file",
            });
          } else {
            // Route returned a failure for this file — either a converter
            // error (200 with `errors[]`) or a request-level 4xx/5xx. Show
            // the upstream message so the user knows WHY the file was
            // rejected instead of seeing a misleading "organized" summary.
            const upstreamError =
              payload?.errors?.find((err) => err.filename === file.name)
                ?.message ??
              payload?.errors?.[0]?.message ??
              payload?.error ??
              `upload failed with status ${res.status}`;
            const upstreamCode =
              payload?.errors?.find((err) => err.filename === file.name)
                ?.code ?? "upload_failed";
            failures.push({
              name: file.name,
              code: upstreamCode,
              message: upstreamError,
            });
            organized.push({
              name: file.name,
              folder: "error",
              size: formatFileSize(file.size),
              type: file.name.split(".").pop() || "file",
            });
          }
        } catch (err) {
          failures.push({
            name: file.name,
            code: "network_error",
            message: err instanceof Error ? err.message : "network error",
          });
          organized.push({
            name: file.name,
            folder: "error",
            size: formatFileSize(file.size),
            type: file.name.split(".").pop() || "file",
          });
        }

        const latestOrganized = organized.at(-1);
        const displayPath = latestOrganized?.name
          ? `${latestOrganized.folder || "other"}/${latestOrganized.name}`
          : file.name;
        // Track in uploaded files (lightweight, no full content)
        setUploadedFiles((prev) => [
          ...prev,
          {
            name: file.name,
            size: formatFileSize(file.size),
            type: file.name.split(".").pop() || "file",
            folder: latestOrganized?.folder || "other",
            workspacePath: uploadedBrainSlug ? `gbrain:${uploadedBrainSlug}` : displayPath,
            source: uploadedSource,
            brainSlug: uploadedBrainSlug,
            displayPath,
          },
        ]);
      }

      // Show brief summary in chat (not full content). Failures are always
      // surfaced as a separate paragraph so a single image-only PDF never
      // looks like a successful ingest.
      const successes = organized.filter((entry) => entry.folder !== "error");
      const byFolder = successes.reduce<Record<string, string[]>>((acc, f) => {
        (acc[f.folder] = acc[f.folder] || []).push(f.name);
        return acc;
      }, {});

      const summary = Object.entries(byFolder)
        .map(([folder, names]) => `  **${folder}/** — ${names.join(", ")}`)
        .join("\n");

      const lines: string[] = [];
      if (successes.length > 0) {
        lines.push(
          `📂 ${successes.length} file${successes.length !== 1 ? "s" : ""} organized:`,
          summary,
        );
        if (workspaceAvailable) {
          lines.push("Companion .md files created with metadata.");
        } else {
          lines.push("Files tracked in memory (workspace API unavailable).");
        }
      }
      if (failures.length > 0) {
        lines.push(
          `⚠️ ${failures.length} file${failures.length !== 1 ? "s" : ""} failed to ingest:`,
          ...failures.map(
            (failure) => `  - **${failure.name}**: ${failure.message}`,
          ),
        );
      }
      if (lines.length === 0) {
        lines.push("No files were imported.");
      } else if (successes.length > 0) {
        lines.push("Ask me about any file.");
      }

      setMessages((prev) => [
        ...prev,
        {
          id: makeId(),
          role: "system",
          content: lines.join("\n"),
          timestamp: new Date(),
        },
      ]);
    },
    [projectName]
  );

  const addWorkspaceFileToChatContext = useCallback((file: WorkspaceChatContextFile) => {
    const workspacePath = file.path.trim().replace(/^\/+/, "");
    const brainSlug =
      typeof file.brainSlug === "string" && file.brainSlug.trim().length > 0
        ? file.brainSlug.trim()
        : workspacePath.startsWith("gbrain:")
          ? workspacePath.slice("gbrain:".length)
          : "";
    if (!workspacePath && !brainSlug) {
      return false;
    }
    if (file.source === "gbrain" && !brainSlug) {
      return false;
    }

    const isGbrain = brainSlug.length > 0;
    const dedupeKey = isGbrain ? `gbrain:${brainSlug}`.toLowerCase() : workspacePath.toLowerCase();
    const alreadyPresent = liveUploadedFilesRef.current.some((entry) => {
      return getUploadedFileReference(entry).replace(/^\/+/, "").toLowerCase() === dedupeKey;
    });

    if (alreadyPresent) {
      return false;
    }

    const name = file.name?.trim() || getBasename(workspacePath || brainSlug);
    const extension = name.includes(".") ? (name.split(".").pop() || "file") : "file";
    const nextFile: UploadedFile = isGbrain
      ? {
          name,
          size: "gbrain page",
          type: extension,
          folder: "Brain",
          source: "gbrain",
          brainSlug,
          workspacePath: `gbrain:${brainSlug}`,
          displayPath: file.displayPath || `gbrain:${brainSlug}`,
        }
      : {
          name,
          size: "workspace file",
          type: extension,
          folder: getFolderLabel(workspacePath),
          source: "workspace",
          workspacePath,
          displayPath: file.displayPath || workspacePath,
        };

    setUploadedFiles((prev) => {
      const next = [...prev, nextFile];
      liveUploadedFilesRef.current = next;
      return next;
    });
    return true;
  }, []);

  const removeFileFromChatContext = useCallback((pathOrName: string) => {
    const dedupeKey = pathOrName.trim().replace(/^\/+/, "").toLowerCase();
    if (!dedupeKey) return;

    setUploadedFiles((prev) => {
      const next = prev.filter((entry) => {
        const candidate = (entry.workspacePath || entry.name || "").trim().replace(/^\/+/, "");
        return candidate.toLowerCase() !== dedupeKey;
      });
      liveUploadedFilesRef.current = next;
      return next;
    });
  }, []);

  const clearChatContext = useCallback(() => {
    liveUploadedFilesRef.current = [];
    setUploadedFiles([]);
  }, []);

  // Exposed setBackend wrapper: any caller outside this hook is treated as
  // an explicit user override, which invalidates in-flight sends so responses
  // from the old backend don't race in after the user switched away.
  const setBackendExternal = useCallback<React.Dispatch<React.SetStateAction<Backend>>>(
    (value) => {
      userBackendOverrideVersionRef.current += 1;
      setBackend(value);
    },
    [],
  );

  return {
    messages,
    setMessages,
    sendMessage: sendMessageFn,
    isStreaming,
    error,
    setError,
    backend,
    setBackend: setBackendExternal,
    chatMode,
    setChatMode,
    crossChannelMessages,
    uploadedFiles,
    workspaceTree,
    generatedArtifacts,
    handleFiles,
    addWorkspaceFileToChatContext,
    removeFileFromChatContext,
    clearChatContext,
    refreshWorkspace,
    checkChanges,
    recordGeneratedArtifacts,
    clearGeneratedArtifacts: () => setGeneratedArtifacts([]),
    clearError: () => setError(null),
    conversationId,
    openClawConnected,
    artifactProvenance,
  };
}
