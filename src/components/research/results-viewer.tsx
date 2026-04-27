import type { ChartPalette, ChartSpec } from "@/lib/chart-generator";
import type { ArtifactProvenanceEntry } from "@/lib/artifact-provenance";

export interface DataPoint {
  label: string;
  value: number;
  color?: string;
}

export interface ResultsStat {
  label: string;
  value: string;
  unit?: string;
  trend?: "up" | "down" | "neutral";
}

export interface ResultsData {
  stats?: ResultsStat[];
  chartData?: DataPoint[];
  secondaryChartData?: DataPoint[];
  secondaryChartTitle?: string;
  tableHeaders?: string[];
  tableRows?: (string | number)[][];
  /**
   * Optional workspace-relative path per table row. When supplied and
   * `onSelectFile` is passed to `<ResultsViewer>`, clicking a row opens
   * the file at that path in the editor tab.
   */
  tableRowPaths?: string[];
  tableTitle?: string;
}

export type ResultFileGroup = "chart" | "report" | "media" | "table" | "log";

interface ResultFileBase {
  path: string;
  name: string;
}

export interface ResultWorkspaceFile extends ResultFileBase {
  group: Exclude<ResultFileGroup, "chart">;
}

export interface ResultArtifactInboxFile extends ResultFileBase {
  createdAt?: string;
}

export interface ResultChartAsset extends ResultFileBase {
  extension: string;
  group: "chart";
}

export interface ResultPreview {
  path: string;
  url: string;
  kind: "iframe" | "image" | "video";
}

export interface EditableChartSession {
  path: string;
  title: string;
  chartType: ChartSpec["type"];
  xColumn: string;
  yColumn: string;
  xLabel: string;
  yLabel: string;
  palette: ChartPalette;
  availableColumns: string[];
  sourceLabel: string;
  isSaving: boolean;
  status: string | null;
  error: string | null;
}

function getVideoMimeType(path: string): string | undefined {
  const ext = path.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "mp4":
    case "m4v":
      return "video/mp4";
    case "webm":
      return "video/webm";
    case "mov":
      return "video/quicktime";
    case "ogg":
      return "video/ogg";
    default:
      return undefined;
  }
}

function formatCreatedAt(createdAt: string): string {
  const value = new Date(createdAt);
  if (Number.isNaN(value.getTime())) {
    return createdAt;
  }

  return value.toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function BarChart({ data, title }: { data: DataPoint[]; title: string }) {
  const max = Math.max(...data.map((d) => d.value));

  return (
    <div className="bg-white border-2 border-border rounded-xl p-4">
      <h4 className="text-sm font-bold mb-3">{title}</h4>
      <div className="space-y-2">
        {data.map((d) => (
          <div key={d.label} className="flex items-center gap-3">
            <span className="text-xs text-muted w-24 text-right truncate">{d.label}</span>
            <div className="flex-1 h-6 bg-surface rounded-full overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{
                  width: `${(d.value / max) * 100}%`,
                  backgroundColor: d.color || "var(--accent)",
                }}
              />
            </div>
            <span className="text-xs font-mono font-bold w-12">{d.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function StatCard({ label, value, unit, trend }: { label: string; value: string; unit?: string; trend?: "up" | "down" | "neutral" }) {
  return (
    <div className="bg-white border-2 border-border rounded-xl p-4">
      <p className="text-xs text-muted mb-1">{label}</p>
      <div className="flex items-baseline gap-1">
        <span className="text-2xl font-bold font-mono">{value}</span>
        {unit && <span className="text-sm text-muted">{unit}</span>}
        {trend && (
          <span className={`text-xs ml-2 ${trend === "up" ? "text-ok" : trend === "down" ? "text-danger" : "text-muted"}`}>
            {trend === "up" ? "▲" : trend === "down" ? "▼" : "—"}
          </span>
        )}
      </div>
    </div>
  );
}

function TableView({
  headers,
  rows,
  rowPaths,
  title,
  onRowSelect,
}: {
  headers: string[];
  rows: (string | number)[][];
  rowPaths?: string[];
  title: string;
  onRowSelect?: (path: string) => void;
}) {
  return (
    <div className="bg-white border-2 border-border rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-border">
        <h4 className="text-sm font-bold">{title}</h4>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-surface">
              {headers.map((h) => (
                <th key={h} className="text-left px-4 py-2 font-bold text-muted border-b border-border">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const path = rowPaths?.[i];
              const clickable = Boolean(path && onRowSelect);
              return (
                <tr
                  key={i}
                  className={`transition-colors ${
                    clickable
                      ? "cursor-pointer hover:bg-accent/5 focus-within:bg-accent/5"
                      : "hover:bg-surface/50"
                  }`}
                  onClick={clickable ? () => onRowSelect!(path!) : undefined}
                  onKeyDown={
                    clickable
                      ? (event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            onRowSelect!(path!);
                          }
                        }
                      : undefined
                  }
                  role={clickable ? "button" : undefined}
                  tabIndex={clickable ? 0 : undefined}
                  title={clickable ? `Open ${path} in editor` : undefined}
                >
                  {row.map((cell, j) => (
                    <td key={j} className="px-4 py-2 font-mono border-b border-border/50">
                      {cell}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const RESULT_FILE_GROUP_ORDER: Array<Exclude<ResultFileGroup, "chart">> = ["report", "media", "table", "log"];
const RESULT_FILE_GROUP_LABELS: Record<Exclude<ResultFileGroup, "chart">, string> = {
  report: "Reports",
  media: "Media",
  table: "Tables",
  log: "Logs",
};

export function ResultsViewer({
  artifactInboxFiles = [],
  data,
  chartAssets = [],
  resultFiles = [],
  artifactProvenance = [],
  preview = null,
  chartEdit = null,
  chartEditLoadingPath = null,
  onClearArtifactInbox,
  onClearPreview,
  onOpenFile,
  onPreviewChart,
  onUseInChat,
  onStartChartEdit,
  onChartEditChange,
  onCancelChartEdit,
  onRegenerateChart,
}: {
  artifactInboxFiles?: ResultArtifactInboxFile[];
  data?: ResultsData;
  chartAssets?: ResultChartAsset[];
  resultFiles?: ResultWorkspaceFile[];
  artifactProvenance?: ArtifactProvenanceEntry[];
  preview?: ResultPreview | null;
  chartEdit?: EditableChartSession | null;
  chartEditLoadingPath?: string | null;
  onClearArtifactInbox?: () => void;
  onClearPreview?: () => void;
  onOpenFile?: (path: string) => void;
  onPreviewChart?: (path: string) => void;
  onUseInChat?: (path: string) => void;
  onStartChartEdit?: (path: string) => void;
  onChartEditChange?: (next: Partial<EditableChartSession>) => void;
  onCancelChartEdit?: () => void;
  onRegenerateChart?: () => void;
}) {
  const hasArtifactInbox = artifactInboxFiles.length > 0;
  const hasStats = data?.stats && data.stats.length > 0;
  const hasChart = data?.chartData && data.chartData.length > 0;
  const hasSecondaryChart = data?.secondaryChartData && data.secondaryChartData.length > 0;
  const hasTable = data?.tableHeaders && data?.tableRows && data.tableRows.length > 0;
  const hasSavedCharts = chartAssets.length > 0;
  const nonChartResultFiles = resultFiles.filter(
    (file) => !chartAssets.some((asset) => asset.path === file.path),
  );
  const groupedResultFiles = RESULT_FILE_GROUP_ORDER.map((group) => ({
    group,
    label: RESULT_FILE_GROUP_LABELS[group],
    files: nonChartResultFiles.filter((file) => file.group === group),
  })).filter((group) => group.files.length > 0);
  const visibleArtifactPaths = new Set([
    ...chartAssets.map((asset) => asset.path),
    ...nonChartResultFiles.map((file) => file.path),
  ]);
  const visibleArtifactProvenance = artifactProvenance.filter((entry) =>
    visibleArtifactPaths.has(entry.projectPath),
  );
  const hasArtifactProvenance = visibleArtifactProvenance.length > 0;
  const hasResultFiles = nonChartResultFiles.length > 0;
  const isEmpty = !hasArtifactInbox
    && !hasStats
    && !hasChart
    && !hasSecondaryChart
    && !hasTable
    && !hasSavedCharts
    && !hasResultFiles
    && !hasArtifactProvenance;

  if (isEmpty) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center p-12">
        <div className="text-4xl mb-4">📊</div>
        <h2 className="text-lg font-bold mb-2">Results Dashboard</h2>
        <p className="text-sm text-muted max-w-md">
          No data yet. Upload CSV or JSON files to generate charts.
        </p>
        <p className="text-xs text-muted mt-2">
          Upload data files to see charts and analysis.
        </p>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6 overflow-y-auto h-full">
      <div>
        <h2 className="text-lg font-bold mb-4">Results Dashboard</h2>
        <p className="text-sm text-muted mb-6">Auto-generated from experiment outputs and data files.</p>
      </div>

      {hasArtifactInbox && (
        <div className="bg-white border-2 border-border rounded-xl p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <h4 className="text-sm font-bold">Artifact inbox</h4>
              <p className="text-[11px] text-muted">Fresh files land here before the workspace tabs sort them.</p>
            </div>
            {onClearArtifactInbox && (
              <button
                type="button"
                onClick={onClearArtifactInbox}
                className="rounded-lg border border-border bg-surface px-2.5 py-1 text-[11px] font-semibold text-foreground transition-colors hover:border-accent hover:text-accent"
              >
                Clear inbox
              </button>
            )}
          </div>
          <div className="space-y-2">
            {artifactInboxFiles.map((file) => (
              <button
                key={file.path}
                type="button"
                onClick={() => onOpenFile?.(file.path)}
                className="flex w-full items-center justify-between gap-3 rounded-lg border border-border bg-surface px-3 py-2 text-left transition-colors hover:border-accent"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-xs font-semibold truncate">{file.name}</p>
                    <span className="rounded-full bg-accent/10 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-accent">
                      New
                    </span>
                  </div>
                  <p className="text-[11px] text-muted truncate">{file.path}</p>
                </div>
                <span className="text-[11px] font-semibold text-accent">Open</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Stats row */}
      {hasStats && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {data!.stats!.map((stat) => (
            <StatCard key={stat.label} {...stat} />
          ))}
        </div>
      )}

      {/* Charts */}
      {(hasChart || hasSecondaryChart) && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {hasChart && <BarChart data={data!.chartData!} title="Primary Results" />}
          {hasSecondaryChart && (
            <BarChart data={data!.secondaryChartData!} title={data!.secondaryChartTitle || "Secondary Results"} />
          )}
        </div>
      )}

      {/* Results table */}
      {hasTable && (
        <TableView
          headers={data!.tableHeaders!}
          rows={data!.tableRows!}
          rowPaths={data!.tableRowPaths}
          title={data!.tableTitle || "Results Summary"}
          onRowSelect={onOpenFile}
        />
      )}

      {hasSavedCharts && (
        <div className="bg-white border-2 border-border rounded-xl p-4">
          <h4 className="text-sm font-bold mb-3">Generated charts</h4>
          <div className="space-y-2">
            {chartAssets.map((asset) => (
              <div key={asset.path} className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface px-3 py-2">
                <div className="min-w-0">
                  <p className="text-xs font-semibold truncate">{asset.name}</p>
                  <p className="text-[11px] text-muted truncate">{asset.path}</p>
                </div>
                <div className="flex gap-2">
                  {onUseInChat && (
                    <button
                      type="button"
                      onClick={() => onUseInChat(asset.path)}
                      className="rounded-lg border border-border bg-white px-2.5 py-1 text-[11px] font-semibold text-foreground transition-colors hover:border-accent hover:text-accent"
                    >
                      Use in chat
                    </button>
                  )}
                  {onPreviewChart && (
                    <button
                      type="button"
                      onClick={() => onPreviewChart(asset.path)}
                      className="rounded-lg border border-border bg-white px-2.5 py-1 text-[11px] font-semibold text-foreground transition-colors hover:border-accent hover:text-accent"
                    >
                      Preview
                    </button>
                  )}
                  {onOpenFile && (
                    <button
                      type="button"
                      onClick={() => onOpenFile(asset.path)}
                      className="rounded-lg border border-border bg-white px-2.5 py-1 text-[11px] font-semibold text-foreground transition-colors hover:border-accent hover:text-accent"
                    >
                      Open file
                    </button>
                  )}
                  {onStartChartEdit && asset.extension === "svg" && (
                    <button
                      type="button"
                      onClick={() => onStartChartEdit(asset.path)}
                      disabled={chartEditLoadingPath === asset.path || chartEdit?.isSaving === true}
                      className="rounded-lg border border-border bg-white px-2.5 py-1 text-[11px] font-semibold text-foreground transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {chartEditLoadingPath === asset.path
                        ? "Loading..."
                        : chartEdit?.path === asset.path
                          ? "Editing"
                          : "Edit"}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {chartEdit && onChartEditChange && onRegenerateChart && (
        <div className="bg-white border-2 border-border rounded-xl p-4 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h4 className="text-sm font-bold">Edit chart</h4>
              <p className="text-[11px] text-muted">{chartEdit.path}</p>
              <p className="text-[11px] text-muted">Source data: {chartEdit.sourceLabel}</p>
            </div>
            {onCancelChartEdit && (
              <button
                type="button"
                onClick={onCancelChartEdit}
                className="rounded-lg border border-border bg-surface px-2.5 py-1 text-[11px] font-semibold text-foreground transition-colors hover:border-accent hover:text-accent"
              >
                Close
              </button>
            )}
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <label className="space-y-1">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">Title</span>
              <input
                type="text"
                value={chartEdit.title}
                onChange={(event) => onChartEditChange({ title: event.target.value, status: null, error: null })}
                className="w-full rounded-lg border border-border bg-white px-3 py-2 text-sm"
              />
            </label>

            <label className="space-y-1">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">Chart type</span>
              <select
                value={chartEdit.chartType}
                onChange={(event) => onChartEditChange({ chartType: event.target.value as ChartSpec["type"], status: null, error: null })}
                className="w-full rounded-lg border border-border bg-white px-3 py-2 text-sm"
              >
                <option value="bar">Bar</option>
                <option value="line">Line</option>
                <option value="scatter">Scatter</option>
                <option value="histogram">Histogram</option>
                <option value="box">Box</option>
                <option value="heatmap">Heatmap</option>
              </select>
            </label>

            <label className="space-y-1">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">X column</span>
              <select
                value={chartEdit.xColumn}
                onChange={(event) => onChartEditChange({ xColumn: event.target.value, status: null, error: null })}
                className="w-full rounded-lg border border-border bg-white px-3 py-2 text-sm"
              >
                {chartEdit.availableColumns.map((column) => (
                  <option key={column} value={column}>{column}</option>
                ))}
              </select>
            </label>

            <label className="space-y-1">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">Y column</span>
              <select
                value={chartEdit.yColumn}
                onChange={(event) => onChartEditChange({ yColumn: event.target.value, status: null, error: null })}
                className="w-full rounded-lg border border-border bg-white px-3 py-2 text-sm"
              >
                {chartEdit.availableColumns.map((column) => (
                  <option key={column} value={column}>{column}</option>
                ))}
              </select>
            </label>

            <label className="space-y-1">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">X label</span>
              <input
                type="text"
                value={chartEdit.xLabel}
                onChange={(event) => onChartEditChange({ xLabel: event.target.value, status: null, error: null })}
                className="w-full rounded-lg border border-border bg-white px-3 py-2 text-sm"
              />
            </label>

            <label className="space-y-1">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">Y label</span>
              <input
                type="text"
                value={chartEdit.yLabel}
                onChange={(event) => onChartEditChange({ yLabel: event.target.value, status: null, error: null })}
                className="w-full rounded-lg border border-border bg-white px-3 py-2 text-sm"
              />
            </label>

            <label className="space-y-1 md:col-span-2">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">Palette</span>
              <select
                value={chartEdit.palette}
                onChange={(event) => onChartEditChange({ palette: event.target.value as ChartPalette, status: null, error: null })}
                className="w-full rounded-lg border border-border bg-white px-3 py-2 text-sm"
              >
                <option value="ocean">Ocean</option>
                <option value="emerald">Emerald</option>
                <option value="sunset">Sunset</option>
                <option value="mono">Monochrome</option>
              </select>
            </label>
          </div>

          {(chartEdit.error || chartEdit.status) && (
            <p className={`text-xs ${chartEdit.error ? "text-danger" : "text-ok"}`}>
              {chartEdit.error ?? chartEdit.status}
            </p>
          )}

          <div className="flex justify-end">
            <button
              type="button"
              onClick={onRegenerateChart}
              disabled={chartEdit.isSaving}
              className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
            >
              {chartEdit.isSaving ? "Regenerating..." : "Regenerate in place"}
            </button>
          </div>
        </div>
      )}

      {hasArtifactProvenance && (
        <div className="bg-white border-2 border-border rounded-xl p-4">
          <h4 className="text-sm font-bold mb-3">Artifact provenance</h4>
          <div className="space-y-3">
            {visibleArtifactProvenance.map((entry) => (
              <div
                key={entry.projectPath}
                className="rounded-xl border border-border bg-surface px-4 py-3"
              >
                <div className="mb-3 min-w-0">
                  <p className="text-xs font-semibold truncate">{entry.projectPath.split("/").pop() || entry.projectPath}</p>
                  <p className="text-[11px] text-muted truncate">{entry.projectPath}</p>
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">Source file</p>
                    <p className="mt-1 text-xs text-foreground whitespace-pre-wrap">
                      {entry.sourceFiles.length > 0 ? entry.sourceFiles.join(", ") : "Not captured"}
                    </p>
                  </div>
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">Tool</p>
                    <p className="mt-1 text-xs text-foreground">{entry.tool}</p>
                  </div>
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">Created</p>
                    <p className="mt-1 text-xs text-foreground">{formatCreatedAt(entry.createdAt)}</p>
                  </div>
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">Study path</p>
                    <p className="mt-1 text-xs font-mono text-foreground break-all">{entry.projectPath}</p>
                  </div>
                  <div className="md:col-span-2">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">Prompt</p>
                    <p className="mt-1 text-xs text-foreground whitespace-pre-wrap">{entry.prompt || "Not captured"}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {preview && (
        <div className="bg-white border-2 border-border rounded-xl p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h4 className="text-sm font-bold">Result preview</h4>
              <p className="text-[11px] text-muted truncate">{preview.path}</p>
            </div>
            {onClearPreview && (
              <button
                type="button"
                onClick={onClearPreview}
                className="rounded-lg border border-border bg-surface px-2.5 py-1 text-[11px] font-semibold text-foreground transition-colors hover:border-accent hover:text-accent"
              >
                Clear
              </button>
            )}
          </div>
          <div className="overflow-hidden rounded-xl border border-border bg-surface/40">
            {preview.kind === "image" ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={preview.url}
                alt={preview.path}
                className="max-h-[32rem] w-full object-contain bg-white"
              />
            ) : preview.kind === "video" ? (
              <video
                controls
                className="max-h-[32rem] w-full bg-black"
              >
                <source src={preview.url} type={getVideoMimeType(preview.path)} />
              </video>
            ) : (
              <iframe
                src={preview.url}
                title={preview.path}
                className="h-[32rem] w-full bg-white"
              />
            )}
          </div>
        </div>
      )}

      {hasResultFiles && (
        <div className="bg-white border-2 border-border rounded-xl p-4">
          <h4 className="text-sm font-bold mb-3">Workspace outputs</h4>
          <div className="space-y-4">
            {groupedResultFiles.map((group) => (
              <section key={group.group} className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <h5 className="text-[11px] font-bold uppercase tracking-[0.18em] text-muted">
                    {group.label}
                  </h5>
                  <span className="rounded-full bg-surface px-2 py-0.5 text-[11px] font-semibold text-muted">
                    {group.files.length}
                  </span>
                </div>
                <div className="space-y-2">
                  {group.files.map((file) => (
                    <div
                      key={file.path}
                      className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface px-3 py-2"
                    >
                      <button
                        type="button"
                        onClick={() => onOpenFile?.(file.path)}
                        className="min-w-0 flex-1 text-left transition-colors hover:text-accent"
                      >
                        <p className="text-xs font-semibold truncate">{file.name}</p>
                        <p className="text-[11px] text-muted truncate">{file.path}</p>
                      </button>
                      <div className="flex gap-2">
                        {onUseInChat && (
                          <button
                            type="button"
                            onClick={() => onUseInChat(file.path)}
                            className="rounded-lg border border-border bg-white px-2.5 py-1 text-[11px] font-semibold text-foreground transition-colors hover:border-accent hover:text-accent"
                          >
                            Use in chat
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => onOpenFile?.(file.path)}
                          className="rounded-lg border border-border bg-white px-2.5 py-1 text-[11px] font-semibold text-accent transition-colors hover:border-accent"
                        >
                          Open
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </div>
      )}

      <div className="text-xs text-muted text-center py-4">
        Charts auto-generated from experiment data. Upload CSV/JSON results to update.
      </div>
    </div>
  );
}
