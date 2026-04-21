"use client";

import { ExperimentsPanel as ExperimentsPanelComponent } from "@/components/research/experiments-panel";
import type { Experiment } from "@/components/research/experiments-panel";

export interface ExperimentsPanelProps {
  experiments: Experiment[];
  onSelect: (exp: Experiment) => void;
  onRun: () => void;
  onUseInChat?: (exp: Experiment) => void;
}

export function ExperimentsPanel({
  experiments,
  onSelect,
  onRun,
  onUseInChat,
}: ExperimentsPanelProps) {
  return (
    <ExperimentsPanelComponent
      experiments={experiments}
      onSelect={onSelect}
      onRun={onRun}
      onUseInChat={onUseInChat}
    />
  );
}
