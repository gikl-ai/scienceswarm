// ── Data Transformation Engine ────────────────────────────────
// Pure TypeScript data transforms for research data tables.

export interface TransformStep {
  type:
    | "parse"
    | "filter"
    | "map"
    | "aggregate"
    | "sort"
    | "join"
    | "pivot"
    | "convert"
    | "clean"
    | "derive";
  config: Record<string, unknown>;
}

export interface DataTable {
  columns: string[];
  rows: (string | number | null)[][];
  metadata?: {
    source: string;
    rowCount: number;
    transformsApplied: string[];
  };
}

export interface CleanRule {
  type: "removeNulls" | "trim" | "coerce" | "dedup" | "fillDefault";
  column?: string;
  targetType?: "number" | "string";
  defaultValue?: string | number | null;
}

// ── Parsers ───────────────────────────────────────────────────

export function parseCSV(text: string, delimiter: string = ","): DataTable {
  const source = delimiter === "\t" ? "tsv" : "csv";
  const trimmed = text.trim();
  if (trimmed === "") {
    return { columns: [], rows: [], metadata: { source, rowCount: 0, transformsApplied: [`parse${source.toUpperCase()}`] } };
  }
  const lines = trimmed.split(/\r?\n/);

  const columns = parseCSVLine(lines[0], delimiter);
  const rows: (string | number | null)[][] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "") continue;
    const cells = parseCSVLine(line, delimiter);
    const row: (string | number | null)[] = columns.map((_, ci) => {
      const raw = cells[ci] ?? null;
      if (raw === null || raw === "") return null;
      const num = Number(raw);
      return !isNaN(num) && raw.trim() !== "" ? num : raw;
    });
    rows.push(row);
  }

  return {
    columns,
    rows,
    metadata: { source, rowCount: rows.length, transformsApplied: [`parse${source.toUpperCase()}`] },
  };
}

function parseCSVLine(line: string, delimiter: string = ","): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === delimiter) {
        result.push(current.trim());
        current = "";
      } else {
        current += ch;
      }
    }
  }
  result.push(current.trim());
  return result;
}

export function parseTSV(text: string): DataTable {
  const trimmed = text.trim();
  if (trimmed === "") {
    return { columns: [], rows: [], metadata: { source: "tsv", rowCount: 0, transformsApplied: ["parseTSV"] } };
  }
  const lines = trimmed.split(/\r?\n/);

  const columns = lines[0].split("\t").map((c) => c.trim());
  const rows: (string | number | null)[][] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    const cells = line.split("\t");
    const row: (string | number | null)[] = columns.map((_, ci) => {
      const raw = cells[ci]?.trim() ?? null;
      if (raw === null || raw === "") return null;
      const num = Number(raw);
      return !isNaN(num) && raw !== "" ? num : raw;
    });
    rows.push(row);
  }

  return {
    columns,
    rows,
    metadata: { source: "tsv", rowCount: rows.length, transformsApplied: ["parseTSV"] },
  };
}

export function parseJSON(text: string): DataTable {
  const parsed: unknown = JSON.parse(text);

  let arr: Record<string, unknown>[];
  if (Array.isArray(parsed)) {
    arr = parsed as Record<string, unknown>[];
  } else if (typeof parsed === "object" && parsed !== null) {
    // Try to find an array property
    const obj = parsed as Record<string, unknown>;
    const arrayKey = Object.keys(obj).find((k) => Array.isArray(obj[k]));
    if (arrayKey) {
      arr = obj[arrayKey] as Record<string, unknown>[];
    } else {
      arr = [obj];
    }
  } else {
    return { columns: [], rows: [], metadata: { source: "json", rowCount: 0, transformsApplied: ["parseJSON"] } };
  }

  if (arr.length === 0) {
    return { columns: [], rows: [], metadata: { source: "json", rowCount: 0, transformsApplied: ["parseJSON"] } };
  }

  const columnsSet = new Set<string>();
  for (const item of arr) {
    if (typeof item === "object" && item !== null) {
      for (const key of Object.keys(item)) {
        columnsSet.add(key);
      }
    }
  }
  const columns = Array.from(columnsSet);

  const rows: (string | number | null)[][] = arr.map((item) => {
    return columns.map((col) => {
      const val = (item as Record<string, unknown>)[col];
      if (val === undefined || val === null) return null;
      if (typeof val === "number") return val;
      if (typeof val === "string") return val;
      return String(val);
    });
  });

  return {
    columns,
    rows,
    metadata: { source: "json", rowCount: rows.length, transformsApplied: ["parseJSON"] },
  };
}

// ── Column helpers ────────────────────────────────────────────

function colIndex(table: DataTable, column: string): number {
  const idx = table.columns.indexOf(column);
  if (idx === -1) throw new Error(`Column "${column}" not found. Available: ${table.columns.join(", ")}`);
  return idx;
}

function withMeta(table: DataTable, transform: string): DataTable {
  return {
    ...table,
    metadata: {
      source: table.metadata?.source ?? "unknown",
      rowCount: table.rows.length,
      transformsApplied: [...(table.metadata?.transformsApplied ?? []), transform],
    },
  };
}

// ── Core Transforms ───────────────────────────────────────────

export function filterRows(
  table: DataTable,
  column: string,
  op: string,
  value: unknown
): DataTable {
  const ci = colIndex(table, column);

  const predicate = (cell: string | number | null): boolean => {
    if (cell === null) return op === "isNull";
    switch (op) {
      case "eq":
        return cell == value;
      case "neq":
        return cell != value;
      case "gt":
        return typeof cell === "number" && cell > (value as number);
      case "gte":
        return typeof cell === "number" && cell >= (value as number);
      case "lt":
        return typeof cell === "number" && cell < (value as number);
      case "lte":
        return typeof cell === "number" && cell <= (value as number);
      case "contains":
        return String(cell).toLowerCase().includes(String(value).toLowerCase());
      case "startsWith":
        return String(cell).toLowerCase().startsWith(String(value).toLowerCase());
      case "endsWith":
        return String(cell).toLowerCase().endsWith(String(value).toLowerCase());
      case "isNull":
        return false; // already handled above
      case "notNull":
        return true;
      default:
        return true;
    }
  };

  const rows = table.rows.filter((row) => predicate(row[ci]));
  return withMeta({ ...table, rows }, `filter(${column} ${op} ${value})`);
}

export function mapColumn(
  table: DataTable,
  column: string,
  fn: string
): DataTable {
  const ci = colIndex(table, column);

  const rows = table.rows.map((row) => {
    const newRow = [...row];
    const cellValue = row[ci];
    // Build a safe evaluation context
    const result = evaluateExpression(fn, {
      value: cellValue,
      row: Object.fromEntries(table.columns.map((c, i) => [c, row[i]])),
    });
    newRow[ci] = result;
    return newRow;
  });

  return withMeta({ ...table, rows }, `map(${column}, ${fn})`);
}

export function aggregateBy(
  table: DataTable,
  groupBy: string,
  column: string,
  op: "sum" | "avg" | "min" | "max" | "count"
): DataTable {
  const gci = colIndex(table, groupBy);
  const vci = colIndex(table, column);

  const groups = new Map<string, number[]>();
  const groupCounts = new Map<string, number>();
  for (const row of table.rows) {
    const key = String(row[gci] ?? "null");
    if (!groups.has(key)) {
      groups.set(key, []);
      groupCounts.set(key, 0);
    }
    const val = row[vci];
    if (typeof val === "number") groups.get(key)!.push(val);
    // Count all non-null cells (not just numeric)
    if (val !== null) groupCounts.set(key, (groupCounts.get(key) ?? 0) + 1);
  }

  const resultRows: (string | number | null)[][] = [];
  for (const [key, values] of groups) {
    let result: number;
    switch (op) {
      case "sum":
        result = values.reduce((a, b) => a + b, 0);
        break;
      case "avg":
        result = values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0;
        break;
      case "min":
        result = values.length > 0 ? Math.min(...values) : 0;
        break;
      case "max":
        result = values.length > 0 ? Math.max(...values) : 0;
        break;
      case "count":
        result = groupCounts.get(key) ?? 0;
        break;
    }
    resultRows.push([key, result]);
  }

  return withMeta(
    { columns: [groupBy, `${op}(${column})`], rows: resultRows },
    `aggregate(${groupBy}, ${op}(${column}))`
  );
}

export function sortBy(
  table: DataTable,
  column: string,
  direction: "asc" | "desc"
): DataTable {
  const ci = colIndex(table, column);
  const mult = direction === "asc" ? 1 : -1;

  const rows = [...table.rows].sort((a, b) => {
    const av = a[ci];
    const bv = b[ci];
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    if (typeof av === "number" && typeof bv === "number") return (av - bv) * mult;
    return String(av).localeCompare(String(bv)) * mult;
  });

  return withMeta({ ...table, rows }, `sort(${column}, ${direction})`);
}

export function joinTables(
  left: DataTable,
  right: DataTable,
  leftKey: string,
  rightKey: string
): DataTable {
  const lki = colIndex(left, leftKey);
  const rki = colIndex(right, rightKey);

  // Right columns excluding the key column
  const rightCols = right.columns.filter((_, i) => i !== rki);
  const columns = [...left.columns, ...rightCols];

  // Build index on right table
  const rightIndex = new Map<string, (string | number | null)[]>();
  for (const row of right.rows) {
    rightIndex.set(String(row[rki] ?? ""), row);
  }

  const rows: (string | number | null)[][] = [];
  for (const lRow of left.rows) {
    const key = String(lRow[lki] ?? "");
    const rRow = rightIndex.get(key);
    if (rRow) {
      const rightValues = rRow.filter((_, i) => i !== rki);
      rows.push([...lRow, ...rightValues]);
    } else {
      rows.push([...lRow, ...rightCols.map(() => null)]);
    }
  }

  return withMeta({ columns, rows }, `join(${leftKey}, ${rightKey})`);
}

export function pivotTable(
  table: DataTable,
  rowKey: string,
  colKey: string,
  valueKey: string
): DataTable {
  const rki = colIndex(table, rowKey);
  const cki = colIndex(table, colKey);
  const vki = colIndex(table, valueKey);

  // Collect unique row and column keys
  const rowKeys = [...new Set(table.rows.map((r) => String(r[rki] ?? "")))];
  const colKeys = [...new Set(table.rows.map((r) => String(r[cki] ?? "")))];

  // Build pivot map
  const pivot = new Map<string, Map<string, string | number | null>>();
  for (const row of table.rows) {
    const rk = String(row[rki] ?? "");
    const ck = String(row[cki] ?? "");
    if (!pivot.has(rk)) pivot.set(rk, new Map());
    pivot.get(rk)!.set(ck, row[vki]);
  }

  const columns = [rowKey, ...colKeys];
  const rows: (string | number | null)[][] = rowKeys.map((rk) => {
    const map = pivot.get(rk);
    return [rk, ...colKeys.map((ck) => map?.get(ck) ?? null)];
  });

  return withMeta({ columns, rows }, `pivot(${rowKey}, ${colKey}, ${valueKey})`);
}

export function convertFormat(
  table: DataTable,
  format: "csv" | "json" | "markdown" | "latex"
): string {
  switch (format) {
    case "csv": {
      const header = table.columns.map(escapeCSV).join(",");
      const rows = table.rows.map((r) => r.map((c) => escapeCSV(String(c ?? ""))).join(","));
      return [header, ...rows].join("\n");
    }
    case "json": {
      const arr = table.rows.map((row) =>
        Object.fromEntries(table.columns.map((col, i) => [col, row[i]]))
      );
      return JSON.stringify(arr, null, 2);
    }
    case "markdown": {
      const escMd = (s: string) => s.replace(/\|/g, "\\|");
      const header = "| " + table.columns.map(escMd).join(" | ") + " |";
      const sep = "| " + table.columns.map(() => "---").join(" | ") + " |";
      const rows = table.rows.map(
        (r) => "| " + r.map((c) => escMd(String(c ?? ""))).join(" | ") + " |"
      );
      return [header, sep, ...rows].join("\n");
    }
    case "latex": {
      const colSpec = table.columns.map(() => "l").join(" ");
      const header = table.columns.map(escapeLatex).join(" & ");
      const rows = table.rows.map(
        (r) => r.map((c) => escapeLatex(String(c ?? ""))).join(" & ") + " \\\\"
      );
      return [
        `\\begin{tabular}{${colSpec}}`,
        "\\toprule",
        header + " \\\\",
        "\\midrule",
        ...rows,
        "\\bottomrule",
        "\\end{tabular}",
      ].join("\n");
    }
  }
}

function escapeCSV(val: string): string {
  if (val.includes(",") || val.includes('"') || val.includes("\n")) {
    return '"' + val.replace(/"/g, '""') + '"';
  }
  return val;
}

function escapeLatex(val: string): string {
  return val.replace(/[&%$#_{}~^\\]/g, (m) => "\\" + m);
}

export function cleanData(table: DataTable, rules: CleanRule[]): DataTable {
  let rows = table.rows.map((r) => [...r]);

  for (const rule of rules) {
    switch (rule.type) {
      case "removeNulls": {
        if (rule.column) {
          const ci = colIndex(table, rule.column);
          rows = rows.filter((r) => r[ci] !== null);
        } else {
          rows = rows.filter((r) => r.every((c) => c !== null));
        }
        break;
      }
      case "trim": {
        rows = rows.map((r) =>
          r.map((c) => (typeof c === "string" ? c.trim() : c))
        );
        break;
      }
      case "coerce": {
        if (rule.column && rule.targetType) {
          const ci = colIndex(table, rule.column);
          rows = rows.map((r) => {
            const newRow = [...r];
            const val = r[ci];
            if (rule.targetType === "number") {
              newRow[ci] = val === null ? null : Number(val) || 0;
            } else {
              newRow[ci] = val === null ? null : String(val);
            }
            return newRow;
          });
        }
        break;
      }
      case "dedup": {
        const seen = new Set<string>();
        rows = rows.filter((r) => {
          const key = JSON.stringify(r);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        break;
      }
      case "fillDefault": {
        if (rule.column) {
          const ci = colIndex(table, rule.column);
          rows = rows.map((r) => {
            const newRow = [...r];
            if (newRow[ci] === null) newRow[ci] = rule.defaultValue ?? null;
            return newRow;
          });
        }
        break;
      }
    }
  }

  return withMeta({ ...table, columns: [...table.columns], rows }, `clean(${rules.map((r) => r.type).join(",")})`);
}

export function deriveColumn(
  table: DataTable,
  name: string,
  expression: string
): DataTable {
  const columns = [...table.columns, name];
  const rows = table.rows.map((row) => {
    const context = Object.fromEntries(table.columns.map((c, i) => [c, row[i]]));
    const result = evaluateExpression(expression, { row: context });
    return [...row, result];
  });

  return withMeta({ columns, rows }, `derive(${name}, ${expression})`);
}

// ── Expression Evaluator ──────────────────────────────────────
// Safe(ish) math expression evaluator — supports basic arithmetic,
// Math functions, and column references via `row.colName`.

function evaluateExpression(
  expr: string,
  context: { value?: string | number | null; row?: Record<string, string | number | null> }
): string | number | null {
  try {
    // Replace row.XXX references with actual values
    let safeExpr = expr;
    if (context.row) {
      for (const [key, val] of Object.entries(context.row)) {
        const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const replacement = val === null ? "null" : typeof val === "number" ? String(val) : `"${String(val).replace(/"/g, '\\"')}"`;
        safeExpr = safeExpr.replace(new RegExp(`row\\.${escaped}`, "g"), replacement);
      }
    }
    if (context.value !== undefined) {
      const replacement =
        context.value === null
          ? "null"
          : typeof context.value === "number"
            ? String(context.value)
            : `"${String(context.value).replace(/"/g, '\\"')}"`;
      safeExpr = safeExpr.replace(/\bvalue\b/g, replacement);
    }

    // Only allow safe characters: numbers, operators, parens, Math.*, string literals
    const sanitized = safeExpr.replace(/Math\.\w+/g, "M");
    if (/[^M\d\s+\-*/().,"<>=!?:&|nulltruefalse%]/.test(sanitized)) {
      return null;
    }

    const fn = new Function("Math", `"use strict"; return (${safeExpr});`);
    const result = fn(Math);
    if (typeof result === "number" || typeof result === "string") return result;
    if (result === null || result === undefined) return null;
    return String(result);
  } catch {
    return null;
  }
}

// ── Pipeline Executor ─────────────────────────────────────────

export function applyTransforms(
  table: DataTable,
  steps: TransformStep[]
): DataTable {
  let result = table;

  for (const step of steps) {
    const c = step.config;
    switch (step.type) {
      case "parse": {
        const text = c.text as string;
        const format = (c.format as string) ?? "csv";
        result = format === "json" ? parseJSON(text) : format === "tsv" ? parseTSV(text) : parseCSV(text);
        break;
      }
      case "convert": {
        const format = (c.format as "csv" | "json" | "markdown" | "latex") ?? "csv";
        // Call convertFormat for its side effect (producing the converted string output)
        // but do NOT re-parse back into a table — markdown/latex are not valid CSV/JSON
        // and re-parsing corrupts the pipeline table.
        convertFormat(result, format);
        break;
      }
      case "filter":
        result = filterRows(result, c.column as string, c.op as string, c.value);
        break;
      case "map":
        result = mapColumn(result, c.column as string, c.fn as string);
        break;
      case "aggregate":
        result = aggregateBy(
          result,
          c.groupBy as string,
          c.column as string,
          c.op as "sum" | "avg" | "min" | "max" | "count"
        );
        break;
      case "sort":
        result = sortBy(result, c.column as string, c.direction as "asc" | "desc");
        break;
      case "join":
        result = joinTables(
          result,
          c.rightTable as DataTable,
          c.leftKey as string,
          c.rightKey as string
        );
        break;
      case "pivot":
        result = pivotTable(
          result,
          c.rowKey as string,
          c.colKey as string,
          c.valueKey as string
        );
        break;
      case "clean":
        result = cleanData(result, c.rules as CleanRule[]);
        break;
      case "derive":
        result = deriveColumn(result, c.name as string, c.expression as string);
        break;
      default:
        throw new Error(`Unsupported transform step type: ${step.type}`);
    }
  }

  return result;
}

// ── Column Type Detection ─────────────────────────────────────

export type ColumnType = "number" | "string" | "mixed" | "empty";

export function detectColumnTypes(table: DataTable): ColumnType[] {
  return table.columns.map((_, ci) => {
    let hasNum = false;
    let hasStr = false;
    let allNull = true;

    for (const row of table.rows) {
      const val = row[ci];
      if (val === null) continue;
      allNull = false;
      if (typeof val === "number") hasNum = true;
      else hasStr = true;
    }

    if (allNull) return "empty";
    if (hasNum && !hasStr) return "number";
    if (hasStr && !hasNum) return "string";
    return "mixed";
  });
}
