"use client";

/**
 * SsSwitch — ScienceSwarm-wrapped preference toggle.
 *
 * Intended for preference toggles only, never for "save state" per
 * the architecture doc. The checked-state track uses the accent
 * token (via --primary through the shadcn bridge) because flipping
 * a preference is an action moment worth acknowledging.
 */

import * as React from "react";
import { Switch } from "./switch";
import { cn } from "@/lib/utils";

export type SsSwitchProps = React.ComponentProps<typeof Switch>;

export function SsSwitch({ className, ...props }: SsSwitchProps) {
  return (
    <Switch
      className={cn(
        "focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]",
        className,
      )}
      {...props}
    />
  );
}
