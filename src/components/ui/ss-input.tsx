"use client";

/**
 * SsInput — ScienceSwarm-wrapped text input. Uses our --rule border
 * and the accent-ring on focus, with font-sans (Public Sans) and
 * a slightly tighter line.
 */

import * as React from "react";
import { Input } from "./input";
import { cn } from "@/lib/utils";

export type SsInputProps = React.ComponentProps<typeof Input>;

export function SsInput({ className, ...props }: SsInputProps) {
  return (
    <Input
      className={cn(
        "font-sans text-[13px]",
        // Token-driven chrome; the raw primitive already reads
        // --input/--ring through the shadcn-bridge.
        "bg-transparent border-rule",
        "focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]",
        className,
      )}
      {...props}
    />
  );
}
