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
}

// ── Render markdown-lite ───────────────────────────────────────

function renderContent(content: string) {
  // Split on bold markers and render
  return content.split(/(\*\*[^*]+\*\*)/g).map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return (
        <strong key={i} className="font-semibold">
          {part.slice(2, -2)}
        </strong>
      );
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
        <div className="whitespace-pre-wrap select-text">{renderContent(content)}</div>

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
