"use client";

import { useState, useCallback, useMemo } from "react";
import type { ChatTaskPhase } from "@/hooks/use-unified-chat";
import { TaskPhaseRail } from "@/components/research/task-phase-rail";

// ── SVG Sanitizer ─────────────────────────────────────────────

const ALLOWED_SVG_TAGS = new Set([
  "svg", "g", "path", "circle", "ellipse", "line", "polyline", "polygon",
  "rect", "text", "tspan", "defs", "clippath", "lineargradient",
  "radialgradient", "stop", "mask", "use", "symbol", "title", "desc",
  "marker", "pattern", "image", "foreignobject",
]);

const DANGEROUS_ATTRS = /^on[a-z]+$/i;
const DANGEROUS_VALUES = /javascript\s*:|data\s*:(?!image\/)/i;

function sanitizeSVG(raw: string): string {
  const parser = new DOMParser();
  const doc = parser.parseFromString(raw, "image/svg+xml");
  const errorNode = doc.querySelector("parsererror");
  if (errorNode) return ""; // malformed SVG

  function walk(node: Element): void {
    // Remove disallowed tags entirely
    if (!ALLOWED_SVG_TAGS.has(node.tagName.toLowerCase())) {
      node.remove();
      return;
    }
    // Strip dangerous attributes
    for (const attr of Array.from(node.attributes)) {
      if (DANGEROUS_ATTRS.test(attr.name) || DANGEROUS_VALUES.test(attr.value)) {
        node.removeAttribute(attr.name);
      }
    }
    // Remove <script> children regardless
    for (const script of Array.from(node.getElementsByTagName("script"))) {
      script.remove();
    }
    for (const child of Array.from(node.children)) {
      walk(child);
    }
  }

  const svg = doc.documentElement;
  walk(svg);
  return svg.outerHTML;
}

// ── Types ────────────────────────────────────────────────────

interface InlineChartProps {
  svgs: string[];
  description: string;
  onDownloadData?: () => void;
  taskPhases?: ChatTaskPhase[];
}

// ── Component ────────────────────────────────────────────────

export function InlineChart({ svgs, description, onDownloadData, taskPhases }: InlineChartProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const visibleTaskPhases = taskPhases ?? [];

  const sanitizedSvgs = useMemo(() => svgs.map(sanitizeSVG), [svgs]);

  if (sanitizedSvgs.length === 0 || !sanitizedSvgs.some(Boolean)) return null;

  return (
    <div className="my-3 rounded-xl border-2 border-border bg-white overflow-hidden">
      {/* Chart header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-surface/30">
        <p className="text-xs text-foreground font-medium">{description}</p>
        <div className="flex items-center gap-2">
          {sanitizedSvgs.length > 1 && (
            <div className="flex gap-1">
              {sanitizedSvgs.map((_, i) => (
                <button
                  key={i}
                  onClick={() => setActiveIndex(i)}
                  className={`w-2 h-2 rounded-full transition-colors ${
                    i === activeIndex ? "bg-accent" : "bg-border"
                  }`}
                />
              ))}
            </div>
          )}
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-[10px] text-muted hover:text-foreground transition-colors px-1.5 py-0.5 border border-border rounded"
          >
            {expanded ? "Collapse" : "Expand"}
          </button>
        </div>
      </div>

      {/* Chart content */}
      <TaskPhaseRail phases={visibleTaskPhases} className="mb-3 px-4 pt-2" />

      <div
        className={`transition-all duration-200 ${
          expanded ? "max-h-[600px]" : "max-h-[300px]"
        } overflow-hidden`}
      >
        <div
          className="w-full [&_svg]:w-full [&_svg]:h-auto p-3"
          dangerouslySetInnerHTML={{ __html: sanitizedSvgs[activeIndex] }}
        />
      </div>

      {/* Chart footer with actions */}
      <div className="flex items-center gap-2 px-4 py-2 border-t border-border bg-surface/30">
        <DownloadPNGButton svg={sanitizedSvgs[activeIndex]} />
        {onDownloadData && (
          <button
            onClick={onDownloadData}
            className="text-[10px] text-muted hover:text-accent transition-colors px-2 py-1 border border-border rounded bg-white"
          >
            Download data
          </button>
        )}
        {sanitizedSvgs.length > 1 && (
          <span className="text-[10px] text-muted ml-auto">
            {activeIndex + 1} of {sanitizedSvgs.length} charts
          </span>
        )}
      </div>
    </div>
  );
}

// ── SVG to PNG download ──────────────────────────────────────

function DownloadPNGButton({ svg }: { svg: string }) {
  const handleDownload = useCallback(() => {
    if (typeof document === "undefined") return;

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const img = new Image();
    const svgBlob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(svgBlob);

    img.onload = () => {
      canvas.width = img.width * 2; // 2x for retina
      canvas.height = img.height * 2;
      ctx.scale(2, 2);
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);

      const pngUrl = canvas.toDataURL("image/png");
      const a = document.createElement("a");
      a.href = pngUrl;
      a.download = "chart.png";
      a.click();
    };

    img.src = url;
  }, [svg]);

  return (
    <button
      onClick={handleDownload}
      className="text-[10px] text-muted hover:text-accent transition-colors px-2 py-1 border border-border rounded bg-white"
    >
      Download PNG
    </button>
  );
}

// ── SVG detection in message content ─────────────────────────

/**
 * Detect if a chat message contains inline SVG charts.
 * Returns the SVG strings if found, or null.
 */
export function extractSVGsFromContent(content: string): string[] | null {
  const svgRegex = /<svg[\s\S]*?<\/svg>/gi;
  const matches = content.match(svgRegex);
  if (!matches || matches.length === 0) return null;
  return matches;
}

/**
 * Split message content into text parts and SVG chart parts.
 * Useful for rendering mixed text+chart messages.
 */
export function splitContentWithCharts(content: string): Array<{ type: "text" | "chart"; content: string }> {
  const parts: Array<{ type: "text" | "chart"; content: string }> = [];
  const svgRegex = /<svg[\s\S]*?<\/svg>/gi;

  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = svgRegex.exec(content)) !== null) {
    // Add text before the SVG
    if (match.index > lastIndex) {
      const textBefore = content.slice(lastIndex, match.index).trim();
      if (textBefore) {
        parts.push({ type: "text", content: textBefore });
      }
    }
    // Add the SVG
    parts.push({ type: "chart", content: match[0] });
    lastIndex = match.index + match[0].length;
  }

  // Add remaining text
  if (lastIndex < content.length) {
    const remaining = content.slice(lastIndex).trim();
    if (remaining) {
      parts.push({ type: "text", content: remaining });
    }
  }

  // If no SVGs found, return the whole content as text
  if (parts.length === 0) {
    parts.push({ type: "text", content });
  }

  return parts;
}
