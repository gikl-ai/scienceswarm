/**
 * Coldstart Classifier
 *
 * Decides what each scanned file is and where it belongs in the MECE buckets:
 * paper / note / experiment / data, with sub-classifications for academic
 * sources, code repos, datasets, etc. Also handles cluster, project, and
 * duplicate detection — the "what does the corpus look like" decisions.
 *
 * Owned by the coldstart split introduced during the gbrain pivot.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { basename, extname, join, relative, resolve } from "path";
import type {
  ColdstartScan,
  Confidence,
  ContentType,
  ImportPreviewFile,
  ImportPreviewProject,
} from "../types";
import { parseCodeRepo } from "../code-parser";
import { STOP_WORDS } from "./scanner";

// ── Constants ─────────────────────────────────────────

export const TITLE_SIMILARITY_THRESHOLD = 0.7;

export const CODE_REPO_MARKERS = [
  ".git",
  "setup.py",
  "pyproject.toml",
  "package.json",
  "Cargo.toml",
  "go.mod",
];

// ── arXiv / DOI detection ─────────────────────────────

export function hasArxivIdInName(name: string): boolean {
  return /\d{4}\.\d{4,5}(v\d+)?/.test(name);
}

export function hasDoiInName(name: string): boolean {
  return /10\.\d{4,}/.test(name);
}

// ── File classification ───────────────────────────────

/**
 * Classify a file for coldstart based on path, extension, and content heuristics.
 */
export function classifyFile(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  const name = basename(filePath).toLowerCase();
  const dir = filePath.toLowerCase();

  // PDFs: check for arXiv IDs, academic patterns
  if (ext === ".pdf") {
    if (hasArxivIdInName(name)) return "arxiv-paper";
    if (hasDoiInName(name)) return "doi-paper";
    if (dir.includes("paper") || dir.includes("publication")) return "paper";
    if (dir.includes("protocol")) return "protocol";
    if (dir.includes("thesis") || dir.includes("dissertation")) return "thesis";
    return "paper";
  }

  // Notebooks
  if (ext === ".ipynb") {
    if (dir.includes("experiment")) return "experiment-notebook";
    return "notebook";
  }

  // Data files
  if ([".csv", ".tsv", ".parquet", ".json"].includes(ext)) {
    if (ext === ".json" && name.includes("package")) return "config";
    return "dataset";
  }

  // Code files
  if ([".py", ".r", ".jl"].includes(ext)) {
    if (dir.includes("analysis") || dir.includes("experiment")) return "analysis-script";
    if (dir.includes("util") || dir.includes("lib")) return "utility-script";
    return "code";
  }

  // TeX/BibTeX
  if (ext === ".tex") {
    if (name.includes("main") || name.includes("manuscript")) return "manuscript";
    return "tex-source";
  }
  if (ext === ".bib") return "bibliography";

  // Office docs
  if (ext === ".pptx") return "presentation";
  if (ext === ".docx") {
    if (dir.includes("protocol")) return "protocol";
    if (dir.includes("manuscript") || dir.includes("draft")) return "manuscript";
    return "document";
  }

  // Markdown/text: content-based classification
  if (ext === ".md" || ext === ".txt") {
    return classifyTextFile(filePath);
  }

  return "unknown";
}

/**
 * Enhanced source classification for academic content.
 * Used by engine.ts classifySource to detect science-specific patterns.
 */
export function classifyAcademicSource(source: string, content?: string): ContentType | null {
  const name = basename(source).toLowerCase();
  const ext = extname(source).toLowerCase();

  // Detect arXiv IDs in filenames (2301.12345.pdf, 2301.12345v2.pdf)
  if (hasArxivIdInName(name)) return "paper";

  // Detect DOI patterns in filenames
  if (hasDoiInName(name)) return "paper";

  // Detect BibTeX files
  if (ext === ".bib") return "paper";

  // Detect TeX files
  if (ext === ".tex") return "paper";

  // Content-based detection
  if (content) {
    // DOI pattern in content
    if (/10\.\d{4,9}\/[^\s]+/.test(content)) return "paper";

    // BibTeX entries
    if (/@(?:article|inproceedings|book|misc|phdthesis|techreport)\{/i.test(content))
      return "paper";

    // LaTeX fragments
    if (/\\begin\{(?:equation|align|theorem|proof|abstract)\}/.test(content))
      return "paper";
    if (/\\cite\{[^}]+\}/.test(content)) return "paper";

    // Protocol-style documents
    if (
      /(?:reagent|protocol|procedure|incubat|centrifug|pipett)/i.test(content) &&
      /(?:step\s*\d|materials|methods)/i.test(content)
    ) {
      return "experiment";
    }

    // Research notes vs general notes heuristics
    if (
      /(?:hypothesis|experiment|result|finding|observation|p\s*[<>=]\s*0\.\d)/i.test(content) &&
      /(?:figure|table|data|analysis|sample|trial)/i.test(content)
    ) {
      return "note"; // research note — will be classified as note with higher academic signal
    }
  }

  return null;
}

/**
 * Content-based classification for plain markdown / text files.
 */
export function classifyTextFile(filePath: string): string {
  try {
    const content = readFileSync(filePath, "utf-8").slice(0, 3000);
    const lower = content.toLowerCase();
    const dir = filePath.toLowerCase();

    // Protocol detection
    if (
      (dir.includes("protocol") || /(?:materials|reagents|procedure|step\s*\d)/i.test(content)) &&
      /(?:incubat|centrifug|pipett|buffer|solution|sample)/i.test(content)
    ) {
      return "protocol";
    }

    // LaTeX content in markdown
    if (/\\begin\{(?:equation|align|theorem)\}/.test(content) || /\\cite\{/.test(content)) {
      return "research-note";
    }

    // BibTeX detection
    if (/@(?:article|inproceedings|book)\{/i.test(content)) {
      return "bibliography";
    }

    // Experiment/lab notebook style
    if (/(?:experiment|trial|replicate|control|treatment)/i.test(lower) &&
        /(?:result|observation|measure|data)/i.test(lower)) {
      return "lab-note";
    }

    // Meeting notes
    if (dir.includes("meeting") || /(?:attendees|agenda|action items)/i.test(lower)) {
      return "meeting-note";
    }

    // General research note detection
    if (/(?:hypothesis|finding|conclusion|literature|review)/i.test(lower)) {
      return "research-note";
    }

    return "note";
  } catch {
    return "note";
  }
}

// ── Project / cluster / duplicate detection ───────────

/**
 * Infer plausible project slugs from a file's containing top-level subdirectory.
 */
export function inferProjectCandidates(filePath: string, dirPaths: string[]): string[] {
  const candidates: string[] = [];
  for (const dirPath of dirPaths) {
    const absDir = resolve(dirPath);
    if (filePath.startsWith(absDir)) {
      const rel = relative(absDir, filePath);
      const parts = rel.split("/");
      if (parts.length > 1) {
        candidates.push(parts[0]);
      }
    }
  }
  return candidates;
}

/**
 * Find duplicate/near-duplicate file groups via content hash and title.
 */
export function detectDuplicates(
  contentHashes: Map<string, string[]>,
  titleMap: Map<string, string[]>,
): Array<{ id: string; paths: string[]; reason: string }> {
  const groups: Array<{ id: string; paths: string[]; reason: string }> = [];
  let groupId = 0;

  // Exact content duplicates (by hash)
  for (const [hash, paths] of contentHashes) {
    if (paths.length > 1) {
      groups.push({
        id: `dup-hash-${groupId++}`,
        paths,
        reason: `Identical content (hash: ${hash.slice(0, 8)}...)`,
      });
    }
  }

  // Near-duplicate by title
  const processed = new Set<string>();
  for (const [title, paths] of titleMap) {
    if (paths.length > 1 && !processed.has(title)) {
      processed.add(title);
      // Check these aren't already grouped by hash
      const alreadyGrouped = groups.some(
        (g) => g.paths.some((p) => paths.includes(p)),
      );
      if (!alreadyGrouped) {
        groups.push({
          id: `dup-title-${groupId++}`,
          paths,
          reason: `Similar titles: "${title}"`,
        });
      }
    }
  }

  return groups;
}

/**
 * Detect topic clusters via keyword co-occurrence across files.
 */
export function detectClusters(
  keywordIndex: Map<string, Set<string>>,
  files: ImportPreviewFile[],
): ColdstartScan["clusters"] {
  // Find keywords that appear in multiple files (shared concepts)
  const significantKeywords = [...keywordIndex.entries()]
    .filter(([, paths]) => paths.size >= 2 && paths.size <= files.length * 0.8)
    .sort((a, b) => b[1].size - a[1].size);

  const clusters: ColdstartScan["clusters"] = [];
  const assignedFiles = new Set<string>();

  for (const [keyword, paths] of significantKeywords.slice(0, 20)) {
    // Find co-occurring keywords
    const coKeywords: string[] = [keyword];
    for (const [otherKw, otherPaths] of significantKeywords) {
      if (otherKw === keyword) continue;
      const overlap = [...otherPaths].filter((p) => paths.has(p)).length;
      if (overlap >= Math.min(paths.size, otherPaths.size) * TITLE_SIMILARITY_THRESHOLD) {
        coKeywords.push(otherKw);
      }
    }

    const clusterPaths = [...paths].filter((p) => !assignedFiles.has(p));
    if (clusterPaths.length < 2) continue;

    for (const p of clusterPaths) {
      assignedFiles.add(p);
    }

    const confidence: Confidence =
      clusterPaths.length >= 5 ? "high" : clusterPaths.length >= 3 ? "medium" : "low";

    clusters.push({
      name: coKeywords.slice(0, 3).join(" + "),
      keywords: [...new Set(coKeywords)].slice(0, 8),
      filePaths: clusterPaths,
      confidence,
    });

    if (clusters.length >= 10) break;
  }

  return clusters;
}

/**
 * Detect projects from top-level directories and topic clusters.
 */
export function detectProjects(
  files: ImportPreviewFile[],
  clusters: ColdstartScan["clusters"],
  dirPaths: string[],
): ImportPreviewProject[] {
  const projects: ImportPreviewProject[] = [];
  const projectSlugs = new Set<string>();

  // Strategy 1: Top-level subdirectories as projects
  for (const dirPath of dirPaths) {
    const absDir = resolve(dirPath);
    try {
      const entries = readdirSync(absDir);
      for (const entry of entries) {
        if (entry.startsWith(".")) continue;
        const fullPath = join(absDir, entry);
        if (!statSync(fullPath).isDirectory()) continue;

        const slug = entry.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
        if (projectSlugs.has(slug)) continue;

        const projectFiles = files.filter((f) => f.path.startsWith(fullPath + "/"));
        if (projectFiles.length === 0) continue;

        projectSlugs.add(slug);
        projects.push({
          slug,
          title: entry.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
          confidence: projectFiles.length >= 5 ? "high" : projectFiles.length >= 2 ? "medium" : "low",
          reason: `Directory with ${projectFiles.length} files`,
          sourcePaths: projectFiles.map((f) => f.path),
        });
      }
    } catch {
      continue;
    }
  }

  // Strategy 2: Clusters as projects (if not already covered by directories)
  for (const cluster of clusters) {
    const slug = cluster.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40);
    if (projectSlugs.has(slug)) continue;

    // Check if cluster files are already covered by a directory project
    const covered = projects.some(
      (p) =>
        cluster.filePaths.filter((f) => p.sourcePaths.includes(f)).length >
        cluster.filePaths.length * 0.5,
    );
    if (covered) continue;

    projectSlugs.add(slug);
    projects.push({
      slug,
      title: cluster.name.replace(/\b\w/g, (c) => c.toUpperCase()),
      confidence: cluster.confidence,
      reason: `Topic cluster: ${cluster.keywords.slice(0, 3).join(", ")}`,
      sourcePaths: cluster.filePaths,
    });
  }

  return projects;
}

/**
 * Detect subdirectories that look like code repositories and enrich
 * project data with code metadata (README content, docstrings, keywords).
 */
export function detectCodeRepos(
  rootDir: string,
  projects: ImportPreviewProject[],
  files: ImportPreviewFile[],
  keywordIndex: Map<string, Set<string>>,
): void {
  let entries: string[];
  try {
    entries = readdirSync(rootDir);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.startsWith(".") || entry === "node_modules" || entry === "__pycache__") continue;
    const fullPath = join(rootDir, entry);
    try {
      if (!statSync(fullPath).isDirectory()) continue;
    } catch {
      continue;
    }

    // Check if this directory looks like a code repo
    const isRepo = CODE_REPO_MARKERS.some((marker) =>
      existsSync(join(fullPath, marker)),
    );
    if (!isRepo) continue;

    try {
      const repoMeta = parseCodeRepo(fullPath);

      // Add README keywords to keyword index for clustering
      if (repoMeta.readme) {
        const readmeWords = repoMeta.readme
          .toLowerCase()
          .replace(/[^a-z\s]/g, " ")
          .split(/\s+/)
          .filter((w) => w.length > 4 && !STOP_WORDS.has(w));
        for (const word of readmeWords.slice(0, 20)) {
          const paths = keywordIndex.get(word);
          if (paths) {
            // Add all repo file paths to this keyword
            for (const f of files) {
              if (f.path.startsWith(fullPath + "/")) paths.add(f.path);
            }
          } else {
            const repoPaths = new Set(
              files.filter((f) => f.path.startsWith(fullPath + "/")).map((f) => f.path),
            );
            if (repoPaths.size > 0) keywordIndex.set(word, repoPaths);
          }
        }
      }

      // Add docstring keywords to keyword index for code-to-project linking
      for (const ds of repoMeta.docstrings) {
        const dsWords = ds.docstring
          .toLowerCase()
          .replace(/[^a-z\s]/g, " ")
          .split(/\s+/)
          .filter((w) => w.length > 4 && !STOP_WORDS.has(w));
        for (const word of dsWords.slice(0, 5)) {
          const paths = keywordIndex.get(word);
          if (paths) {
            for (const f of files) {
              if (f.path.startsWith(fullPath + "/")) paths.add(f.path);
            }
          } else {
            const repoPaths = new Set(
              files.filter((f) => f.path.startsWith(fullPath + "/")).map((f) => f.path),
            );
            if (repoPaths.size > 0) keywordIndex.set(word, repoPaths);
          }
        }
      }

      // Enrich matching project with code metadata
      const slug = entry.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      const matchingProject = projects.find((p) => p.slug === slug);
      if (matchingProject) {
        const langNote = `Code repo (${repoMeta.language})`;
        if (!matchingProject.reason.includes("Code repo")) {
          matchingProject.reason += ` | ${langNote}`;
        }
        if (repoMeta.dependencies.length > 0) {
          matchingProject.reason += ` | deps: ${repoMeta.dependencies.slice(0, 5).join(", ")}`;
        }
      }
    } catch {
      // Non-fatal — skip repos that can't be parsed
    }
  }
}

// ── Type mapping helpers ──────────────────────────────

/**
 * Map a coldstart classification string to a coarse ContentType bucket.
 */
export function mapClassificationToContentType(type: string): ContentType {
  if (type === "paper" || type === "experiment" || type === "data") {
    return type as ContentType;
  }
  return "note";
}

/**
 * Pick the raw/ subdirectory name where the original file should be archived.
 */
export function getRawSubdir(type: ContentType): string {
  const map: Record<string, string> = {
    paper: "papers",
    note: "notes",
    experiment: "experiments",
    data: "data",
    observation: "observations",
  };
  return map[type] ?? "imports";
}

/**
 * Infer a wiki page type from its relative path under `wiki/`.
 */
export function inferTypeFromPath(path: string): string {
  if (path.includes("entities/papers")) return "paper";
  if (path.includes("experiments")) return "experiment";
  if (path.includes("hypotheses")) return "hypothesis";
  if (path.includes("projects")) return "project";
  if (path.includes("entities/observations")) return "observation";
  return "note";
}
