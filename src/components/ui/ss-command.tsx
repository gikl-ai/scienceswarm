"use client";

/**
 * SsCommand — ScienceSwarm-wrapped command palette.
 *
 * This is the ⌘K palette and sits on the critical researcher workflow
 * path; the wrapper invests a little more than the peers:
 *
 *   - Input uses the Public Sans body face (labels) with slight
 *     loosening, while Shortcut uses JetBrains Mono so command IDs
 *     look like factual strings rather than prose.
 *   - Item selection uses --accent-faint so the selected row reads as
 *     a "hover band" rather than an action button.
 */

import * as React from "react";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "./command";
import { cn } from "@/lib/utils";

function SsCommand({
  className,
  ...props
}: React.ComponentProps<typeof Command>) {
  return (
    <Command
      className={cn(
        "bg-raised text-body border border-rule rounded-[var(--radius-2)]",
        className,
      )}
      {...props}
    />
  );
}

function SsCommandInput({
  className,
  ...props
}: React.ComponentProps<typeof CommandInput>) {
  return (
    <CommandInput
      className={cn(
        "font-sans text-[14px] tracking-[-0.003em]",
        className,
      )}
      {...props}
    />
  );
}

function SsCommandItem({
  className,
  ...props
}: React.ComponentProps<typeof CommandItem>) {
  return (
    <CommandItem
      className={cn(
        "font-sans text-[13px]",
        "data-[selected=true]:bg-[var(--accent-faint)] data-[selected=true]:text-strong",
        className,
      )}
      {...props}
    />
  );
}

function SsCommandShortcut({
  className,
  ...props
}: React.ComponentProps<typeof CommandShortcut>) {
  return (
    <CommandShortcut
      className={cn(
        "font-mono text-[10.5px] tracking-[0.02em] text-dim",
        className,
      )}
      {...props}
    />
  );
}

function SsCommandSeparator({
  className,
  ...props
}: React.ComponentProps<typeof CommandSeparator>) {
  return (
    <CommandSeparator className={cn("bg-rule-soft", className)} {...props} />
  );
}

const SsCommandDialog = CommandDialog;
const SsCommandList = CommandList;
const SsCommandEmpty = CommandEmpty;
const SsCommandGroup = CommandGroup;

export {
  SsCommand,
  SsCommandDialog,
  SsCommandInput,
  SsCommandList,
  SsCommandEmpty,
  SsCommandGroup,
  SsCommandItem,
  SsCommandSeparator,
  SsCommandShortcut,
};
