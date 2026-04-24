"use client";

/**
 * SsCheckbox — ScienceSwarm-wrapped checkbox. The checked state is
 * one of the product's canonical "action moments" per DESIGN.md §6.2,
 * so we keep shadcn's accent-on-check behavior (it maps through
 * --primary → the real accent token via the shadcn bridge).
 */

import * as React from "react";
import { Checkbox } from "./checkbox";
import { cn } from "@/lib/utils";

export type SsCheckboxProps = React.ComponentProps<typeof Checkbox>;

export function SsCheckbox({ className, ...props }: SsCheckboxProps) {
  return (
    <Checkbox
      className={cn(
        "border-rule rounded-[var(--radius-1)]",
        "focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]",
        className,
      )}
      {...props}
    />
  );
}
