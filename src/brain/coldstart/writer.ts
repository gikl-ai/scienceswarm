/**
 * Coldstart Writer — the thin write surface.
 *
 * This is the only file in the coldstart pipeline that touches the filesystem
 * to create wiki pages. It reads scanner+classifier+transformer output and
 * persists pages under `wiki/`. In Phase B of the gbrain pivot, this is the
 * single file rewritten to call `gbrain.putPage` instead of writing markdown
 * directly. Keep it small and focused.
 *
 * Owned by the coldstart split introduced during the gbrain pivot.
 */

import { createHash } from "node:crypto";
import {
  createReadStream,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { basename, extname, join } from "path";
import { Readable } from "stream";
import matter from "gray-matter";
import type { GbrainClient } from "@/brain/gbrain-client";
import type {
  GbrainPageFileRef,
  IngestInputFile,
  IngestSuccess,
} from "@/brain/gbrain-data-contracts";
import { createInProcessGbrainClient } from "@/brain/in-process-gbrain-client";
import { createIngestService, type IngestService } from "@/brain/ingest/service";
import { getCurrentUserHandle } from "@/lib/setup/gbrain-installer";
import { getTargetFolder } from "@/lib/workspace-manager";
import type {
  BrainConfig,
  ContentType,
  ImportPreviewFile,
  ImportPreviewProject,
} from "../types";
import type { LLMClient } from "../llm";
import { parseNotebook, notebookToExperimentPage } from "../notebook-parser";
import {
  getRawSubdir,
  mapClassificationToContentType,
} from "./classifier";
import {
  ensureFrontmatter,
  extractMarkdownTitle,
  formatSize,
} from "./transformer";
import { withLlmTimeout } from "./timeout";

export interface ColdstartWriterOptions {
  enableGbrain?: boolean;
  gbrain?: GbrainClient;
  ingestService?: IngestService;
  uploadedBy?: string;
  projectSlug?: string;
}

interface ColdstartWriterDeps {
  gbrain: GbrainClient;
  ingestService: IngestService;
  uploadedBy: string;
  projectSlug?: string;
}

const DEFAULT_TEXT_EXTRACTION_TIMEOUT_MS = 15_000;

function getProjectScopedSourceFilename(
  filePath: string,
  projectSlug?: string,
): string {
  if (!projectSlug) {
    return filePath;
  }
  const baseName = basename(filePath);
  return `${getTargetFolder(baseName)}/${baseName}`;
}

// ── Study page ────────────────────────────────────────

/**
 * Create a study landing page. Returns the page path or null if the page
 * already exists (idempotent).
 */
export function createProjectPage(
  config: BrainConfig,
  project: ImportPreviewProject,
): string | null {
  const projectDir = join(config.root, "wiki/projects");
  mkdirSync(projectDir, { recursive: true });

  const pagePath = `wiki/projects/${project.slug}.md`;
  const absPath = join(config.root, pagePath);

  if (existsSync(absPath)) return null; // Don't overwrite

  const date = new Date().toISOString().slice(0, 10);
  const content = [
    "---",
    `title: "${project.title}"`,
    `date: ${date}`,
    "type: study",
    "para: projects",
    `study: ${project.slug}`,
    `study_slug: ${project.slug}`,
    `legacy_project_slug: ${project.slug}`,
    `confidence: ${project.confidence}`,
    `tags: [coldstart]`,
    "---",
    "",
    `# ${project.title}`,
    "",
    `## Origin`,
    `Detected during coldstart import. ${project.reason}.`,
    "",
    `## Source Files`,
    ...project.sourcePaths.slice(0, 20).map((p) => `- ${basename(p)}`),
    project.sourcePaths.length > 20
      ? `- ... and ${project.sourcePaths.length - 20} more`
      : "",
    "",
    "## Status",
    "Active — newly imported, needs review.",
    "",
    "## Next Steps",
    "- [ ] Review imported files for accuracy",
    "- [ ] Add study description",
    "- [ ] Link related experiments and hypotheses",
  ].filter(Boolean).join("\n");

  writeFileSync(absPath, content + "\n");
  return pagePath;
}

// ── Single-file import dispatcher ─────────────────────

/**
 * Import a single scanned file into the brain. Routes to the appropriate
 * page-builder based on file extension.
 */
export async function importSingleFile(
  config: BrainConfig,
  llm: LLMClient,
  file: ImportPreviewFile,
  options: ColdstartWriterOptions = {},
): Promise<string | null> {
  if (!existsSync(file.path)) return null;

  const ext = extname(file.path).toLowerCase();
  const contentType = mapClassificationToContentType(file.type);
  const isTextFile = [".md", ".txt", ".tex", ".py", ".r", ".jl"].includes(ext);
  const isPdfFile = ext === ".pdf";
  const isNotebookFile = ext === ".ipynb";
  const isDataFile = [".csv", ".tsv", ".parquet", ".json"].includes(ext);
  const gbrainDeps = resolveColdstartDeps(options);
  const shouldAttach = isTextFile || isPdfFile || isNotebookFile || isDataFile;
  const attached = gbrainDeps && shouldAttach
    ? await attachColdstartSourceFile(gbrainDeps, file)
    : null;
  const sourceFileRef = attached?.pageFileRef;

  // Save raw file
  const rawDir = join(config.root, `raw/${getRawSubdir(contentType)}`);
  mkdirSync(rawDir, { recursive: true });
  const rawDest = join(rawDir, basename(file.path));
  if (!existsSync(rawDest)) {
    try {
      copyFileSync(file.path, rawDest);
    } catch {
      // Non-fatal — continue with wiki page creation
    }
  }

  // For text files, create a wiki page via LLM extraction
  let pagePath: string | null = null;
  if (isTextFile) {
    pagePath = await createWikiPageFromText(config, llm, file, contentType);
    return putGbrainMirrorIfNeeded(config, pagePath, sourceFileRef, gbrainDeps);
  }

  // For PDFs, try Docling full-text conversion, fall back to metadata stub
  // when Docling is unavailable or conversion fails.
  if (isPdfFile) {
    try {
      const { convertSinglePdf } = await import("../pdf-to-markdown");
      const result = await convertSinglePdf(file.path, config.root);
      if (result) {
        return putGbrainMirrorIfNeeded(config, result, sourceFileRef, gbrainDeps);
      }
    } catch {
      // Docling not available or failed — fall back to stub
    }
    pagePath = createPaperPageFromPdf(config, file);
    return putGbrainMirrorIfNeeded(config, pagePath, sourceFileRef, gbrainDeps);
  }

  // For notebooks, create an experiment page
  if (isNotebookFile) {
    pagePath = createExperimentPage(config, file);
    return putGbrainMirrorIfNeeded(config, pagePath, sourceFileRef, gbrainDeps);
  }

  // For data files, create a data page
  if (isDataFile) {
    pagePath = createDataPage(config, file);
    return putGbrainMirrorIfNeeded(config, pagePath, sourceFileRef, gbrainDeps);
  }

  return null;
}

function resolveColdstartDeps(
  options: ColdstartWriterOptions,
): ColdstartWriterDeps | null {
  if (!options.enableGbrain && !options.gbrain && !options.ingestService) {
    return null;
  }
  const gbrain = options.gbrain ?? createInProcessGbrainClient();
  return {
    gbrain,
    ingestService: options.ingestService ?? createIngestService({ gbrain }),
    uploadedBy: options.uploadedBy ?? getCurrentUserHandle(),
    projectSlug: options.projectSlug,
  };
}

async function attachColdstartSourceFile(
  deps: ColdstartWriterDeps,
  file: ImportPreviewFile,
): Promise<IngestSuccess> {
  const ingestInput: IngestInputFile = {
    project: deps.projectSlug ?? file.projectCandidates[0] ?? "coldstart",
    filename: getProjectScopedSourceFilename(file.path, deps.projectSlug),
    mime: mimeFromPath(file.path),
    sizeBytes: file.size,
    stream: Readable.toWeb(createReadStream(file.path)) as ReadableStream<Uint8Array>,
    uploadedBy: deps.uploadedBy,
    source: { kind: "coldstart", sourcePath: file.path },
  };
  const pageSlug = `coldstart/source/${hashPath(file.path)}`;
  const result = await deps.ingestService.attachSourceFile({
    ...ingestInput,
    pageSlug,
  });
  if ("code" in result) {
    throw new Error(`Failed to attach coldstart source ${file.path}: ${result.message}`);
  }
  return result;
}

async function putGbrainMirrorIfNeeded(
  config: BrainConfig,
  pagePath: string | null,
  sourceFileRef: GbrainPageFileRef | undefined,
  deps: ColdstartWriterDeps | null,
): Promise<string | null> {
  if (!pagePath || !deps) return pagePath;
  const absPath = join(config.root, pagePath);
  if (!existsSync(absPath)) return pagePath;
  const content = withSourceFileRef(
    readFileSync(absPath, "utf-8"),
    sourceFileRef,
    deps.projectSlug,
  );
  writeFileSync(absPath, content.endsWith("\n") ? content : `${content}\n`);
  await deps.gbrain.putPage(slugFromPagePath(pagePath), content);
  return pagePath;
}

function withSourceFileRef(
  content: string,
  sourceFileRef: GbrainPageFileRef | undefined,
  projectSlug?: string,
): string {
  const parsed = matter(content);
  const existingProjects = [
    ...(Array.isArray(parsed.data.studies) ? parsed.data.studies : []),
    ...(Array.isArray(parsed.data.projects) ? parsed.data.projects : []),
  ].filter(
        (value): value is string =>
          typeof value === "string" && value.trim().length > 0,
      );
  const data: Record<string, unknown> = {
    ...parsed.data,
  };

  if (projectSlug) {
    data.study = projectSlug;
    data.study_slug = projectSlug;
    data.legacy_project_slug = projectSlug;
    data.studies = Array.from(new Set([...existingProjects, projectSlug]));
  }

  if (sourceFileRef) {
    data.file_object_id = sourceFileRef.fileObjectId;
    data.source_file_object_id = sourceFileRef.fileObjectId;
    data.file_refs = [sourceFileRef];
  }

  return matter.stringify(parsed.content, data);
}

function slugFromPagePath(pagePath: string): string {
  return pagePath
    .replace(/\\/g, "/")
    .replace(/^wiki\//, "")
    .replace(/\.md$/i, "");
}

function mimeFromPath(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".md") return "text/markdown";
  if (ext === ".txt" || ext === ".tex") return "text/plain";
  if (ext === ".csv") return "text/csv";
  if (ext === ".tsv") return "text/tab-separated-values";
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".json") return "application/json";
  if (ext === ".ipynb") return "application/x-ipynb+json";
  if ([".py", ".r", ".jl", ".ts", ".tsx", ".js", ".jsx"].includes(ext)) {
    return "text/plain";
  }
  return "application/octet-stream";
}

function hashPath(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

// ── Per-type page builders ────────────────────────────

export async function createWikiPageFromText(
  config: BrainConfig,
  llm: LLMClient,
  file: ImportPreviewFile,
  contentType: ContentType,
): Promise<string | null> {
  const content = readFileSync(file.path, "utf-8");
  const date = new Date().toISOString().slice(0, 10);
  const slug = basename(file.path, extname(file.path))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 60);

  const dirMap: Record<string, string> = {
    paper: "wiki/entities/papers",
    note: "wiki/resources",
    experiment: "wiki/experiments",
    data: "wiki/resources",
  };
  const dir = dirMap[contentType] ?? "wiki/resources";
  mkdirSync(join(config.root, dir), { recursive: true });

  const pagePath = `${dir}/${date}-${slug}.md`;
  const absPath = join(config.root, pagePath);
  if (existsSync(absPath)) return null;

  try {
    const response = await completeTextExtractionWithTimeout(llm, {
      system: `You are a research knowledge extraction agent. Given source text, produce a wiki page with YAML frontmatter (date, type, para, tags, title) and markdown body. Be concise and factual. Extract key claims with source references.`,
      user: content.slice(0, 8000),
      model: config.extractionModel,
    });

    const pageContent = ensureFrontmatter(response.content, {
      date,
      type: contentType,
      para: contentType === "experiment" ? "projects" : "resources",
      tags: ["coldstart"],
      title: extractMarkdownTitle(content) ?? slug,
    });

    writeFileSync(absPath, pageContent);
    return pagePath;
  } catch {
    // Fallback: create a simple page without LLM
    const title = extractMarkdownTitle(content) ?? slug.replace(/-/g, " ");
    const para = contentType === "experiment" ? "projects" : "resources";
    const simpleContent = [
      "---",
      `title: "${title}"`,
      `date: ${date}`,
      `type: ${contentType}`,
      `para: ${para}`,
      "tags: [coldstart]",
      "---",
      "",
      `# ${title}`,
      "",
      content.slice(0, 5000),
    ].join("\n");
    writeFileSync(absPath, simpleContent + "\n");
    return pagePath;
  }
}

async function completeTextExtractionWithTimeout(
  llm: LLMClient,
  call: Parameters<LLMClient["complete"]>[0],
): Promise<Awaited<ReturnType<LLMClient["complete"]>>> {
  return withLlmTimeout(llm.complete(call), {
    defaultMs: DEFAULT_TEXT_EXTRACTION_TIMEOUT_MS,
    envVar: "SCIENCESWARM_COLDSTART_TEXT_LLM_TIMEOUT_MS",
    stage: "Coldstart text extraction",
  });
}

export function createPaperPageFromPdf(
  config: BrainConfig,
  file: ImportPreviewFile,
): string | null {
  const date = new Date().toISOString().slice(0, 10);
  const name = basename(file.path, ".pdf");
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60);

  const dir = "wiki/entities/papers";
  mkdirSync(join(config.root, dir), { recursive: true });

  const pagePath = `${dir}/${slug}.md`;
  const absPath = join(config.root, pagePath);
  if (existsSync(absPath)) return null;

  const title = name.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const arxivMatch = name.match(/(\d{4}\.\d{4,5})(v\d+)?/);
  const arxivId = arxivMatch ? arxivMatch[1] : undefined;

  const frontmatter: string[] = [
    "---",
    `title: "${title}"`,
    `date: ${date}`,
    "type: paper",
    "para: resources",
    "authors: []",
    `year: ${new Date().getFullYear()}`,
    'venue: ""',
  ];
  if (arxivId) frontmatter.push(`arxiv: "${arxivId}"`);
  frontmatter.push("tags: [coldstart, needs-review]", "---");

  const content = [
    ...frontmatter,
    "",
    `# ${title}`,
    "",
    "## Summary",
    `Imported from: ${basename(file.path)}`,
    "",
    "## Key Contributions",
    "- *Pending extraction — run full ingest for detailed analysis*",
    "",
    "## Relevance to Our Work",
    "*To be determined after full analysis.*",
  ].join("\n");

  writeFileSync(absPath, content + "\n");
  return pagePath;
}

export function createExperimentPage(
  config: BrainConfig,
  file: ImportPreviewFile,
): string | null {
  const date = new Date().toISOString().slice(0, 10);
  const name = basename(file.path, extname(file.path));
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60);

  const dir = "wiki/experiments";
  mkdirSync(join(config.root, dir), { recursive: true });

  const pagePath = `${dir}/${date}-${slug}.md`;
  const absPath = join(config.root, pagePath);
  if (existsSync(absPath)) return null;

  // Try to use the notebook parser for .ipynb files
  if (extname(file.path).toLowerCase() === ".ipynb" && existsSync(file.path)) {
    try {
      const metadata = parseNotebook(file.path);
      const content = notebookToExperimentPage(metadata, file.path);
      writeFileSync(absPath, content);
      return pagePath;
    } catch {
      // Fall through to basic page creation
    }
  }

  const title = name.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const content = [
    "---",
    `title: "${title}"`,
    `date: ${date}`,
    "type: experiment",
    "para: projects",
    "status: completed",
    "hypotheses: []",
    "tags: [coldstart, notebook]",
    "---",
    "",
    `# ${title}`,
    "",
    "## Overview",
    `Notebook imported from: ${basename(file.path)}`,
    "",
    "## Observation Log",
    "*Run full ingest for detailed extraction.*",
  ].join("\n");

  writeFileSync(absPath, content + "\n");
  return pagePath;
}

export function createDataPage(
  config: BrainConfig,
  file: ImportPreviewFile,
): string | null {
  const date = new Date().toISOString().slice(0, 10);
  const name = basename(file.path, extname(file.path));
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60);

  const dir = "wiki/resources";
  mkdirSync(join(config.root, dir), { recursive: true });

  const pagePath = `${dir}/${date}-${slug}.md`;
  const absPath = join(config.root, pagePath);
  if (existsSync(absPath)) return null;

  const title = name.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const ext = extname(file.path).slice(1);
  const content = [
    "---",
    `title: "${title}"`,
    `date: ${date}`,
    "type: data",
    "para: resources",
    `format: ${ext}`,
    "tags: [coldstart, dataset]",
    "---",
    "",
    `# ${title}`,
    "",
    "## Description",
    `Data file imported from: ${basename(file.path)}`,
    `Format: ${ext} | Size: ${formatSize(file.size)}`,
  ].join("\n");

  writeFileSync(absPath, content + "\n");
  return pagePath;
}
