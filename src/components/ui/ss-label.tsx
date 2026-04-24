"use client";

/**
 * SsLabel — ScienceSwarm-wrapped Label. Slightly dimmer than body
 * text (text-dim), tabular-friendly letter-spacing, inherits the
 * Public Sans stack.
 */

import * as React from "react";
import { Label } from "./label";
import { cn } from "@/lib/utils";

export type SsLabelProps = React.ComponentProps<typeof Label>;

export function SsLabel({ className, ...props }: SsLabelProps) {
  return (
    <Label
      className={cn(
        "font-sans text-[12px] font-medium text-dim tracking-[0.005em]",
        className,
      )}
      {...props}
    />
  );
}
