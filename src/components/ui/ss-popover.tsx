"use client";

/**
 * SsPopover — ScienceSwarm-wrapped Popover. Applies the design-system
 * surface treatment (raised bg + rule border + radius-2) while leaving
 * size and positioning to the caller.
 */

import * as React from "react";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "./popover";
import { cn } from "@/lib/utils";

function SsPopoverContent({
  className,
  ...props
}: React.ComponentProps<typeof PopoverContent>) {
  return (
    <PopoverContent
      className={cn(
        "bg-raised text-body border-rule rounded-[var(--radius-2)]",
        "shadow-[0_12px_30px_-8px_rgba(0,0,0,0.35)]",
        className,
      )}
      {...props}
    />
  );
}

const SsPopover = Popover;
const SsPopoverTrigger = PopoverTrigger;
const SsPopoverAnchor = PopoverAnchor;
const SsPopoverHeader = PopoverHeader;
const SsPopoverTitle = PopoverTitle;
const SsPopoverDescription = PopoverDescription;

export {
  SsPopover,
  SsPopoverTrigger,
  SsPopoverAnchor,
  SsPopoverContent,
  SsPopoverHeader,
  SsPopoverTitle,
  SsPopoverDescription,
};
