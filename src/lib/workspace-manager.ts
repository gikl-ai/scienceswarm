import crypto from "crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { getScienceSwarmWorkspaceRoot } from "@/lib/scienceswarm-paths";

// The workspace is the OpenHands Docker sandbox at /workspace/.
// When OpenHands isn't running, we use a local fallback under SCIENCESWARM_DIR
// or ~/.scienceswarm/workspace/.

export interface FileReference {
  originalPath: string;      // where the file came from
  workspacePath: string;     // where it lives in the workspace
  hash: string;              // SHA-256 of content for change detection
  type: string;              // paper, code, data, doc, figure, config
  size: number;
  importedAt: string;
  lastChecked?: string;
  changed?: boolean;
  localEditedAt?: string;
}

export interface ReferencesFile {
  version: number;
  files: FileReference[];
}

export interface FileMeta {
  title: string;
  type: string;
  format: string;            // pdf, python, csv, latex, etc.
  size: string;
  originalPath?: string;
  importedAt: string;
  structure?: string;        // e.g. "50 pages, 12 sections" or "342 rows, 6 columns"
  summary?: string;          // AI-generated summary
  conclusions?: string;      // key findings
  references?: string[];     // cited papers or dependencies
  changes?: string[];        // change log
}

export interface SavedArtifactFile {
  absolutePath: string;
  relativePath: string;
  title: string;
}

/** Map file extension to a workspace sub-folder. */
export function getTargetFolder(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() || "";

  // Test files
  if (/^test_|_test\.|\.test\.|\.spec\./.test(filename)) return "code/tests";

  const map: Record<string, string> = {
    pdf: "papers", py: "code", r: "code", jl: "code", ipynb: "code",
    csv: "data", json: "data", tsv: "data", xlsx: "data", npy: "data", h5: "data",
    tex: "docs", bib: "docs", md: "docs", txt: "docs",
    png: "figures", jpg: "figures", svg: "figures", gif: "figures", html: "figures",
    yaml: "config", yml: "config", toml: "config", ini: "config",
  };

  return map[ext] || "other";
}

/** Build companion `.md` content for an imported file. */
export function generateCompanionMd(
  filename: string,
  content: string,
  type: string,
): string {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  const lines = content.split("\n");

  let structure = "";
  let format = ext.toUpperCase();

  if (ext === "csv" || ext === "tsv") {
    const sep = ext === "tsv" ? "\t" : ",";
    const headers = lines[0]?.split(sep) || [];
    structure = `${lines.length - 1} rows, ${headers.length} columns: ${headers.join(", ")}`;
    format = `${ext.toUpperCase()} (tabular data)`;
  } else if (ext === "json") {
    try {
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) structure = `Array with ${parsed.length} items`;
      else structure = `Object with keys: ${Object.keys(parsed).slice(0, 10).join(", ")}`;
    } catch {
      structure = "Invalid JSON";
    }
    format = "JSON";
  } else if (ext === "py") {
    const functions = lines
      .filter(l => l.match(/^def /))
      .map(l => l.match(/^def (\w+)/)?.[1])
      .filter(Boolean);
    const classes = lines
      .filter(l => l.match(/^class /))
      .map(l => l.match(/^class (\w+)/)?.[1])
      .filter(Boolean);
    const imports = lines.filter(l => l.match(/^import |^from /)).length;
    structure = `${lines.length} lines, ${functions.length} functions, ${classes.length} classes, ${imports} imports`;
    if (functions.length > 0) structure += `\nFunctions: ${functions.join(", ")}`;
    if (classes.length > 0) structure += `\nClasses: ${classes.join(", ")}`;
    format = "Python";
  } else if (ext === "tex") {
    const sections = lines
      .filter(l => l.match(/\\section\{|\\subsection\{/))
      .map(l => l.match(/\\(?:sub)?section\{([^}]+)\}/)?.[1])
      .filter(Boolean);
    structure = `${lines.length} lines, ${sections.length} sections`;
    if (sections.length > 0) structure += `\nSections: ${sections.join(", ")}`;
    format = "LaTeX";
  } else if (ext === "pdf") {
    // PDF content is binary — word count from raw bytes is meaningless.
    // Companion .md will show it as a binary placeholder; actual text
    // extraction should use pdf-parse at the call site if needed.
    structure = "(binary — use pdf-parse for text extraction)";
    format = "PDF";
  } else {
    structure = `${lines.length} lines`;
  }

  const now = new Date().toISOString();

  return `---
title: "${filename}"
type: ${type}
format: ${format}
imported: ${now}
---

# ${filename}

## File Info
- **Format:** ${format}
- **Structure:** ${structure}
- **Type:** ${type}

## Content Preview
\`\`\`
${content.slice(0, 2000)}${content.length > 2000 ? "\n... (truncated)" : ""}
\`\`\`

## Summary
*(Auto-generated on next AI analysis)*

## Key Findings
*(Updated when AI analyzes this file)*

## References
*(Links to related files in this study)*

## Change Log
- ${now.split("T")[0]}: Imported
`;
}

/** SHA-256 hash of content for change detection. */
export function hashContent(content: string | Buffer): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

export function slugifyWorkspaceSegment(input: string): string {
  let slug = "";
  let needsSeparator = false;
  for (const character of input.trim().toLowerCase()) {
    const code = character.charCodeAt(0);
    const isSafe =
      (code >= 48 && code <= 57)
      || (code >= 97 && code <= 122);

    if (isSafe) {
      if (needsSeparator && slug.length > 0) {
        slug += "-";
      }
      slug += character;
      needsSeparator = false;
      if (slug.length >= 80) break;
      continue;
    }

    needsSeparator = slug.length > 0;
  }

  while (slug.endsWith("-")) {
    slug = slug.slice(0, -1);
  }
  return slug || "untitled";
}

export function getProjectWorkspaceRoot(
  project: string,
  root = getScienceSwarmWorkspaceRoot(),
): Promise<string> {
  const projectSlug = slugifyWorkspaceSegment(project);
  const projectRoot = path.join(root, projectSlug);
  return mkdir(projectRoot, { recursive: true }).then(() => projectRoot);
}

export async function saveProjectArtifact(params: {
  project: string;
  artifactType: string;
  title: string;
  content: string;
  fileName?: string;
  root?: string;
  returnPathBase?: "workspace" | "project";
  timestamp?: Date;
}): Promise<SavedArtifactFile> {
  const workspaceRoot = params.root ?? getScienceSwarmWorkspaceRoot();
  const projectSlug = slugifyWorkspaceSegment(params.project);
  const artifactTypeSlug = slugifyWorkspaceSegment(params.artifactType);
  const titleSlug = slugifyWorkspaceSegment(params.title);
  const timestamp = params.timestamp ?? new Date();
  const stamp = timestamp.toISOString().slice(0, 10);
  const projectRoot = await getProjectWorkspaceRoot(projectSlug, workspaceRoot);
  const artifactDir = path.join(projectRoot, "artifacts", artifactTypeSlug);
  await mkdir(artifactDir, { recursive: true });

  const requestedBaseName = params.fileName
    ? slugifyWorkspaceSegment(path.basename(params.fileName, path.extname(params.fileName)))
    : "";
  const requestedExtension = params.fileName ? path.extname(params.fileName).toLowerCase() : "";
  const safeExtension = requestedExtension.match(/^\.[a-z0-9]+$/) ? requestedExtension : ".md";
  const baseName = requestedBaseName
    ? `${stamp}-${requestedBaseName}`
    : `${stamp}-${titleSlug}`;

  let attempt = 0;
  let absolutePath = "";
  while (true) {
    const suffix = attempt === 0 ? "" : `-${attempt + 1}`;
    const filename = `${baseName}${suffix}${safeExtension}`;
    absolutePath = path.join(artifactDir, filename);

    try {
      await writeFile(absolutePath, params.content, { encoding: "utf-8", flag: "wx" });
      break;
    } catch (error) {
      if (isAlreadyExistsError(error)) {
        attempt += 1;
        continue;
      }
      throw error;
    }
  }

  const relativePath = path.relative(
    params.returnPathBase === "project" ? projectRoot : workspaceRoot,
    absolutePath,
  );

  return {
    absolutePath,
    relativePath,
    title: params.title,
  };
}

function isAlreadyExistsError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
