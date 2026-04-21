import { basename, extname } from "node:path";
import { hashContent } from "@/lib/workspace-manager";
import type {
  Confidence,
  ImportPreview,
  ImportPreviewFile,
  ImportPreviewProject,
} from "@/brain/types";

export interface PreviewInputFile {
  path: string;
  type: string;
  size: number;
  content?: string;
  hash?: string;
  metadata?: Record<string, unknown>;
}

export interface BuildImportPreviewInput {
  analysis: string;
  backend: string;
  summary: string;
  files: PreviewInputFile[];
  sourceLabel?: string;
}

const MAX_PREVIEW_FILES = 100;

const CODE_EXTENSIONS = new Set([
  "py", "js", "ts", "tsx", "jsx", "r", "jl", "m", "sh", "bash", "sql", "dockerfile",
]);
const STATS_EXTENSIONS = new Set(["do", "sps"]);
const NOTEBOOK_EXTENSIONS = new Set(["ipynb"]);
const SPREADSHEET_EXTENSIONS = new Set(["xlsx", "xlsm", "xls"]);
const DATA_EXTENSIONS = new Set(["csv", "json", "tsv", "npy", "pkl", "h5", "hdf5", "dat"]);
const PROTOCOL_HINTS = [/protocol/i, /checklist/i];
const MEETING_HINTS = [/meetings\//i, /meeting/i, /call/i];
const CLASS_HINTS = [/coursework\//i, /notes\/class\//i, /syllabus/i, /seminar/i];
const DRAFT_HINTS = [/writing\//i, /draft/i, /manuscript/i, /grant/i, /chapter/i];
const GENERIC_SOURCE_LABEL_SUFFIXES = [
  /-lab-archive$/i,
  /-archive$/i,
  /-dataset$/i,
  /-corpus$/i,
];

export function buildImportPreview(input: BuildImportPreviewInput): ImportPreview {
  const normalizedFiles = input.files.map((file) => normalizePreviewFile(file));
  const files = normalizedFiles.slice(0, MAX_PREVIEW_FILES);
  const duplicateGroups = buildDuplicateGroups(input.files);
  const projects = inferProjects(input.summary, normalizedFiles, input.sourceLabel);
  const warnings = buildWarnings(normalizedFiles.length, duplicateGroups);

  return {
    analysis: input.analysis,
    backend: input.backend,
    totalFiles: normalizedFiles.length,
    previewFileLimit: MAX_PREVIEW_FILES,
    files,
    projects,
    duplicateGroups,
    warnings,
  };
}

export function buildPreviewAnalysis(preview: ImportPreview): string {
  const totalFiles = preview.totalFiles ?? preview.files.length;
  const previewedFiles = preview.files.length;
  const lines = [
    `Local scan preview (${preview.backend})`,
    "",
    preview.analysis.trim(),
    "",
    totalFiles > previewedFiles
      ? `Files: ${previewedFiles} shown / ${totalFiles} prepared for import`
      : `Files: ${totalFiles} prepared for import`,
    `Projects: ${preview.projects.length}`,
    `Duplicate groups: ${preview.duplicateGroups.length}`,
    `Warnings: ${preview.warnings.length}`,
  ];

  if (preview.projects.length > 0) {
    lines.push(
      "",
      "Top project candidates:",
      ...preview.projects.slice(0, 3).map((project) => `- ${project.title} (${project.confidence})`),
    );
  }

  if (preview.warnings.length > 0) {
    lines.push(
      "",
      "Warnings:",
      ...preview.warnings.slice(0, 5).map((warning) => `- ${warning.code}: ${warning.message}`),
    );
  }

  return lines.join("\n");
}

function normalizePreviewFile(file: PreviewInputFile): ImportPreviewFile {
  const content = file.content ?? "";
  const hash = file.hash ?? hashContent(content || `${file.path}:${file.size}`);
  const projectCandidates = inferProjectCandidates(file.path, content);
  const warnings = buildFileWarnings(file, content, inferPreviewExtension(file));

  return {
    path: file.path,
    type: inferPreviewExtension(file) || "unknown",
    size: file.size,
    hash,
    classification: classifyImportFile(file),
    projectCandidates,
    warnings,
  };
}

function inferPreviewExtension(file: Pick<PreviewInputFile, "path" | "type">): string {
  if (file.type) {
    return normalizeExtension(file.type);
  }

  const pathExtension = normalizeExtension(extname(file.path));
  if (pathExtension) {
    return pathExtension;
  }

  return normalizeExtension(basename(file.path));
}

export function classifyImportFile(
  file: Pick<PreviewInputFile, "path" | "type" | "content">,
): string {
  const extension = inferPreviewExtension(file);
  const content = file.content ?? "";
  return classifyFile(file.path, extension, content);
}

function classifyFile(path: string, extension: string, content: string): string {
  if (extension === "pdf") return "paper";
  if (NOTEBOOK_EXTENSIONS.has(extension)) return "notebook";
  if (SPREADSHEET_EXTENSIONS.has(extension)) return "spreadsheet";
  if (DATA_EXTENSIONS.has(extension)) return "data";
  if (STATS_EXTENSIONS.has(extension)) return "stats";
  if (CODE_EXTENSIONS.has(extension)) return "code";
  if (matchesAny(path, PROTOCOL_HINTS)) return "protocol";
  if (matchesAny(path, MEETING_HINTS)) return "meeting_note";
  if (matchesAny(path, CLASS_HINTS)) return "class_note";
  if (matchesAny(path, DRAFT_HINTS)) return "draft";
  if (content.startsWith("[Binary file:")) return "binary";
  if (content.trim().length > 0) return "note";
  return "other";
}

function inferProjects(
  summary: string,
  files: ImportPreviewFile[],
  sourceLabel?: string,
): ImportPreviewProject[] {
  const suggestions: ImportPreviewProject[] = [];
  const rootLabel = sourceLabel || extractSummaryLabel(summary);

  if (rootLabel) {
    const rootSlug = slugify(normalizeSourceLabel(rootLabel));
    suggestions.push({
      slug: rootSlug,
      title: humanizeSlug(rootSlug),
      confidence: "medium",
      reason: "Archive root detected; treat this as an umbrella import until project buckets are confirmed.",
      sourcePaths: files.slice(0, 10).map((file) => file.path),
    });
  }

  suggestions.push(...buildArchiveBucketProjects(files));

  if (suggestions.length === 0) {
    const fallbackSlug = slugify(files[0]?.path.split(/[\\/]/)[0] || "imported-project");
    suggestions.push({
      slug: fallbackSlug,
      title: humanizeSlug(fallbackSlug),
      confidence: "low",
      reason: "Fallback inferred from imported file paths.",
      sourcePaths: files.slice(0, 10).map((file) => file.path),
    });
  }

  return dedupeProjects(suggestions).slice(0, 5);
}

function buildDuplicateGroups(
  files: Array<Pick<PreviewInputFile, "path" | "size" | "hash" | "content">>,
): ImportPreview["duplicateGroups"] {
  const groups = new Map<string, ImportPreviewFile[]>();
  for (const file of files) {
    const hash = resolvePreviewHash(file);
    const bucket = groups.get(hash) ?? [];
    bucket.push({
      path: file.path,
      type: "",
      size: file.size,
      hash,
      classification: "other",
      projectCandidates: [],
      warnings: [],
    });
    groups.set(hash, bucket);
  }

  return Array.from(groups.entries())
    .filter(([, group]) => group.length > 1)
    .map(([hash, group], index) => ({
      id: `dup-${index + 1}-${hash.slice(0, 8)}`,
      paths: group.map((file) => file.path),
      reason: `Identical content hash ${hash.slice(0, 12)}`,
      hashPrefix: hash.slice(0, 12),
      contentType: inferDuplicateGroupContentType(group.map((file) => file.path)),
    }));
}

export function inferDuplicateGroupContentType(paths: string[]): string {
  const classifications = new Set(
    paths.map((candidatePath) => classifyImportFile({ path: candidatePath, type: "", content: "" })),
  );
  if (classifications.size === 1) {
    return classifications.values().next().value ?? "other";
  }
  return "mixed";
}

function buildWarnings(
  totalFiles: number,
  duplicateGroups: ImportPreview["duplicateGroups"],
): ImportPreview["warnings"] {
  const warnings: ImportPreview["warnings"] = [];

  if (totalFiles > MAX_PREVIEW_FILES) {
    warnings.push({
      code: "file-limit",
      message: `Preview shows only the first ${MAX_PREVIEW_FILES} prepared files out of ${totalFiles} local files scanned.`,
    });
  }

  if (duplicateGroups.length > 0) {
    warnings.push({
      code: "duplicates",
      message: `${duplicateGroups.length} duplicate group(s) detected in the local scan.`,
    });
  }

  if (totalFiles === 0) {
    warnings.push({
      code: "empty-import",
      message: "No importable files were found.",
    });
  }

  return warnings;
}

function resolvePreviewHash(
  file: Pick<PreviewInputFile, "path" | "size" | "hash" | "content">,
): string {
  if (file.hash) {
    return file.hash;
  }

  if (typeof file.content === "string" && file.content.length > 0) {
    return hashContent(file.content);
  }

  return hashContent(`${file.path}:${file.size}`);
}

function buildFileWarnings(
  file: PreviewInputFile,
  content: string,
  extension: string,
): string[] {
  const warnings: string[] = [];
  if (file.size > 10_000_000) {
    warnings.push("Large file");
  }
  if (content.length === 0 && extension !== "pdf") {
    warnings.push("Empty content");
  }
  if (content.includes("[... truncated ...]")) {
    warnings.push("Truncated content");
  }
  return warnings;
}

function normalizeExtension(input: string): string {
  const ext = input.startsWith(".") ? input.slice(1) : input;
  return ext.toLowerCase();
}

function extractSummaryLabel(summary: string): string | null {
  const patterns = [
    /^Local scan:\s*([^\n(]+)/i,
    /^Scan:\s*([^\n(]+)/i,
    /^Imported:\s*([^\n(]+)/i,
    /^Folder:\s*([^\n(]+)/i,
  ];

  for (const pattern of patterns) {
    const match = summary.match(pattern);
    if (match) {
      return match[1].trim();
    }
  }

  return null;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64) || "imported-project";
}

function humanizeSlug(value: string): string {
  return value
    .split(/[-_/]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function inferProjectCandidates(path: string, content: string): string[] {
  const candidates = new Set<string>();
  const parts = path.split(/[\\/]+/).filter(Boolean);
  if (parts.length > 1) {
    candidates.add(slugify(parts[0]));
  }

  const firstHeading = content.match(/^#\s+(.+)$/m)?.[1];
  if (firstHeading) {
    candidates.add(slugify(firstHeading));
  }

  const titleMatch = content.match(/^title:\s*(.+)$/im)?.[1];
  if (titleMatch) {
    candidates.add(slugify(titleMatch));
  }

  return Array.from(candidates);
}

function matchesAny(value: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

function normalizeSourceLabel(value: string): string {
  let normalized = value.trim();
  let strippedGenericSuffix = false;
  for (const pattern of GENERIC_SOURCE_LABEL_SUFFIXES) {
    const next = normalized.replace(pattern, "");
    if (next !== normalized) {
      strippedGenericSuffix = true;
      normalized = next;
    }
  }
  if (!normalized) {
    normalized = value.trim();
  }
  if (strippedGenericSuffix && !/archive/i.test(normalized)) {
    normalized = `${normalized}-research-archive`;
  }
  return normalized;
}

function buildArchiveBucketProjects(files: ImportPreviewFile[]): ImportPreviewProject[] {
  const buckets = new Map<string, {
    title: string;
    confidence: Confidence;
    reason: string;
    sourcePaths: string[];
  }>();

  const assign = (
    slug: string,
    title: string,
    confidence: Confidence,
    reason: string,
    path: string,
  ) => {
    const existing = buckets.get(slug);
    if (existing) {
      if (existing.sourcePaths.length < 10) {
        existing.sourcePaths.push(path);
      }
      return;
    }
    buckets.set(slug, { title, confidence, reason, sourcePaths: [path] });
  };

  for (const file of files) {
    const normalizedPath = file.path.replace(/\\/g, "/");

    if (/^(analysis|data|fieldsite|protocols|papers|collab-drop)\//.test(normalizedPath)) {
      assign(
        "active-research",
        "Active Research",
        "medium",
        "Derived from analysis, data, field, protocol, or collaborator materials.",
        file.path,
      );
    }

    if (/^writing\//.test(normalizedPath) || file.classification === "draft") {
      assign(
        "writing-and-publication",
        "Writing And Publication",
        "medium",
        "Derived from manuscript, grant, and book-draft materials.",
        file.path,
      );
    }

    if (/^(coursework|notes\/class)\//.test(normalizedPath) || file.classification === "class_note") {
      assign(
        "coursework-and-reading",
        "Coursework And Reading",
        "low",
        "Derived from class notes and reading-log style materials.",
        file.path,
      );
    }

    if (/^(admin|notes\/meetings)\//.test(normalizedPath) || file.classification === "meeting_note") {
      assign(
        "operations-and-planning",
        "Operations And Planning",
        "low",
        "Derived from admin files, meeting notes, and planning artifacts.",
        file.path,
      );
    }
  }

  return Array.from(buckets.entries()).map(([slug, bucket]) => ({
    slug,
    title: bucket.title,
    confidence: bucket.confidence,
    reason: bucket.reason,
    sourcePaths: bucket.sourcePaths,
  }));
}

function dedupeProjects(projects: ImportPreviewProject[]): ImportPreviewProject[] {
  const seen = new Set<string>();
  const deduped: ImportPreviewProject[] = [];

  for (const project of projects) {
    if (seen.has(project.slug)) continue;
    seen.add(project.slug);
    deduped.push(project);
  }

  return deduped;
}
