/**
 * POST /api/import-project
 *
 * Reads a local directory recursively (server-side via Node fs)
 * and returns the file tree + parsed contents.
 *
 * Security: only allows paths under the user's home directory.
 */

import { readdir, stat, readFile, realpath } from "fs/promises";
import { join, relative, extname, basename, sep, resolve } from "path";
import { homedir } from "os";
import { parseFile } from "@/lib/file-parser";
import { expandHomeDir } from "@/lib/scienceswarm-paths";
import { hashContent } from "@/lib/workspace-manager";
import { buildImportPreview, buildPreviewAnalysis } from "@/lib/import/preview-core";
import { shouldSkipImportDirectory, shouldSkipImportFile } from "@/lib/import/ignore";
import { isLocalRequest } from "@/lib/local-guard";

// ── Types ────────────────────────────────────────────────────

interface ImportedFile {
  path: string;
  name: string;
  type: string;
  size: number;
  hash?: string;
  content?: string;
  metadata?: Record<string, unknown>;
}

interface ImportedFolder {
  name: string;
  basePath: string;
  totalFiles: number;
  detectedFiles: number;
  detectedItems: number;
  detectedBytes: number;
  files: ImportedFile[];
  tree: TreeNode[];
}

interface TreeNode {
  name: string;
  type: "file" | "directory";
  size?: string;
  children?: TreeNode[];
}

// ── Constants ────────────────────────────────────────────────

const MAX_FILES = 500;
const MAX_FILE_SIZE = 10_000_000; // 10 MB
const MAX_TOTAL_SIZE = 100_000_000; // 100 MB total

const TEXT_EXTENSIONS = new Set([
  ".py", ".js", ".ts", ".tsx", ".jsx", ".r", ".jl", ".m", ".sh", ".bash",
  ".tex", ".bib", ".sty", ".cls",
  ".md", ".txt", ".rst", ".log",
  ".yaml", ".yml", ".toml", ".ini", ".cfg",
  ".html", ".css", ".xml", ".sql",
  ".csv", ".json", ".tsv", ".ipynb", ".do", ".sps",
  ".dockerfile",
]);

const STRUCTURED_EXTENSIONS = new Set([".pdf", ".xlsx", ".xlsm"]);

interface ScanStats {
  detectedFiles: number;
  detectedItems: number;
  detectedBytes: number;
  hitFileLimit: boolean;
  hitTotalSizeLimit: boolean;
}

// ── Security ─────────────────────────────────────────────────

async function isPathAllowed(targetPath: string): Promise<boolean> {
  const home = resolve(homedir());
  let resolved = resolve(targetPath);
  try {
    // Resolve symlinks so aliased paths cannot escape the allow-listed root.
    resolved = await realpath(targetPath);
  } catch {
    // Keep the normalized path for the existence check that follows in the route.
  }

  // Must be under home directory — require trailing sep to prevent prefix bypass
  const homeWithSep = home.endsWith(sep) ? home : home + sep;
  if (resolved !== home && !resolved.startsWith(homeWithSep)) return false;
  // Block system directories
  const blockedPrefixes = [
    resolve(join(home, ".ssh")),
    resolve(join(home, ".gnupg")),
    resolve(join(home, ".aws")),
    resolve(join(home, ".config")),
  ];
  for (const blocked of blockedPrefixes) {
    const blockedWithSep = blocked.endsWith(sep) ? blocked : blocked + sep;
    if (resolved === blocked || resolved.startsWith(blockedWithSep)) return false;
  }
  return true;
}

// ── Helpers ──────────────────────────────────────────────────

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function inferImportedFileType(filename: string): string {
  const extension = extname(filename).slice(1).toLowerCase();
  if (extension) return extension;
  return basename(filename).toLowerCase();
}

// ── Recursive directory walker ───────────────────────────────

async function walkDirectory(
  dirPath: string,
  basePath: string,
  files: ImportedFile[],
  tree: TreeNode[],
  totalSize: { value: number },
  stats: ScanStats,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return; // Skip unreadable directories
  }

  // Sort: directories first, then files
  entries.sort((a, b) => {
    if (a.isDirectory() && !b.isDirectory()) return -1;
    if (!a.isDirectory() && b.isDirectory()) return 1;
    return a.name.localeCompare(b.name);
  });

  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);

    if (entry.isDirectory()) {
      if (shouldSkipImportDirectory(entry.name)) continue;

      stats.detectedItems += 1;

      const shouldRecordTree = files.length < MAX_FILES && totalSize.value < MAX_TOTAL_SIZE;
      const dirChildren: TreeNode[] = [];
      if (shouldRecordTree) {
        tree.push({
          name: entry.name,
          type: "directory",
          children: dirChildren,
        });
      }

      await walkDirectory(fullPath, basePath, files, dirChildren, totalSize, stats);
    } else if (entry.isFile()) {
      if (shouldSkipImportFile(entry.name)) continue;

      try {
        const fileStat = await stat(fullPath);
        stats.detectedFiles += 1;
        stats.detectedItems += 1;
        stats.detectedBytes += fileStat.size;

        if (files.length >= MAX_FILES || totalSize.value >= MAX_TOTAL_SIZE) {
          if (files.length >= MAX_FILES) stats.hitFileLimit = true;
          if (totalSize.value >= MAX_TOTAL_SIZE) stats.hitTotalSizeLimit = true;
          continue;
        }

        if (fileStat.size > MAX_FILE_SIZE) {
          const fileNode: TreeNode = {
            name: entry.name,
            type: "file",
            size: formatSize(fileStat.size),
          };
          tree.push(fileNode);
          files.push({
            path: relative(basePath, fullPath),
            name: entry.name,
            type: extname(entry.name).slice(1).toLowerCase(),
            size: fileStat.size,
            content: `[Skipped: file too large (${formatSize(fileStat.size)})]`,
          });
          continue;
        }

        totalSize.value += fileStat.size;

        const ext = extname(entry.name).toLowerCase();
        const fileType = inferImportedFileType(entry.name);
        const fileNode: TreeNode = {
          name: entry.name,
          type: "file",
          size: formatSize(fileStat.size),
        };
        tree.push(fileNode);

        const importedFile: ImportedFile = {
          path: relative(basePath, fullPath),
          name: entry.name,
          type: fileType,
          size: fileStat.size,
        };

        if (STRUCTURED_EXTENSIONS.has(ext) || TEXT_EXTENSIONS.has(ext) || fileType === "dockerfile") {
          try {
            const buffer = await readFile(fullPath);
            importedFile.hash = hashContent(buffer);
            const parsed = await parseFile(buffer, entry.name);
            importedFile.content = parsed.text;
            const metadata: Record<string, unknown> = {};
            if (parsed.pages) metadata.pages = parsed.pages;
            if (parsed.metadata) {
              Object.assign(metadata, parsed.metadata);
            }

            // Extract metadata for data files
            if (ext === ".csv" || ext === ".tsv") {
              const separator = ext === ".tsv" ? "\t" : ",";
              const lines = parsed.text.split("\n");
              Object.assign(metadata, {
                rows: Math.max(0, lines.length - 1),
                columns: lines[0]?.split(separator).length || 0,
              });
            } else if (ext === ".json") {
              try {
                const json = JSON.parse(parsed.text);
                if (Array.isArray(json)) {
                  Object.assign(metadata, { items: json.length });
                }
              } catch { /* not valid JSON */ }
            }

            if (Object.keys(metadata).length > 0) {
              importedFile.metadata = metadata;
            }
          } catch {
            importedFile.content = ext === ".pdf"
              ? "[Could not parse PDF]"
              : `[Could not parse ${fileType || "file"}]`;
          }
        } else {
          try {
            const buffer = await readFile(fullPath);
            importedFile.hash = hashContent(buffer);
          } catch {
            importedFile.hash = hashContent(`${importedFile.path}:${importedFile.size}`);
          }
          importedFile.content = `[Binary file: ${formatSize(fileStat.size)}]`;
        }

        files.push(importedFile);
      } catch {
        // Skip unreadable files
      }
    }
  }
}

function buildScanWarnings(
  result: ImportedFolder,
  stats: ScanStats,
): Array<{ code: string; message: string }> {
  const warnings: Array<{ code: string; message: string }> = [];
  if (!stats.hitFileLimit && !stats.hitTotalSizeLimit) {
    return warnings;
  }

  const limitReasons: string[] = [];
  if (stats.hitFileLimit) {
    limitReasons.push(`${MAX_FILES.toLocaleString("en-US")}-file cap`);
  }
  if (stats.hitTotalSizeLimit) {
    limitReasons.push(`${formatSize(MAX_TOTAL_SIZE)} readable-size cap`);
  }

  warnings.push({
    code: "scan-limit",
    message:
      `Local scan found ${result.detectedItems.toLocaleString("en-US")} items ` +
      `(${formatSize(result.detectedBytes)} on disk). Prepared ` +
      `${result.totalFiles.toLocaleString("en-US")} files for preview in this pass ` +
      `because of the ${limitReasons.join(" and ")}. The server-side import can continue from the full local folder in the background.`,
  });

  return warnings;
}

// ── POST handler ─────────────────────────────────────────────

export async function POST(request: Request) {
  if (!(await isLocalRequest(request))) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const body = await request.json() as unknown;
    if (typeof body !== "object" || body === null) {
      return Response.json({ error: "Invalid request body" }, { status: 400 });
    }

    const targetPath = (body as { path?: unknown }).path;

    if (typeof targetPath !== "string" || !targetPath.trim()) {
      return Response.json({ error: "No path provided" }, { status: 400 });
    }

    const normalizedTargetPath = expandHomeDir(targetPath.trim());

    // Security check
    if (!(await isPathAllowed(normalizedTargetPath))) {
      return Response.json(
        { error: "Path not allowed. Must be under your home directory and not in sensitive directories." },
        { status: 403 }
      );
    }

    // Verify directory exists
    try {
      const dirStat = await stat(normalizedTargetPath);
      if (!dirStat.isDirectory()) {
        return Response.json(
          { error: "Path is not a directory" },
          { status: 400 }
        );
      }
    } catch {
      return Response.json(
        { error: "Directory not found" },
        { status: 404 }
      );
    }

    const files: ImportedFile[] = [];
    const tree: TreeNode[] = [];
    const totalSize = { value: 0 };
    const stats: ScanStats = {
      detectedFiles: 0,
      detectedItems: 0,
      detectedBytes: 0,
      hitFileLimit: false,
      hitTotalSizeLimit: false,
    };

    await walkDirectory(normalizedTargetPath, normalizedTargetPath, files, tree, totalSize, stats);

    const result: ImportedFolder = {
      name: basename(normalizedTargetPath),
      basePath: normalizedTargetPath,
      totalFiles: files.length,
      detectedFiles: stats.detectedFiles,
      detectedItems: stats.detectedItems,
      detectedBytes: stats.detectedBytes,
      files,
      tree,
    };

    const summary = `Local scan: ${result.name} (${result.totalFiles} files prepared)`;
    const rawPreview = buildImportPreview({
      analysis: summary,
      backend: "local-scan",
      summary,
      files: result.files.map((file) => ({
        path: file.path,
        type: file.type,
        size: file.size,
        content: file.content,
        hash: file.hash ?? hashContent(`${file.path}:${file.size}`),
        metadata: file.metadata,
      })),
      sourceLabel: result.name,
    });
    const preview = {
      ...rawPreview,
      warnings: buildScanWarnings(result, stats).concat(rawPreview.warnings),
    };

    return Response.json({
      ...result,
      analysis: buildPreviewAnalysis(preview),
      backend: "local-scan",
      preview,
      projects: preview.projects,
      duplicateGroups: preview.duplicateGroups,
      warnings: preview.warnings,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Import error";
    console.error("Project import error:", message);
    return Response.json({ error: message }, { status: 500 });
  }
}
