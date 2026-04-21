// ── Auto Chart Generation ─────────────────────────────────────
// Pure SVG chart rendering — no external dependencies.

import { type DataTable, detectColumnTypes } from "./data-transform";

export interface ChartSpec {
  type: "bar" | "line" | "scatter" | "histogram" | "heatmap" | "box";
  title: string;
  xColumn: string;
  yColumn: string;
  groupBy?: string;
  xLabel?: string;
  yLabel?: string;
  palette?: ChartPalette;
  data: DataTable;
}

export interface ChartRecommendation {
  spec: ChartSpec;
  reason: string;
  score: number;
}

// ── ScienceSwarm Palette ───────────────────────────────────────

export type ChartPalette = "ocean" | "emerald" | "sunset" | "mono";

const PALETTES: Record<ChartPalette, string[]> = {
  ocean: [
    "#0891b2",
    "#0e7490",
    "#155e75",
    "#06b6d4",
    "#22d3ee",
    "#67e8f9",
    "#164e63",
    "#0284c7",
    "#0369a1",
    "#7c3aed",
  ],
  emerald: [
    "#059669",
    "#047857",
    "#10b981",
    "#34d399",
    "#6ee7b7",
    "#065f46",
    "#22c55e",
    "#16a34a",
    "#4ade80",
    "#86efac",
  ],
  sunset: [
    "#f97316",
    "#ea580c",
    "#dc2626",
    "#fb7185",
    "#f59e0b",
    "#f43f5e",
    "#7c2d12",
    "#c2410c",
    "#e11d48",
    "#fdba74",
  ],
  mono: [
    "#334155",
    "#475569",
    "#64748b",
    "#94a3b8",
    "#0f172a",
    "#1e293b",
    "#475569",
    "#64748b",
    "#94a3b8",
    "#cbd5e1",
  ],
};

const TEXT_COLOR = "#1e293b";
const GRID_COLOR = "#e2e8f0";
const BG_COLOR = "#ffffff";

// ── Chart Dimensions ──────────────────────────────────────────

interface Dims {
  width: number;
  height: number;
  margin: { top: number; right: number; bottom: number; left: number };
  plotW: number;
  plotH: number;
}

function dims(w = 600, h = 400): Dims {
  const margin = { top: 50, right: 30, bottom: 60, left: 70 };
  return {
    width: w,
    height: h,
    margin,
    plotW: w - margin.left - margin.right,
    plotH: h - margin.top - margin.bottom,
  };
}

function svgWrap(d: Dims, inner: string, title: string): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${d.width} ${d.height}" font-family="system-ui, -apple-system, sans-serif">`,
    `<rect width="${d.width}" height="${d.height}" fill="${BG_COLOR}" rx="8"/>`,
    `<text x="${d.width / 2}" y="28" text-anchor="middle" font-size="14" font-weight="600" fill="${TEXT_COLOR}">${escSvg(title)}</text>`,
    `<g transform="translate(${d.margin.left},${d.margin.top})">`,
    inner,
    `</g>`,
    `</svg>`,
  ].join("\n");
}

function escSvg(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function colorsFor(spec: ChartSpec): string[] {
  return PALETTES[spec.palette ?? "ocean"] ?? PALETTES.ocean;
}

function xAxisLabel(spec: ChartSpec): string {
  return spec.xLabel?.trim() || spec.xColumn;
}

function yAxisLabel(spec: ChartSpec): string {
  return spec.yLabel?.trim() || spec.yColumn;
}

// ── Axis Helpers ──────────────────────────────────────────────

function niceScale(minVal: number, maxVal: number, ticks: number): { min: number; max: number; step: number } {
  if (maxVal === minVal) {
    // Guard: if min and max are equal, create a range around the value
    const offset = maxVal === 0 ? 1 : Math.abs(maxVal) * 0.1;
    return { min: minVal - offset, max: maxVal + offset, step: offset };
  }
  const range = maxVal - minVal;
  const roughStep = range / ticks;
  const magnitude = Math.pow(10, Math.floor(Math.log10(roughStep)));
  const residual = roughStep / magnitude;
  let niceStep: number;
  if (residual <= 1.5) niceStep = magnitude;
  else if (residual <= 3) niceStep = 2 * magnitude;
  else if (residual <= 7) niceStep = 5 * magnitude;
  else niceStep = 10 * magnitude;

  const niceMin = Math.floor(minVal / niceStep) * niceStep;
  const niceMax = Math.ceil(maxVal / niceStep) * niceStep;
  return { min: niceMin, max: niceMax, step: niceStep };
}

function yAxis(d: Dims, scale: { min: number; max: number; step: number }): string {
  const parts: string[] = [];
  for (let v = scale.min; v <= scale.max; v += scale.step) {
    const y = d.plotH - ((v - scale.min) / (scale.max - scale.min)) * d.plotH;
    parts.push(`<line x1="0" y1="${y}" x2="${d.plotW}" y2="${y}" stroke="${GRID_COLOR}" stroke-width="1"/>`);
    const label = Math.abs(v) >= 1000 ? (v / 1000).toFixed(1) + "k" : Number.isInteger(v) ? String(v) : v.toFixed(1);
    parts.push(`<text x="-8" y="${y + 4}" text-anchor="end" font-size="10" fill="${TEXT_COLOR}">${label}</text>`);
  }
  return parts.join("\n");
}

function truncLabel(s: string, max = 12): string {
  return s.length > max ? s.slice(0, max - 1) + "\u2026" : s;
}

// ── Bar Chart ─────────────────────────────────────────────────

function renderBarChart(spec: ChartSpec): string {
  const d = dims();
  const colors = colorsFor(spec);
  const table = spec.data;
  const xci = table.columns.indexOf(spec.xColumn);
  const yci = table.columns.indexOf(spec.yColumn);
  if (xci === -1 || yci === -1) return renderEmpty(d, spec.title, "Column not found");

  const labels = table.rows.map((r) => String(r[xci] ?? ""));
  const values = table.rows.map((r) => (typeof r[yci] === "number" ? r[yci] as number : Number(r[yci]) || 0));

  if (values.length === 0) return renderEmpty(d, spec.title, "No data");

  const scale = niceScale(0, Math.max(...values, 1), 5);
  const barW = Math.min(40, (d.plotW / values.length) * 0.7);
  const gap = (d.plotW - barW * values.length) / (values.length + 1);

  const parts: string[] = [yAxis(d, scale)];

  // x axis line
  parts.push(`<line x1="0" y1="${d.plotH}" x2="${d.plotW}" y2="${d.plotH}" stroke="${TEXT_COLOR}" stroke-width="1.5"/>`);

  values.forEach((v, i) => {
    const x = gap + i * (barW + gap);
    const barH = ((v - scale.min) / (scale.max - scale.min)) * d.plotH;
    const y = d.plotH - barH;
    const color = colors[i % colors.length];

    parts.push(`<rect x="${x}" y="${y}" width="${barW}" height="${barH}" fill="${color}" rx="3"/>`);
    parts.push(`<text x="${x + barW / 2}" y="${y - 6}" text-anchor="middle" font-size="10" font-weight="600" fill="${TEXT_COLOR}">${v}</text>`);
    parts.push(`<text x="${x + barW / 2}" y="${d.plotH + 16}" text-anchor="middle" font-size="9" fill="${TEXT_COLOR}" transform="rotate(-30 ${x + barW / 2} ${d.plotH + 16})">${escSvg(truncLabel(labels[i]))}</text>`);
  });

  // axis labels
  parts.push(`<text x="${d.plotW / 2}" y="${d.plotH + 50}" text-anchor="middle" font-size="11" fill="${TEXT_COLOR}">${escSvg(xAxisLabel(spec))}</text>`);
  parts.push(`<text x="-50" y="${d.plotH / 2}" text-anchor="middle" font-size="11" fill="${TEXT_COLOR}" transform="rotate(-90 -50 ${d.plotH / 2})">${escSvg(yAxisLabel(spec))}</text>`);

  return svgWrap(d, parts.join("\n"), spec.title);
}

// ── Line Chart ────────────────────────────────────────────────

function renderLineChart(spec: ChartSpec): string {
  const d = dims();
  const colors = colorsFor(spec);
  const table = spec.data;
  const xci = table.columns.indexOf(spec.xColumn);
  const yci = table.columns.indexOf(spec.yColumn);
  if (xci === -1 || yci === -1) return renderEmpty(d, spec.title, "Column not found");

  const labels = table.rows.map((r) => String(r[xci] ?? ""));
  const values = table.rows.map((r) => (typeof r[yci] === "number" ? r[yci] as number : Number(r[yci]) || 0));

  if (values.length === 0) return renderEmpty(d, spec.title, "No data");

  const scale = niceScale(Math.min(...values), Math.max(...values), 5);
  const parts: string[] = [yAxis(d, scale)];

  // x axis
  parts.push(`<line x1="0" y1="${d.plotH}" x2="${d.plotW}" y2="${d.plotH}" stroke="${TEXT_COLOR}" stroke-width="1.5"/>`);

  // Points and line
  const points = values.map((v, i) => {
    const x = values.length === 1 ? d.plotW / 2 : (i / (values.length - 1)) * d.plotW;
    const y = d.plotH - ((v - scale.min) / (scale.max - scale.min)) * d.plotH;
    return { x, y, v, label: labels[i] };
  });

  // Line path
  const pathD = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");
  parts.push(`<path d="${pathD}" fill="none" stroke="${colors[0]}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`);

  // Area fill
  const areaD = `${pathD} L ${points[points.length - 1].x} ${d.plotH} L ${points[0].x} ${d.plotH} Z`;
  parts.push(`<path d="${areaD}" fill="${colors[0]}" opacity="0.08"/>`);

  // Data points and labels
  points.forEach((p, i) => {
    parts.push(`<circle cx="${p.x}" cy="${p.y}" r="4" fill="${BG_COLOR}" stroke="${colors[0]}" stroke-width="2"/>`);
    if (points.length <= 20) {
      parts.push(`<text x="${p.x}" y="${d.plotH + 16}" text-anchor="middle" font-size="9" fill="${TEXT_COLOR}" transform="rotate(-30 ${p.x} ${d.plotH + 16})">${escSvg(truncLabel(p.label))}</text>`);
    } else if (i % Math.ceil(points.length / 10) === 0) {
      parts.push(`<text x="${p.x}" y="${d.plotH + 16}" text-anchor="middle" font-size="9" fill="${TEXT_COLOR}">${escSvg(truncLabel(p.label))}</text>`);
    }
  });

  parts.push(`<text x="${d.plotW / 2}" y="${d.plotH + 50}" text-anchor="middle" font-size="11" fill="${TEXT_COLOR}">${escSvg(xAxisLabel(spec))}</text>`);
  parts.push(`<text x="-50" y="${d.plotH / 2}" text-anchor="middle" font-size="11" fill="${TEXT_COLOR}" transform="rotate(-90 -50 ${d.plotH / 2})">${escSvg(yAxisLabel(spec))}</text>`);

  return svgWrap(d, parts.join("\n"), spec.title);
}

// ── Scatter Plot ──────────────────────────────────────────────

function renderScatterChart(spec: ChartSpec): string {
  const d = dims();
  const colors = colorsFor(spec);
  const table = spec.data;
  const xci = table.columns.indexOf(spec.xColumn);
  const yci = table.columns.indexOf(spec.yColumn);
  if (xci === -1 || yci === -1) return renderEmpty(d, spec.title, "Column not found");

  const points = table.rows
    .map((r) => ({
      x: typeof r[xci] === "number" ? (r[xci] as number) : Number(r[xci]),
      y: typeof r[yci] === "number" ? (r[yci] as number) : Number(r[yci]),
    }))
    .filter((p) => !isNaN(p.x) && !isNaN(p.y));

  if (points.length === 0) return renderEmpty(d, spec.title, "No numeric data");

  const xScale = niceScale(Math.min(...points.map((p) => p.x)), Math.max(...points.map((p) => p.x)), 5);
  const yScale = niceScale(Math.min(...points.map((p) => p.y)), Math.max(...points.map((p) => p.y)), 5);

  const parts: string[] = [yAxis(d, yScale)];

  // x axis with labels
  parts.push(`<line x1="0" y1="${d.plotH}" x2="${d.plotW}" y2="${d.plotH}" stroke="${TEXT_COLOR}" stroke-width="1.5"/>`);
  for (let v = xScale.min; v <= xScale.max; v += xScale.step) {
    const x = ((v - xScale.min) / (xScale.max - xScale.min)) * d.plotW;
    parts.push(`<line x1="${x}" y1="${d.plotH}" x2="${x}" y2="${d.plotH + 5}" stroke="${TEXT_COLOR}" stroke-width="1"/>`);
    const label = Number.isInteger(v) ? String(v) : v.toFixed(1);
    parts.push(`<text x="${x}" y="${d.plotH + 18}" text-anchor="middle" font-size="10" fill="${TEXT_COLOR}">${label}</text>`);
  }

  // Points
  points.forEach((p) => {
    const px = ((p.x - xScale.min) / (xScale.max - xScale.min)) * d.plotW;
    const py = d.plotH - ((p.y - yScale.min) / (yScale.max - yScale.min)) * d.plotH;
    parts.push(`<circle cx="${px}" cy="${py}" r="4.5" fill="${colors[0]}" opacity="0.7"/>`);
  });

  // Trend line (linear regression)
  if (points.length >= 2) {
    const n = points.length;
    const sx = points.reduce((a, p) => a + p.x, 0);
    const sy = points.reduce((a, p) => a + p.y, 0);
    const sxy = points.reduce((a, p) => a + p.x * p.y, 0);
    const sxx = points.reduce((a, p) => a + p.x * p.x, 0);
    const denom = n * sxx - sx * sx;
    if (Math.abs(denom) > 1e-10) {
      const slope = (n * sxy - sx * sy) / denom;
      const intercept = (sy - slope * sx) / n;

      const x1 = xScale.min;
      const x2 = xScale.max;
      const y1 = slope * x1 + intercept;
      const y2 = slope * x2 + intercept;

      const px1 = 0;
      const px2 = d.plotW;
      const py1 = d.plotH - ((y1 - yScale.min) / (yScale.max - yScale.min)) * d.plotH;
      const py2 = d.plotH - ((y2 - yScale.min) / (yScale.max - yScale.min)) * d.plotH;

      parts.push(`<line x1="${px1}" y1="${py1}" x2="${px2}" y2="${py2}" stroke="${colors[2 % colors.length]}" stroke-width="1.5" stroke-dasharray="6 4" opacity="0.6"/>`);
    }
  }

  parts.push(`<text x="${d.plotW / 2}" y="${d.plotH + 50}" text-anchor="middle" font-size="11" fill="${TEXT_COLOR}">${escSvg(xAxisLabel(spec))}</text>`);
  parts.push(`<text x="-50" y="${d.plotH / 2}" text-anchor="middle" font-size="11" fill="${TEXT_COLOR}" transform="rotate(-90 -50 ${d.plotH / 2})">${escSvg(yAxisLabel(spec))}</text>`);

  return svgWrap(d, parts.join("\n"), spec.title);
}

// ── Histogram ─────────────────────────────────────────────────

function renderHistogram(spec: ChartSpec): string {
  const d = dims();
  const colors = colorsFor(spec);
  const table = spec.data;
  const yci = table.columns.indexOf(spec.yColumn);
  if (yci === -1) return renderEmpty(d, spec.title, "Column not found");

  const values = table.rows
    .map((r) => (typeof r[yci] === "number" ? (r[yci] as number) : Number(r[yci])))
    .filter((v) => !isNaN(v));

  if (values.length === 0) return renderEmpty(d, spec.title, "No numeric data");

  // Sturges' formula for bin count
  const numBins = Math.max(5, Math.ceil(Math.log2(values.length) + 1));
  const minVal = Math.min(...values);
  const maxVal = Math.max(...values);
  const binWidth = (maxVal - minVal) / numBins || 1;

  const bins: { min: number; max: number; count: number }[] = [];
  for (let i = 0; i < numBins; i++) {
    bins.push({ min: minVal + i * binWidth, max: minVal + (i + 1) * binWidth, count: 0 });
  }
  for (const v of values) {
    const idx = Math.min(Math.floor((v - minVal) / binWidth), numBins - 1);
    bins[idx].count++;
  }

  const maxCount = Math.max(...bins.map((b) => b.count), 1);
  const yScale = niceScale(0, maxCount, 5);

  const parts: string[] = [yAxis(d, yScale)];
  parts.push(`<line x1="0" y1="${d.plotH}" x2="${d.plotW}" y2="${d.plotH}" stroke="${TEXT_COLOR}" stroke-width="1.5"/>`);

  const barW = d.plotW / numBins;
  bins.forEach((bin, i) => {
    const x = i * barW;
    const barH = (bin.count / (yScale.max - yScale.min)) * d.plotH;
    const y = d.plotH - barH;

    parts.push(`<rect x="${x + 1}" y="${y}" width="${barW - 2}" height="${barH}" fill="${colors[0]}" opacity="0.8" rx="1"/>`);
    if (bin.count > 0) {
      parts.push(`<text x="${x + barW / 2}" y="${y - 4}" text-anchor="middle" font-size="9" font-weight="600" fill="${TEXT_COLOR}">${bin.count}</text>`);
    }
    const label = bin.min.toFixed(1);
    parts.push(`<text x="${x + barW / 2}" y="${d.plotH + 14}" text-anchor="middle" font-size="8" fill="${TEXT_COLOR}">${label}</text>`);
  });

  parts.push(`<text x="${d.plotW / 2}" y="${d.plotH + 50}" text-anchor="middle" font-size="11" fill="${TEXT_COLOR}">${escSvg(xAxisLabel({ ...spec, xLabel: spec.xLabel ?? spec.yLabel ?? spec.yColumn }))}</text>`);
  parts.push(`<text x="-50" y="${d.plotH / 2}" text-anchor="middle" font-size="11" fill="${TEXT_COLOR}" transform="rotate(-90 -50 ${d.plotH / 2})">${escSvg(yAxisLabel({ ...spec, yLabel: spec.yLabel ?? "Frequency" }))}</text>`);

  return svgWrap(d, parts.join("\n"), spec.title);
}

// ── Box Plot ──────────────────────────────────────────────────

function renderBoxPlot(spec: ChartSpec): string {
  const d = dims(400, 400);
  const colors = colorsFor(spec);
  const table = spec.data;
  const yci = table.columns.indexOf(spec.yColumn);
  if (yci === -1) return renderEmpty(d, spec.title, "Column not found");

  // Group by xColumn if present, else single group
  const groups = new Map<string, number[]>();
  const xci = table.columns.indexOf(spec.xColumn);

  for (const row of table.rows) {
    const key = xci >= 0 ? String(row[xci] ?? "All") : "All";
    const val = typeof row[yci] === "number" ? (row[yci] as number) : Number(row[yci]);
    if (isNaN(val)) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(val);
  }

  const entries = Array.from(groups.entries());
  if (entries.length === 0) return renderEmpty(d, spec.title, "No data");

  // Compute quartiles
  function quartiles(arr: number[]): { min: number; q1: number; median: number; q3: number; max: number } {
    const sorted = [...arr].sort((a, b) => a - b);
    const n = sorted.length;
    const q = (p: number) => {
      const idx = p * (n - 1);
      const lo = Math.floor(idx);
      const hi = Math.ceil(idx);
      return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
    };
    return { min: sorted[0], q1: q(0.25), median: q(0.5), q3: q(0.75), max: sorted[n - 1] };
  }

  const allValues = entries.flatMap(([, v]) => v);
  const globalMin = Math.min(...allValues);
  const globalMax = Math.max(...allValues);
  const yScale = niceScale(globalMin, globalMax, 5);

  const parts: string[] = [yAxis(d, yScale)];
  parts.push(`<line x1="0" y1="${d.plotH}" x2="${d.plotW}" y2="${d.plotH}" stroke="${TEXT_COLOR}" stroke-width="1.5"/>`);

  const boxW = Math.min(60, (d.plotW / entries.length) * 0.6);
  const gap = (d.plotW - boxW * entries.length) / (entries.length + 1);

  entries.forEach(([label, values], i) => {
    const q = quartiles(values);
    const cx = gap + i * (boxW + gap) + boxW / 2;
    const x = cx - boxW / 2;
    const yMap = (v: number) => d.plotH - ((v - yScale.min) / (yScale.max - yScale.min)) * d.plotH;

    const yMin = yMap(q.min);
    const yQ1 = yMap(q.q1);
    const yMed = yMap(q.median);
    const yQ3 = yMap(q.q3);
    const yMax = yMap(q.max);
    const color = colors[i % colors.length];

    // Whiskers
    parts.push(`<line x1="${cx}" y1="${yMin}" x2="${cx}" y2="${yQ1}" stroke="${color}" stroke-width="1.5"/>`);
    parts.push(`<line x1="${cx}" y1="${yQ3}" x2="${cx}" y2="${yMax}" stroke="${color}" stroke-width="1.5"/>`);
    parts.push(`<line x1="${x + boxW * 0.25}" y1="${yMin}" x2="${x + boxW * 0.75}" y2="${yMin}" stroke="${color}" stroke-width="1.5"/>`);
    parts.push(`<line x1="${x + boxW * 0.25}" y1="${yMax}" x2="${x + boxW * 0.75}" y2="${yMax}" stroke="${color}" stroke-width="1.5"/>`);

    // Box
    parts.push(`<rect x="${x}" y="${yQ3}" width="${boxW}" height="${yQ1 - yQ3}" fill="${color}" opacity="0.15" stroke="${color}" stroke-width="1.5" rx="2"/>`);

    // Median
    parts.push(`<line x1="${x}" y1="${yMed}" x2="${x + boxW}" y2="${yMed}" stroke="${color}" stroke-width="2.5"/>`);

    // Label
    parts.push(`<text x="${cx}" y="${d.plotH + 16}" text-anchor="middle" font-size="10" fill="${TEXT_COLOR}">${escSvg(truncLabel(label))}</text>`);
  });

  parts.push(`<text x="-50" y="${d.plotH / 2}" text-anchor="middle" font-size="11" fill="${TEXT_COLOR}" transform="rotate(-90 -50 ${d.plotH / 2})">${escSvg(yAxisLabel(spec))}</text>`);

  return svgWrap(d, parts.join("\n"), spec.title);
}

// ── Heatmap ───────────────────────────────────────────────────

function renderHeatmap(spec: ChartSpec): string {
  const d = dims(600, 450);
  const colors = colorsFor(spec);
  const table = spec.data;
  const xci = table.columns.indexOf(spec.xColumn);
  const yci = table.columns.indexOf(spec.yColumn);
  const gci = spec.groupBy ? table.columns.indexOf(spec.groupBy) : -1;
  if (xci === -1 || yci === -1) return renderEmpty(d, spec.title, "Column not found");

  // Use groupBy as value column, or count occurrences
  const xLabels = [...new Set(table.rows.map((r) => String(r[xci] ?? "")))];
  const yLabels = [...new Set(table.rows.map((r) => String(r[yci] ?? "")))];

  const grid = new Map<string, number>();
  for (const row of table.rows) {
    const xk = String(row[xci] ?? "");
    const yk = String(row[yci] ?? "");
    const key = `${xk}::${yk}`;
    const val = gci >= 0 && typeof row[gci] === "number" ? (row[gci] as number) : (grid.get(key) ?? 0) + 1;
    grid.set(key, val);
  }

  const allVals = Array.from(grid.values());
  const minV = Math.min(...allVals, 0);
  const maxV = Math.max(...allVals, 1);

  const cellW = Math.min(50, d.plotW / xLabels.length);
  const cellH = Math.min(30, d.plotH / yLabels.length);

  const parts: string[] = [];
  yLabels.forEach((yl, yi) => {
    parts.push(`<text x="-6" y="${yi * cellH + cellH / 2 + 4}" text-anchor="end" font-size="9" fill="${TEXT_COLOR}">${escSvg(truncLabel(yl, 10))}</text>`);
    xLabels.forEach((xl, xi) => {
      const key = `${xl}::${yl}`;
      const val = grid.get(key) ?? 0;
      const t = maxV > minV ? (val - minV) / (maxV - minV) : 0;
      const color = interpolateColor("#f8fafc", colors[0], t);

      parts.push(`<rect x="${xi * cellW}" y="${yi * cellH}" width="${cellW - 1}" height="${cellH - 1}" fill="${color}" rx="2"/>`);
      if (cellW > 25 && cellH > 16) {
        parts.push(`<text x="${xi * cellW + cellW / 2}" y="${yi * cellH + cellH / 2 + 3}" text-anchor="middle" font-size="8" fill="${t > 0.5 ? "#fff" : TEXT_COLOR}">${val}</text>`);
      }
    });
  });

  xLabels.forEach((xl, xi) => {
    parts.push(`<text x="${xi * cellW + cellW / 2}" y="${yLabels.length * cellH + 14}" text-anchor="middle" font-size="9" fill="${TEXT_COLOR}" transform="rotate(-45 ${xi * cellW + cellW / 2} ${yLabels.length * cellH + 14})">${escSvg(truncLabel(xl, 10))}</text>`);
  });

  parts.push(`<text x="${d.plotW / 2}" y="${d.plotH + 56}" text-anchor="middle" font-size="11" fill="${TEXT_COLOR}">${escSvg(xAxisLabel(spec))}</text>`);
  parts.push(`<text x="-50" y="${d.plotH / 2}" text-anchor="middle" font-size="11" fill="${TEXT_COLOR}" transform="rotate(-90 -50 ${d.plotH / 2})">${escSvg(yAxisLabel(spec))}</text>`);

  return svgWrap(d, parts.join("\n"), spec.title);
}

function interpolateColor(startHex: string, endHex: string, t: number): string {
  const clamped = Math.max(0, Math.min(1, t));
  const start = parseInt(startHex.slice(1), 16);
  const end = parseInt(endHex.slice(1), 16);
  const sr = (start >> 16) & 0xff;
  const sg = (start >> 8) & 0xff;
  const sb = start & 0xff;
  const er = (end >> 16) & 0xff;
  const eg = (end >> 8) & 0xff;
  const eb = end & 0xff;
  const r = Math.round(sr + (er - sr) * clamped);
  const g = Math.round(sg + (eg - sg) * clamped);
  const b = Math.round(sb + (eb - sb) * clamped);
  return `rgb(${r},${g},${b})`;
}

// ── Empty / Error Chart ───────────────────────────────────────

function renderEmpty(d: Dims, title: string, message: string): string {
  const inner = `<text x="${d.plotW / 2}" y="${d.plotH / 2}" text-anchor="middle" font-size="13" fill="#94a3b8">${escSvg(message)}</text>`;
  return svgWrap(d, inner, title);
}

// ── Public API ────────────────────────────────────────────────

export function generateChartSVG(spec: ChartSpec): string {
  switch (spec.type) {
    case "bar":
      return renderBarChart(spec);
    case "line":
      return renderLineChart(spec);
    case "scatter":
      return renderScatterChart(spec);
    case "histogram":
      return renderHistogram(spec);
    case "box":
      return renderBoxPlot(spec);
    case "heatmap":
      return renderHeatmap(spec);
    default:
      return renderEmpty(dims(), spec.title, `Unsupported chart type: ${spec.type}`);
  }
}

export function generateChartHTML(specs: ChartSpec[]): string {
  const charts = specs.map((spec) => generateChartSVG(spec));
  return [
    "<!DOCTYPE html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="UTF-8"/>',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0"/>',
    "<title>ScienceSwarm Charts</title>",
    '<script src="https://cdn.tailwindcss.com"></script>',
    "</head>",
    '<body class="font-sans bg-slate-50 p-8">',
    '<div class="grid grid-cols-1 lg:grid-cols-2 gap-6 max-w-[1400px] mx-auto">',
    ...charts.map((svg) => `<div class="bg-white border-2 border-slate-200 rounded-xl p-4 [&_svg]:w-full [&_svg]:h-auto">${svg}</div>`),
    "</div>",
    "</body>",
    "</html>",
  ].join("\n");
}

// ── Auto-Analysis ─────────────────────────────────────────────
// Heuristic chart recommendations based on column types and cardinality.

export function analyzeData(table: DataTable): ChartRecommendation[] {
  const types = detectColumnTypes(table);
  const recommendations: ChartRecommendation[] = [];

  const numCols = table.columns.filter((_, i) => types[i] === "number");
  const strCols = table.columns.filter((_, i) => types[i] === "string");

  // Bar chart: categorical x + numeric y
  if (strCols.length >= 1 && numCols.length >= 1) {
    const xCol = strCols[0];
    const uniqueX = new Set(table.rows.map((r) => r[table.columns.indexOf(xCol)])).size;
    if (uniqueX <= 30) {
      recommendations.push({
        spec: {
          type: "bar",
          title: `${numCols[0]} by ${xCol}`,
          xColumn: xCol,
          yColumn: numCols[0],
          data: table,
        },
        reason: `Bar chart shows ${numCols[0]} values across ${xCol} categories (${uniqueX} unique values).`,
        score: 0.9,
      });
    }
  }

  // Line chart: if data looks sequential (first column as x, first numeric as y)
  if (numCols.length >= 1 && table.rows.length >= 3) {
    const xCol = table.columns[0];
    const yCol = numCols[0];
    if (xCol !== yCol) {
      recommendations.push({
        spec: {
          type: "line",
          title: `${yCol} over ${xCol}`,
          xColumn: xCol,
          yColumn: yCol,
          data: table,
        },
        reason: `Line chart tracks ${yCol} progression over ${xCol}.`,
        score: 0.7,
      });
    }
  }

  // Scatter: two numeric columns
  if (numCols.length >= 2) {
    recommendations.push({
      spec: {
        type: "scatter",
        title: `${numCols[0]} vs ${numCols[1]}`,
        xColumn: numCols[0],
        yColumn: numCols[1],
        data: table,
      },
      reason: `Scatter plot reveals correlation between ${numCols[0]} and ${numCols[1]}.`,
      score: 0.85,
    });
  }

  // Histogram: any numeric column with enough data
  for (const col of numCols) {
    if (table.rows.length >= 10) {
      recommendations.push({
        spec: {
          type: "histogram",
          title: `Distribution of ${col}`,
          xColumn: col,
          yColumn: col,
          data: table,
        },
        reason: `Histogram shows the distribution of ${col} across ${table.rows.length} data points.`,
        score: 0.6,
      });
      break; // One histogram is enough
    }
  }

  // Box plot: numeric grouped by category
  if (strCols.length >= 1 && numCols.length >= 1) {
    const xCol = strCols[0];
    const uniqueX = new Set(table.rows.map((r) => r[table.columns.indexOf(xCol)])).size;
    if (uniqueX >= 2 && uniqueX <= 10) {
      recommendations.push({
        spec: {
          type: "box",
          title: `${numCols[0]} by ${xCol}`,
          xColumn: xCol,
          yColumn: numCols[0],
          data: table,
        },
        reason: `Box plot compares ${numCols[0]} distribution across ${uniqueX} groups of ${xCol}.`,
        score: 0.65,
      });
    }
  }

  // Sort by score descending
  recommendations.sort((a, b) => b.score - a.score);
  return recommendations.slice(0, 5);
}
