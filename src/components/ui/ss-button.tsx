"use client";

/**
 * SsButton — ScienceSwarm-wrapped Button.
 *
 * Applies the design-system defaults on top of the raw shadcn primitive:
 *   - Default variant is `ghost` (neutral chrome). Action moments use
 *     `default` explicitly, per DESIGN.md §6.2 (accent budget ≤ 5 per
 *     visible surface).
 *   - Forces `font-sans` to the Public Sans body face even when the
 *     parent uses a display or mono tree.
 *   - Uses Tailwind-managed size utilities so the wrapper cost is flat.
 *
 * App code imports from "@/components/ui" (which re-exports this file).
 * The `no-restricted-imports` ESLint rule blocks direct imports of the
 * raw `./button` primitive outside the ui/ layer.
 */

import * as React from "react";
import { Button, buttonVariants } from "./button";
import { cn } from "@/lib/utils";

export type SsButtonProps = React.ComponentProps<typeof Button>;

export function SsButton({ className, variant, ...props }: SsButtonProps) {
  return (
    <Button
      variant={variant ?? "ghost"}
      className={cn(
        "font-sans font-medium tracking-[-0.003em]",
        // Neutral focus ring — layers on top of the accent ring from the
        // token system, sits cleanly over --surface-ink.
        "focus-visible:ring-offset-2 focus-visible:ring-offset-ink",
        className,
      )}
      {...props}
    />
  );
}

export { buttonVariants };
