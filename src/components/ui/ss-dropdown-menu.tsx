"use client";

/**
 * SsDropdownMenu — ScienceSwarm-wrapped dropdown.
 *
 * Content and item defaults are restyled to our token surfaces;
 * the focus/hover surface uses --accent-faint (the low-saturation
 * wash) rather than the raw shadcn --accent remap, so the hover
 * state reads as a "selection tint" rather than an action signal.
 */

import * as React from "react";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "./dropdown-menu";
import { cn } from "@/lib/utils";

function SsDropdownMenuContent({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuContent>) {
  return (
    <DropdownMenuContent
      className={cn(
        "bg-raised text-body border-rule rounded-[var(--radius-2)]",
        "shadow-[0_12px_30px_-8px_rgba(0,0,0,0.35)]",
        className,
      )}
      {...props}
    />
  );
}

function SsDropdownMenuItem({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuItem>) {
  return (
    <DropdownMenuItem
      className={cn(
        "font-sans text-[13px]",
        "focus:bg-[var(--accent-faint)] focus:text-strong",
        className,
      )}
      {...props}
    />
  );
}

function SsDropdownMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuSeparator>) {
  return (
    <DropdownMenuSeparator
      className={cn("bg-rule-soft", className)}
      {...props}
    />
  );
}

const SsDropdownMenu = DropdownMenu;
const SsDropdownMenuTrigger = DropdownMenuTrigger;
const SsDropdownMenuPortal = DropdownMenuPortal;
const SsDropdownMenuGroup = DropdownMenuGroup;
const SsDropdownMenuLabel = DropdownMenuLabel;
const SsDropdownMenuCheckboxItem = DropdownMenuCheckboxItem;
const SsDropdownMenuRadioGroup = DropdownMenuRadioGroup;
const SsDropdownMenuRadioItem = DropdownMenuRadioItem;
const SsDropdownMenuShortcut = DropdownMenuShortcut;
const SsDropdownMenuSub = DropdownMenuSub;
const SsDropdownMenuSubTrigger = DropdownMenuSubTrigger;
const SsDropdownMenuSubContent = DropdownMenuSubContent;

export {
  SsDropdownMenu,
  SsDropdownMenuTrigger,
  SsDropdownMenuPortal,
  SsDropdownMenuContent,
  SsDropdownMenuGroup,
  SsDropdownMenuLabel,
  SsDropdownMenuItem,
  SsDropdownMenuCheckboxItem,
  SsDropdownMenuRadioGroup,
  SsDropdownMenuRadioItem,
  SsDropdownMenuSeparator,
  SsDropdownMenuShortcut,
  SsDropdownMenuSub,
  SsDropdownMenuSubTrigger,
  SsDropdownMenuSubContent,
};
