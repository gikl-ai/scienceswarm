"use client";

/**
 * SsTextarea — ScienceSwarm-wrapped multi-line input. Matches ss-input
 * chrome; leaves height to the caller because composition surfaces
 * (chat composer, prompt editor) size themselves.
 */

import * as React from "react";
import { Textarea } from "./textarea";
import { cn } from "@/lib/utils";

export type SsTextareaProps = React.ComponentProps<typeof Textarea>;

export function SsTextarea({ className, ...props }: SsTextareaProps) {
  return (
    <Textarea
      className={cn(
        "font-sans text-[13px] leading-[var(--leading-body)]",
        "bg-transparent border-rule",
        "focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]",
        className,
      )}
      {...props}
    />
  );
}
