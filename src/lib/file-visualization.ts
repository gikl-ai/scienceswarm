import type { CompiledPageRead } from "@/components/research/compiled-page-view";

export type WorkspacePreviewSource = "workspace" | "gbrain";

export type FileVisualizationKind =
  | "source-code"
  | "markdown"
  | "latex"
  | "notebook"
  | "html"
  | "data"
  | "pdf"
  | "image"
  | "unknown";

export type FilePreviewState =
  | { status: "idle" }
  | { status: "loading"; path: string; source: WorkspacePreviewSource }
  | {
      status: "ready";
      path: string;
      source: WorkspacePreviewSource;
      kind: FileVisualizationKind;
      content?: string;
      rawUrl?: string;
      mime?: string;
      sizeBytes?: number;
      editable: boolean;
      compiledPage?: CompiledPageRead;
    }
  | { status: "error"; path: string; source: WorkspacePreviewSource; message: string; retryable: boolean };

const SOURCE_CODE_EXTENSIONS = new Set([
  "py",
  "r",
  "c",
  "cc",
  "cpp",
  "cxx",
  "h",
  "hh",
  "hpp",
  "js",
  "jsx",
  "ts",
  "tsx",
  "mjs",
  "cjs",
  "sh",
  "bash",
  "zsh",
  "sql",
  "toml",
  "yaml",
  "yml",
  "txt",
  "log",
  "xml",
  "svg",
]);

const MARKDOWN_EXTENSIONS = new Set(["md", "markdown", "mdown", "mkd"]);
const LATEX_EXTENSIONS = new Set(["tex", "sty", "cls", "bib"]);
const NOTEBOOK_EXTENSIONS = new Set(["ipynb"]);
const HTML_EXTENSIONS = new Set(["html", "htm"]);
const DATA_EXTENSIONS = new Set(["csv", "tsv", "json", "jsonl"]);
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  py: "python",
  r: "r",
  c: "c",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  h: "c",
  hh: "cpp",
  hpp: "cpp",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  tsx: "tsx",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  sql: "sql",
  toml: "toml",
  yaml: "yaml",
  yml: "yaml",
  json: "json",
  jsonl: "json",
  md: "markdown",
  markdown: "markdown",
  tex: "latex",
  sty: "latex",
  cls: "latex",
  bib: "bibtex",
  html: "html",
  htm: "html",
  csv: "csv",
  tsv: "tsv",
  xml: "xml",
  svg: "xml",
  txt: "text",
  log: "log",
};

export function getFileExtension(filePath: string): string {
  const withoutQuery = filePath.split("?")[0] ?? filePath;
  const basename = withoutQuery.split("/").pop() ?? withoutQuery;
  const index = basename.lastIndexOf(".");
  if (index < 0 || index === basename.length - 1) return "";
  return basename.slice(index + 1).toLowerCase();
}

export function getFileDisplayName(filePath: string): string {
  return filePath.split("/").pop() || filePath;
}

export function normalizeWorkspaceRelativePath(filePath: string): string | null {
  const segments: string[] = [];
  for (const segment of filePath.replaceAll("\\", "/").split("/")) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      return null;
    }
    segments.push(segment);
  }

  const normalized = segments.join("/");
  if (!normalized || normalized === "." || normalized === "..") {
    return null;
  }
  return normalized;
}

export function buildWorkspaceRawPreviewUrl(
  filePath: string,
  projectId: string | null,
  { preferPathRoute = false }: { preferPathRoute?: boolean } = {},
): string | null {
  const normalizedPath = normalizeWorkspaceRelativePath(filePath);
  if (!normalizedPath) {
    return null;
  }

  if (preferPathRoute && projectId) {
    const encodedSegments = normalizedPath
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");
    return `/api/workspace/raw/${encodeURIComponent(projectId)}/${encodedSegments}`;
  }

  const params = new URLSearchParams({ action: "raw", file: normalizedPath });
  if (projectId) {
    params.set("projectId", projectId);
  }
  return `/api/workspace?${params.toString()}`;
}

export function classifyFile(filePath: string, mime?: string): FileVisualizationKind {
  const normalizedMime = (mime ?? "").toLowerCase();
  if (normalizedMime.startsWith("application/pdf")) return "pdf";
  if (normalizedMime.startsWith("image/") && normalizedMime !== "image/svg+xml") return "image";
  if (normalizedMime.includes("html")) return "html";
  if (normalizedMime.includes("markdown")) return "markdown";
  if (normalizedMime.includes("json")) return "data";

  const ext = getFileExtension(filePath);
  if (ext === "pdf") return "pdf";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (NOTEBOOK_EXTENSIONS.has(ext)) return "notebook";
  if (MARKDOWN_EXTENSIONS.has(ext)) return "markdown";
  if (LATEX_EXTENSIONS.has(ext)) return "latex";
  if (HTML_EXTENSIONS.has(ext)) return "html";
  if (DATA_EXTENSIONS.has(ext)) return "data";
  if (SOURCE_CODE_EXTENSIONS.has(ext)) return "source-code";
  return "unknown";
}

export function isRawRenderableKind(kind: FileVisualizationKind): boolean {
  return kind === "pdf" || kind === "image";
}

export function shouldLoadAsText(kind: FileVisualizationKind): boolean {
  return (
    kind === "source-code" ||
    kind === "markdown" ||
    kind === "latex" ||
    kind === "notebook" ||
    kind === "html" ||
    kind === "data"
  );
}

export function canRenderKind(kind: FileVisualizationKind): boolean {
  return kind !== "source-code" && kind !== "unknown";
}

export function getShikiLanguageForPath(filePath: string, mime?: string): string {
  const normalizedMime = (mime ?? "").toLowerCase();
  if (normalizedMime.includes("typescript")) return "typescript";
  if (normalizedMime.includes("javascript")) return "javascript";
  if (normalizedMime.includes("python")) return "python";
  if (normalizedMime.includes("json")) return "json";
  if (normalizedMime.includes("html")) return "html";
  if (normalizedMime.includes("markdown")) return "markdown";
  if (normalizedMime.includes("latex") || normalizedMime.includes("tex")) return "latex";
  return LANGUAGE_BY_EXTENSION[getFileExtension(filePath)] ?? "text";
}
