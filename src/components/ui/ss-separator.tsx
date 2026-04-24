"use client";

/**
 * SsSeparator — ScienceSwarm-wrapped hairline rule.
 *
 * Adds a `weight` prop that switches between the full --rule token
 * and the lower-contrast --rule-soft token. App code should prefer
 * `weight="soft"` for incidental dividers and keep the default
 * weight for structural separators.
 */

import * as React from "react";
import { Separator } from "./separator";
import { cn } from "@/lib/utils";

type RuleWeight = "default" | "soft";

export type SsSeparatorProps = React.ComponentProps<typeof Separator> & {
  weight?: RuleWeight;
};

export function SsSeparator({
  className,
  weight = "default",
  ...props
}: SsSeparatorProps) {
  return (
    <Separator
      data-weight={weight}
      className={cn(
        weight === "soft" ? "bg-rule-soft" : "bg-rule",
        className,
      )}
      {...props}
    />
  );
}
