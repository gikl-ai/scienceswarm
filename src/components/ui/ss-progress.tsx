"use client";

/**
 * SsProgress — ScienceSwarm-wrapped progress bar.
 *
 * Adds a `tone` prop that switches the indicator between the three
 * sanctioned states:
 *   - `progress` (default) — solid accent; an in-flight operation.
 *   - `stalled`            — warn (amber) for delegation-waited-too-long.
 *   - `quiet`              — --text-quiet; an idle or background signal.
 *
 * The shadcn primitive assumes a blue "rainbow fill"; we override
 * both track and indicator via children-class selectors so the
 * primitive's internal structure stays untouched.
 */

import * as React from "react";
import { Progress } from "./progress";
import { cn } from "@/lib/utils";

type ProgressTone = "progress" | "stalled" | "quiet";

export type SsProgressProps = React.ComponentProps<typeof Progress> & {
  tone?: ProgressTone;
};

const indicatorClass: Record<ProgressTone, string> = {
  progress:
    "[&_[data-slot=progress-indicator]]:bg-accent",
  stalled:
    "[&_[data-slot=progress-indicator]]:bg-warn",
  quiet:
    "[&_[data-slot=progress-indicator]]:bg-[var(--text-quiet)]",
};

export function SsProgress({
  className,
  tone = "progress",
  ...props
}: SsProgressProps) {
  return (
    <Progress
      data-tone={tone}
      className={cn(
        "bg-rule-soft h-[3px] rounded-full overflow-hidden",
        indicatorClass[tone],
        className,
      )}
      {...props}
    />
  );
}
