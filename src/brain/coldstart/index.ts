/**
 * Second Brain — Coldstart Onboarding (orchestrator)
 *
 * Solves the empty-brain problem: a scientist points at their research folders,
 * gets a preview of what was found, approves import, and immediately has a
 * useful brain.
 *
 * Three phases:
 * 1. scanCorpus — walk directories, classify files, detect clusters/projects
 * 2. approveAndImport — bulk import approved files through the engine
 * 3. generateFirstBriefing — "here's what I found" summary
 *
 * Decision 6A (eng review) splits this module into:
 *   - scanner.ts      — directory walking, hashing, keyword extraction
 *   - classifier.ts   — file/project/cluster classification (MECE buckets)
 *   - transformer.ts  — pure shape/text helpers (frontmatter, prompts, briefing)
 *   - writer.ts       — the only filesystem write surface (Phase B target)
 *   - index.ts        — this file: orchestrates the modules, public API
 *
 * Aggregates the split coldstart modules introduced during the gbrain pivot.
 */

import {
  existsSync,
  readFileSync,
  statSync,
} from "fs";
import { basename, extname, join, relative, resolve } from "path";
import matter from "gray-matter";
import type {
  BrainConfig,
  ColdstartScan,
  ColdstartResult,
  ColdstartBriefing,
  ImportPreview,
  ImportPreviewFile,
} from "../types";
import type { LLMClient } from "../llm";
import { logEvent } from "../cost";
import { ripple } from "../ripple";
import { extractPdfMetadata } from "../pdf-metadata";

import {
  MAX_FILE_SIZE,
  SCIENCE_EXTENSIONS,
  walkDirectory,
  hashFileHead,
  extractFileTitle,
  normalizeTitle,
  extractKeywords,
} from "./scanner";

import {
  classifyFile,
  detectClusters,
  detectCodeRepos,
  detectDuplicates,
  detectProjects,
  inferProjectCandidates,
  inferTypeFromPath,
} from "./classifier";

import {
  buildBriefingPrompt,
  buildHeuristicBriefing,
  extractAllTags,
  extractMarkdownTitle,
  generateScanQuestions,
  loadColdstartTemplate,
  parseBriefingResponse,
} from "./transformer";
import { withLlmTimeout } from "./timeout";

import {
  type ColdstartWriterOptions,
  createProjectPage,
  importSingleFile,
} from "./writer";
import { persistImportedWorkspaceFile } from "@/lib/import/commit-import";
import { writeProjectImportSummary } from "@/lib/state/project-import-summary";
import { getTargetFolder } from "@/lib/workspace-manager";

// ── Public re-exports (the coldstart.ts surface) ──────

export {
  classifyFile,
  classifyAcademicSource,
  hasArxivIdInName,
  hasDoiInName,
} from "./classifier";

// ── Progress Callback Types ─────────────────────────

export interface ColdstartProgressCallbacks {
  onProgress?: (progress: {
    phase: "importing" | "ripple" | "briefing";
    current: number;
    total: number;
    currentFile: string;
    message: string;
  }) => void;
  onFileDone?: (file: {
    path: string;
    type: string;
    wikiPath: string;
  }) => void;
  onError?: (error: { path: string; error: string }) => void;
}

export interface ColdstartImportOptions extends ColdstartWriterOptions {
  skipDuplicates?: boolean;
}

interface ProjectImportSummaryFile {
  path: string;
  classification: string;
}

const DEFAULT_COLDSTART_LLM_TIMEOUT_MS = 15_000;

function getProjectWorkspaceRelativePath(filePath: string): string {
  const filename = basename(filePath);
  return `${getTargetFolder(filename)}/${filename}`;
}

// ── Public API ────────────────────────────────────────

/**
 * Walk directories, classify files, detect projects and clusters.
 * Returns an ImportPreview extended with cluster and question data.
 */
export async function scanCorpus(dirPaths: string[]): Promise<ColdstartScan> {
  const allFiles: ImportPreviewFile[] = [];
  const contentHashes = new Map<string, string[]>(); // hash -> paths[]
  const titleMap = new Map<string, string[]>(); // normalized title -> paths[]
  const keywordIndex = new Map<string, Set<string>>(); // keyword -> paths

  for (const dirPath of dirPaths) {
    const absDir = resolve(dirPath);
    if (!existsSync(absDir)) continue;
    walkDirectory(absDir, (filePath) => {
      const ext = extname(filePath).toLowerCase();
      if (!SCIENCE_EXTENSIONS[ext]) return;

      const stat = statSync(filePath);
      if (stat.size > MAX_FILE_SIZE || stat.size === 0) return;

      const classification = classifyFile(filePath);
      const type = SCIENCE_EXTENSIONS[ext] ?? "note";
      const hash = hashFileHead(filePath);

      // Track content hashes for duplicate detection
      const existing = contentHashes.get(hash);
      if (existing) {
        existing.push(filePath);
      } else {
        contentHashes.set(hash, [filePath]);
      }

      // Extract title for near-duplicate detection
      const title = extractFileTitle(filePath, ext);
      if (title) {
        const normalized = normalizeTitle(title);
        const titlePaths = titleMap.get(normalized);
        if (titlePaths) {
          titlePaths.push(filePath);
        } else {
          titleMap.set(normalized, [filePath]);
        }
      }

      // Build keyword index for clustering
      const keywords = extractKeywords(filePath, ext);
      for (const kw of keywords) {
        const kwPaths = keywordIndex.get(kw);
        if (kwPaths) {
          kwPaths.add(filePath);
        } else {
          keywordIndex.set(kw, new Set([filePath]));
        }
      }

      const warnings: string[] = [];
      if (stat.size > 50 * 1024 * 1024) {
        warnings.push("Large file (>50MB), import may be slow");
      }

      allFiles.push({
        path: filePath,
        type: type as string,
        size: stat.size,
        hash,
        classification,
        projectCandidates: inferProjectCandidates(filePath, dirPaths),
        warnings,
      });
    });
  }

  // Extract PDF metadata in a second pass (async operation)
  for (const file of allFiles) {
    if (file.type === "paper" && file.path.toLowerCase().endsWith(".pdf")) {
      try {
        file.metadata = await extractPdfMetadata(file.path);
      } catch {
        // Metadata extraction is non-fatal; continue without it
      }
    }
  }

  // Detect duplicate groups
  const duplicateGroups = detectDuplicates(contentHashes, titleMap);

  // Detect clusters via keyword co-occurrence
  const clusters = detectClusters(keywordIndex, allFiles);

  // Detect projects from folder structure + clusters
  const projects = detectProjects(allFiles, clusters, dirPaths);

  // Build warnings
  const warnings: Array<{ path?: string; code: string; message: string }> = [];
  if (allFiles.length === 0) {
    warnings.push({
      code: "EMPTY_SCAN",
      message: "No supported files found in the provided directories",
    });
  }
  if (duplicateGroups.length > 0) {
    warnings.push({
      code: "DUPLICATES_FOUND",
      message: `Found ${duplicateGroups.length} groups of duplicate/near-duplicate files`,
    });
  }

  // Detect code repos in subdirectories and enhance projects with code metadata
  for (const dirPath of dirPaths) {
    const absDir = resolve(dirPath);
    if (!existsSync(absDir)) continue;
    detectCodeRepos(absDir, projects, allFiles, keywordIndex);
  }

  // Generate suggested questions
  const suggestedQuestions = generateScanQuestions(allFiles, clusters, projects);

  const paperCount = allFiles.filter((f) => f.type === "paper").length;
  const noteCount = allFiles.filter(
    (f) => f.type === "note",
  ).length;
  const dataCount = allFiles.filter(
    (f) => f.type === "data" || f.type === "experiment",
  ).length;

  return {
    analysis: `Scanned ${dirPaths.length} director${dirPaths.length === 1 ? "y" : "ies"}: found ${allFiles.length} files (${paperCount} papers, ${noteCount} notes, ${dataCount} data/experiments), ${projects.length} detected projects, ${clusters.length} topic clusters`,
    backend: "coldstart-scan",
    files: allFiles,
    projects,
    duplicateGroups,
    warnings,
    clusters,
    suggestedQuestions,
  };
}

/**
 * Bulk import approved files from a scan preview.
 * Runs a lightweight import for each file, then a single ripple pass at the end.
 */
export async function approveAndImport(
  config: BrainConfig,
  llm: LLMClient,
  preview: ImportPreview,
  options?: ColdstartImportOptions,
): Promise<ColdstartResult> {
  const startTime = Date.now();
  const imported: string[] = [];
  const skipped: string[] = [];
  const errors: Array<{ path: string; error: string }> = [];
  const projectsCreated: string[] = [];
  const createdPages: string[] = [];
  const importedProjectFiles: ProjectImportSummaryFile[] = [];

  // Collect paths to skip (duplicates)
  const skipPaths = new Set<string>();
  if (options?.skipDuplicates) {
    for (const group of preview.duplicateGroups) {
      // Keep the first path, skip the rest
      for (const p of group.paths.slice(1)) {
        skipPaths.add(p);
      }
    }
  }

  // Phase 1: Create project pages
  for (const project of preview.projects) {
    try {
      const projectPage = createProjectPage(config, project);
      if (projectPage) {
        createdPages.push(projectPage);
        projectsCreated.push(project.slug);
      }
    } catch (err) {
      errors.push({
        path: `project:${project.slug}`,
        error: err instanceof Error ? err.message : "Study creation failed",
      });
    }
  }

  // Phase 2: Import files (lightweight — no ripple per file)
  for (const file of preview.files) {
    if (skipPaths.has(file.path)) {
      skipped.push(file.path);
      continue;
    }

    try {
      if (options?.projectSlug) {
        await persistImportedWorkspaceFile({
          projectSlug: options.projectSlug,
          relativePath: getProjectWorkspaceRelativePath(file.path),
          sourcePath: file.path,
        });
      }
      const pagePath = await importSingleFile(config, llm, file, {
        ...options,
        projectSlug: options?.projectSlug ?? file.projectCandidates[0] ?? preview.projects[0]?.slug,
      });
      if (pagePath) {
        imported.push(file.path);
        createdPages.push(pagePath);
        if (options?.projectSlug) {
          importedProjectFiles.push({
            path: getProjectWorkspaceRelativePath(file.path),
            classification: file.type,
          });
        }
      } else {
        skipped.push(file.path);
      }
    } catch (err) {
      errors.push({
        path: file.path,
        error: err instanceof Error ? err.message : "Import failed",
      });
    }
  }

  await syncProjectImportState(options?.projectSlug, preview, importedProjectFiles);

  // Phase 3: Single ripple pass across all created pages
  if (createdPages.length > 0) {
    try {
      const allContent = createdPages
        .map((p) => {
          const absPath = join(config.root, p);
          if (!existsSync(absPath)) return null;
          return readFileSync(absPath, "utf-8");
        })
        .filter(Boolean)
        .join("\n");

      const allTags = extractAllTags(config, createdPages);
      if (allTags.length > 0) {
        await withColdstartLlmTimeout(
          ripple(config, llm, {
            newPagePath: createdPages[0],
            newPageContent: allContent.slice(0, 10000),
            tags: allTags.slice(0, 10),
          }),
          "ripple pass",
        );
      }
    } catch {
      // Ripple failure is non-fatal for coldstart
    }
  }

  // Phase 4: Generate first briefing
  const firstBriefing = await generateFirstBriefing(config, llm);

  // Log the coldstart event
  logEvent(config, {
    ts: new Date().toISOString(),
    type: "ingest",
    contentType: "project",
    created: createdPages,
    durationMs: Date.now() - startTime,
  });

  return {
    imported: imported.length,
    skipped: skipped.length,
    errors,
    projectsCreated,
    pagesCreated: createdPages.length,
    firstBriefing,
    durationMs: Date.now() - startTime,
  };
}

/**
 * Streaming version of approveAndImport with progress callbacks.
 * Wraps the same logic but emits progress/file-done/error events.
 */
export async function approveAndImportWithProgress(
  config: BrainConfig,
  llm: LLMClient,
  preview: ImportPreview,
  options: ColdstartImportOptions | undefined,
  callbacks: ColdstartProgressCallbacks,
): Promise<ColdstartResult> {
  const startTime = Date.now();
  const imported: string[] = [];
  const skipped: string[] = [];
  const errors: Array<{ path: string; error: string }> = [];
  const projectsCreated: string[] = [];
  const createdPages: string[] = [];
  const importedProjectFiles: ProjectImportSummaryFile[] = [];

  // Collect paths to skip (duplicates)
  const skipPaths = new Set<string>();
  if (options?.skipDuplicates) {
    for (const group of preview.duplicateGroups) {
      for (const p of group.paths.slice(1)) {
        skipPaths.add(p);
      }
    }
  }

  // Files that will actually be processed (excluding pre-skipped duplicates)
  // so progress reaches 100% rather than topping out at (total - skipped)/total.
  const totalFiles = preview.files.length - skipPaths.size;

  // Phase 1: Create project pages
  for (const project of preview.projects) {
    try {
      const projectPage = createProjectPage(config, project);
      if (projectPage) {
        createdPages.push(projectPage);
        projectsCreated.push(project.slug);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Study creation failed";
      errors.push({ path: `project:${project.slug}`, error: msg });
      callbacks.onError?.({ path: `project:${project.slug}`, error: msg });
    }
  }

  // Phase 2: Import files with progress
  let processed = 0;
  for (let i = 0; i < preview.files.length; i++) {
    const file = preview.files[i];

    if (skipPaths.has(file.path)) {
      skipped.push(file.path);
      continue;
    }

    processed++;
    callbacks.onProgress?.({
      phase: "importing",
      current: processed,
      total: totalFiles,
      currentFile: file.path,
      message: `Importing ${basename(file.path)} (${processed}/${totalFiles})`,
    });

    try {
      if (options?.projectSlug) {
        await persistImportedWorkspaceFile({
          projectSlug: options.projectSlug,
          relativePath: getProjectWorkspaceRelativePath(file.path),
          sourcePath: file.path,
        });
      }
      const pagePath = await importSingleFile(config, llm, file, {
        ...options,
        projectSlug: options?.projectSlug ?? file.projectCandidates[0] ?? preview.projects[0]?.slug,
      });
      if (pagePath) {
        imported.push(file.path);
        createdPages.push(pagePath);
        if (options?.projectSlug) {
          importedProjectFiles.push({
            path: getProjectWorkspaceRelativePath(file.path),
            classification: file.type,
          });
        }
        callbacks.onFileDone?.({
          path: file.path,
          type: file.type,
          wikiPath: pagePath,
        });
      } else {
        skipped.push(file.path);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Import failed";
      errors.push({ path: file.path, error: msg });
      callbacks.onError?.({ path: file.path, error: msg });
    }
  }

  await syncProjectImportState(options?.projectSlug, preview, importedProjectFiles);

  // Phase 3: Ripple
  if (createdPages.length > 0) {
    callbacks.onProgress?.({
      phase: "ripple",
      current: 0,
      total: 1,
      currentFile: "",
      message: "Running cross-reference ripple pass...",
    });

    try {
      const allContent = createdPages
        .map((p) => {
          const absPath = join(config.root, p);
          if (!existsSync(absPath)) return null;
          return readFileSync(absPath, "utf-8");
        })
        .filter(Boolean)
        .join("\n");

      const allTags = extractAllTags(config, createdPages);
      if (allTags.length > 0) {
        await withColdstartLlmTimeout(
          ripple(config, llm, {
            newPagePath: createdPages[0],
            newPageContent: allContent.slice(0, 10000),
            tags: allTags.slice(0, 10),
          }),
          "ripple pass",
        );
      }
    } catch {
      // Ripple failure is non-fatal for coldstart
    }
  }

  // Phase 4: Briefing
  callbacks.onProgress?.({
    phase: "briefing",
    current: 0,
    total: 1,
    currentFile: "",
    message: "Generating first briefing...",
  });

  const firstBriefing = await generateFirstBriefing(config, llm);

  logEvent(config, {
    ts: new Date().toISOString(),
    type: "ingest",
    contentType: "project",
    created: createdPages,
    durationMs: Date.now() - startTime,
  });

  return {
    imported: imported.length,
    skipped: skipped.length,
    errors,
    projectsCreated,
    pagesCreated: createdPages.length,
    firstBriefing,
    durationMs: Date.now() - startTime,
  };
}

async function syncProjectImportState(
  projectSlug: string | undefined,
  preview: ImportPreview,
  importedProjectFiles: ProjectImportSummaryFile[],
): Promise<void> {
  if (!projectSlug || importedProjectFiles.length === 0) {
    return;
  }

  const projectName =
    preview.projects.find((project) => project.slug === projectSlug)?.title
    ?? projectSlug;

  await writeProjectImportSummary(projectSlug, {
    name: projectName,
    preparedFiles: importedProjectFiles.length,
    detectedItems: preview.files.length,
    detectedBytes: preview.files.reduce((total, file) => total + file.size, 0),
    duplicateGroups: preview.duplicateGroups.length,
    generatedAt: new Date().toISOString(),
    source: "coldstart-project-import",
  });
}

/**
 * After import, generate the "here's what I found" briefing.
 * Analyzes the brain contents to identify threads, stalled work, and central papers.
 */
export async function generateFirstBriefing(
  config: BrainConfig,
  llm: LLMClient,
): Promise<ColdstartBriefing> {
  const wikiDir = join(config.root, "wiki");
  const stats = { papers: 0, notes: 0, experiments: 0, projects: 0, totalPages: 0 };
  const paperPages: Array<{ title: string; path: string; content: string }> = [];
  const allPages: Array<{ title: string; path: string; type: string; content: string; mtime: string }> = [];

  if (existsSync(wikiDir)) {
    walkDirectory(wikiDir, (filePath) => {
      if (!filePath.endsWith(".md")) return;
      const relPath = relative(config.root, filePath);
      const content = readFileSync(filePath, "utf-8");
      const parsed = matter(content);
      const title = (parsed.data.title as string) ?? extractMarkdownTitle(content) ?? basename(filePath, ".md");
      const type = (parsed.data.type as string) ?? inferTypeFromPath(relPath);
      const mtime = statSync(filePath).mtime.toISOString();

      stats.totalPages++;
      if (type === "paper") {
        stats.papers++;
        paperPages.push({ title, path: relPath, content: content.slice(0, 2000) });
      } else if (type === "note") stats.notes++;
      else if (type === "experiment") stats.experiments++;
      else if (type === "study" || type === "project") stats.projects++;

      allPages.push({ title, path: relPath, type, content: content.slice(0, 500), mtime });
    });
  }

  // Use LLM to generate the briefing if we have enough content
  if (allPages.length > 0 && stats.totalPages >= 3) {
    try {
      const briefingPrompt = buildBriefingPrompt(allPages, paperPages, stats);
      const response = await withColdstartLlmTimeout(
        llm.complete({
          system: loadColdstartTemplate(),
          user: briefingPrompt,
          model: config.synthesisModel,
        }),
        "first briefing",
      );
      const parsed = parseBriefingResponse(response.content, paperPages, stats);
      if (parsed) return parsed;
    } catch {
      // Fall through to heuristic briefing
    }
  }

  // Heuristic briefing (no LLM)
  return buildHeuristicBriefing(allPages, paperPages, stats);
}

async function withColdstartLlmTimeout<T>(
  promise: Promise<T>,
  stage: string,
): Promise<T> {
  return withLlmTimeout(promise, {
    defaultMs: DEFAULT_COLDSTART_LLM_TIMEOUT_MS,
    envVar: "SCIENCESWARM_COLDSTART_LLM_TIMEOUT_MS",
    stage: `Coldstart ${stage}`,
  });
}
