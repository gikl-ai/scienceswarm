"use client";

/**
 * SsSheet — ScienceSwarm-wrapped side drawer. Used primarily for the
 * knowledge panel on narrow breakpoints. Surface uses --surface-rail
 * (one step cooler than raised) to read as a "panel that slid out
 * of the edge chrome," not as a modal card.
 */

import * as React from "react";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "./sheet";
import { cn } from "@/lib/utils";

// The raw sheet primitive keeps Portal/Overlay private and renders
// them internally from <SheetContent />. We apply our overlay tint
// by targeting the slot attribute on the portaled overlay node.

function SsSheetContent({
  className,
  ...props
}: React.ComponentProps<typeof SheetContent>) {
  return (
    <SheetContent
      className={cn(
        "bg-rail text-body border-rule",
        className,
      )}
      {...props}
    />
  );
}

const SsSheet = Sheet;
const SsSheetTrigger = SheetTrigger;
const SsSheetClose = SheetClose;
const SsSheetHeader = SheetHeader;
const SsSheetFooter = SheetFooter;
const SsSheetTitle = SheetTitle;
const SsSheetDescription = SheetDescription;

export {
  SsSheet,
  SsSheetTrigger,
  SsSheetClose,
  SsSheetContent,
  SsSheetHeader,
  SsSheetFooter,
  SsSheetTitle,
  SsSheetDescription,
};
