import { type ReactNode, useEffect, useReducer, useRef, useState } from "react";
import { Check, CopySimple, WarningCircle } from "@phosphor-icons/react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import type {
  ChatTaskPhase,
  MessageProgressEntry,
} from "@/hooks/use-unified-chat";
import { StepCards, type Step } from "@/components/research/step-cards";
import { TaskPhaseRail } from "@/components/research/task-phase-rail";
import { Spinner } from "@/components/spinner";

// ── Channel badges ─────────────────────────────────────────────

const CHANNEL_BADGES: Record<string, { icon: string; label: string; color: string }> = {
  web: { icon: "\u{1F310}", label: "Web", color: "bg-accent/10 text-accent border-accent/30" },
  telegram: { icon: "\u{1F4F1}", label: "Telegram", color: "bg-sunk text-body border-rule" },
  slack: { icon: "\u{1F4AC}", label: "Slack", color: "bg-sunk text-body border-rule" },
  whatsapp: { icon: "\u{1F4F2}", label: "WhatsApp", color: "bg-ok/10 text-ok border-ok/30" },
  discord: { icon: "\u{1F3AE}", label: "Discord", color: "bg-sunk text-body border-rule" },
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
      section: "thinking" | "activity";
    }
  | {
      type: "explored";
      stableKey: string;
      lines: string[];
      rawCount: number;
      section: "activity";
    };

const PROGRESS_SECTION_META: Record<
  "thinking" | "activity",
  {
    title: string;
    compactTitle: string;
    icon: string;
    className: string;
    rowClassName: string;
  }
> = {
  thinking: {
    title: "Thinking Trace",
    compactTitle: "Thinking",
    icon: "🧠",
    className: "border-rule bg-sunk text-body",
    rowClassName: "text-strong/90",
  },
  activity: {
    title: "OpenClaw Activity",
    compactTitle: "Activity",
    icon: "⚙️",
    className: "border-border bg-sunk text-muted",
    rowClassName: "text-muted",
  },
};

const EXPLORED_INLINE_LINE_LIMIT = 3;
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
const COMPACT_STEP_VERB_LABELS: Record<Step["verb"], string> = {
  reading: "Reading",
  searching: "Searching",
  drafting: "Drafting",
  running: "Running",
};
const LEGACY_HTML_EMBED_ALIASES: Record<string, string> = {
  "snake-game": "snake/index.html",
  "snake-webpage": "snake_game.html",
};
const ASSISTANT_BODY_TEXT_CLASS =
  "text-[15px] leading-7 tracking-[0.005em] text-body sm:text-base sm:leading-8";
const ASSISTANT_PARAGRAPH_CLASS = `mb-5 ${ASSISTANT_BODY_TEXT_CLASS}`;
const ASSISTANT_TITLE_CLASS =
  "mb-6 text-[2.25rem] leading-[0.98] font-semibold tracking-[-0.05em] text-strong sm:text-[2.6rem]";
const ASSISTANT_SUBTITLE_CLASS =
  "mt-10 mb-4 text-[1.7rem] leading-[1.08] font-semibold tracking-[-0.04em] text-strong first:mt-0 sm:text-[1.95rem]";
const ASSISTANT_SECTION_CLASS =
  "mt-8 mb-3 text-[1.18rem] leading-7 font-semibold tracking-[-0.02em] text-strong first:mt-0 sm:text-[1.24rem]";
const ASSISTANT_SUBSECTION_CLASS =
  "mt-6 mb-3 text-[1rem] leading-6 font-semibold tracking-[-0.01em] text-strong first:mt-0";
const ASSISTANT_LIST_CLASS =
  "mb-5 pl-6 text-[15px] leading-7 tracking-[0.005em] text-body sm:text-base sm:leading-8";
const ASSISTANT_LIST_ITEM_CLASS = "pl-2 [&>ol]:mt-3 [&>ul]:mt-3";
const ASSISTANT_CAPTION_CLASS = "mt-2 block text-[11px] leading-5 text-dim";
const ASSISTANT_METADATA_CLASS =
  "text-[10px] font-medium tracking-[0.02em] text-quiet";
const ASSISTANT_METADATA_CHIP_CLASS =
  "inline-flex items-center rounded-full bg-sunk/85 px-2.5 py-1 text-[10px] font-medium tracking-[0.015em] text-quiet";
const ASSISTANT_BLOCKQUOTE_CLASS =
  "my-6 rounded-r-2xl border-l-2 border-rule bg-sunk/75 px-4 py-3 italic text-body";
const ASSISTANT_LINK_CLASS =
  "font-medium text-accent underline decoration-accent/30 underline-offset-4 transition-colors hover:text-accent-dim hover:decoration-accent";
const ASSISTANT_INLINE_CODE_CLASS =
  "rounded-md border border-rule bg-sunk/90 px-1.5 py-0.5 font-mono text-[0.9em] font-medium text-strong";
const PROGRESS_INLINE_CODE_CLASS =
  "rounded border border-rule/70 bg-sunk/70 px-1 py-0.5 font-mono text-[0.85em] font-normal text-body";
const ASSISTANT_CODE_BLOCK_CLASS =
  "my-6 overflow-x-auto rounded-3xl border border-rule bg-ink px-5 py-4 text-[13px] leading-6 text-quiet shadow-[0_12px_30px_rgba(15,23,42,0.12)]";
const ASSISTANT_RULE_CLASS = "my-8 border-0 border-t border-rule";
const ASSISTANT_TABLE_WRAPPER_CLASS =
  "my-6 overflow-x-auto rounded-[1.35rem] border border-rule bg-raised shadow-[0_16px_36px_-24px_rgba(15,23,42,0.24)]";
const ASSISTANT_TABLE_CLASS =
  "min-w-full border-collapse text-left text-[14px] leading-6 text-body";
const ASSISTANT_TABLE_HEAD_CLASS = "bg-sunk/90 text-strong";
const ASSISTANT_TABLE_ROW_CLASS = "border-t border-rule first:border-t-0 even:bg-sunk/35";
const ASSISTANT_TABLE_HEADER_CELL_CLASS =
  "border-b border-rule px-4 py-3 text-[12px] font-semibold uppercase tracking-[0.08em] text-dim";
const ASSISTANT_TABLE_CELL_CLASS = "px-4 py-3 align-top";
const ASSISTANT_MEDIA_CARD_CLASS =
  "overflow-hidden rounded-[1.35rem] border border-rule/90 bg-raised shadow-[0_16px_36px_-24px_rgba(15,23,42,0.4)]";
const ASSISTANT_MEDIA_FRAME_CLASS =
  "block w-full max-h-[26rem] bg-sunk object-contain";

function sanitizeMarkdownHref(href: string | undefined): string | null {
  if (!href) {
    return null;
  }
  if (href.startsWith("#") || (href.startsWith("/") && !href.startsWith("//")) || href.startsWith("./")) {
    return href;
  }
  if (href.startsWith("../") || href.startsWith("//")) {
    return null;
  }

  try {
    const parsed = new URL(href);
    if (parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "mailto:") {
      return href;
    }
  } catch {
    return null;
  }

  return null;
}

const ASSISTANT_MARKDOWN_COMPONENTS: Components = {
  h1: ({ children }) => <h1 className={ASSISTANT_TITLE_CLASS}>{children}</h1>,
  h2: ({ children }) => <h2 className={ASSISTANT_SUBTITLE_CLASS}>{children}</h2>,
  h3: ({ children }) => <h3 className={ASSISTANT_SECTION_CLASS}>{children}</h3>,
  h4: ({ children }) => <h4 className={ASSISTANT_SUBSECTION_CLASS}>{children}</h4>,
  h5: ({ children }) => <h5 className={ASSISTANT_SUBSECTION_CLASS}>{children}</h5>,
  h6: ({ children }) => <h6 className={ASSISTANT_SUBSECTION_CLASS}>{children}</h6>,
  p: ({ children }) => <p className={ASSISTANT_PARAGRAPH_CLASS}>{children}</p>,
  ul: ({ children }) => (
    <ul className={`${ASSISTANT_LIST_CLASS} list-disc space-y-2.5 marker:text-quiet`}>{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className={`${ASSISTANT_LIST_CLASS} list-decimal space-y-2.5 marker:font-medium marker:text-dim`}>{children}</ol>
  ),
  li: ({ children }) => <li className={ASSISTANT_LIST_ITEM_CLASS}>{children}</li>,
  blockquote: ({ children }) => <blockquote className={ASSISTANT_BLOCKQUOTE_CLASS}>{children}</blockquote>,
  hr: () => <hr className={ASSISTANT_RULE_CLASS} />,
  table: ({ children }) => (
    <div className={ASSISTANT_TABLE_WRAPPER_CLASS}>
      <table className={ASSISTANT_TABLE_CLASS}>{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className={ASSISTANT_TABLE_HEAD_CLASS}>{children}</thead>,
  tr: ({ children }) => <tr className={ASSISTANT_TABLE_ROW_CLASS}>{children}</tr>,
  th: ({ children }) => <th className={ASSISTANT_TABLE_HEADER_CELL_CLASS}>{children}</th>,
  td: ({ children }) => <td className={ASSISTANT_TABLE_CELL_CLASS}>{children}</td>,
  pre: ({ children }) => <pre className={ASSISTANT_CODE_BLOCK_CLASS}>{children}</pre>,
  code: ({ className, children }) => {
    const languageClass = typeof className === "string" ? className : "";
    const isBlock =
      languageClass.length > 0
      || (typeof children === "string" && children.includes("\n"));
    if (isBlock) {
      return <code className="font-mono">{children}</code>;
    }
    return (
      <code className={ASSISTANT_INLINE_CODE_CLASS}>
        {children}
      </code>
    );
  },
  a: ({ href, children }) => {
    const safeHref = sanitizeMarkdownHref(href);
    if (!safeHref) {
      return <span className="text-quiet">{children}</span>;
    }
    const external = safeHref.startsWith("http://") || safeHref.startsWith("https://");
    return (
      <a
        href={safeHref}
        className={ASSISTANT_LINK_CLASS}
        target={external ? "_blank" : undefined}
        rel={external ? "noreferrer noopener" : undefined}
      >
        {children}
      </a>
    );
  },
  strong: ({ children }) => <strong className="font-semibold text-strong">{children}</strong>,
  em: ({ children }) => <em className="italic text-body">{children}</em>,
};

const PROGRESS_MARKDOWN_COMPONENTS: Components = {
  h1: ({ children }) => (
    <h1 className="mb-2 text-[14px] font-semibold leading-5 text-strong">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="mb-2 text-[14px] font-semibold leading-5 text-strong">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="mb-2 text-[13px] font-semibold leading-5 text-strong">
      {children}
    </h3>
  ),
  h4: ({ children }) => (
    <h4 className="mb-2 text-[13px] font-semibold leading-5 text-strong">
      {children}
    </h4>
  ),
  h5: ({ children }) => (
    <h5 className="mb-2 text-[13px] font-semibold leading-5 text-strong">
      {children}
    </h5>
  ),
  h6: ({ children }) => (
    <h6 className="mb-2 text-[13px] font-semibold leading-5 text-strong">
      {children}
    </h6>
  ),
  p: ({ children }) => <p className="m-0 text-inherit">{children}</p>,
  ul: ({ children }) => (
    <ul className="m-0 list-disc space-y-1.5 pl-4 text-inherit marker:text-quiet">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="m-0 list-decimal space-y-1.5 pl-4 text-inherit marker:text-dim">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="pl-1">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="m-0 border-l-2 border-rule pl-3 italic text-body">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-3 border-0 border-t border-rule" />,
  pre: ({ children }) => (
    <pre className="m-0 overflow-x-auto rounded-2xl border border-rule bg-ink px-4 py-3 text-[12px] leading-5 text-quiet">
      {children}
    </pre>
  ),
  code: ({ className, children }) => {
    const languageClass = typeof className === "string" ? className : "";
    const isBlock =
      languageClass.length > 0
      || (typeof children === "string" && children.includes("\n"));
    if (isBlock) {
      return <code className="font-mono">{children}</code>;
    }
    return (
      <code className={PROGRESS_INLINE_CODE_CLASS}>
        {children}
      </code>
    );
  },
  a: ASSISTANT_MARKDOWN_COMPONENTS.a,
  strong: ASSISTANT_MARKDOWN_COMPONENTS.strong,
  em: ASSISTANT_MARKDOWN_COMPONENTS.em,
};

type RenderedContentPart = {
  key: string;
  kind: "flow" | "gallery-item";
  node: ReactNode;
};

function collapseAssistantMediaGalleries(parts: RenderedContentPart[]): ReactNode[] {
  const collapsed: ReactNode[] = [];

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part || part.kind !== "gallery-item") {
      if (part) {
        collapsed.push(part.node);
      }
      continue;
    }

    const galleryItems: RenderedContentPart[] = [part];
    let cursor = index + 1;
    while (cursor < parts.length && parts[cursor]?.kind === "gallery-item") {
      galleryItems.push(parts[cursor]!);
      cursor += 1;
    }

    if (galleryItems.length === 1) {
      collapsed.push(part.node);
      continue;
    }

    collapsed.push(
      <div
        key={`assistant-gallery-${part.key}`}
        data-testid="assistant-media-gallery"
        className="my-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-3"
      >
        {galleryItems.map((galleryItem) => (
          <div key={galleryItem.key} className="min-w-0">
            {galleryItem.node}
          </div>
        ))}
      </div>,
    );

    index = cursor - 1;
  }

  return collapsed;
}

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
  const legacyHtmlAliasPath = resolveLegacyHtmlAliasPath(normalized);
  if (legacyHtmlAliasPath) {
    return legacyHtmlAliasPath;
  }
  return normalized;
}

function resolveLegacyHtmlAliasPath(value: string): string | null {
  const normalized = normalizeWorkspaceRelativePath(value);
  if (!normalized) {
    return null;
  }
  if (/\.[a-z0-9]+$/i.test(normalized)) {
    return null;
  }

  const aliasedPath = LEGACY_HTML_EMBED_ALIASES[normalized];
  if (aliasedPath) {
    return aliasedPath;
  }

  return normalizeWorkspaceRelativePath(`${normalized}/index.html`);
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
  const exploredBlockCounts = new Map<string, number>();

  const flushExploredLines = () => {
    if (exploredLines.length === 0) return;
    const coalescedLines = coalesceExploredLines(exploredLines);
    const firstLine = coalescedLines[0] ?? "explored";
    const occurrence = exploredBlockCounts.get(firstLine) ?? 0;
    exploredBlockCounts.set(firstLine, occurrence + 1);
    blocks.push({
      type: "explored",
      stableKey: `${firstLine}::${occurrence}`,
      lines: coalescedLines,
      rawCount: exploredLines.length,
      section: "activity",
    });
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
      section: entry.kind,
    });
  }

  flushExploredLines();
  return blocks;
}

function parseCoalescibleExploredLine(
  line: string,
): { verb: "Read" | "Write" | "Edit" | "List"; target: string } | null {
  const match = line.match(/^(Read|Write|Edit|List)\s+(.+)$/);
  if (!match?.[1] || !match[2]) {
    return null;
  }

  const verb = match[1] as "Read" | "Write" | "Edit" | "List";
  const target = match[2].trim();
  if (!target) {
    return null;
  }

  return { verb, target };
}

function coalesceExploredLines(lines: string[]): string[] {
  const grouped: string[] = [];
  let pending:
    | { verb: "Read" | "Write" | "Edit" | "List"; targets: string[] }
    | null = null;

  const flushPending = () => {
    if (!pending) {
      return;
    }
    grouped.push(
      pending.targets.length > 1
        ? `${pending.verb} ${pending.targets.join(" · ")}`
        : `${pending.verb} ${pending.targets[0]}`,
    );
    pending = null;
  };

  for (const line of lines) {
    const parsed = parseCoalescibleExploredLine(line);
    if (!parsed) {
      flushPending();
      grouped.push(line);
      continue;
    }

    if (pending && pending.verb === parsed.verb) {
      pending.targets.push(parsed.target);
      continue;
    }

    flushPending();
    pending = {
      verb: parsed.verb,
      targets: [parsed.target],
    };
  }

  flushPending();
  return grouped;
}

function summarizeCompactPhaseStatus(phases: ChatTaskPhase[]): string[] {
  if (phases.length === 0) {
    return [];
  }

  let activePhase: ChatTaskPhase | null = null;
  let failedPhase: ChatTaskPhase | null = null;
  let completedCount = 0;

  for (let index = phases.length - 1; index >= 0; index -= 1) {
    const phase = phases[index];
    if (phase.status === "active" && activePhase === null) {
      activePhase = phase;
    } else if (phase.status === "failed" && failedPhase === null) {
      failedPhase = phase;
    }
  }

  for (const phase of phases) {
    if (phase.status === "completed") {
      completedCount += 1;
    }
  }

  if (failedPhase) {
    return [`Failed: ${failedPhase.label}`];
  }
  if (activePhase) {
    return [`Phase: ${activePhase.label}`];
  }
  if (completedCount > 0) {
    return [`${completedCount}/${phases.length} phases complete`];
  }
  return [`${phases.length} phases queued`];
}

function summarizeCompactSteps(steps: Step[]): string[] {
  if (steps.length === 0) {
    return [];
  }

  let latestRunningOrErrorStep: Step | null = null;
  let doneCount = 0;

  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index];
    if (step.status === "done") {
      doneCount += 1;
      continue;
    }
    if (latestRunningOrErrorStep === null) {
      latestRunningOrErrorStep = step;
    }
  }

  if (latestRunningOrErrorStep) {
    const verbLabel = COMPACT_STEP_VERB_LABELS[latestRunningOrErrorStep.verb];
    const target = latestRunningOrErrorStep.target.trim();
    if (latestRunningOrErrorStep.status === "error") {
      return [`${verbLabel} ${target} failed`];
    }
    return [`${verbLabel} ${target}`];
  }

  if (doneCount > 0) {
    return [`${doneCount} step${doneCount === 1 ? "" : "s"} complete`];
  }

  return [];
}

function ExploredTranscriptBlock({
  blockIndex,
  lines,
  compact,
}: {
  blockIndex: number;
  lines: string[];
  compact: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const hiddenCount = Math.max(0, lines.length - EXPLORED_INLINE_LINE_LIMIT);
  const visibleLines =
    expanded || hiddenCount === 0
      ? lines
      : lines.slice(0, EXPLORED_INLINE_LINE_LIMIT);

  return (
    <div className={compact ? "space-y-1.5" : "space-y-1"}>
      <div className={`flex items-start gap-2 ${PROGRESS_SECTION_META.activity.rowClassName}`}>
        <span aria-hidden="true" className="pt-0.5 text-quiet">• </span>
        <span className="font-medium">Explored</span>
      </div>
      <div className={`${compact ? "space-y-1 pl-4" : "space-y-1 pl-5"} text-muted`}>
        {visibleLines.map((line, lineIndex) => (
          <div
            key={`${blockIndex}-${lineIndex}-${line}`}
            className="flex items-start gap-2 whitespace-pre-wrap"
          >
            <span aria-hidden="true" className="text-quiet">
              {lineIndex === 0 ? "└ " : "· "}
            </span>
            <span className="min-w-0 flex-1">
              {renderInlineMarkdownLite(
                line,
                `progress-explored-${blockIndex}-${lineIndex}`,
              )}
            </span>
          </div>
        ))}
        {hiddenCount > 0 && (
          <button
            type="button"
            data-testid={`assistant-explored-toggle-${blockIndex}`}
            className="inline-flex items-center gap-2 rounded-full border border-rule bg-raised px-2.5 py-1 text-[11px] font-medium text-body transition hover:bg-sunk"
            onClick={() => setExpanded((current) => !current)}
          >
            {expanded
              ? "Hide extra actions"
              : `Show ${hiddenCount} more action${hiddenCount === 1 ? "" : "s"}`}
          </button>
        )}
      </div>
    </div>
  );
}

function buildProgressSectionChanges(
  blocks: ProgressTranscriptBlock[],
  options: { compact?: boolean } = {},
): ReactNode[] {
  const compact = options.compact === true;
  const elements: ReactNode[] = [];
  let lastSection: "thinking" | "activity" | null = null;

  blocks.forEach((block, index) => {
    const nextSection = block.section;
    // Repeat labels on section switches so interleaved thinking/activity reads
    // like the live OpenClaw transcript order instead of two detached panels.
    if (nextSection !== lastSection) {
      const sectionMeta = PROGRESS_SECTION_META[nextSection];
      elements.push(
        compact ? (
          <div
            key={`section-${nextSection}-${index}`}
            className="text-[10px] font-semibold uppercase tracking-[0.14em] text-dim"
          >
            {sectionMeta.compactTitle}
          </div>
        ) : (
          <div
            key={`section-${nextSection}-${index}`}
            className={`mb-2 inline-flex w-fit items-center gap-2 rounded-full border px-2 py-0.5 text-[10px] font-semibold tracking-[0.1em] ${sectionMeta.className}`}
          >
            <span aria-hidden="true">{sectionMeta.icon}</span>
            <span>{sectionMeta.title}</span>
          </div>
        ),
      );
      lastSection = nextSection;
    }

    if (block.type === "explored") {
      elements.push(
        <ExploredTranscriptBlock
          key={block.stableKey}
          blockIndex={index}
          lines={block.lines}
          compact={compact}
        />,
      );
      return;
    }

    const rowClassName = PROGRESS_SECTION_META[block.section].rowClassName;
    const isMarkdownBlock = shouldRenderProgressMarkdownBlock(block.entry.text);
    elements.push(
      <div
        key={`${index}-${block.entry.kind}-${block.entry.text}`}
        className={`flex items-start gap-2 ${isMarkdownBlock ? "" : "whitespace-pre-wrap"} ${rowClassName}`}
      >
        <span
          aria-hidden="true"
          className={`text-quiet ${isMarkdownBlock ? "pt-1.5" : "pt-0.5"}`}
        >
          {isMarkdownBlock ? "↳ " : "• "}
        </span>
        {isMarkdownBlock
          ? renderProgressMarkdown(block.entry.text)
          : (
            <span className="min-w-0 flex-1">
              {renderInlineMarkdownLite(block.entry.text, `progress-${index}`)}
            </span>
          )}
      </div>,
    );
  });

  return elements;
}

function summarizeLatestRunStateDetail(blocks: ProgressTranscriptBlock[]): string | null {
  const compactDetail = (value: string): string | null => {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    if (shouldRenderProgressMarkdownBlock(trimmed) || trimmed.includes("\n")) {
      return null;
    }
    return trimmed;
  };

  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (block.type === "narrative") {
      const detail = compactDetail(block.entry.text);
      if (detail) {
        return detail;
      }
      continue;
    }
    if (block.lines.length > 0) {
      if (block.rawCount > 1) {
        return `Explored ${block.rawCount} actions`;
      }
      const detail = compactDetail(block.lines[block.lines.length - 1]);
      if (detail) {
        return detail;
      }
    }
  }

  return null;
}

function ActiveRunStateSurface({
  workingElapsed,
  summaries,
  detail,
}: {
  workingElapsed: string | null;
  summaries: string[];
  detail: string | null;
}) {
  return (
    <div
      data-testid="assistant-run-state"
      className="mb-3 rounded-xl border border-rule bg-sunk/70 px-3.5 py-3 text-[13px] leading-6 text-foreground/95"
    >
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-dim">
        <span className="inline-flex items-center gap-1.5 font-medium text-body">
          <Spinner size="h-3.5 w-3.5" testId="chat-streaming-spinner" />
          <span>{workingElapsed ? `Working (${workingElapsed} • esc to interrupt)` : "Working…"}</span>
        </span>
        {summaries.map((summary, index) => (
          <span
            key={`${summary}-${index}`}
            className="inline-flex items-center rounded-full border border-rule bg-raised px-2 py-0.5 text-[10px] font-medium text-body"
          >
            {summary}
          </span>
        ))}
      </div>
      {detail && (
        <div className="mt-2 text-[12px] leading-6 text-dim">
          {detail}
        </div>
      )}
    </div>
  );
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

function millisecondsUntilNextSecond(nowMs: number): number {
  const remainder = nowMs % 1000;
  return remainder === 0 ? 1000 : 1000 - remainder;
}

function useLiveSecondTick(enabled: boolean): void {
  const [, bumpElapsedTick] = useReducer((value: number) => value + 1, 0);

  useEffect(() => {
    if (!enabled) {
      return undefined;
    }

    let timeoutId: number | null = null;
    const scheduleNextTick = () => {
      timeoutId = window.setTimeout(() => {
        bumpElapsedTick();
        scheduleNextTick();
      }, millisecondsUntilNextSecond(Date.now()));
    };

    timeoutId = window.setTimeout(() => {
      bumpElapsedTick();
      scheduleNextTick();
    }, millisecondsUntilNextSecond(Date.now()));

    return () => {
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [enabled]);
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

function buildWorkspaceRawPreviewUrl(
  filePath: string,
  projectId: string,
  { preferPathRoute = false }: { preferPathRoute?: boolean } = {},
) : string | null {
  const normalizedPath = normalizeWorkspaceRelativePath(filePath);
  if (!normalizedPath) {
    return null;
  }
  if (preferPathRoute && projectId) {
    const encodedSegments = normalizedPath
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");
    return `/api/workspace/raw/${encodeURIComponent(projectId)}/${encodedSegments}`;
  }

  return `/api/workspace?action=raw&file=${encodeURIComponent(normalizedPath)}&projectId=${encodeURIComponent(projectId)}`;
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
  ref?: string;
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
    ref: values.ref,
    url: values.url,
    title: values.title,
    height: values.height,
  };
}

type InlineMarkdownToken = {
  type: "code" | "bold" | "italic" | "boldItalic";
  start: number;
  end: number;
  value: string;
};

function isInlineWhitespace(value: string | undefined): boolean {
  return typeof value === "string" && /\s/.test(value);
}

function findNextInlineMarkdownToken(value: string, fromIndex: number): InlineMarkdownToken | null {
  const emphasisMarkers = [
    { marker: "***", type: "boldItalic" as const },
    { marker: "**", type: "bold" as const },
    { marker: "*", type: "italic" as const },
  ];

  for (let index = fromIndex; index < value.length; index += 1) {
    if (value[index] === "`") {
      const closingIndex = value.indexOf("`", index + 1);
      if (closingIndex > index + 1) {
        return {
          type: "code",
          start: index,
          end: closingIndex + 1,
          value: value.slice(index + 1, closingIndex),
        };
      }
    }

    if (value[index] !== "*") {
      continue;
    }

    for (const { marker, type } of emphasisMarkers) {
      if (!value.startsWith(marker, index)) {
        continue;
      }

      const contentStart = index + marker.length;
      let closingIndex = value.indexOf(marker, contentStart);
      while (closingIndex !== -1) {
        const innerValue = value.slice(contentStart, closingIndex);
        if (
          innerValue.length > 0
          && !isInlineWhitespace(innerValue[0])
          && !isInlineWhitespace(innerValue[innerValue.length - 1])
        ) {
          return {
            type,
            start: index,
            end: closingIndex + marker.length,
            value: innerValue,
          };
        }
        closingIndex = value.indexOf(marker, closingIndex + marker.length);
      }

      break;
    }
  }

  return null;
}

function renderInlineMarkdownLite(value: string, keyPrefix: string) {
  const elements: ReactNode[] = [];
  let cursor = 0;
  let plainTextIndex = 0;
  let formattedIndex = 0;

  while (cursor < value.length) {
    const token = findNextInlineMarkdownToken(value, cursor);
    if (!token) {
      const remainingText = value.slice(cursor);
      if (remainingText) {
        elements.push(
          <span key={`${keyPrefix}-text-${plainTextIndex}`}>{remainingText}</span>,
        );
      }
      break;
    }

    if (token.start > cursor) {
      const plainText = value.slice(cursor, token.start);
      if (plainText) {
        elements.push(
          <span key={`${keyPrefix}-text-${plainTextIndex}`}>{plainText}</span>,
        );
        plainTextIndex += 1;
      }
    }

    const tokenKey = `${keyPrefix}-${token.type}-${formattedIndex}`;
    if (token.type === "code") {
      elements.push(
        <code
          key={tokenKey}
          className={ASSISTANT_INLINE_CODE_CLASS}
        >
          {token.value}
        </code>,
      );
    } else if (token.type === "bold") {
      elements.push(
        <strong key={tokenKey} className="font-semibold">
          {renderInlineMarkdownLite(token.value, `${tokenKey}-inner`)}
        </strong>,
      );
    } else if (token.type === "boldItalic") {
      elements.push(
        <strong key={tokenKey} className="font-semibold">
          <em className="italic">
            {renderInlineMarkdownLite(token.value, `${tokenKey}-inner`)}
          </em>
        </strong>
      );
    } else {
      elements.push(
        <em key={tokenKey} className="italic">
          {renderInlineMarkdownLite(token.value, `${tokenKey}-inner`)}
        </em>,
      );
    }

    cursor = token.end;
    formattedIndex += 1;
  }

  return elements;
}

function hasProgressMarkdownTable(value: string): boolean {
  const lines = value
    .split("\n")
    .map((line) => line.trim());

  for (let index = 0; index < lines.length - 1; index += 1) {
    const header = lines[index];
    const separator = lines[index + 1];
    if (!header || !separator) {
      continue;
    }
    const headerCells = header.replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
    const separatorCells = separator.replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());

    if (headerCells.length < 2 || separatorCells.length !== headerCells.length) {
      continue;
    }

    if (separatorCells.every((cell) => /^:?-+:?$/.test(cell))) {
      return true;
    }
  }

  return false;
}

function shouldRenderProgressMarkdownBlock(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed.includes("\n")) {
    return false;
  }

  return (
    /```/.test(trimmed) ||
    /^#{1,6}\s/m.test(trimmed) ||
    /^>\s/m.test(trimmed) ||
    /^\s*(?:[-*+]|\d+\.)\s/m.test(trimmed) ||
    /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/m.test(trimmed) ||
    hasProgressMarkdownTable(trimmed)
  );
}

function renderProgressMarkdown(value: string) {
  return (
    <div
      className="min-w-0 flex-1 [&>div>p:first-child]:mt-0 [&>div>ul:last-child]:mb-0 [&>div>ol:last-child]:mb-0 [&>div>pre:last-child]:mb-0"
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        skipHtml
        components={PROGRESS_MARKDOWN_COMPONENTS}
      >
        {value}
      </ReactMarkdown>
    </div>
  );
}

function renderAssistantMarkdownSegment(value: string, keyPrefix: string) {
  if (value.trim().length === 0) {
    return [];
  }
  const markdownKey = keyPrefix;

  return [
    <ReactMarkdown
      key={markdownKey}
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeSanitize]}
      skipHtml
      components={ASSISTANT_MARKDOWN_COMPONENTS}
    >
      {value}
    </ReactMarkdown>,
  ];
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

function renderContent(
  content: string,
  projectId: string,
  { assistantTypography = false }: { assistantTypography?: boolean } = {},
) {
  // Split on MEDIA references, embed tags, and markdown images.
  const parts = content.split(/(MEDIA:[^\s\n]+|\[embed[^\]]*\]|!\[[^\]]*\]\([^)]+\))/gi);
  const renderedParts = parts.flatMap<RenderedContentPart>((part, i) => {
    const captionClass = assistantTypography
      ? ASSISTANT_CAPTION_CLASS
      : "mt-1 block font-mono text-[10px] text-muted";
    if (part.startsWith("MEDIA:")) {
      const filePath = part.slice(6).trim();
      const workspaceFilePath = normalizeMediaWorkspacePath(filePath);
      const ext = workspaceFilePath.split(".").pop()?.toLowerCase() || "";
      const src = buildWorkspaceRawPreviewUrl(workspaceFilePath, projectId, {
        preferPathRoute: ext === "html" || ext === "htm",
      });
      if (!src) {
        return [{
          key: `content-${i}`,
          kind: "flow",
          node: (
          <div key={i} className="my-2">
            <span className="font-mono text-xs text-muted">[media blocked: invalid path]</span>
          </div>
          ),
        }];
      }
      if (["png", "jpg", "jpeg", "gif", "webp", "avif"].includes(ext)) {
        return [{
          key: `content-${i}`,
          kind: "gallery-item",
          node: (
          <figure key={i} className={`my-2 p-2 ${ASSISTANT_MEDIA_CARD_CLASS}`}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={src} alt={filePath} className={`${ASSISTANT_MEDIA_FRAME_CLASS} rounded-[1rem]`} />
            <span className={captionClass}>{filePath}</span>
          </figure>
          ),
        }];
      }
      if (ext === "html" || ext === "htm") {
        return [{
          key: `content-${i}`,
          kind: "flow",
          node: (
          <div key={i} className="my-2">
            <iframe
              src={src}
              title={filePath}
              className="w-full min-w-0 h-[80vh] min-h-[700px] rounded-lg border border-border bg-white"
              sandbox="allow-scripts"
            />
            <span className={captionClass}>{filePath}</span>
          </div>
          ),
        }];
      }
      if (ext === "pdf") {
        return [{
          key: `content-${i}`,
          kind: "flow",
          node: (
          <div key={i} className="my-2">
            <iframe
              src={src}
              title={filePath}
              className="w-full min-w-0 h-[80vh] min-h-[600px] rounded-lg border border-border bg-white"
              sandbox="allow-same-origin allow-downloads"
            />
            <span className={captionClass}>{filePath}</span>
          </div>
          ),
        }];
      }
      if (ext === "svg") {
        // SVG rendered as <img> to prevent script execution
        return [{
          key: `content-${i}`,
          kind: "gallery-item",
          node: (
          <figure key={i} className={`my-2 p-2 ${ASSISTANT_MEDIA_CARD_CLASS}`}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={src} alt={filePath} className={`${ASSISTANT_MEDIA_FRAME_CLASS} rounded-[1rem]`} />
            <span className={captionClass}>{filePath}</span>
          </figure>
          ),
        }];
      }
      if (["mp4", "webm", "mov", "m4v"].includes(ext)) {
        return [{
          key: `content-${i}`,
          kind: "flow",
          node: (
          <div key={i} className="my-2">
            <video controls className="max-w-full max-h-[50vh] rounded-lg border border-border bg-black">
              <source src={src} type={getVideoMimeType(ext)} />
            </video>
            <span className={captionClass}>{filePath}</span>
          </div>
          ),
        }];
      }
      if (["mp3", "wav", "ogg", "m4a", "flac", "opus", "aac"].includes(ext)) {
        return [{
          key: `content-${i}`,
          kind: "flow",
          node: (
          <div key={i} className="my-2">
            <audio controls className="w-full">
              <source src={src} type={getAudioMimeType(ext)} />
            </audio>
            <span className={captionClass}>{filePath}</span>
          </div>
          ),
        }];
      }
      return [{
        key: `content-${i}`,
        kind: "flow",
        node: <span key={i} className="font-mono text-xs text-accent underline">{filePath}</span>,
      }];
    }
    const embedDirective = parseEmbedDirective(part);
    if (embedDirective) {
      const legacyEmbedRefPath =
        typeof embedDirective.ref === "string"
          ? resolveLegacyHtmlAliasPath(embedDirective.ref)
          : null;
      const embedDirectiveUrl = embedDirective.url?.trim() || null;
      if (embedDirectiveUrl || legacyEmbedRefPath) {
        let embedUrl = embedDirectiveUrl || legacyEmbedRefPath!;
        // OpenClaw canvas/internal URLs need proxying through workspace API
        if (embedUrl.includes("__openclaw__") || embedUrl.includes("canvas/documents")) {
          // Find the most recent saved HTML filename anywhere earlier in the
          // message so later embeds can still inherit it after intervening text.
          const savedFileName = findLastSavedHtmlFilename(parts.slice(0, i).join(""));
          const fileName = resolveEmbeddedRawPath(embedUrl, savedFileName);
          if (!fileName) {
            return [{
              key: `content-${i}`,
              kind: "flow",
              node: (
              <div key={i} className="my-2">
                <span className="font-mono text-xs text-muted">[embed blocked: invalid path]</span>
              </div>
              ),
            }];
          }
          const rawPreviewUrl = buildWorkspaceRawPreviewUrl(fileName, projectId, { preferPathRoute: true });
          if (!rawPreviewUrl) {
            return [{
              key: `content-${i}`,
              kind: "flow",
              node: (
              <div key={i} className="my-2">
                <span className="font-mono text-xs text-muted">[embed blocked: invalid path]</span>
              </div>
              ),
            }];
          }
          embedUrl = rawPreviewUrl;
        } else {
          const workspaceHtmlPath = normalizeWorkspaceRelativePath(embedUrl);
          if (workspaceHtmlPath && /\.html?$/i.test(workspaceHtmlPath)) {
            const rawPreviewUrl = buildWorkspaceRawPreviewUrl(workspaceHtmlPath, projectId, {
              preferPathRoute: true,
            });
            if (!rawPreviewUrl) {
              return [{
                key: `content-${i}`,
                kind: "flow",
                node: (
                <div key={i} className="my-2">
                  <span className="font-mono text-xs text-muted">[embed blocked: invalid path]</span>
                </div>
                ),
              }];
            }
            embedUrl = rawPreviewUrl;
          } else if (/\.html?$/i.test(embedUrl)) {
            return [{
              key: `content-${i}`,
              kind: "flow",
              node: (
              <div key={i} className="my-2">
                <span className="font-mono text-xs text-muted">[embed blocked: invalid path]</span>
              </div>
              ),
            }];
          } else {
            // Strip every leading slash and re-add a single one so protocol-
            // relative URLs ("//external.host/...") collapse to a same-origin
            // path instead of loading third-party content into the iframe.
            embedUrl = `/${embedUrl.replace(/^\/+/, "")}`;
          }
        }
        const embedTitle = embedDirective.title ?? "Embedded content";
        const embedHeight = sanitizeEmbedHeight(embedDirective.height, "60vh");
        return [{
          key: `content-${i}`,
          kind: "flow",
          node: (
          <div key={i} className="my-2">
            <iframe
              src={embedUrl}
              title={embedTitle}
              className="w-full min-w-0 min-h-[700px] rounded-lg border border-border bg-white"
              style={{ height: embedHeight }}
              sandbox="allow-scripts"
            />
            <span className={captionClass}>{embedTitle}</span>
          </div>
          ),
        }];
      }
      return [];
    }
    if (part.startsWith("![")) {
      const match = part.match(/!\[([^\]]*)\]\(([^)]+)\)/);
      if (match && isSafeImageUrl(match[2])) {
        return [{
          key: `content-${i}`,
          kind: "gallery-item",
          node: (
          <figure key={i} className={`my-2 p-2 ${ASSISTANT_MEDIA_CARD_CLASS}`}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={match[2]} alt={match[1]} className={`${ASSISTANT_MEDIA_FRAME_CLASS} rounded-[1rem]`} />
            {match[1] ? <span className={captionClass}>{match[1]}</span> : null}
          </figure>
          ),
        }];
      }
      if (match) {
        // Unsafe external URL — render as text link instead
        return [{
          key: `content-${i}`,
          kind: "flow",
          node: (
          <div key={i} className="my-2">
            <span className="font-mono text-xs text-muted">[image: {match[1] || match[2]}]</span>
          </div>
          ),
        }];
      }
    }
    if (assistantTypography) {
      return renderAssistantMarkdownSegment(part, `content-${i}`).map((node, index) => ({
        key: `content-${i}-${index}`,
        kind: "flow" as const,
        node,
      }));
    }
    return [{
      key: `content-${i}`,
      kind: "flow",
      node: <span key={i}>{renderInlineMarkdownLite(part, `content-${i}`)}</span>,
    }];
  });

  if (!assistantTypography) {
    return renderedParts.map((part) => part.node);
  }

  return collapseAssistantMediaGalleries(renderedParts);
}

// ── Component ──────────────────────────────────────────────────

export function ChatMessage({
  role,
  content,
  thinking,
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
  useLiveSecondTick(Boolean(isStreaming));

  const badge = channel ? CHANNEL_BADGES[channel] : undefined;
  const isCrossChannel = channel && channel !== "web";
  const isAssistantTurn = role === "assistant";
  const isLiveAssistantTurn = role === "assistant" && Boolean(isStreaming);
  const visibleTaskPhases =
    role === "assistant" && Array.isArray(taskPhases) && taskPhases.length > 0
      ? taskPhases
      : [];
  const visibleSteps =
    role === "assistant" && Array.isArray(steps) && steps.length > 0
      ? steps
      : [];
  const visibleActivityLog =
    role === "assistant" && Array.isArray(activityLog) && activityLog.length > 0
      ? activityLog
      : [];
  const storedProgressLog =
    role === "assistant" && Array.isArray(progressLog) && progressLog.length > 0
      ? progressLog
      : [];
  const hasLegacyProgressFields =
    role === "assistant"
    && (
      Boolean(thinking?.trim().length)
      || visibleActivityLog.length > 0
    );
  const visibleStreamProgressLog =
    role === "assistant" && isStreaming
      ? storedProgressLog.length > 0
        ? storedProgressLog
        : buildFallbackProgressLog(thinking, visibleActivityLog)
      : [];
  const visibleProgressLog =
    role === "assistant"
      ? isStreaming
        ? visibleStreamProgressLog
        : storedProgressLog.length > 0
          ? storedProgressLog
          : hasLegacyProgressFields
            ? buildFallbackProgressLog(thinking, visibleActivityLog)
            : []
      : [];
  const progressTranscript = buildProgressTranscript(visibleProgressLog);
  const compactLiveRunSummary = isLiveAssistantTurn
    ? [
        ...summarizeCompactPhaseStatus(visibleTaskPhases),
        ...summarizeCompactSteps(visibleSteps),
      ]
    : [];
  const liveRunStateDetail = isLiveAssistantTurn
    ? summarizeLatestRunStateDetail(progressTranscript)
    : null;
  const liveElapsedMs = getProgressElapsedMs(timestamp, isStreaming);
  const workingElapsed =
    liveElapsedMs === null ? null : formatElapsedCompact(liveElapsedMs);
  const useCompactAssistantTranscript =
    role === "assistant" && !isLiveAssistantTurn && progressTranscript.length > 0;
  const showCompactLiveTranscript =
    isLiveAssistantTurn
    && (
      visibleProgressLog.length > 0
      || visibleTaskPhases.length > 0
      || visibleSteps.length > 0
    );
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
  const footerTextClass =
    role === "user" ? "text-quiet" : isAssistantTurn ? ASSISTANT_METADATA_CLASS : "text-muted/55";
  const selectionClass = role === "user"
    ? "selection:bg-accent/30 selection:text-strong"
    : "selection:bg-accent/25 selection:text-strong";
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
        ? "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-accent/30 bg-accent/15 text-accent transition-colors hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        : copyState === "error"
          ? "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-danger/30 bg-danger/10 text-danger transition-colors hover:bg-danger/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40"
          : "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-transparent text-quiet transition-colors hover:border-accent/25 hover:bg-accent/10 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      : copyState === "copied"
        ? "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-ok/30 bg-ok/10 text-ok transition-all hover:bg-ok/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ok/30"
        : copyState === "error"
        ? "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-danger/30 bg-danger/10 text-danger transition-all hover:bg-danger/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/30"
        : isAssistantTurn
          ? "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-transparent text-quiet opacity-0 transition-all group-hover/assistant:opacity-100 group-focus-within/assistant:opacity-100 hover:border-rule hover:bg-sunk hover:text-dim focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30"
          : "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-transparent text-muted/65 transition-colors hover:border-border hover:bg-sunk hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30";
  const bubbleClass =
    role === "user"
      ? `max-w-2xl rounded-xl px-5 py-4 text-sm leading-relaxed select-text cursor-text ${
          isOpenClawToolsTurn
            ? "bg-ok/10 text-ok border border-ok/30"
            : "bg-accent/10 text-accent border border-accent/30"
        }`
      : role === "system"
        ? "w-full max-w-[min(92vw,72rem)] rounded-xl px-5 py-4 text-sm leading-relaxed shadow-sm select-text cursor-text bg-white border-2 border-border text-muted text-xs font-mono"
        : "w-full max-w-[min(90vw,56rem)] px-1 py-3 select-text cursor-text text-strong sm:px-2";
  const assistantSurfaceClass = isAssistantTurn
    ? "group/assistant mx-auto flex w-full max-w-[48rem] flex-col"
    : "";
  const contentClass = isAssistantTurn
    ? `select-text text-strong [&>*:last-child]:mb-0 ${selectionClass}`
    : `whitespace-pre-wrap select-text ${selectionClass}`;
  const footerRowClass = isAssistantTurn
    ? "mt-5 flex items-center justify-end gap-2"
    : "mt-3 flex items-center justify-end gap-3";

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

  const messageBody = (
    <>
      {isOpenClawToolsTurn && (
        <div className={`mb-2 inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] ${
          role === "user"
            ? "border-ok/30 bg-ok/10 text-ok"
            : "border-ok/30 bg-raised text-ok"
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

      {!useCompactAssistantTranscript && !showCompactLiveTranscript && (
        <TaskPhaseRail phases={visibleTaskPhases} className="mb-3" />
      )}

      {/* Agent step cards (above content; no-op when absent) */}
      {!useCompactAssistantTranscript && !showCompactLiveTranscript && role === "assistant" && (
        <StepCards steps={visibleSteps} />
      )}

      {/* Streaming indicator */}
      {role === "assistant" && content === "" && isStreaming && !showCompactLiveTranscript && visibleProgressLog.length === 0 && (
        <ActiveRunStateSurface
          workingElapsed={workingElapsed}
          summaries={compactLiveRunSummary}
          detail={null}
        />
      )}

      {showCompactLiveTranscript && (
        <div
          aria-live="polite"
          className="mb-3 space-y-0"
          role="log"
        >
          <ActiveRunStateSurface
            workingElapsed={workingElapsed}
            summaries={compactLiveRunSummary}
            detail={liveRunStateDetail}
          />

          {progressTranscript.length > 0 && (
            <div className="space-y-2" data-testid="assistant-progress-transcript">
              {buildProgressSectionChanges(progressTranscript, { compact: true })}
            </div>
          )}
        </div>
      )}

      {!showCompactLiveTranscript && visibleProgressLog.length > 0 && (
        <div
          aria-live="polite"
          className="mb-3 space-y-3 text-[13px] leading-6 text-foreground/95"
          data-testid="assistant-progress-transcript"
          role="log"
        >
          {buildProgressSectionChanges(progressTranscript)}

          {workingElapsed && (
            <div className="flex items-start gap-2 whitespace-pre-wrap text-dim">
              <span aria-hidden="true" className="pt-0.5 text-quiet">• </span>
              <span>{`Working (${workingElapsed} • esc to interrupt)`}</span>
            </div>
          )}
        </div>
      )}

      {/* Message content */}
      <div
        ref={contentRef}
        data-testid={isAssistantTurn ? "assistant-reply-content" : undefined}
        className={contentClass}
      >
        {renderContent(content, projectId, { assistantTypography: isAssistantTurn })}
      </div>

      <div className={footerRowClass}>
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
        <div className={isAssistantTurn ? ASSISTANT_METADATA_CHIP_CLASS : `text-[9px] ${footerTextClass}`}>
          {timestampText}
        </div>
      </div>
    </>
  );

  return (
    <div
      className={`flex ${role === "user" ? "justify-end" : "justify-center"}`}
    >
      <div
        data-testid="chat-bubble"
        data-chat-selectable={role === "user" ? "true" : undefined}
        className={bubbleClass}
      >
        {isAssistantTurn ? (
          <div data-testid="assistant-reply-surface" className={assistantSurfaceClass}>
            {messageBody}
          </div>
        ) : (
          messageBody
        )}
      </div>
    </div>
  );
}
