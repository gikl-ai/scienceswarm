import { ResultsViewer } from "@/components/research/results-viewer";
import type { ComponentProps } from "react";

type ResultsViewerProps = ComponentProps<typeof ResultsViewer>;

export interface ResultsPanelProps {
  artifactInboxFiles?: ResultsViewerProps["artifactInboxFiles"];
  data: ResultsViewerProps["data"];
  chartAssets: ResultsViewerProps["chartAssets"];
  resultFiles: ResultsViewerProps["resultFiles"];
  artifactProvenance?: ResultsViewerProps["artifactProvenance"];
  preview: ResultsViewerProps["preview"];
  chartEdit?: ResultsViewerProps["chartEdit"];
  chartEditLoadingPath?: ResultsViewerProps["chartEditLoadingPath"];
  onClearArtifactInbox?: ResultsViewerProps["onClearArtifactInbox"];
  onClearPreview: NonNullable<ResultsViewerProps["onClearPreview"]>;
  onOpenFile: NonNullable<ResultsViewerProps["onOpenFile"]>;
  onPreviewChart: NonNullable<ResultsViewerProps["onPreviewChart"]>;
  onUseInChat?: ResultsViewerProps["onUseInChat"];
  onStartChartEdit?: ResultsViewerProps["onStartChartEdit"];
  onChartEditChange?: ResultsViewerProps["onChartEditChange"];
  onCancelChartEdit?: ResultsViewerProps["onCancelChartEdit"];
  onRegenerateChart?: ResultsViewerProps["onRegenerateChart"];
}

export function ResultsPanel({
  artifactInboxFiles,
  data,
  chartAssets,
  resultFiles,
  artifactProvenance,
  preview,
  onClearArtifactInbox,
  onClearPreview,
  onOpenFile,
  onPreviewChart,
  chartEdit,
  chartEditLoadingPath,
  onStartChartEdit,
  onChartEditChange,
  onCancelChartEdit,
  onRegenerateChart,
  onUseInChat,
}: ResultsPanelProps) {
  return (
    <ResultsViewer
      artifactInboxFiles={artifactInboxFiles}
      data={data}
      chartAssets={chartAssets}
      resultFiles={resultFiles}
      artifactProvenance={artifactProvenance}
      preview={preview}
      chartEdit={chartEdit}
      chartEditLoadingPath={chartEditLoadingPath}
      onClearArtifactInbox={onClearArtifactInbox}
      onClearPreview={onClearPreview}
      onOpenFile={onOpenFile}
      onPreviewChart={onPreviewChart}
      onStartChartEdit={onStartChartEdit}
      onChartEditChange={onChartEditChange}
      onCancelChartEdit={onCancelChartEdit}
      onRegenerateChart={onRegenerateChart}
      onUseInChat={onUseInChat}
    />
  );
}
