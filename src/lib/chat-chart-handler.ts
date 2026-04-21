// ── Chat Chart Handler ────────────────────────────────────────
// Detects chart intent from chat messages and generates inline charts.

import { parseCSV, parseTSV, parseJSON, type DataTable } from "./data-transform";
import { generateChartSVG, analyzeData, type ChartSpec } from "./chart-generator";

// ── Types ────────────────────────────────────────────────────

export interface UploadedFile {
  name: string;
  size: string;
  type: string;
  content?: string;
}

export type ChartIntentType = "auto" | "scatter" | "bar" | "line" | "histogram" | "compare" | "box";

export interface ChartIntent {
  type: ChartIntentType;
  dataSource: string; // filename or "all"
  columns?: string[]; // specific columns mentioned
  rawMessage: string;
}

export interface ChartResult {
  svgs: string[];
  dataTable?: DataTable;
  description: string;
  error?: string;
}

// ── Detection ────────────────────────────────────────────────

const CHART_KEYWORDS = [
  "chart", "plot", "histogram", "compare", "visualize", "graph",
  "table", "scatter", "bar chart", "line chart", "box plot",
  "distribution", "trend", "correlation",
];

const CHART_TYPE_MAP: Record<string, ChartIntentType> = {
  scatter: "scatter",
  "scatter plot": "scatter",
  bar: "bar",
  "bar chart": "bar",
  line: "line",
  "line chart": "line",
  histogram: "histogram",
  distribution: "histogram",
  compare: "compare",
  comparison: "compare",
  "box plot": "box",
  boxplot: "box",
};

export function detectChartIntent(
  message: string,
  uploadedFiles: UploadedFile[]
): ChartIntent | null {
  const lower = message.toLowerCase().trim();

  // Check for chart keywords
  const hasChartKeyword = CHART_KEYWORDS.some((kw) => lower.includes(kw));
  if (!hasChartKeyword) return null;

  // Detect specific chart type
  let type: ChartIntentType = "auto";
  for (const [keyword, chartType] of Object.entries(CHART_TYPE_MAP)) {
    if (lower.includes(keyword)) {
      type = chartType;
      break;
    }
  }

  // Detect data source — look for filename references
  let dataSource = "all";
  for (const file of uploadedFiles) {
    if (lower.includes(file.name.toLowerCase())) {
      dataSource = file.name;
      break;
    }
  }

  // Also check for "chart <filename>" pattern
  const chartFileMatch = lower.match(/(?:chart|plot|visualize|graph)\s+(\S+\.(?:csv|json|tsv))/);
  if (chartFileMatch) {
    const matchedName = chartFileMatch[1];
    const matchedFile = uploadedFiles.find(
      (f) => f.name.toLowerCase() === matchedName
    );
    if (matchedFile) dataSource = matchedFile.name;
  }

  // Detect column references — "column A vs column B" or "of the gaps"
  const columns: string[] = [];
  const vsMatch = lower.match(/(\w+)\s+vs\.?\s+(\w+)/);
  if (vsMatch) {
    columns.push(vsMatch[1], vsMatch[2]);
  }
  const ofTheMatch = lower.match(/(?:of|for|in)\s+(?:the\s+)?(\w+)/);
  if (ofTheMatch && !["data", "file", "chart", "plot"].includes(ofTheMatch[1])) {
    columns.push(ofTheMatch[1]);
  }

  return {
    type,
    dataSource,
    columns: columns.length > 0 ? columns : undefined,
    rawMessage: message,
  };
}

// ── Execution ────────────────────────────────────────────────

export function executeChartIntent(
  intent: ChartIntent,
  uploadedFiles: UploadedFile[]
): ChartResult {
  // Find the target data file
  const targetFile = intent.dataSource === "all"
    ? uploadedFiles.find((f) => f.type === "csv" || f.type === "tsv" || f.type === "json")
    : uploadedFiles.find((f) => f.name === intent.dataSource);

  if (!targetFile || !targetFile.content) {
    return {
      svgs: [],
      description: "No data file found to chart.",
      error: intent.dataSource === "all"
        ? "No data file found in the workspace. Import or select a CSV, TSV, or JSON file to chart."
        : `File "${intent.dataSource}" not found or has no content.`,
    };
  }

  // Parse the data
  let table: DataTable;
  try {
    if (targetFile.type === "json") {
      table = parseJSON(targetFile.content);
    } else if (targetFile.type === "tsv") {
      table = parseTSV(targetFile.content);
    } else {
      table = parseCSV(targetFile.content);
    }
  } catch (err) {
    return {
      svgs: [],
      description: `Could not parse ${targetFile.name}.`,
      error: err instanceof Error ? err.message : "Parse error",
    };
  }

  if (table.rows.length === 0) {
    return {
      svgs: [],
      dataTable: table,
      description: `${targetFile.name} has no data rows.`,
      error: "Empty dataset",
    };
  }

  // Generate charts based on intent type
  const svgs: string[] = [];
  const specs: ChartSpec[] = [];

  if (intent.type === "auto") {
    // Use auto-analysis to recommend charts
    const recommendations = analyzeData(table);
    for (const rec of recommendations.slice(0, 3)) {
      specs.push(rec.spec);
    }
  } else {
    // Build specific chart spec
    const spec = buildSpecFromIntent(intent, table);
    if (spec) specs.push(spec);
  }

  for (const spec of specs) {
    try {
      svgs.push(generateChartSVG(spec));
    } catch {
      // Skip failed charts
    }
  }

  if (svgs.length === 0) {
    return {
      svgs: [],
      dataTable: table,
      description: `Could not generate charts for ${targetFile.name}.`,
      error: "No suitable chart configuration found for this data.",
    };
  }

  const description = buildChartDescription(targetFile.name, table, specs);
  return { svgs, dataTable: table, description };
}

// ── Spec Builder ─────────────────────────────────────────────

function buildSpecFromIntent(intent: ChartIntent, table: DataTable): ChartSpec | null {
  const numCols = table.columns.filter((col) => {
    return table.rows.some((row) => typeof row[table.columns.indexOf(col)] === "number");
  });
  const strCols = table.columns.filter((col) => {
    return table.rows.some((row) => typeof row[table.columns.indexOf(col)] === "string");
  });

  // Try to match intent columns to actual table columns
  const matchColumn = (name: string): string | null => {
    const lower = name.toLowerCase();
    return table.columns.find((c) => c.toLowerCase() === lower)
      || table.columns.find((c) => c.toLowerCase().includes(lower))
      || null;
  };

  const intentCols = (intent.columns || []).map(matchColumn).filter(Boolean) as string[];

  switch (intent.type) {
    case "scatter": {
      const xCol = intentCols[0] || numCols[0];
      const yCol = intentCols[1] || numCols[1] || numCols[0];
      if (!xCol || !yCol) return null;
      return {
        type: "scatter",
        title: `${xCol} vs ${yCol}`,
        xColumn: xCol,
        yColumn: yCol,
        data: table,
      };
    }
    case "bar": {
      const xCol = intentCols[0] || strCols[0] || table.columns[0];
      const yCol = intentCols[1] || numCols[0];
      if (!xCol || !yCol) return null;
      return {
        type: "bar",
        title: `${yCol} by ${xCol}`,
        xColumn: xCol,
        yColumn: yCol,
        data: table,
      };
    }
    case "line": {
      const xCol = intentCols[0] || table.columns[0];
      const yCol = intentCols[1] || numCols[0];
      if (!xCol || !yCol) return null;
      return {
        type: "line",
        title: `${yCol} over ${xCol}`,
        xColumn: xCol,
        yColumn: yCol,
        data: table,
      };
    }
    case "histogram": {
      const col = intentCols[0] || numCols[0];
      if (!col) return null;
      return {
        type: "histogram",
        title: `Distribution of ${col}`,
        xColumn: col,
        yColumn: col,
        data: table,
      };
    }
    case "box": {
      const xCol = intentCols[0] || strCols[0] || table.columns[0];
      const yCol = intentCols[1] || numCols[0];
      if (!xCol || !yCol) return null;
      return {
        type: "box",
        title: `${yCol} by ${xCol}`,
        xColumn: xCol,
        yColumn: yCol,
        data: table,
      };
    }
    case "compare":
    default: {
      // Fall back to auto-analysis
      const recommendations = analyzeData(table);
      return recommendations[0]?.spec || null;
    }
  }
}

// ── Description Builder ──────────────────────────────────────

function buildChartDescription(
  filename: string,
  table: DataTable,
  specs: ChartSpec[]
): string {
  const lines: string[] = [
    `Charts for **${filename}** (${table.rows.length} rows, ${table.columns.length} columns):`,
  ];

  for (const spec of specs) {
    lines.push(`- ${spec.type} chart: ${spec.title}`);
  }

  return lines.join("\n");
}
