import { DataPanel as DataPanelComponent } from "@/components/research/data-panel";
import type { ComponentProps } from "react";

type DataPanelComponentProps = ComponentProps<typeof DataPanelComponent>;

export interface DataPanelProps {
  dataFiles: DataPanelComponentProps["dataFiles"];
  projectId: DataPanelComponentProps["projectId"];
  onGeneratedCharts: DataPanelComponentProps["onGeneratedCharts"];
  onUseInChat?: DataPanelComponentProps["onUseInChat"];
}

export function DataPanel({
  dataFiles,
  projectId,
  onGeneratedCharts,
  onUseInChat,
}: DataPanelProps) {
  return (
    <DataPanelComponent
      dataFiles={dataFiles}
      projectId={projectId}
      onGeneratedCharts={onGeneratedCharts}
      onUseInChat={onUseInChat}
    />
  );
}
