"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import type { ChartSpec } from "@/lib/chart-generator";
import type { DataTable } from "@/lib/data-transform";

interface ChartResult {
  svg: string;
  title: string;
}

interface WorkspaceDataFile {
  path: string;
  name: string;
  extension: string;
}

interface PendingChartPlan {
  sourceLabel: string;
  charts: ChartSpec[];
  previews: ChartSelectionPreview[];
}

interface ChartSelectionPreview {
  title: string;
  type: ChartSpec["type"];
  xColumn: string;
  yColumn: string;
  groupBy?: string;
  selectedRowCount: number;
  omittedRowCount: number;
  sampleColumns: string[];
  sampleRows: Array<Array<string | number | null>>;
}

type ExportFormat = "csv" | "json" | "markdown" | "latex";
type PreviewState =
  | {
      kind: "message";
      title: string;
      content: string;
    }
  | {
      kind: "text";
      title: string;
      content: string;
    };

function getFileBadge(extension: string): string {
  if (!extension) return "FILE";
  return extension.toUpperCase();
}

function coerceWorkbookCell(value: string): string | number | null {
  if (value === "" || value.toLowerCase() === "null") {
    return null;
  }

  const numericValue = Number(value);
  if (!Number.isNaN(numericValue) && value.trim() !== "") {
    return numericValue;
  }

  return value;
}

function parseWorkbookPreview(content: string): DataTable | null {
  const rows: Array<Array<string | number | null>> = [];
  let inFirstSheet = false;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      if (inFirstSheet && rows.length > 0) {
        break;
      }
      continue;
    }

    if (line.startsWith("Sheet: ")) {
      if (inFirstSheet && rows.length > 0) {
        break;
      }
      inFirstSheet = true;
      continue;
    }

    if (!inFirstSheet || !line.includes(" | ")) {
      continue;
    }

    rows.push(line.split(" | ").map((cell) => coerceWorkbookCell(cell.trim())));
  }

  if (rows.length === 0) {
    return null;
  }

  const [headerRow, ...dataRows] = rows;
  const columns = headerRow.map((cell, index) => String(cell ?? `Column ${index + 1}`));

  return {
    columns,
    rows: dataRows.map((row) =>
      columns.map((_, index) => row[index] ?? null),
    ),
    metadata: {
      source: "xlsx",
      rowCount: dataRows.length,
      transformsApplied: ["parseXLSXPreview"],
    },
  };
}

function formatChartType(type: ChartSpec["type"]): string {
  switch (type) {
    case "bar":
      return "Bar chart";
    case "line":
      return "Line chart";
    case "scatter":
      return "Scatter plot";
    case "histogram":
      return "Histogram";
    case "heatmap":
      return "Heatmap";
    case "box":
      return "Box plot";
    default:
      return "Chart";
  }
}

function buildChartSelectionPreview(table: DataTable, spec: ChartSpec): ChartSelectionPreview {
  const sampleColumns = Array.from(
    new Set([spec.xColumn, spec.yColumn, spec.groupBy].filter((value): value is string => Boolean(value))),
  );
  const sampleIndexes = sampleColumns.map((column) => table.columns.indexOf(column));
  const requiredIndexes = [table.columns.indexOf(spec.xColumn), table.columns.indexOf(spec.yColumn)];
  const selectedRows = table.rows.filter((row) =>
    requiredIndexes.every((index) => index >= 0 && row[index] !== null && row[index] !== ""),
  );

  return {
    title: spec.title,
    type: spec.type,
    xColumn: spec.xColumn,
    yColumn: spec.yColumn,
    groupBy: spec.groupBy,
    selectedRowCount: selectedRows.length,
    omittedRowCount: Math.max(table.rows.length - selectedRows.length, 0),
    sampleColumns,
    sampleRows: selectedRows
      .slice(0, 5)
      .map((row) => sampleIndexes.map((index) => (index >= 0 ? row[index] ?? null : null))),
  };
}

export function DataPanel({
  dataFiles,
  projectId,
  onGeneratedCharts,
  onUseInChat,
}: {
  dataFiles: WorkspaceDataFile[];
  projectId?: string | null;
  onGeneratedCharts?: (sourceLabel: string, svgs: string[]) => Promise<unknown>;
  onUseInChat?: (path: string) => void;
}) {
  const [selectedPath, setSelectedPath] = useState<string | null>(dataFiles[0]?.path ?? null);
  const [table, setTable] = useState<DataTable | null>(null);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [charts, setCharts] = useState<ChartResult[]>([]);
  const [pendingChartPlan, setPendingChartPlan] = useState<PendingChartPlan | null>(null);
  const [insights, setInsights] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sortCol, setSortCol] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [expandedChart, setExpandedChart] = useState<number | null>(null);

  const selectedFile = useMemo(
    () => dataFiles.find((file) => file.path === selectedPath) ?? dataFiles[0] ?? null,
    [dataFiles, selectedPath],
  );

  useEffect(() => {
    if (!selectedFile && dataFiles[0]) {
      setSelectedPath(dataFiles[0].path);
      return;
    }

    if (selectedFile && !dataFiles.some((file) => file.path === selectedFile.path)) {
      setSelectedPath(dataFiles[0]?.path ?? null);
    }
  }, [dataFiles, selectedFile]);

  const loadParsedTable = useCallback(async (text: string, format: "csv" | "tsv" | "json") => {
    const res = await fetch("/api/transform", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "parse", data: text, format }),
    });
    const result = await res.json();
    if (result.error) {
      throw new Error(result.error);
    }
    return result.table as DataTable;
  }, []);

  const loadSelectedFile = useCallback(async (file: WorkspaceDataFile) => {
    setLoading(true);
    setError(null);
    setCharts([]);
    setPendingChartPlan(null);
    setInsights(null);
    setExpandedChart(null);

    const params = new URLSearchParams({
      action: "read",
      file: file.path,
    });
    if (projectId) {
      params.set("projectId", projectId);
    }

    try {
      const res = await fetch(`/api/workspace?${params.toString()}`);
      const payload = await res.json().catch(() => ({})) as {
        content?: string;
        error?: string;
        tooLarge?: boolean;
        binary?: boolean;
        parsed?: boolean;
        format?: string;
      };

      if (!res.ok) {
        throw new Error(payload.error || `Failed to read ${file.name}`);
      }

      if (payload.tooLarge) {
        setTable(null);
        setPreview({
          kind: "message",
          title: "Preview unavailable",
          content: `${file.name} is too large to render directly in the Data tab.`,
        });
        return;
      }

      if (payload.binary) {
        setTable(null);
        setPreview({
          kind: "message",
          title: "Binary data file",
          content: `${file.name} cannot be rendered as a sheet preview yet.`,
        });
        return;
      }

      if (typeof payload.content !== "string") {
        throw new Error(`Could not load ${file.name} into Data.`);
      }

      if (file.extension === "csv" || file.extension === "tsv" || file.extension === "json") {
        const nextTable = await loadParsedTable(payload.content, file.extension);
        setTable(nextTable);
        setPreview(null);
        return;
      }

      if ((file.extension === "xlsx" || file.extension === "xlsm") && payload.parsed) {
        const workbookTable = parseWorkbookPreview(payload.content);
        if (workbookTable) {
          setTable(workbookTable);
          setPreview({
            kind: "text",
            title: "Workbook preview",
            content: payload.content,
          });
          return;
        }
      }

      setTable(null);
      setPreview({
        kind: "text",
        title: payload.parsed ? "Parsed data preview" : "Data preview",
        content: payload.content,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load workspace data");
      setTable(null);
      setPreview(null);
    } finally {
      setLoading(false);
    }
  }, [loadParsedTable, projectId]);

  useEffect(() => {
    if (!selectedFile) {
      setTable(null);
      setPreview(null);
      setError(null);
      return;
    }

    void loadSelectedFile(selectedFile);
  }, [loadSelectedFile, selectedFile]);

  const exportData = useCallback(
    async (format: ExportFormat) => {
      if (!table) return;
      try {
        const res = await fetch("/api/transform", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "export", table, format }),
        });
        const result = await res.json();
        if (result.error) throw new Error(result.error);

        const blob = new Blob([result.output], { type: "text/plain" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${selectedFile?.name ?? "data"}.${format === "markdown" ? "md" : format === "latex" ? "tex" : format}`;
        a.click();
        URL.revokeObjectURL(url);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Export failed");
      }
    },
    [selectedFile?.name, table],
  );

  const autoAnalyze = useCallback(async () => {
    if (!table) return;
    setLoading(true);
    setError(null);
    setCharts([]);
    setPendingChartPlan(null);
    try {
      const exportRes = await fetch("/api/transform", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "export", table, format: "csv" }),
      });
      const exportResult = await exportRes.json();
      if (exportResult.error) throw new Error(exportResult.error);

      const res = await fetch("/api/transform", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "auto-analyze", data: exportResult.output }),
      });
      const result = await res.json();
      if (result.error) throw new Error(result.error);

      setInsights(result.insights);
      const nextCharts = Array.isArray(result.charts) ? result.charts as ChartSpec[] : [];
      if (nextCharts.length === 0) {
        return;
      }

      setPendingChartPlan({
        sourceLabel: selectedFile?.name || table.metadata?.source || "data-analysis",
        charts: nextCharts,
        previews: nextCharts.map((spec) => buildChartSelectionPreview(table, spec)),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Analysis failed");
    } finally {
      setLoading(false);
    }
  }, [selectedFile?.name, table]);

  const generatePendingCharts = useCallback(async () => {
    if (!table || !pendingChartPlan) return;
    setLoading(true);
    setError(null);
    try {
      const chartResults: ChartResult[] = [];
      for (const spec of pendingChartPlan.charts) {
        const chartRes = await fetch("/api/transform", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "chart", table, spec }),
        });
        const chartData = await chartRes.json();
        if (chartData.svg) {
          chartResults.push({ svg: chartData.svg, title: spec.title });
        }
      }

      setCharts(chartResults);
      setPendingChartPlan(null);
      if (chartResults.length > 0 && onGeneratedCharts) {
        await onGeneratedCharts(
          pendingChartPlan.sourceLabel,
          chartResults.map((chart) => chart.svg),
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Chart generation failed");
    } finally {
      setLoading(false);
    }
  }, [onGeneratedCharts, pendingChartPlan, table]);

  const handleSort = useCallback((col: string) => {
    if (sortCol === col) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortCol(col);
      setSortDir("asc");
    }
  }, [sortCol, sortDir]);

  const displayRows = useMemo(() => {
    if (!table) return [];
    let rows = table.rows.slice(0, 100);
    if (sortCol) {
      const ci = table.columns.indexOf(sortCol);
      if (ci >= 0) {
        const mult = sortDir === "asc" ? 1 : -1;
        rows = [...rows].sort((a, b) => {
          const av = a[ci];
          const bv = b[ci];
          if (av === null && bv === null) return 0;
          if (av === null) return 1;
          if (bv === null) return -1;
          if (typeof av === "number" && typeof bv === "number") return (av - bv) * mult;
          return String(av).localeCompare(String(bv)) * mult;
        });
      }
    }
    return rows;
  }, [sortCol, sortDir, table]);

  const colTypes: string[] = useMemo(() => {
    if (!table) return [];
    return table.columns.map((_, ci) => {
      let hasNum = false;
      let hasStr = false;
      for (const row of table.rows.slice(0, 50)) {
        const value = row[ci];
        if (value === null) continue;
        if (typeof value === "number") {
          hasNum = true;
        } else {
          hasStr = true;
        }
      }
      if (hasNum && !hasStr) return "#";
      if (hasStr && !hasNum) return "Aa";
      return "?";
    });
  }, [table]);

  if (dataFiles.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="max-w-lg rounded-2xl border border-border bg-white p-8 text-center">
          <div className="text-4xl mb-4">📊</div>
          <h3 className="text-lg font-bold text-foreground mb-2">No workspace tables yet</h3>
          <p className="text-sm text-muted">
            The Data tab shows tabular files already present in the current study workspace,
            such as CSV, TSV, JSON, and spreadsheet files.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full overflow-hidden bg-white">
      <aside className="w-72 shrink-0 border-r-2 border-border bg-surface/30">
        <div className="border-b border-border px-4 py-3">
          <h3 className="text-xs font-bold uppercase tracking-wider text-muted">Workspace data</h3>
          <p className="mt-1 text-xs text-muted">
            Showing {dataFiles.length} table{dataFiles.length === 1 ? "" : "s"} from this study.
          </p>
        </div>
        <div className="overflow-y-auto p-2">
          {dataFiles.map((file) => {
            const isActive = selectedFile?.path === file.path;
            return (
              <button
                key={file.path}
                type="button"
                onClick={() => setSelectedPath(file.path)}
                className={`mb-1 flex w-full items-start gap-3 rounded-xl border px-3 py-3 text-left transition-colors ${
                  isActive
                    ? "border-accent bg-accent/5 text-foreground"
                    : "border-transparent bg-white text-foreground hover:border-border hover:bg-surface"
                }`}
              >
                <span className="rounded border border-border bg-surface px-1.5 py-0.5 text-[10px] font-mono text-muted">
                  {getFileBadge(file.extension)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{file.name}</span>
                  <span className="block truncate text-xs text-muted">{file.path}</span>
                </span>
              </button>
            );
          })}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="flex items-center gap-2 border-b-2 border-border bg-white px-4 py-2">
          <span className="rounded border border-border bg-surface px-2 py-1 text-[10px] font-mono uppercase text-muted">
            {selectedFile ? getFileBadge(selectedFile.extension) : "DATA"}
          </span>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-foreground">
              {selectedFile?.name || "Workspace data"}
            </div>
            <div className="truncate text-xs text-muted">
              {selectedFile?.path || "No file selected"}
            </div>
          </div>
          <div className="flex-1" />
          {table ? (
            <>
              {selectedFile && onUseInChat && (
                <button
                  onClick={() => onUseInChat(selectedFile.path)}
                  className="rounded-lg border border-border bg-white px-3 py-1.5 text-xs font-semibold text-foreground transition-colors hover:border-accent hover:text-accent"
                >
                  Use in chat
                </button>
              )}
              <span className="rounded border border-border bg-surface px-2 py-1 text-[10px] text-muted">
                {table.rows.length} rows, {table.columns.length} cols
              </span>
              <button
                onClick={autoAnalyze}
                disabled={loading}
                className="rounded-lg bg-accent px-4 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
              >
                {loading ? "Analyzing..." : "Auto Analyze"}
              </button>
              {(["csv", "json", "markdown", "latex"] as ExportFormat[]).map((format) => (
                <button
                  key={format}
                  onClick={() => exportData(format)}
                  className="rounded border border-border bg-surface px-2 py-1 text-[10px] font-medium uppercase text-muted transition-colors hover:border-accent hover:text-foreground"
                >
                  {format}
                </button>
              ))}
            </>
          ) : preview ? (
            <span className="rounded border border-border bg-surface px-2 py-1 text-[10px] text-muted">
              {preview.title}
            </span>
          ) : null}
        </div>

        {error && (
          <div className="border-b border-danger/30 bg-danger/10 px-4 py-2 text-xs text-danger">
            {error}
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-auto">
          {loading ? (
            <div className="flex h-full items-center justify-center text-sm text-muted">
              Loading workspace data…
            </div>
          ) : table ? (
            <table className="w-full border-collapse text-xs">
              <thead className="sticky top-0 z-10">
                <tr className="bg-surface">
                  <th className="w-10 border-b-2 border-border px-3 py-2 text-left font-mono font-bold text-muted">
                    #
                  </th>
                  {table.columns.map((col, ci) => (
                    <th
                      key={col}
                      onClick={() => handleSort(col)}
                      className="cursor-pointer border-b-2 border-border px-3 py-2 text-left font-bold text-foreground transition-colors hover:bg-white"
                    >
                      <div className="flex items-center gap-1.5">
                        <span className="rounded border border-border bg-white px-1 text-[9px] font-mono text-muted">
                          {colTypes[ci]}
                        </span>
                        <span>{col}</span>
                        {sortCol === col ? (
                          <span className="text-accent">{sortDir === "asc" ? "↑" : "↓"}</span>
                        ) : null}
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {displayRows.map((row, ri) => (
                  <tr key={`${selectedFile?.path || "row"}-${ri}`} className="transition-colors hover:bg-surface/50">
                    <td className="border-b border-border/50 px-3 py-1.5 font-mono text-muted">{ri + 1}</td>
                    {row.map((cell, ci) => (
                      <td
                        key={`${ri}-${ci}`}
                        className={`border-b border-border/50 px-3 py-1.5 font-mono ${
                          cell === null ? "italic text-muted/40" : "text-foreground"
                        }`}
                      >
                        {cell === null ? "null" : String(cell)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          ) : preview ? (
            <div className="p-6">
              <div className="mb-3 text-sm font-semibold text-foreground">{preview.title}</div>
              <pre className="overflow-x-auto whitespace-pre-wrap rounded-xl border border-border bg-surface p-4 text-xs leading-relaxed text-foreground">
                {preview.content}
              </pre>
            </div>
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted">
              Select a workspace data file to preview it here.
            </div>
          )}
        </div>

        {pendingChartPlan && (
          <div className="shrink-0 border-t-2 border-border bg-surface/20">
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3">
              <div>
                <h4 className="text-sm font-bold text-foreground">Confirm chart inputs</h4>
                <p className="mt-1 text-xs text-muted">
                  Review the extracted columns and sample rows before plotting.
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setPendingChartPlan(null)}
                  className="rounded-lg border border-border bg-white px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:text-foreground"
                >
                  Dismiss
                </button>
                <button
                  type="button"
                  onClick={generatePendingCharts}
                  disabled={loading}
                  className="rounded-lg bg-accent px-4 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
                >
                  {loading ? "Generating…" : `Generate ${pendingChartPlan.charts.length} chart${pendingChartPlan.charts.length === 1 ? "" : "s"}`}
                </button>
              </div>
            </div>
            <div className="grid gap-3 p-4 md:grid-cols-2">
              {pendingChartPlan.previews.map((previewItem, index) => (
                <section
                  key={`${previewItem.title}-${index}`}
                  className="rounded-2xl border border-border bg-white p-4"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <div className="text-sm font-semibold text-foreground">{previewItem.title}</div>
                      <div className="mt-1 text-xs text-muted">
                        {formatChartType(previewItem.type)} · {previewItem.selectedRowCount} row{previewItem.selectedRowCount === 1 ? "" : "s"} selected
                        {previewItem.omittedRowCount > 0 ? ` · ${previewItem.omittedRowCount} omitted` : ""}
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-1 text-[10px] font-medium uppercase tracking-wide text-muted">
                      <span className="rounded border border-border bg-surface px-2 py-1">X: {previewItem.xColumn}</span>
                      <span className="rounded border border-border bg-surface px-2 py-1">Y: {previewItem.yColumn}</span>
                      {previewItem.groupBy ? (
                        <span className="rounded border border-border bg-surface px-2 py-1">Group: {previewItem.groupBy}</span>
                      ) : null}
                    </div>
                  </div>

                  {previewItem.sampleColumns.length > 0 ? (
                    <>
                      <div className="mt-3 overflow-x-auto rounded-xl border border-border">
                        <table className="min-w-full border-collapse text-xs">
                          <thead className="bg-surface">
                            <tr>
                              {previewItem.sampleColumns.map((column) => (
                                <th
                                  key={column}
                                  className="border-b border-border px-3 py-2 text-left font-semibold text-foreground"
                                >
                                  {column}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {previewItem.sampleRows.length > 0 ? previewItem.sampleRows.map((row, rowIndex) => (
                              <tr key={`${previewItem.title}-sample-${rowIndex}`}>
                                {row.map((cell, cellIndex) => (
                                  <td
                                    key={`${previewItem.title}-sample-${rowIndex}-${cellIndex}`}
                                    className="border-b border-border/50 px-3 py-2 font-mono text-foreground"
                                  >
                                    {cell === null ? "null" : String(cell)}
                                  </td>
                                ))}
                              </tr>
                            )) : (
                              <tr>
                                <td
                                  colSpan={previewItem.sampleColumns.length}
                                  className="px-3 py-3 text-left text-xs text-muted"
                                >
                                  No rows with values in the selected chart columns.
                                </td>
                              </tr>
                            )}
                          </tbody>
                        </table>
                      </div>
                      <p className="mt-2 text-[11px] text-muted">
                        Showing up to the first {Math.min(previewItem.sampleRows.length, 5)} plotted rows for confirmation.
                      </p>
                    </>
                  ) : (
                    <p className="mt-3 text-xs text-muted">
                      This chart did not resolve any previewable columns from the extracted table.
                    </p>
                  )}
                </section>
              ))}
            </div>
          </div>
        )}

        {charts.length > 0 && (
          <div className="shrink-0 border-t-2 border-border bg-white">
            <div className="border-b border-border px-4 py-2">
              <h4 className="text-xs font-bold text-foreground">Charts</h4>
            </div>
            <div className="flex gap-3 overflow-x-auto p-4">
              {charts.map((chart, index) => (
                <button
                  key={`${chart.title}-${index}`}
                  onClick={() => setExpandedChart(expandedChart === index ? null : index)}
                  className={`overflow-hidden rounded-xl border-2 bg-white transition-all hover:border-accent ${
                    expandedChart === index ? "w-[500px] border-accent" : "w-56 border-border"
                  }`}
                >
                  <div className="w-full" dangerouslySetInnerHTML={{ __html: chart.svg }} />
                </button>
              ))}
            </div>
          </div>
        )}

        {insights && (
          <div className="max-h-40 shrink-0 overflow-y-auto border-t-2 border-border bg-surface/30 px-4 py-3">
            <h4 className="mb-2 text-xs font-bold text-foreground">Insights</h4>
            <div className="whitespace-pre-wrap text-xs leading-relaxed text-foreground">
              {insights.split(/(\*\*[^*]+\*\*)/g).map((part, index) =>
                part.startsWith("**") && part.endsWith("**") ? (
                  <strong key={index} className="font-semibold">
                    {part.slice(2, -2)}
                  </strong>
                ) : (
                  <span key={index}>{part}</span>
                ),
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
