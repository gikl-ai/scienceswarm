"use client";

/**
 * SsScrollArea — ScienceSwarm-wrapped ScrollArea. Thumb uses --rule
 * (a neutral near-transparent gray) and opacity ticks up on hover.
 * Keeps the scrollbar subtle enough for the knowledge panel and
 * thread list while still reading as affordance.
 */

import * as React from "react";
import { ScrollArea, ScrollBar } from "./scroll-area";
import { cn } from "@/lib/utils";

export type SsScrollAreaProps = React.ComponentProps<typeof ScrollArea>;

export function SsScrollArea({ className, children, ...props }: SsScrollAreaProps) {
  return (
    <ScrollArea className={cn("relative", className)} {...props}>
      {children}
    </ScrollArea>
  );
}

export function SsScrollBar({
  className,
  ...props
}: React.ComponentProps<typeof ScrollBar>) {
  return (
    <ScrollBar
      className={cn(
        "[&_[data-slot=scroll-area-thumb]]:bg-rule",
        "[&_[data-slot=scroll-area-thumb]]:opacity-60",
        "hover:[&_[data-slot=scroll-area-thumb]]:opacity-100",
        className,
      )}
      {...props}
    />
  );
}
