import { type ReactNode, useState } from "react";
import type { MessageProgressEntry } from "@/hooks/use-unified-chat";

export type ProgressTranscriptBlock =
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

export const PROGRESS_SECTION_META: Record<
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

function ExploredTranscriptBlock({
  blockIndex,
  stableKey,
  lines,
  rawCount,
  compact,
  expanded,
  onToggle,
  renderInlineContent,
}: {
  blockIndex: number;
  stableKey: string;
  lines: string[];
  rawCount: number;
  compact: boolean;
  expanded: boolean;
  onToggle: (stableKey: string) => void;
  renderInlineContent: (value: string, keyPrefix: string) => ReactNode;
}) {
  const hiddenCount = Math.max(0, lines.length - EXPLORED_INLINE_LINE_LIMIT);
  const visibleLines =
    expanded || hiddenCount === 0
      ? lines
      : lines.slice(0, EXPLORED_INLINE_LINE_LIMIT);
  const actionCountLabel = `${rawCount} action${rawCount === 1 ? "" : "s"}`;

  return (
    <div className={compact ? "space-y-1.5" : "space-y-1"}>
      <div className={`flex items-start gap-2 ${PROGRESS_SECTION_META.activity.rowClassName}`}>
        <span aria-hidden="true" className="pt-0.5 text-quiet">• </span>
        <span className="font-medium">Explored</span>
        <span
          data-testid={`assistant-explored-count-${blockIndex}`}
          className="inline-flex items-center rounded-full border border-rule bg-raised px-2 py-0.5 text-[10px] font-medium text-dim"
        >
          {actionCountLabel}
        </span>
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
              {renderInlineContent(line, `progress-explored-${blockIndex}-${lineIndex}`)}
            </span>
          </div>
        ))}
        {hiddenCount > 0 && (
          <button
            type="button"
            data-testid={`assistant-explored-toggle-${blockIndex}`}
            className="inline-flex items-center gap-2 rounded-full border border-rule bg-raised px-2.5 py-1 text-[11px] font-medium text-body transition hover:bg-sunk"
            onClick={() => onToggle(stableKey)}
          >
            {expanded
              ? "Hide extra lines"
              : `Show ${hiddenCount} more line${hiddenCount === 1 ? "" : "s"}`}
          </button>
        )}
      </div>
    </div>
  );
}

export function AssistantProgressTranscript({
  blocks,
  compact = false,
  workingElapsed = null,
  renderInlineContent,
  shouldRenderMarkdownBlock,
  renderMarkdownBlock,
}: {
  blocks: ProgressTranscriptBlock[];
  compact?: boolean;
  workingElapsed?: string | null;
  renderInlineContent: (value: string, keyPrefix: string) => ReactNode;
  shouldRenderMarkdownBlock: (value: string) => boolean;
  renderMarkdownBlock: (value: string) => ReactNode;
}) {
  const [expandedExploredBlocks, setExpandedExploredBlocks] = useState<Record<string, boolean>>({});
  let lastSection: "thinking" | "activity" | null = null;

  return (
    <>
      {blocks.map((block, index) => {
        const sectionElements: ReactNode[] = [];
        const nextSection = block.section;
        if (nextSection !== lastSection) {
          const sectionMeta = PROGRESS_SECTION_META[nextSection];
          sectionElements.push(
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
          sectionElements.push(
            <ExploredTranscriptBlock
              key={block.stableKey}
              blockIndex={index}
              stableKey={block.stableKey}
              lines={block.lines}
              rawCount={block.rawCount}
              compact={compact}
              expanded={expandedExploredBlocks[block.stableKey] === true}
              onToggle={(stableKey) =>
                setExpandedExploredBlocks((current) => ({
                  ...current,
                  [stableKey]: !current[stableKey],
                }))
              }
              renderInlineContent={renderInlineContent}
            />,
          );
          return sectionElements;
        }

        const rowClassName = PROGRESS_SECTION_META[block.section].rowClassName;
        const isMarkdownBlock = shouldRenderMarkdownBlock(block.entry.text);
        sectionElements.push(
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
              ? renderMarkdownBlock(block.entry.text)
              : (
                <span className="min-w-0 flex-1">
                  {renderInlineContent(block.entry.text, `progress-${index}`)}
                </span>
              )}
          </div>,
        );

        return sectionElements;
      })}

      {workingElapsed && (
        <div className="flex items-start gap-2 whitespace-pre-wrap text-dim">
          <span aria-hidden="true" className="pt-0.5 text-quiet">• </span>
          <span>{`Working (${workingElapsed} • esc to interrupt)`}</span>
        </div>
      )}
    </>
  );
}
