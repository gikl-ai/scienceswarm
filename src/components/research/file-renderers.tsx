"use client";

import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { parseCSV, parseJSON, parseTSV, type DataTable } from "@/lib/data-transform";
import {
  getFileExtension,
  getShikiLanguageForPath,
  type FilePreviewState,
} from "@/lib/file-visualization";

const HIGHLIGHT_SIZE_LIMIT_BYTES = 300 * 1024;
const SHIKI_CACHE_MAX_ENTRIES = 100;
const MAX_TABLE_ROWS = 500;
const MAX_TABLE_COLUMNS = 50;
const MAX_NOTEBOOK_OUTPUT_CHARS = 20_000;

const SANDBOX_CSP =
  '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data: blob:; style-src \'unsafe-inline\'; font-src data:;">';

const shikiCache = new Map<string, string>();

function setCachedHighlight(key: string, value: string): void {
  if (!shikiCache.has(key) && shikiCache.size >= SHIKI_CACHE_MAX_ENTRIES) {
    const oldestKey = shikiCache.keys().next().value;
    if (oldestKey !== undefined) {
      shikiCache.delete(oldestKey);
    }
  }
  shikiCache.set(key, value);
}

const markdownSanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    span: [
      ...(defaultSchema.attributes?.span ?? []),
      ["className"],
      [
        "style",
        /^(?:(?:font-size|vertical-align|margin(?:-[a-z]+)?|padding(?:-[a-z]+)?|height|width|font-family|display|top|left|right|bottom|position|border(?:-[a-z]+)?|color|background-color|line-height|min-width|max-width|min-height|max-height|text-align|white-space)\s*:\s*[^;(){}]*;?\s*)+$/i,
      ],
    ],
    div: [
      ...(defaultSchema.attributes?.div ?? []),
      ["className"],
    ],
    math: [
      ...(defaultSchema.attributes?.math ?? []),
      ["xmlns"],
    ],
    annotation: [
      ...(defaultSchema.attributes?.annotation ?? []),
      ["encoding"],
    ],
  },
};

function cheapHash(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return String(hash >>> 0);
}

function countLines(content: string): number {
  if (content.length === 0) return 1;
  return content.split("\n").length;
}

function readNotebookText(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry)).join("");
  }
  return typeof value === "string" ? value : "";
}

function truncateOutput(value: string): string {
  if (value.length <= MAX_NOTEBOOK_OUTPUT_CHARS) return value;
  return `${value.slice(0, MAX_NOTEBOOK_OUTPUT_CHARS)}\n\n[output truncated]`;
}

export function buildSandboxedSrcDoc(html: string): string {
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head([^>]*)>/i, `<head$1>${SANDBOX_CSP}`);
  }
  return `<!doctype html><html><head>${SANDBOX_CSP}</head><body>${html}</body></html>`;
}

async function highlightWithShiki(content: string, language: string): Promise<string> {
  const key = `${language}:${content.length}:${cheapHash(content)}`;
  const cached = shikiCache.get(key);
  if (cached) return cached;

  const { codeToHtml } = await import("shiki");
  let html: string;
  try {
    html = await codeToHtml(content, {
      lang: language || "text",
      theme: "github-light",
    });
  } catch {
    html = await codeToHtml(content, {
      lang: "text",
      theme: "github-light",
    });
  }
  setCachedHighlight(key, html);
  return html;
}

function LineNumbers({ lines }: { lines: number }) {
  return (
    <div
      aria-hidden="true"
      className="select-none border-r border-border bg-surface/60 px-2 py-3 text-right font-mono text-[11px] leading-5 text-muted"
    >
      {Array.from({ length: lines }, (_, index) => (
        <div key={index + 1}>{index + 1}</div>
      ))}
    </div>
  );
}

function PlainSource({ content, lineCount }: { content: string; lineCount: number }) {
  return (
    <div className="grid min-w-max grid-cols-[auto_minmax(0,1fr)]">
      <LineNumbers lines={lineCount} />
      <pre className="m-0 overflow-auto bg-white px-3 py-3 font-mono text-xs leading-5 text-foreground">
        <code>{content || " "}</code>
      </pre>
    </div>
  );
}

export function SourceRenderer({
  content,
  language,
  fileName,
  sizeBytes,
  compact = false,
}: {
  content: string;
  language: string;
  fileName: string;
  sizeBytes?: number;
  compact?: boolean;
}) {
  const byteSize = sizeBytes ?? new TextEncoder().encode(content).byteLength;
  const highlightDisabled = byteSize > HIGHLIGHT_SIZE_LIMIT_BYTES;
  const lineCount = useMemo(() => countLines(content), [content]);
  const highlightKey = `${language}:${content.length}:${cheapHash(content)}`;
  const [highlightState, setHighlightState] = useState<{
    key: string;
    html: string | null;
    failed: boolean;
  }>({ key: highlightKey, html: null, failed: false });
  const highlightedHtml =
    highlightState.key === highlightKey ? highlightState.html : null;
  const highlightFailed =
    highlightState.key === highlightKey ? highlightState.failed : false;

  useEffect(() => {
    let cancelled = false;
    if (highlightDisabled) return;

    void highlightWithShiki(content, language).then(
      (html) => {
        if (!cancelled) setHighlightState({ key: highlightKey, html, failed: false });
      },
      () => {
        if (!cancelled) setHighlightState({ key: highlightKey, html: null, failed: true });
      },
    );

    return () => {
      cancelled = true;
    };
  }, [content, highlightDisabled, highlightKey, language]);

  const copyToClipboard = async () => {
    const clipboard = navigator.clipboard;
    if (!clipboard?.writeText) return;
    await clipboard.writeText(content).catch(() => {});
  };

  const downloadSource = () => {
    const url = URL.createObjectURL(new Blob([content], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName || "source.txt";
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="h-full overflow-auto bg-white" aria-label="Source code">
      {!compact && (
        <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-border bg-white px-3 py-2">
          <div className="min-w-0 text-[11px] text-muted">
            {highlightDisabled
              ? "Highlighting disabled for large file"
              : highlightFailed
                ? "Plain source fallback"
                : `${language || "text"} source`}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={copyToClipboard}
              className="rounded border border-border px-2 py-1 text-[11px] font-semibold text-foreground transition-colors hover:border-accent hover:text-accent"
            >
              Copy
            </button>
            <button
              type="button"
              onClick={downloadSource}
              className="rounded border border-border px-2 py-1 text-[11px] font-semibold text-foreground transition-colors hover:border-accent hover:text-accent"
            >
              Download
            </button>
          </div>
        </div>
      )}
      {highlightedHtml && !highlightDisabled ? (
        <div className="grid min-w-max grid-cols-[auto_minmax(0,1fr)]">
          <LineNumbers lines={lineCount} />
          <div
            className="[&_.shiki]:m-0 [&_.shiki]:min-h-full [&_.shiki]:overflow-auto [&_.shiki]:bg-white! [&_.shiki]:px-3 [&_.shiki]:py-3 [&_.shiki]:text-xs [&_.shiki]:leading-5"
            dangerouslySetInnerHTML={{ __html: highlightedHtml }}
          />
        </div>
      ) : (
        <PlainSource content={content} lineCount={lineCount} />
      )}
    </div>
  );
}

export function MarkdownRenderer({ content }: { content: string }) {
  return (
    <div className="file-markdown h-full overflow-auto bg-white px-5 py-4 text-sm leading-6 text-foreground">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeKatex, { strict: false }], [rehypeSanitize, markdownSanitizeSchema]]}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

function latexToMarkdown(content: string): string {
  return content
    .replace(/%.*$/gm, "")
    .replace(/\\documentclass(?:\[[^\]]*])?\{[^}]+}/g, "")
    .replace(/\\usepackage(?:\[[^\]]*])?\{[^}]+}/g, "")
    .replace(/\\begin\{document}/g, "")
    .replace(/\\end\{document}/g, "")
    .replace(/\\begin\{equation\*?}/g, "$$")
    .replace(/\\end\{equation\*?}/g, "$$")
    .replace(/\\section\{([^}]+)}/g, "\n\n## $1\n\n")
    .replace(/\\subsection\{([^}]+)}/g, "\n\n### $1\n\n")
    .replace(/\\subsubsection\{([^}]+)}/g, "\n\n#### $1\n\n")
    .replace(/\\textbf\{([^}]+)}/g, "**$1**")
    .replace(/\\emph\{([^}]+)}/g, "*$1*")
    .replace(/\\\\/g, "\n");
}

export function LatexRenderer({ content }: { content: string }) {
  return <MarkdownRenderer content={latexToMarkdown(content)} />;
}

export function HtmlRenderer({ content, title }: { content: string; title: string }) {
  return (
    <iframe
      title={title}
      srcDoc={buildSandboxedSrcDoc(content)}
      sandbox=""
      className="h-full w-full border-0 bg-white"
    />
  );
}

function renderCellValue(value: string | number | null): string {
  if (value === null) return "";
  return String(value);
}

function TablePreview({ table }: { table: DataTable }) {
  const columns = table.columns.slice(0, MAX_TABLE_COLUMNS);
  const rows = table.rows.slice(0, MAX_TABLE_ROWS);
  const rowCount = table.metadata?.rowCount ?? table.rows.length;
  const clippedColumns = Math.max(0, table.columns.length - columns.length);
  const clippedRows = Math.max(0, rowCount - rows.length);

  return (
    <div className="h-full overflow-auto bg-white">
      <div className="sticky top-0 z-10 border-b border-border bg-white px-3 py-2 text-[11px] text-muted">
        {rowCount} row{rowCount === 1 ? "" : "s"}
        {clippedRows > 0 ? `, showing first ${rows.length}` : ""}
        {clippedColumns > 0 ? `, ${clippedColumns} columns hidden` : ""}
      </div>
      <table className="min-w-full border-collapse text-xs">
        <thead className="sticky top-[33px] z-10 bg-surface">
          <tr>
            {columns.map((column) => (
              <th
                key={column}
                scope="col"
                className="border-b border-r border-border px-2 py-1.5 text-left font-semibold text-foreground"
              >
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex} className="odd:bg-white even:bg-surface/40">
              {columns.map((column, columnIndex) => (
                <td
                  key={`${rowIndex}-${column}`}
                  className="max-w-[18rem] truncate border-b border-r border-border/70 px-2 py-1.5 text-foreground"
                  title={renderCellValue(row[columnIndex])}
                >
                  {renderCellValue(row[columnIndex])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function DataTableRenderer({ content, path }: { content: string; path: string }) {
  const table = useMemo(() => {
    try {
      const ext = getFileExtension(path);
      if (ext === "csv") return parseCSV(content);
      if (ext === "tsv") return parseTSV(content);
      if (ext === "json" || ext === "jsonl") return parseJSON(content);
      return null;
    } catch {
      return null;
    }
  }, [content, path]);

  if (!table || table.columns.length === 0) {
    return (
      <SourceRenderer
        content={content}
        language={getShikiLanguageForPath(path)}
        fileName={path.split("/").pop() || "data.txt"}
      />
    );
  }

  return <TablePreview table={table} />;
}

interface NotebookCell {
  cell_type?: string;
  source?: unknown;
  execution_count?: number | null;
  outputs?: NotebookOutput[];
}

interface NotebookOutput {
  output_type?: string;
  name?: string;
  text?: unknown;
  data?: Record<string, unknown>;
  traceback?: unknown;
  ename?: string;
  evalue?: string;
}

interface NotebookDocument {
  cells?: NotebookCell[];
  metadata?: Record<string, unknown>;
  nbformat?: number;
}

function NotebookOutputView({ output, index }: { output: NotebookOutput; index: number }) {
  const label = output.name || output.output_type || `Output ${index + 1}`;

  if (output.output_type === "stream") {
    return (
      <pre className="overflow-auto rounded border border-border bg-surface px-3 py-2 font-mono text-xs leading-5">
        {truncateOutput(readNotebookText(output.text))}
      </pre>
    );
  }

  if (output.output_type === "error") {
    return (
      <pre className="overflow-auto rounded border border-red-200 bg-red-50 px-3 py-2 font-mono text-xs leading-5 text-red-800">
        {truncateOutput(readNotebookText(output.traceback) || [output.ename, output.evalue].filter(Boolean).join(": "))}
      </pre>
    );
  }

  const data = output.data ?? {};
  const html = readNotebookText(data["text/html"]);
  if (html) {
    return (
      <iframe
        title={label}
        srcDoc={buildSandboxedSrcDoc(html)}
        sandbox=""
        className="h-52 w-full rounded border border-border bg-white"
      />
    );
  }

  const svg = readNotebookText(data["image/svg+xml"]);
  if (svg) {
    return (
      <iframe
        title={label}
        srcDoc={buildSandboxedSrcDoc(svg)}
        sandbox=""
        className="h-52 w-full rounded border border-border bg-white"
      />
    );
  }

  const png = readNotebookText(data["image/png"]);
  const jpeg = readNotebookText(data["image/jpeg"]);
  if (png || jpeg) {
    const mime = png ? "image/png" : "image/jpeg";
    const payload = png || jpeg;
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={`data:${mime};base64,${payload}`}
        alt={label}
        className="max-h-96 max-w-full rounded border border-border bg-white object-contain"
      />
    );
  }

  const plain = readNotebookText(data["text/plain"]);
  if (plain) {
    return (
      <pre className="overflow-auto rounded border border-border bg-surface px-3 py-2 font-mono text-xs leading-5">
        {truncateOutput(plain)}
      </pre>
    );
  }

  return null;
}

export function NotebookRenderer({ content }: { content: string }) {
  let notebook: NotebookDocument | null = null;
  try {
    notebook = JSON.parse(content) as NotebookDocument;
  } catch {
    notebook = null;
  }

  if (!notebook || !Array.isArray(notebook.cells)) {
    return (
      <div className="flex h-full items-center justify-center bg-white px-4 text-sm text-muted">
        Notebook could not be parsed.
      </div>
    );
  }

  const language =
    typeof notebook.metadata?.language_info === "object" &&
    notebook.metadata.language_info !== null &&
    "name" in notebook.metadata.language_info &&
    typeof notebook.metadata.language_info.name === "string"
      ? notebook.metadata.language_info.name
      : "python";

  return (
    <div className="h-full overflow-auto bg-white px-4 py-3">
      <div className="mb-3 rounded border border-border bg-surface px-3 py-2 text-xs text-muted">
        nbformat {notebook.nbformat ?? "?"} · {notebook.cells.length} cell{notebook.cells.length === 1 ? "" : "s"} · {language}
      </div>
      <div className="space-y-3">
        {notebook.cells.map((cell, index) => {
          const source = readNotebookText(cell.source);
          return (
            <section key={index} className="overflow-hidden rounded border border-border bg-white">
              <div className="border-b border-border bg-surface px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
                Cell {index + 1} · {cell.cell_type || "unknown"}
              </div>
              {cell.cell_type === "markdown" ? (
                <MarkdownRenderer content={source} />
              ) : cell.cell_type === "code" ? (
                <SourceRenderer
                  content={source}
                  language={language}
                  fileName={`cell-${index + 1}.${language === "r" ? "r" : "py"}`}
                  compact
                />
              ) : (
                <pre className="overflow-auto bg-white px-3 py-3 font-mono text-xs leading-5">
                  {source}
                </pre>
              )}
              {Array.isArray(cell.outputs) && cell.outputs.length > 0 && (
                <div className="space-y-2 border-t border-border bg-white px-3 py-3">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">Output</div>
                  {cell.outputs.map((output, outputIndex) => (
                    <NotebookOutputView
                      key={outputIndex}
                      output={output}
                      index={outputIndex}
                    />
                  ))}
                </div>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}

export function MediaRenderer({ preview }: { preview: Extract<FilePreviewState, { status: "ready" }> }) {
  if (!preview.rawUrl) {
    return (
      <div className="flex h-full items-center justify-center bg-white text-sm text-muted">
        Preview unavailable.
      </div>
    );
  }

  if (preview.kind === "image") {
    return (
      <div className="flex h-full items-center justify-center bg-[linear-gradient(45deg,#f4f4f5_25%,transparent_25%),linear-gradient(-45deg,#f4f4f5_25%,transparent_25%),linear-gradient(45deg,transparent_75%,#f4f4f5_75%),linear-gradient(-45deg,transparent_75%,#f4f4f5_75%)] bg-[length:20px_20px] bg-[position:0_0,0_10px,10px_-10px,-10px_0] p-3">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={preview.rawUrl}
          alt={preview.path}
          className="max-h-full max-w-full object-contain"
        />
      </div>
    );
  }

  return (
    // The native PDF viewer needs this unsandboxed raw URL iframe; arbitrary
    // HTML still uses scriptless srcDoc iframes above.
    <iframe
      src={preview.rawUrl}
      title={preview.path}
      className="h-full w-full border-0 bg-white"
    />
  );
}

export function RenderedFileContent({ preview }: { preview: Extract<FilePreviewState, { status: "ready" }> }) {
  const content = preview.content ?? "";

  switch (preview.kind) {
    case "markdown":
      return <MarkdownRenderer content={content} />;
    case "latex":
      return <LatexRenderer content={content} />;
    case "notebook":
      return <NotebookRenderer content={content} />;
    case "html":
      return <HtmlRenderer content={content} title={preview.path} />;
    case "data":
      return <DataTableRenderer content={content} path={preview.path} />;
    case "pdf":
    case "image":
      return <MediaRenderer preview={preview} />;
    default:
      return (
        <SourceRenderer
          content={content}
          language={getShikiLanguageForPath(preview.path, preview.mime)}
          fileName={preview.path.split("/").pop() || "source.txt"}
          sizeBytes={preview.sizeBytes}
        />
      );
  }
}
