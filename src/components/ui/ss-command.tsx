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
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "./command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./dialog";
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

// Recompose CommandDialog so the inner Command lands on the
// `bg-raised` / border-rule surface and items pick up the
// `--accent-faint` selection band. Aliasing the raw CommandDialog
// would bypass both the ss-* styling and the themed Dialog shell.
function SsCommandDialog({
  title = "Command Palette",
  description = "Search for a command to run...",
  children,
  className,
  showCloseButton = true,
  ...props
}: React.ComponentProps<typeof Dialog> & {
  title?: string;
  description?: string;
  className?: string;
  showCloseButton?: boolean;
}) {
  return (
    <Dialog {...props}>
      <DialogHeader className="sr-only">
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      <DialogContent
        className={cn(
          "bg-raised text-strong border-rule",
          "rounded-[var(--radius-3)] shadow-[0_18px_50px_-10px_rgba(0,0,0,0.45)]",
          "overflow-hidden p-0",
          className,
        )}
        showCloseButton={showCloseButton}
      >
        <SsCommand className="**:data-[slot=command-input-wrapper]:h-12 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-dim [&_[cmdk-group]]:px-2 [&_[cmdk-group]:not([hidden])_~[cmdk-group]]:pt-0 [&_[cmdk-input-wrapper]_svg]:h-5 [&_[cmdk-input-wrapper]_svg]:w-5 [&_[cmdk-input]]:h-12 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-3 [&_[cmdk-item]_svg]:h-5 [&_[cmdk-item]_svg]:w-5">
          {children}
        </SsCommand>
      </DialogContent>
    </Dialog>
  );
}

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
