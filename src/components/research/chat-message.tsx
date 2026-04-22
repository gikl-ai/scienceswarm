import type { ChatTaskPhase } from "@/hooks/use-unified-chat";
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
  // Relative paths (starts with /, ./ or ../) are safe — served from our own origin
  if (url.startsWith("/") || url.startsWith("./") || url.startsWith("../")) {
    return true;
  }
  // Block anything that looks like an absolute external URL
  try {
    const parsed = new URL(url, "http://self");
    return parsed.hostname === "self";
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

// ── Render markdown-lite ───────────────────────────────────────

function renderContent(content: string, projectId: string) {
  // Split on bold markers, MEDIA references, embed tags, and markdown images
  return content.split(/(\*\*[^*]+\*\*|MEDIA:[^\s\n]+|\[embed[^\]]*\]|!\[[^\]]*\]\([^)]+\))/g).map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return (
        <strong key={i} className="font-semibold">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.startsWith("MEDIA:")) {
      const filePath = part.slice(6).trim();
      const ext = filePath.split(".").pop()?.toLowerCase() || "";
      const src = `/api/workspace?action=raw&file=${encodeURIComponent(filePath)}&projectId=${encodeURIComponent(projectId)}`;
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
              className="w-full min-w-[800px] h-[80vh] min-h-[700px] rounded-lg border border-border bg-white"
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
              <source src={src} />
            </video>
            <span className="block text-[10px] text-muted mt-1 font-mono">{filePath}</span>
          </div>
        );
      }
      if (["mp3", "wav", "ogg", "m4a"].includes(ext)) {
        return (
          <div key={i} className="my-2">
            <audio controls className="w-full">
              <source src={src} />
            </audio>
            <span className="block text-[10px] text-muted mt-1 font-mono">{filePath}</span>
          </div>
        );
      }
      return <span key={i} className="font-mono text-xs text-accent underline">{filePath}</span>;
    }
    if (part.startsWith("[embed")) {
      const urlMatch = part.match(/url="([^"]+)"/);
      const titleMatch = part.match(/title="([^"]+)"/);
      const heightMatch = part.match(/height="([^"]+)"/);
      if (urlMatch) {
        let embedUrl = urlMatch[1];
        // OpenClaw canvas/internal URLs need proxying through workspace API
        if (embedUrl.includes("__openclaw__") || embedUrl.includes("canvas/documents")) {
          // Try extracting filename from Saved list, or from URL path
          const savedMatch = content.match(/[`']([^`']+\.html?)[`']/);
          const urlPathMatch = embedUrl.match(/documents\/([^/]+)/);
          const fileName = savedMatch?.[1] ?? (urlPathMatch ? `${urlPathMatch[1]}.html` : "index.html");
          embedUrl = `/api/workspace?action=raw&file=${encodeURIComponent(fileName)}&projectId=${encodeURIComponent(projectId)}`;
        } else {
          // Strip every leading slash and re-add a single one so protocol-
          // relative URLs ("//external.host/...") collapse to a same-origin
          // path instead of loading third-party content into the iframe.
          embedUrl = `/${embedUrl.replace(/^\/+/, "")}`;
        }
        const embedTitle = titleMatch?.[1] ?? "Embedded content";
        const embedHeight = sanitizeEmbedHeight(heightMatch?.[1], "60vh");
        return (
          <div key={i} className="my-2">
            <iframe
              src={embedUrl}
              title={embedTitle}
              className="w-full min-w-[800px] min-h-[700px] rounded-lg border border-border bg-white"
              style={{ height: embedHeight }}
              sandbox="allow-scripts"
            />
            <span className="block text-[10px] text-muted mt-1 font-mono">{embedTitle}</span>
          </div>
        );
      }
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
    return <span key={i}>{part}</span>;
  });
}

// ── Component ──────────────────────────────────────────────────

export function ChatMessage({
  role,
  content,
  thinking,
  chatMode,
  channel,
  userName,
  timestamp,
  isStreaming,
  taskPhases,
  steps,
  projectId = "",
}: ChatMessageProps) {
  const badge = channel ? CHANNEL_BADGES[channel] : undefined;
  const isCrossChannel = channel && channel !== "web";
  const visibleTaskPhases =
    role === "assistant" && Array.isArray(taskPhases) && taskPhases.length > 0
      ? taskPhases
      : [];
  const isOpenClawToolsTurn = chatMode === "openclaw-tools" && role !== "system";

  return (
    <div
      className={`flex ${role === "user" ? "justify-end" : "justify-start"}`}
    >
      <div
        data-testid="chat-bubble"
        data-chat-selectable={role === "user" ? "true" : undefined}
        className={`max-w-2xl rounded-xl px-5 py-4 text-sm leading-relaxed shadow-sm select-text cursor-text ${
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
        {role === "assistant" && content === "" && isStreaming && (
          <div className="flex items-center gap-2 text-accent/60">
            <Spinner size="h-4 w-4" testId="chat-streaming-spinner" />
            <span className="text-xs">Thinking…</span>
          </div>
        )}

        {role === "assistant" && typeof thinking === "string" && thinking.trim().length > 0 && (
          <details
            className="mb-3 rounded-lg border border-border/80 bg-surface/70 px-3 py-2"
            open={Boolean(isStreaming || content.trim().length === 0)}
          >
            <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">
              Thinking Trace
            </summary>
            <div className="mt-2 whitespace-pre-wrap text-xs text-muted">
              {thinking}
            </div>
          </details>
        )}

        {/* Message content */}
        <div className="whitespace-pre-wrap select-text">{renderContent(content, projectId)}</div>

        {/* Timestamp for cross-channel messages */}
        {isCrossChannel && (
          <div className="mt-2 text-[9px] text-muted/40">
            {timestamp.toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </div>
        )}
      </div>
    </div>
  );
}
