"use client";

/**
 * SsTabs — ScienceSwarm-wrapped Tabs. Multi-pane reading only (never
 * navigation — see COMPONENT_ARCHITECTURE.md §4.4). List background
 * uses the sunk surface so selected tabs rise out of the rail.
 */

import * as React from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs";
import { cn } from "@/lib/utils";

function SsTabsList({
  className,
  ...props
}: React.ComponentProps<typeof TabsList>) {
  return (
    <TabsList
      className={cn(
        "bg-sunk text-dim border border-rule rounded-[var(--radius-2)]",
        className,
      )}
      {...props}
    />
  );
}

function SsTabsTrigger({
  className,
  ...props
}: React.ComponentProps<typeof TabsTrigger>) {
  return (
    <TabsTrigger
      className={cn(
        "font-sans text-[13px]",
        "data-[state=active]:bg-raised data-[state=active]:text-strong",
        className,
      )}
      {...props}
    />
  );
}

const SsTabs = Tabs;
const SsTabsContent = TabsContent;

export { SsTabs, SsTabsList, SsTabsTrigger, SsTabsContent };
