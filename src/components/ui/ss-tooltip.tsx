"use client";

/**
 * SsTooltip — ScienceSwarm-wrapped Tooltip.
 *
 * - Default `delayDuration` drops from the shadcn default (0ms) to
 *   400ms so the caret doesn't flash labels on every sweep.
 * - Content uses JetBrains Mono at the 2xs scale for data-adjacent
 *   tooltips (keyboard shortcuts, file names) — a small visual cue
 *   that tooltips are factual, not editorial.
 * - Surface uses --surface-raised against the ink page for stronger
 *   separation than the shadcn default (which inverts foreground).
 */

import * as React from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./tooltip";
import { cn } from "@/lib/utils";

function SsTooltipProvider({
  delayDuration = 400,
  ...props
}: React.ComponentProps<typeof TooltipProvider>) {
  return <TooltipProvider delayDuration={delayDuration} {...props} />;
}

function SsTooltipContent({
  className,
  ...props
}: React.ComponentProps<typeof TooltipContent>) {
  return (
    <TooltipContent
      className={cn(
        "bg-raised text-strong border border-rule",
        "font-mono text-[10.5px] tracking-[0.02em]",
        "px-2 py-1 rounded-[var(--radius-1)]",
        className,
      )}
      {...props}
    />
  );
}

const SsTooltip = Tooltip;
const SsTooltipTrigger = TooltipTrigger;

export { SsTooltip, SsTooltipTrigger, SsTooltipContent, SsTooltipProvider };
