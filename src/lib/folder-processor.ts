// ── Folder Processor ──────────────────────────────────────────
// Recursively processes folders uploaded via webkitdirectory.
// Groups files by type, extracts content, builds a structured result.

import { parseCSV, parseTSV, parseJSON } from "./data-transform";

// ── Types ────────────────────────────────────────────────────

export interface ProcessedFile {
  path: string;
  name: string;
  type: string; // pdf, py, csv, json, tex, md, etc.
  size: number;
  hash?: string;
  content?: string; // extracted text (for text files and PDFs)
  metadata?: Record<string, unknown>; // parsed stats for data files
}

export interface ProcessedFolderTreeNode {
  name: string;
  type: "file" | "directory";
  size?: string;
  children?: ProcessedFolderTreeNode[];
}

export interface ProcessedFolder {
  name: string;
  totalFiles: number;
  files: ProcessedFile[];
  tree: ProcessedFolderTreeNode[];
  summary: string; // AI-generated summary of the folder contents
  filesByType: Record<string, ProcessedFile[]>;
}

export interface FolderProgress {
  total: number;
  processed: number;
  currentFile: string;
}

export interface FolderPreviewInputFile {
  path: string;
  type: string;
  size: number;
  content?: string;
  hash?: string;
  metadata?: Record<string, unknown>;
}

// ── Constants ────────────────────────────────────────────────

const TEXT_EXTENSIONS = new Set([
  "py", "js", "ts", "tsx", "jsx", "r", "jl", "m", "sh", "bash",
  "tex", "bib", "sty", "cls", "md", "txt", "rst", "log",
  "yaml", "yml", "toml", "ini", "cfg",
  "html", "css", "xml",
  "sql", "dockerfile", "do", "sps",
]);

const DATA_EXTENSIONS = new Set(["csv", "json", "tsv"]);
const API_PARSED_EXTENSIONS = new Set(["pdf", "ipynb", "xlsx", "xlsm"]);

const MAX_TEXT_SIZE = 100_000; // 100 KB text cap per file
const MAX_FILE_SIZE = 50_000_000; // 50 MB skip threshold

// ── Helpers ──────────────────────────────────────────────────

function getExtension(filename: string): string {
  return filename.split(".").pop()?.toLowerCase() || "";
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function extractFolderName(files: File[]): string {
  if (files.length === 0) return "unknown";
  // webkitRelativePath is like "folder/sub/file.txt"
  const first = (files[0] as File & { webkitRelativePath?: string }).webkitRelativePath || files[0].name;
  const parts = first.split("/");
  return parts.length > 1 ? parts[0] : "uploaded";
}

function normalizeRelativePath(rawPath: string, folderName: string): string {
  const normalizedPath = rawPath.replace(/\\/g, "/");
  const folderPrefix = `${folderName}/`;
  if (normalizedPath.startsWith(folderPrefix)) {
    return normalizedPath.slice(folderPrefix.length);
  }
  return normalizedPath;
}

// ── Text extraction ──────────────────────────────────────────

async function extractTextContent(file: File): Promise<string> {
  if (file.size > MAX_TEXT_SIZE) {
    const slice = file.slice(0, MAX_TEXT_SIZE);
    const text = await slice.text();
    return text + `\n\n[... truncated at ${formatSize(MAX_TEXT_SIZE)} ...]`;
  }
  return file.text();
}

async function extractPdfContent(file: File): Promise<{ text: string; pages?: number }> {
  try {
    const formData = new FormData();
    formData.append("file", file);
    const res = await fetch("/api/parse-file", {
      method: "POST",
      body: formData,
    });
    const result = await res.json();
    if (result.error) return { text: `[PDF parse error: ${result.error}]` };
    return { text: result.text, pages: result.pages };
  } catch {
    return { text: "[Could not parse PDF]" };
  }
}

async function extractStructuredContent(file: File): Promise<{
  text: string;
  metadata?: Record<string, unknown>;
}> {
  try {
    const formData = new FormData();
    formData.append("file", file);
    const res = await fetch("/api/parse-file", {
      method: "POST",
      body: formData,
    });
    const result = await res.json();
    if (!res.ok || result.error) {
      throw new Error(typeof result.error === "string" ? result.error : "Parse failed");
    }

    const metadata: Record<string, unknown> = {};
    if (result.pages) metadata.pages = result.pages;
    if (result.metadata && typeof result.metadata === "object") {
      Object.assign(metadata, result.metadata);
    }

    return {
      text: typeof result.text === "string" ? result.text : "",
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    };
  } catch {
    const ext = getExtension(file.name);
    return {
      text: ext === "pdf" ? "[Could not parse PDF]" : `[Could not parse ${ext || "file"}]`,
    };
  }
}

async function hashFile(file: File): Promise<string | undefined> {
  try {
    const buffer = await file.arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", buffer);
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return undefined;
  }
}

function extractDataMetadata(content: string, ext: string): Record<string, unknown> {
  try {
    if (ext === "csv" || ext === "tsv") {
      const table = ext === "tsv" ? parseTSV(content) : parseCSV(content);
      return {
        rows: table.rows.length,
        columns: table.columns.length,
        columnNames: table.columns,
        sampleValues: table.rows.slice(0, 3).map((row) =>
          Object.fromEntries(table.columns.map((col, i) => [col, row[i]]))
        ),
      };
    }
    if (ext === "json") {
      const table = parseJSON(content);
      return {
        rows: table.rows.length,
        columns: table.columns.length,
        columnNames: table.columns,
      };
    }
  } catch {
    // Fall through
  }
  return {};
}

// ── Main Processor ───────────────────────────────────────────

export async function processFolder(
  files: File[],
  onProgress?: (progress: FolderProgress) => void
): Promise<ProcessedFolder> {
  const folderName = extractFolderName(files);
  const processed: ProcessedFile[] = [];
  const total = files.length;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const rawRelativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    const relativePath = normalizeRelativePath(rawRelativePath, folderName);
    const ext = getExtension(file.name);

    onProgress?.({ total, processed: i, currentFile: relativePath });

    // Skip very large binary files
    if (file.size > MAX_FILE_SIZE) {
      processed.push({
        path: relativePath,
        name: file.name,
        type: ext,
        size: file.size,
        content: `[Skipped: file too large (${formatSize(file.size)})]`,
      });
      continue;
    }

    const entry: ProcessedFile = {
      path: relativePath,
      name: file.name,
      type: ext,
      size: file.size,
    };
    entry.hash = await hashFile(file);

    if (API_PARSED_EXTENSIONS.has(ext)) {
      const result = ext === "pdf"
        ? await extractPdfContent(file)
        : await extractStructuredContent(file);
      entry.content = result.text;
      if ("pages" in result && result.pages) {
        entry.metadata = { ...(entry.metadata || {}), pages: result.pages };
      }
      if ("metadata" in result && result.metadata) {
        entry.metadata = { ...(entry.metadata || {}), ...result.metadata };
      }
    } else if (TEXT_EXTENSIONS.has(ext)) {
      entry.content = await extractTextContent(file);
    } else if (DATA_EXTENSIONS.has(ext)) {
      const text = await extractTextContent(file);
      entry.content = text;
      entry.metadata = extractDataMetadata(text, ext);
    } else {
      // Binary file — just record metadata
      entry.content = `[Binary file: ${formatSize(file.size)}]`;
    }

    processed.push(entry);
  }

  onProgress?.({ total, processed: total, currentFile: "Done" });

  // Group by type
  const filesByType: Record<string, ProcessedFile[]> = {};
  for (const file of processed) {
    const cat = categorizeFile(file.type);
    if (!filesByType[cat]) filesByType[cat] = [];
    filesByType[cat].push(file);
  }

  return {
    name: folderName,
    totalFiles: processed.length,
    files: processed,
    tree: buildTree(processed),
    summary: buildLocalSummary(folderName, processed, filesByType),
    filesByType,
  };
}

// ── Categorization ───────────────────────────────────────────

function categorizeFile(ext: string): string {
  if (ext === "pdf") return "papers";
  if (["py", "js", "ts", "tsx", "jsx", "r", "jl", "m", "sh", "bash"].includes(ext)) return "code";
  if (["csv", "json", "tsv", "npy", "pkl", "h5", "hdf5", "dat"].includes(ext)) return "data";
  if (["tex", "bib", "sty", "cls"].includes(ext)) return "latex";
  if (["md", "txt", "rst", "log"].includes(ext)) return "docs";
  if (["png", "jpg", "jpeg", "gif", "svg", "webp"].includes(ext)) return "figures";
  if (["yaml", "yml", "toml", "ini", "cfg"].includes(ext)) return "config";
  return "other";
}

// ── Local Summary (before AI) ────────────────────────────────

function buildLocalSummary(
  name: string,
  files: ProcessedFile[],
  byType: Record<string, ProcessedFile[]>
): string {
  const lines: string[] = [`Folder: ${name} (${files.length} files)`];

  for (const [category, catFiles] of Object.entries(byType)) {
    const totalSize = catFiles.reduce((sum, f) => sum + f.size, 0);
    lines.push(`  ${category}: ${catFiles.length} files (${formatSize(totalSize)})`);

    for (const f of catFiles.slice(0, 5)) {
      let detail = formatSize(f.size);
      if (f.metadata) {
        if (f.metadata.pages) detail += `, ${f.metadata.pages} pages`;
        if (f.metadata.rows) detail += `, ${f.metadata.rows} rows x ${f.metadata.columns} cols`;
      }
      lines.push(`    - ${f.path} (${detail})`);
    }
    if (catFiles.length > 5) {
      lines.push(`    ... and ${catFiles.length - 5} more`);
    }
  }

  return lines.join("\n");
}

function buildTree(files: ProcessedFile[]): ProcessedFolderTreeNode[] {
  const root: ProcessedFolderTreeNode[] = [];

  for (const file of files) {
    const parts = file.path.split("/").filter(Boolean);
    let cursor = root;

    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      const isLeaf = index === parts.length - 1;

      if (isLeaf) {
        if (!cursor.find((node) => node.type === "file" && node.name === part)) {
          cursor.push({
            name: part,
            type: "file",
            size: formatSize(file.size),
          });
        }
        continue;
      }

      let next = cursor.find(
        (node): node is ProcessedFolderTreeNode =>
          node.type === "directory" && node.name === part,
      );

      if (!next) {
        next = {
          name: part,
          type: "directory",
          children: [],
        };
        cursor.push(next);
      }

      cursor = next.children ?? [];
      next.children = cursor;
    }
  }

  return root;
}

// ── Prepare for AI analysis ──────────────────────────────────

export function prepareFolderForAnalysis(folder: ProcessedFolder): {
  summary: string;
  fileContents: { path: string; type: string; content: string }[];
  previewFiles: FolderPreviewInputFile[];
} {
  const fileContents: { path: string; type: string; content: string }[] = [];
  const previewFiles: FolderPreviewInputFile[] = [];

  for (const file of folder.files) {
    previewFiles.push({
      path: file.path,
      type: file.type,
      size: file.size,
      content: file.content,
      hash: file.hash,
      metadata: file.metadata,
    });

    if (!file.content) continue;
    // Limit per-file content for the AI call
    const maxChars = file.type === "pdf" ? 8000 : 4000;
    const content = file.content.length > maxChars
      ? file.content.slice(0, maxChars) + "\n[... truncated ...]"
      : file.content;
    fileContents.push({ path: file.path, type: file.type, content });
  }

  return { summary: folder.summary, fileContents, previewFiles };
}
