"use client";

/**
 * SsDialog — ScienceSwarm-wrapped Dialog.
 *
 * Re-exports the full Dialog surface so consumers get the same
 * structural API as the raw primitive. The Overlay and Content
 * pieces are re-wrapped so we can apply the ScienceSwarm overlay
 * (--surface-overlay, a low-noise black that adapts per theme)
 * and the --radius-3 corner for the sheet-class surface.
 */

import * as React from "react";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
} from "./dialog";
import { cn } from "@/lib/utils";

function SsDialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogOverlay>) {
  return (
    <DialogOverlay
      className={cn("bg-[var(--surface-overlay)]", className)}
      {...props}
    />
  );
}

function SsDialogContent({
  className,
  ...props
}: React.ComponentProps<typeof DialogContent>) {
  return (
    <DialogContent
      className={cn(
        "bg-raised text-strong border-rule",
        "rounded-[var(--radius-3)] shadow-[0_18px_50px_-10px_rgba(0,0,0,0.45)]",
        className,
      )}
      {...props}
    />
  );
}

// Re-export with Ss* names so consumers have a consistent surface.
const SsDialog = Dialog;
const SsDialogTrigger = DialogTrigger;
const SsDialogClose = DialogClose;
const SsDialogPortal = DialogPortal;
const SsDialogHeader = DialogHeader;
const SsDialogFooter = DialogFooter;
const SsDialogTitle = DialogTitle;
const SsDialogDescription = DialogDescription;

export {
  SsDialog,
  SsDialogTrigger,
  SsDialogClose,
  SsDialogPortal,
  SsDialogOverlay,
  SsDialogContent,
  SsDialogHeader,
  SsDialogFooter,
  SsDialogTitle,
  SsDialogDescription,
};
