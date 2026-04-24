"use client";

/**
 * SsSelect — ScienceSwarm-wrapped Select. Re-theme the trigger and
 * content surfaces to our tokens. The item hover uses --accent-faint
 * (hover tint), not the action-moment accent.
 */

import * as React from "react";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "./select";
import { cn } from "@/lib/utils";

function SsSelectTrigger({
  className,
  ...props
}: React.ComponentProps<typeof SelectTrigger>) {
  return (
    <SelectTrigger
      className={cn(
        "font-sans text-[13px] bg-transparent border-rule",
        "focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]",
        className,
      )}
      {...props}
    />
  );
}

function SsSelectContent({
  className,
  ...props
}: React.ComponentProps<typeof SelectContent>) {
  return (
    <SelectContent
      className={cn(
        "bg-raised text-body border-rule rounded-[var(--radius-2)]",
        "shadow-[0_12px_30px_-8px_rgba(0,0,0,0.35)]",
        className,
      )}
      {...props}
    />
  );
}

function SsSelectItem({
  className,
  ...props
}: React.ComponentProps<typeof SelectItem>) {
  return (
    <SelectItem
      className={cn(
        "font-sans text-[13px]",
        "focus:bg-[var(--accent-faint)] focus:text-strong",
        className,
      )}
      {...props}
    />
  );
}

const SsSelect = Select;
const SsSelectGroup = SelectGroup;
const SsSelectValue = SelectValue;
const SsSelectLabel = SelectLabel;
const SsSelectSeparator = SelectSeparator;
const SsSelectScrollUpButton = SelectScrollUpButton;
const SsSelectScrollDownButton = SelectScrollDownButton;

export {
  SsSelect,
  SsSelectGroup,
  SsSelectValue,
  SsSelectTrigger,
  SsSelectContent,
  SsSelectLabel,
  SsSelectItem,
  SsSelectSeparator,
  SsSelectScrollUpButton,
  SsSelectScrollDownButton,
};
