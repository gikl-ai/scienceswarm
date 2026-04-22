import { useEffect, useReducer, useRef, useState } from "react";
import { Check, CopySimple, WarningCircle } from "@phosphor-icons/react";
import type {
  ChatTaskPhase,
  MessageProgressEntry,
} from "@/hooks/use-unified-chat";
import { StepCards, type Step } from "@/components/research/step-cards";
import { TaskPhaseRail } from "@/components/research/task-phase-rail";
import { Spinner } from "@/components/spinner";

// ── Channel badges ─────────────────────────────────────────────

const CHANNEL_BADGES: Record<string, { icon: string; label: string; color: string }> = {
  web: { icon: "\u{1F310}", label: "Web", color: "bg-blue-50 text-blue-700 border-blue-200" },
  telegram: { icon: "\u{1F4F1}", label: "Telegram", color: "bg-sky-50 text-sky-700 border-sky-200" },
  slack: { icon: "\u{1F4AC}", label: "Slack", color: "bg-purple-50 text-purple-700 border-purple-200" },
  whatsapp: { icon: "\u{1F4F2}", label: "WhatsApp", color: "bg-green-50 text-green-700 border-green-200" },
  discord: { icon: "\u{1F3AE}", label: "Discord", color: "bg-indigo-50 text-indigo-700 border-indigo-200" },
};

// ── Props ──────────────────────────────────────────────────────

export interface ChatMessageProps {
  role: "user" | "assistant" | "system";
  content: string;
  thinking?: string;
  activityLog?: string[];
  progressLog?: MessageProgressEntry[];
  chatMode?: "reasoning" | "openclaw-tools";
  channel?: string;
  userName?: string;
  timestamp: Date;
  isStreaming?: boolean;
  taskPhases?: ChatTaskPhase[];
  steps?: Step[];
  /** Project ID for workspace media URLs — avoids SSR window.location access. */
  projectId?: string;
}

// ── Helpers ───────────────────────────────────────────────────

/** Only allow same-origin or workspace-relative image URLs. */
function isSafeImageUrl(url: string): boolean {
  // Reject protocol-relative URLs ("//host/path") — browsers resolve those
  // against the current origin's scheme and load external content.
  if (url.startsWith("//")) {
    return false;
  }
  // Only accept explicit same-origin root paths and ./-relative paths.
  // Reject ../ and bare relative paths so assistant content cannot walk
  // the current page URL into unintended same-origin API requests.
  if (url.startsWith("/") || url.startsWith("./")) {
    return true;
  }
  // Block bare relative paths and absolute external URLs.
  try {
    void new URL(url);
    return false;
  } catch {
    return false;
  }
}

/**
 * Cap iframe height so an assistant-controlled value cannot force the embed
 * to cover the entire viewport. Accepts a small set of CSS length units and
 * clamps the numeric portion; everything else falls back to the default.
 */
function sanitizeEmbedHeight(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  // Allow integer or decimal value followed by px, vh, em, or rem.
  const match = value.match(/^(\d+(?:\.\d+)?)(px|vh|em|rem)$/);
  if (!match) return fallback;
  const n = Number.parseFloat(match[1]);
  const unit = match[2];
  if (!Number.isFinite(n) || n <= 0) return fallback;
  // Clamp to limits per unit so the iframe cannot exceed the viewport.
  const max =
    unit === "vh" ? 100
    : unit === "px" ? 2000
    : /* em / rem */ 200;
  const clamped = Math.min(n, max);
  return `${clamped}${unit}`;
}

function getVideoMimeType(ext: string): string | undefined {
  switch (ext) {
    case "mp4":
    case "m4v":
      return "video/mp4";
    case "webm":
      return "video/webm";
    case "mov":
      return "video/quicktime";
    default:
      return undefined;
  }
}

function getAudioMimeType(ext: string): string | undefined {
  switch (ext) {
    case "mp3":
      return "audio/mpeg";
    case "wav":
      return "audio/wav";
    case "ogg":
      return "audio/ogg";
    case "m4a":
      return "audio/mp4";
    case "flac":
      return "audio/flac";
    case "opus":
      return "audio/ogg; codecs=opus";
    case "aac":
      return "audio/aac";
    default:
      return undefined;
  }
}

function findLastSavedHtmlFilename(value: string): string | undefined {
  const matches = value.matchAll(/[`']([^`']+\.html?)[`']/g);
  let fileName: string | undefined;
  for (const match of matches) {
    fileName = match[1];
  }
  return fileName;
}

function buildFallbackProgressLog(
  thinking: string | undefined,
  activityLog: string[] | undefined,
): MessageProgressEntry[] {
  const entries: MessageProgressEntry[] = [];

  if (typeof thinking === "string" && thinking.trim().length > 0) {
    for (const line of thinking.split(/\n+/).map((value) => value.trim()).filter(Boolean)) {
      entries.push({ kind: "thinking", text: line });
    }
  }

  if (Array.isArray(activityLog)) {
    for (const line of activityLog.map((value) => value.trim()).filter(Boolean)) {
      entries.push({ kind: "activity", text: line });
    }
  }

  return entries;
}

type ProgressTranscriptBlock =
  | {
      type: "narrative";
      entry: MessageProgressEntry;
    }
  | {
      type: "explored";
      lines: string[];
    };

const EXPLORE_COMMAND_PREFIXES = [
  "Read ",
  "Write ",
  "Edit ",
  "Search ",
  "List ",
  "Run ",
  "Generate image ",
  "Update plan",
  "Use ",
  "Waited for background terminal",
  "Interacted with background terminal",
];

function isExploredCommand(text: string): boolean {
  return EXPLORE_COMMAND_PREFIXES.some((prefix) => text.startsWith(prefix));
}

function inferOpenClawDisplayWorkspacePath(value: string): string | null {
  const normalized = value.trim().replaceAll("\\", "/");
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

function formatProgressDisplayPath(value: string): string {
  const normalized = value.trim().replaceAll("\\", "/");
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

function normalizeProgressDisplayCommand(value: string, maxChars = 160): string {
  let normalized = value.trim().replaceAll("\\", "/").replace(/\s+/g, " ");
  normalized = normalized.replace(
    /(^|\s)(?:\/usr\/local\/Caskroom\/miniforge\/base\/bin\/python3|\/usr\/bin\/python3)(?=\s|$)/g,
    "$1python3",
  );
  normalized = normalized.replace(
    /\/(?:Users|home)\/[^/\s]+\/\.scienceswarm\/projects\/[^/\s]+\/[^\s"'`]+/g,
    (match) => formatProgressDisplayPath(match),
  );
  normalized = normalized.replace(
    /\/(?:Users|home)\/[^/\s]+\/(?:\.scienceswarm\/openclaw|\.openclaw)\/(?:media|canvas\/documents)\/[^\s"'`]+/g,
    (match) => formatProgressDisplayPath(match),
  );

  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars - 1)}…`;
}

function formatLegacyImageGenerateText(text: string): string | null {
  const filenameMatch = text.match(/"filename":"([^"]+)"/);
  const sizeMatch = text.match(/"size":"([^"]+)"/);
  const promptMatch = text.match(/"prompt":"([^"]+)"/);

  let label = filenameMatch?.[1] ? `Generate image ${filenameMatch[1]}` : "Generate image";
  if (sizeMatch?.[1]) {
    label += ` (${sizeMatch[1]})`;
  }
  if (!filenameMatch?.[1] && promptMatch?.[1]) {
    const prompt = promptMatch[1].replace(/\\"/g, "\"");
    label += `: ${prompt.length > 96 ? `${prompt.slice(0, 95)}…` : prompt}`;
  }
  return label;
}

function formatLegacyUseToolText(text: string): string | null {
  const trimmed = text.trim();

  const readPathMatch = trimmed.match(/^Use (?:read|read_file|open_file):\s*[\s\S]*"path":"([^"]+)"/i);
  if (readPathMatch?.[1]) {
    return `Read ${formatProgressDisplayPath(readPathMatch[1])}`;
  }

  const writePathMatch = trimmed.match(/^Use (?:write|write_file|create_file):\s*[\s\S]*"path":"([^"]+)"/i);
  if (writePathMatch?.[1]) {
    return `Write ${formatProgressDisplayPath(writePathMatch[1])}`;
  }

  const editPathMatch = trimmed.match(/^Use (?:edit|apply_patch|replace_in_file):\s*[\s\S]*"path":"([^"]+)"/i);
  if (editPathMatch?.[1]) {
    return `Edit ${formatProgressDisplayPath(editPathMatch[1])}`;
  }

  const searchPathMatch = trimmed.match(
    /^Use (?:search|grep|rg|search_code):\s*[\s\S]*"pattern":"([^"]+)"[\s\S]*"path":"([^"]+)"/i,
  );
  if (searchPathMatch?.[1] && searchPathMatch?.[2]) {
    return `Search ${searchPathMatch[1]} in ${formatProgressDisplayPath(searchPathMatch[2])}`;
  }

  const searchPatternMatch = trimmed.match(/^Use (?:search|grep|rg|search_code):\s*[\s\S]*"pattern":"([^"]+)"/i);
  if (searchPatternMatch?.[1]) {
    return `Search ${searchPatternMatch[1]}`;
  }

  const execCommandMatch = trimmed.match(/^Use (?:exec|exec_command|process):\s*[\s\S]*"cmd":"([^"]+)"/i);
  if (execCommandMatch?.[1]) {
    return `Run ${normalizeProgressDisplayCommand(execCommandMatch[1].replace(/\\"/g, "\""))}`;
  }

  const imageMatch = /^Use (?:image_generate|generate_image|image_generation|tool-image-generation): /i.test(trimmed);
  if (imageMatch) {
    return formatLegacyImageGenerateText(trimmed);
  }

  const planSteps = Array.from(trimmed.matchAll(/"step":"([^"]+)"/g))
    .map((match) => match[1])
    .filter(Boolean);
  if (/^Use update_plan:/i.test(trimmed) && planSteps.length > 0) {
    return `Plan: ${planSteps.join(" -> ")}`;
  }

  return trimmed;
}

function formatLegacyToolText(text: string): string | null {
  const trimmed = text.trim();

  const planSteps = Array.from(trimmed.matchAll(/"step":"([^"]+)"/g))
    .map((match) => match[1])
    .filter(Boolean);
  if (/^Tool update_plan(?::| result:)/i.test(trimmed) && planSteps.length > 0) {
    return `Plan: ${planSteps.join(" -> ")}`;
  }

  if (/^Tool [a-z0-9_-]+ result:/i.test(trimmed) && !/failed|error/i.test(trimmed)) {
    return null;
  }

  if (/^Tool [a-z0-9_-]+ finished$/i.test(trimmed)) {
    return null;
  }

  const readPathMatch = trimmed.match(/^Tool (?:read|read_file|open_file):\s*[\s\S]*"path":"([^"]+)"/i);
  if (readPathMatch?.[1]) {
    return `Read ${formatProgressDisplayPath(readPathMatch[1])}`;
  }

  const writePathMatch = trimmed.match(/^Tool (?:write|write_file|create_file):\s*[\s\S]*"path":"([^"]+)"/i);
  if (writePathMatch?.[1]) {
    return `Write ${formatProgressDisplayPath(writePathMatch[1])}`;
  }
  const writeSummaryMatch = trimmed.match(/^Tool (?:write|write_file|create_file):\s+(.+)$/i);
  if (writeSummaryMatch?.[1] && !writeSummaryMatch[1].trim().startsWith("{")) {
    return `Write ${formatProgressDisplayPath(writeSummaryMatch[1])}`;
  }

  const editPathMatch = trimmed.match(/^Tool (?:edit|apply_patch|replace_in_file):\s*[\s\S]*"path":"([^"]+)"/i);
  if (editPathMatch?.[1]) {
    return `Edit ${formatProgressDisplayPath(editPathMatch[1])}`;
  }
  const editSummaryMatch = trimmed.match(/^Tool (?:edit|apply_patch|replace_in_file):\s+(.+)$/i);
  if (editSummaryMatch?.[1] && !editSummaryMatch[1].trim().startsWith("{")) {
    return `Edit ${formatProgressDisplayPath(editSummaryMatch[1])}`;
  }

  const searchPathMatch = trimmed.match(
    /^Tool (?:search|grep|rg|search_code):\s*[\s\S]*"pattern":"([^"]+)"[\s\S]*"path":"([^"]+)"/i,
  );
  if (searchPathMatch?.[1] && searchPathMatch?.[2]) {
    return `Search ${searchPathMatch[1]} in ${formatProgressDisplayPath(searchPathMatch[2])}`;
  }

  const searchPatternMatch = trimmed.match(/^Tool (?:search|grep|rg|search_code):\s*[\s\S]*"pattern":"([^"]+)"/i);
  if (searchPatternMatch?.[1]) {
    return `Search ${searchPatternMatch[1]}`;
  }

  const execCommandMatch = trimmed.match(/^Tool (?:exec|exec_command|process):\s*[\s\S]*"cmd":"([^"]+)"/i);
  if (execCommandMatch?.[1]) {
    return `Run ${normalizeProgressDisplayCommand(execCommandMatch[1].replace(/\\"/g, "\""))}`;
  }
  const execSummaryMatch = trimmed.match(/^Tool (?:exec|exec_command|process):\s+(.+)$/i);
  if (execSummaryMatch?.[1] && !execSummaryMatch[1].trim().startsWith("{")) {
    return `Run ${normalizeProgressDisplayCommand(execSummaryMatch[1])}`;
  }

  if (/^Tool (?:image_generate|generate_image|image_generation|tool-image-generation): /i.test(trimmed)) {
    const legacyImageText = formatLegacyImageGenerateText(trimmed.replace(/^Tool [^:]+:\s*/i, "Use image_generate: "));
    if (legacyImageText) {
      return legacyImageText;
    }
    const imageSummaryMatch = trimmed.match(/^Tool (?:image_generate|generate_image|image_generation|tool-image-generation):\s+(.+)$/i);
    if (imageSummaryMatch?.[1]) {
      return `Generate image ${imageSummaryMatch[1]}`;
    }
  }

  return trimmed;
}

function normalizeMediaWorkspacePath(filePath: string): string {
  const normalized = filePath.trim().replaceAll("\\", "/");
  const openClawMediaMatch = normalized.match(/\/(?:\.scienceswarm\/openclaw|\.openclaw)\/media\/(.+)$/);
  if (openClawMediaMatch?.[1]) {
    return `__openclaw__/media/${openClawMediaMatch[1]}`;
  }
  return normalized;
}

function normalizeProgressTextForDisplay(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  if (
    trimmed === "Turn started" ||
    trimmed === "Turn finished" ||
    trimmed === "Run command" ||
    trimmed === "Run command complete" ||
    trimmed === "Use read complete" ||
    trimmed === "Use write complete" ||
    trimmed === "Use edit complete"
  ) {
    return null;
  }

  if (/^Tool /i.test(trimmed)) {
    return formatLegacyToolText(trimmed);
  }

  if (/^Use /i.test(trimmed)) {
    return formatLegacyUseToolText(trimmed);
  }

  if (trimmed.startsWith("Run ")) {
    return `Run ${normalizeProgressDisplayCommand(trimmed.slice(4))}`;
  }

  return trimmed;
}

function buildProgressTranscript(entries: MessageProgressEntry[]): ProgressTranscriptBlock[] {
  const blocks: ProgressTranscriptBlock[] = [];
  let exploredLines: string[] = [];

  const flushExploredLines = () => {
    if (exploredLines.length === 0) return;
    blocks.push({ type: "explored", lines: exploredLines });
    exploredLines = [];
  };

  for (const entry of entries) {
    const text = normalizeProgressTextForDisplay(entry.text);
    if (!text) continue;

    if (entry.kind === "activity" && isExploredCommand(text)) {
      exploredLines.push(text);
      continue;
    }

    flushExploredLines();
    blocks.push({
      type: "narrative",
      entry: { ...entry, text },
    });
  }

  flushExploredLines();
  return blocks;
}

function formatElapsedCompact(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);

  if (hours > 0) {
    return `${hours}h ${minutes.toString().padStart(2, "0")}m ${seconds.toString().padStart(2, "0")}s`;
  }

  if (minutes > 0) {
    return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
  }

  return `${seconds}s`;
}

function getProgressElapsedMs(timestamp: Date, isStreaming: boolean | undefined): number | null {
  if (!isStreaming) return null;

  const elapsedMs = Date.now() - timestamp.getTime();
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
    return 0;
  }

  // Streaming placeholders are created just before the first event arrives.
  // If a stale timestamp is replayed from test fixtures or restored history,
  // clamp the footer to 0s instead of showing a bogus multi-day timer.
  if (elapsedMs > 24 * 60 * 60 * 1000) {
    return 0;
  }

  return elapsedMs;
}

// ── Render markdown-lite ───────────────────────────────────────

function normalizeWorkspaceRelativePath(value: string): string | null {
  const normalized = value
    .trim()
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\\/g, "/");
  if (!normalized) {
    return null;
  }

  const segments: string[] = [];
  for (const segment of normalized.split("/")) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      return null;
    }
    segments.push(segment);
  }

  const collapsed = segments.join("/");
  if (!collapsed || collapsed === "." || collapsed === "..") {
    return null;
  }
  return collapsed;
}

function resolveEmbeddedRawPath(
  embedUrl: string,
  savedFileName: string | undefined,
): string | null {
  const documentPathMatch = embedUrl.match(/(?:^|\/)canvas\/documents\/([^?#]+)/);
  const rawDocumentPath = documentPathMatch?.[1];
  const normalizedDocumentPath =
    typeof rawDocumentPath === "string"
      ? normalizeWorkspaceRelativePath(rawDocumentPath)
      : null;

  if (typeof rawDocumentPath === "string") {
    if (!normalizedDocumentPath) {
      return null;
    }
    const basename = normalizedDocumentPath.split("/").pop() || normalizedDocumentPath;
    if (/\.[a-z0-9]+$/i.test(basename)) {
      return `__openclaw__/canvas/documents/${normalizedDocumentPath}`;
    }
    return `__openclaw__/canvas/documents/${normalizedDocumentPath}.html`;
  }

  return savedFileName ?? "index.html";
}

function parseEmbedDirective(part: string): {
  url?: string;
  title?: string;
  height?: string;
} | null {
  if (!/^\[embed\b/i.test(part)) {
    return null;
  }

  const attributes = Array.from(
    part.matchAll(/(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s\]]+))/g),
  );
  if (attributes.length === 0) {
    return {};
  }

  const values: Record<string, string> = {};
  for (const match of attributes) {
    const key = match[1]?.toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    if (key) {
      values[key] = value;
    }
  }

  return {
    url: values.url,
    title: values.title,
    height: values.height,
  };
}

function renderInlineMarkdownLite(value: string, keyPrefix: string) {
  return value.split(/(\*\*[^*]+\*\*)/g).map((part, index) =>
    part.startsWith("**") && part.endsWith("**") ? (
      <strong key={`${keyPrefix}-bold-${index}`} className="font-semibold">
        {part.slice(2, -2)}
      </strong>
    ) : (
      <span key={`${keyPrefix}-text-${index}`}>{part}</span>
    ),
  );
}

function getCopyableMessageText(root: HTMLDivElement | null, fallback: string): string {
  const renderedText =
    typeof root?.innerText === "string" && root.innerText.trim().length > 0
      ? root.innerText
      : root?.textContent ?? "";
  const normalizedRenderedText = renderedText
    .replace(/\u00a0/g, " ")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (normalizedRenderedText) {
    return normalizedRenderedText;
  }

  return fallback
    .replace(/!\[[^\]]*]\([^)]+\)/g, "")
    .replace(/\[embed[^\]]*]/gi, "")
    .replace(/^MEDIA:[^\n]+$/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function renderContent(content: string, projectId: string) {
  // Split on bold markers, MEDIA references, embed tags, and markdown images
  const parts = content.split(/(\*\*[^*]+\*\*|MEDIA:[^\s\n]+|\[embed[^\]]*\]|!\[[^\]]*\]\([^)]+\))/gi);
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return (
        <strong key={i} className="font-semibold">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.startsWith("MEDIA:")) {
      const filePath = part.slice(6).trim();
      const workspaceFilePath = normalizeMediaWorkspacePath(filePath);
      const ext = workspaceFilePath.split(".").pop()?.toLowerCase() || "";
      const src = `/api/workspace?action=raw&file=${encodeURIComponent(workspaceFilePath)}&projectId=${encodeURIComponent(projectId)}`;
      if (["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) {
        return (
          <div key={i} className="my-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={src} alt={filePath} className="max-w-full max-h-[50vh] rounded-lg border border-border" />
            <span className="block text-[10px] text-muted mt-1 font-mono">{filePath}</span>
          </div>
        );
      }
      if (ext === "html" || ext === "htm") {
        return (
          <div key={i} className="my-2">
            <iframe
              src={src}
              title={filePath}
              className="w-full min-w-0 h-[80vh] min-h-[700px] rounded-lg border border-border bg-white"
              sandbox="allow-scripts"
            />
            <span className="block text-[10px] text-muted mt-1 font-mono">{filePath}</span>
          </div>
        );
      }
      if (ext === "svg") {
        // SVG rendered as <img> to prevent script execution
        return (
          <div key={i} className="my-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={src} alt={filePath} className="max-w-full max-h-[50vh] rounded-lg border border-border" />
            <span className="block text-[10px] text-muted mt-1 font-mono">{filePath}</span>
          </div>
        );
      }
      if (["mp4", "webm", "mov", "m4v"].includes(ext)) {
        return (
          <div key={i} className="my-2">
            <video controls className="max-w-full max-h-[50vh] rounded-lg border border-border bg-black">
              <source src={src} type={getVideoMimeType(ext)} />
            </video>
            <span className="block text-[10px] text-muted mt-1 font-mono">{filePath}</span>
          </div>
        );
      }
      if (["mp3", "wav", "ogg", "m4a", "flac", "opus", "aac"].includes(ext)) {
        return (
          <div key={i} className="my-2">
            <audio controls className="w-full">
              <source src={src} type={getAudioMimeType(ext)} />
            </audio>
            <span className="block text-[10px] text-muted mt-1 font-mono">{filePath}</span>
          </div>
        );
      }
      return <span key={i} className="font-mono text-xs text-accent underline">{filePath}</span>;
    }
    const embedDirective = parseEmbedDirective(part);
    if (embedDirective) {
      if (embedDirective.url) {
        let embedUrl = embedDirective.url;
        // OpenClaw canvas/internal URLs need proxying through workspace API
        if (embedUrl.includes("__openclaw__") || embedUrl.includes("canvas/documents")) {
          // Find the most recent saved HTML filename anywhere earlier in the
          // message so later embeds can still inherit it after intervening text.
          const savedFileName = findLastSavedHtmlFilename(parts.slice(0, i).join(""));
          const fileName = resolveEmbeddedRawPath(embedUrl, savedFileName);
          if (!fileName) {
            return (
              <div key={i} className="my-2">
                <span className="font-mono text-xs text-muted">[embed blocked: invalid path]</span>
              </div>
            );
          }
          embedUrl = `/api/workspace?action=raw&file=${encodeURIComponent(fileName)}&projectId=${encodeURIComponent(projectId)}`;
        } else {
          const workspaceHtmlPath = normalizeWorkspaceRelativePath(embedUrl);
          if (workspaceHtmlPath && /\.html?$/i.test(workspaceHtmlPath)) {
            embedUrl = `/api/workspace?action=raw&file=${encodeURIComponent(workspaceHtmlPath)}&projectId=${encodeURIComponent(projectId)}`;
          } else if (/\.html?$/i.test(embedUrl)) {
            return (
              <div key={i} className="my-2">
                <span className="font-mono text-xs text-muted">[embed blocked: invalid path]</span>
              </div>
            );
          } else {
            // Strip every leading slash and re-add a single one so protocol-
            // relative URLs ("//external.host/...") collapse to a same-origin
            // path instead of loading third-party content into the iframe.
            embedUrl = `/${embedUrl.replace(/^\/+/, "")}`;
          }
        }
        const embedTitle = embedDirective.title ?? "Embedded content";
        const embedHeight = sanitizeEmbedHeight(embedDirective.height, "60vh");
        return (
          <div key={i} className="my-2">
            <iframe
              src={embedUrl}
              title={embedTitle}
              className="w-full min-w-0 min-h-[700px] rounded-lg border border-border bg-white"
              style={{ height: embedHeight }}
              sandbox="allow-scripts"
            />
            <span className="block text-[10px] text-muted mt-1 font-mono">{embedTitle}</span>
          </div>
        );
      }
      return null;
    }
    if (part.startsWith("![")) {
      const match = part.match(/!\[([^\]]*)\]\(([^)]+)\)/);
      if (match && isSafeImageUrl(match[2])) {
        return (
          <div key={i} className="my-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={match[2]} alt={match[1]} className="max-w-full max-h-[50vh] rounded-lg border border-border" />
          </div>
        );
      }
      if (match) {
        // Unsafe external URL — render as text link instead
        return (
          <div key={i} className="my-2">
            <span className="font-mono text-xs text-muted">[image: {match[1] || match[2]}]</span>
          </div>
        );
      }
    }
    return <span key={i}>{renderInlineMarkdownLite(part, `content-${i}`)}</span>;
  });
}

// ── Component ──────────────────────────────────────────────────

export function ChatMessage({
  role,
  content,
  activityLog,
  progressLog,
  chatMode,
  channel,
  userName,
  timestamp,
  isStreaming,
  taskPhases,
  steps,
  projectId = "",
}: ChatMessageProps) {
  const [, bumpElapsedTick] = useReducer((value: number) => value + 1, 0);

  useEffect(() => {
    if (!isStreaming) {
      return undefined;
    }

    const timerId = window.setInterval(() => {
      bumpElapsedTick();
    }, 1000);

    return () => {
      window.clearInterval(timerId);
    };
  }, [isStreaming, timestamp]);

  const badge = channel ? CHANNEL_BADGES[channel] : undefined;
  const isCrossChannel = channel && channel !== "web";
  const visibleTaskPhases =
    role === "assistant" && Array.isArray(taskPhases) && taskPhases.length > 0
      ? taskPhases
      : [];
  const visibleActivityLog =
    role === "assistant" && Array.isArray(activityLog) && activityLog.length > 0
      ? activityLog
      : [];
  const visibleStreamProgressLog =
    role === "assistant" && isStreaming
      ? Array.isArray(progressLog) && progressLog.length > 0
        ? progressLog.filter((entry) => entry.kind === "activity")
        : buildFallbackProgressLog(undefined, visibleActivityLog)
      : [];
  const visibleProgressLog =
    role === "assistant"
      ? visibleStreamProgressLog
      : [];
  const progressTranscript = buildProgressTranscript(visibleProgressLog);
  const liveElapsedMs = getProgressElapsedMs(timestamp, isStreaming);
  const workingElapsed =
    liveElapsedMs === null ? null : formatElapsedCompact(liveElapsedMs);
  const isOpenClawToolsTurn = chatMode === "openclaw-tools" && role !== "system";
  const contentRef = useRef<HTMLDivElement | null>(null);
  const copyFeedbackTimerRef = useRef<number | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const hasCopyableText = content.trim().length > 0 && !isStreaming;
  const timestampText = `${timestamp.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  })} · ${timestamp.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  })}`;
  const footerTextClass = role === "user" ? "text-white/75" : "text-muted/55";
  const selectionClass = role === "user"
    ? "selection:bg-white/45 selection:text-slate-900"
    : "selection:bg-accent/25 selection:text-slate-900";
  const CopyStatusIcon =
    copyState === "copied"
      ? Check
      : copyState === "error"
        ? WarningCircle
        : CopySimple;
  const copyButtonLabel =
    copyState === "copied"
      ? "Copied message"
      : copyState === "error"
        ? "Copy failed"
        : "Copy message";
  const copyButtonClass =
    role === "user"
      ? copyState === "copied"
        ? "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-white/25 bg-white/15 text-white transition-colors hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/45"
        : copyState === "error"
          ? "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-white/25 bg-white/15 text-rose-100 transition-colors hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/45"
          : "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-transparent text-white/70 transition-colors hover:border-white/20 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/45"
      : copyState === "copied"
        ? "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-emerald-200 bg-emerald-50 text-emerald-700 transition-colors hover:bg-emerald-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/30"
        : copyState === "error"
          ? "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-rose-200 bg-rose-50 text-rose-700 transition-colors hover:bg-rose-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/30"
          : "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-transparent text-muted/65 transition-colors hover:border-border hover:bg-slate-50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30";

  useEffect(() => () => {
    if (copyFeedbackTimerRef.current !== null) {
      window.clearTimeout(copyFeedbackTimerRef.current);
    }
  }, []);

  const scheduleCopyFeedbackReset = () => {
    if (copyFeedbackTimerRef.current !== null) {
      window.clearTimeout(copyFeedbackTimerRef.current);
    }
    copyFeedbackTimerRef.current = window.setTimeout(() => {
      setCopyState("idle");
    }, 2000);
  };

  const copyToClipboard = async () => {
    const nextClipboardText = getCopyableMessageText(contentRef.current, content);
    const clipboard = navigator.clipboard;
    if (!clipboard?.writeText || nextClipboardText.length === 0) {
      console.warn("ChatMessage copy failed: clipboard API unavailable or no visible text.");
      setCopyState("error");
      scheduleCopyFeedbackReset();
      return;
    }
    try {
      await clipboard.writeText(nextClipboardText);
      setCopyState("copied");
    } catch (error) {
      console.warn("ChatMessage copy failed.", error);
      setCopyState("error");
    }
    scheduleCopyFeedbackReset();
  };

  return (
    <div
      className={`flex ${role === "user" ? "justify-end" : "justify-start"}`}
    >
      <div
        data-testid="chat-bubble"
        data-chat-selectable={role === "user" ? "true" : undefined}
        className={`${
          role === "user" ? "max-w-2xl" : "w-full max-w-[min(92vw,72rem)]"
        } rounded-xl px-5 py-4 text-sm leading-relaxed shadow-sm select-text cursor-text ${
          role === "user"
            ? isOpenClawToolsTurn
              ? "bg-green-600 text-white border-2 border-green-600"
              : "bg-accent text-white border-2 border-accent"
            : role === "system"
              ? "bg-white border-2 border-border text-muted text-xs font-mono"
              : isOpenClawToolsTurn
                ? "bg-green-50 border-2 border-green-200 text-foreground"
                : "bg-white border-2 border-border text-foreground"
        }`}
      >
        {isOpenClawToolsTurn && (
          <div className={`mb-2 inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] ${
            role === "user"
              ? "border-white/30 bg-white/10 text-white"
              : "border-green-200 bg-white text-green-800"
          }`}>
            Run with OpenClaw tools
          </div>
        )}

        {/* Channel badge + user name for cross-channel messages */}
        {isCrossChannel && badge && (
          <div className="flex items-center gap-2 mb-2">
            <span
              className={`inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded border ${badge.color}`}
            >
              <span>{badge.icon}</span>
              {badge.label}
            </span>
            {userName && (
              <span className="text-[10px] text-muted font-medium">
                {userName}
              </span>
            )}
            <span className="text-[10px] text-muted/50">via OpenClaw</span>
          </div>
        )}

        <TaskPhaseRail phases={visibleTaskPhases} className="mb-3" />

        {/* Agent step cards (above content; no-op when absent) */}
        {role === "assistant" && <StepCards steps={steps} />}

        {/* Streaming indicator */}
        {role === "assistant" && content === "" && isStreaming && visibleProgressLog.length === 0 && (
          <div className="flex items-center gap-2 text-accent/60">
            <Spinner size="h-4 w-4" testId="chat-streaming-spinner" />
            <span className="text-xs">Thinking…</span>
          </div>
        )}

        {visibleProgressLog.length > 0 && (
          <div
            aria-live="polite"
            className="mb-3 space-y-3 font-mono text-[13px] leading-6 text-foreground/95"
            role="log"
          >
            {progressTranscript.map((block, index) =>
              block.type === "explored" ? (
                <div key={`${index}-explored`} className="space-y-0.5">
                  <div className="whitespace-pre-wrap text-foreground">
                    • Explored
                  </div>
                  <div className="space-y-0.5 pl-6 text-muted">
                    {block.lines.map((line, lineIndex) => (
                      <div
                        key={`${index}-${lineIndex}-${line}`}
                        className="whitespace-pre-wrap"
                      >
                        {lineIndex === 0 ? `└ ${line}` : `  ${line}`}
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div
                  key={`${index}-${block.entry.kind}-${block.entry.text}`}
                  className={`whitespace-pre-wrap ${
                    block.entry.kind === "thinking" ? "text-foreground" : "text-muted"
                  }`}
                >
                  <span aria-hidden="true">• </span>
                  {renderInlineMarkdownLite(block.entry.text, `progress-${index}`)}
                </div>
              ),
            )}

            {workingElapsed && (
              <div className="whitespace-pre-wrap text-muted">
                {`• Working (${workingElapsed} • esc to interrupt)`}
              </div>
            )}
          </div>
        )}

        {/* Message content */}
        <div
          ref={contentRef}
          className={`whitespace-pre-wrap select-text ${selectionClass}`}
        >
          {renderContent(content, projectId)}
        </div>

        <div className="mt-3 flex items-center justify-end gap-3">
          {hasCopyableText && (
            <button
              type="button"
              onClick={copyToClipboard}
              className={copyButtonClass}
              aria-label={copyButtonLabel}
              title={copyButtonLabel}
            >
              <CopyStatusIcon size={18} weight="regular" aria-hidden="true" />
            </button>
          )}
          <div className={`text-[9px] ${footerTextClass}`}>{timestampText}</div>
        </div>
      </div>
    </div>
  );
}
