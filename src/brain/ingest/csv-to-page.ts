/**
 * CSV ingest — tiny hand-rolled parser that produces a gbrain-friendly
 * markdown body plus a PaperFrontmatter-compatible metadata dict.
 *
 * Why hand-rolled: the audit-revise demo needs exactly one operation
 * (parse header + first 1000 rows, infer column dtypes, render a preview
 * table). Adding csv-parse or papaparse just to support that is budget
 * we don't need, and every new dep ships with its own unlisted deps.
 *
 * Limitations we intentionally accept for v1:
 * - RFC 4180 quoting is supported for simple `"quoted, value"` cells, but
 *   embedded quote escaping (`""`) is not. Scientific CSVs almost never
 *   embed quoted strings inside cells.
 * - Delimiter defaults to comma. Tab/semicolon can be passed explicitly.
 * - Line endings: \n, \r\n, and \r are all treated as row terminators.
 */

import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { createInterface } from "node:readline";

export type ColumnDtype = "number" | "integer" | "string" | "boolean";

export interface CsvIngestResult {
  /** Header names in original order. */
  columns: string[];
  /** Inferred dtypes in the same order as `columns`. */
  columnDtypes: ColumnDtype[];
  /** Row count read (capped at MAX_ROWS). */
  rowCount: number;
  /** True when the input had more rows than MAX_ROWS. */
  truncated: boolean;
  /** Markdown body: header table + first `previewRows` rows + summary. */
  markdown: string;
}

export interface CsvIngestOptions {
  /** Override the field separator. Default `,`. */
  delimiter?: string;
  /** How many rows to render in the markdown preview. Default 20. */
  previewRows?: number;
  /** How many rows to parse from the source. Default 1000. */
  maxRows?: number;
}

const DEFAULT_PREVIEW_ROWS = 20;
const DEFAULT_MAX_ROWS = 1000;

export function ingestCsvContent(
  raw: string,
  options: CsvIngestOptions = {},
): CsvIngestResult {
  const delimiter = options.delimiter ?? ",";
  const previewRows = options.previewRows ?? DEFAULT_PREVIEW_ROWS;
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;

  if (raw.trim().length === 0) {
    return {
      columns: [],
      columnDtypes: [],
      rowCount: 0,
      truncated: false,
      markdown: "_(empty CSV)_",
    };
  }

  const lines = splitLines(raw);
  const [headerLine, ...bodyLines] = lines;
  const columns = parseRow(headerLine, delimiter).map((c) => c.trim());

  const rows: string[][] = [];
  let truncated = false;
  for (const line of bodyLines) {
    if (rows.length >= maxRows) {
      truncated = true;
      break;
    }
    // Skip blank trailing lines rather than emitting a row of empties.
    if (line.trim().length === 0) continue;
    rows.push(parseRow(line, delimiter));
  }

  const columnDtypes = inferColumnDtypes(columns.length, rows);
  const markdown = renderMarkdown({
    columns,
    columnDtypes,
    rows,
    previewRows,
    truncated,
    rawLineCount: bodyLines.length,
  });

  return {
    columns,
    columnDtypes,
    rowCount: rows.length,
    truncated,
    markdown,
  };
}

export async function ingestCsvFile(
  filePath: string,
  options: CsvIngestOptions = {},
): Promise<CsvIngestResult> {
  const delimiter = options.delimiter ?? ",";
  const previewRows = options.previewRows ?? DEFAULT_PREVIEW_ROWS;
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;

  const lines = createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  let sawContent = false;
  let headerLine: string | null = null;
  let rawLineCount = 0;
  let truncated = false;
  const rows: string[][] = [];

  for await (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, "");
    if (!sawContent && line.trim().length > 0) {
      sawContent = true;
    }
    if (headerLine === null) {
      headerLine = line;
      continue;
    }

    rawLineCount += 1;
    if (line.trim().length === 0) continue;
    if (rows.length >= maxRows) {
      truncated = true;
      continue;
    }
    rows.push(parseRow(line, delimiter));
  }

  if (headerLine !== null && (await endsWithLineBreak(filePath))) {
    rawLineCount += 1;
  }

  if (!sawContent || headerLine === null) {
    return {
      columns: [],
      columnDtypes: [],
      rowCount: 0,
      truncated: false,
      markdown: "_(empty CSV)_",
    };
  }

  const columns = parseRow(headerLine, delimiter).map((c) => c.trim());
  const columnDtypes = inferColumnDtypes(columns.length, rows);
  const markdown = renderMarkdown({
    columns,
    columnDtypes,
    rows,
    previewRows,
    truncated,
    rawLineCount,
  });

  return {
    columns,
    columnDtypes,
    rowCount: rows.length,
    truncated,
    markdown,
  };
}

async function endsWithLineBreak(filePath: string): Promise<boolean> {
  const handle = await open(filePath, "r");
  try {
    const stat = await handle.stat();
    if (stat.size === 0) return false;
    const buffer = Buffer.alloc(1);
    await handle.read(buffer, 0, 1, stat.size - 1);
    return buffer[0] === 10 || buffer[0] === 13;
  } finally {
    await handle.close();
  }
}

function splitLines(raw: string): string[] {
  // Normalise CRLF and lone CR to LF before splitting so we handle every
  // realistic line-ending style without extra branching downstream.
  return raw.replace(/\r\n?/g, "\n").split("\n");
}

function parseRow(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let i = 0;
  let current = "";
  let inQuotes = false;
  while (i < line.length) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else if (ch === '"' && current.length === 0) {
      inQuotes = true;
    } else if (ch === delimiter) {
      out.push(current);
      current = "";
    } else {
      current += ch;
    }
    i += 1;
  }
  out.push(current);
  return out.map((field) => field.trim());
}

function inferColumnDtypes(
  columnCount: number,
  rows: string[][],
): ColumnDtype[] {
  const dtypes: ColumnDtype[] = [];
  for (let col = 0; col < columnCount; col += 1) {
    let isInteger = true;
    let isNumber = true;
    let isBoolean = true;
    let nonEmptyCount = 0;
    for (const row of rows) {
      const raw = row[col];
      if (raw === undefined || raw === "") continue;
      nonEmptyCount += 1;
      if (!/^-?\d+$/.test(raw)) isInteger = false;
      if (!/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(raw)) isNumber = false;
      if (!/^(true|false|True|False|TRUE|FALSE)$/.test(raw)) isBoolean = false;
    }
    if (nonEmptyCount === 0) {
      dtypes.push("string");
    } else if (isBoolean) {
      dtypes.push("boolean");
    } else if (isInteger) {
      dtypes.push("integer");
    } else if (isNumber) {
      dtypes.push("number");
    } else {
      dtypes.push("string");
    }
  }
  return dtypes;
}

interface RenderArgs {
  columns: string[];
  columnDtypes: ColumnDtype[];
  rows: string[][];
  previewRows: number;
  truncated: boolean;
  rawLineCount: number;
}

function renderMarkdown(args: RenderArgs): string {
  const { columns, columnDtypes, rows, previewRows, truncated, rawLineCount } =
    args;

  const header = columns.map((c) => (c.length > 0 ? c : " ")).join(" | ");
  const divider = columns.map(() => "---").join(" | ");
  const preview = rows.slice(0, previewRows).map((row) =>
    columns
      .map((_, idx) => (row[idx] ?? "").replace(/\|/g, "\\|"))
      .join(" | "),
  );

  const lines = [
    `| ${header} |`,
    `| ${divider} |`,
    ...preview.map((row) => `| ${row} |`),
  ];

  const summary: string[] = [];
  summary.push(`- **Rows parsed:** ${rows.length}`);
  if (truncated) {
    summary.push(`- **Truncated:** yes (file has > ${rows.length} data rows)`);
  } else if (rawLineCount > rows.length) {
    const blanks = rawLineCount - rows.length;
    summary.push(`- **Blank lines skipped:** ${blanks}`);
  }
  summary.push(
    `- **Columns:** ${columns.length} — ${columns
      .map((name, idx) => `\`${name}\` (${columnDtypes[idx]})`)
      .join(", ")}`,
  );

  return [`${lines.join("\n")}`, "", ...summary].join("\n");
}
