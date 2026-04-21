import { PapersPanel } from "@/components/research/papers-panel";
import type { Paper } from "@/components/research/papers-panel";

export interface LiteraturePanelProps {
  papers: Paper[];
  onSelectPaper: (paper: Paper) => void;
  onAddPaper: () => void;
  onUseInChat?: (paper: Paper) => void;
}

export function LiteraturePanel({
  papers,
  onSelectPaper,
  onAddPaper,
  onUseInChat,
}: LiteraturePanelProps) {
  return (
    <PapersPanel
      papers={papers}
      onSelectPaper={onSelectPaper}
      onAddPaper={onAddPaper}
      onUseInChat={onUseInChat}
    />
  );
}
