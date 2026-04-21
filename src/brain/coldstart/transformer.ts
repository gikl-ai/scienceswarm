/**
 * Coldstart Transformer
 *
 * Pure shape/text transformations that turn scanner+classifier output into
 * structured payloads (frontmatter, briefing JSON, suggested questions). No
 * filesystem writes. No LLM calls — only prompt and response shaping.
 *
 * Owned by the coldstart split introduced during the gbrain pivot.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import matter from "gray-matter";
import type {
  BrainConfig,
  ColdstartBriefing,
  ColdstartScan,
  ImportPreviewFile,
  ImportPreviewProject,
} from "../types";
import { resolveBrainFile } from "../template-paths";

// ── Frontmatter / markdown helpers ────────────────────

/**
 * Ensure a markdown blob has at minimum the supplied frontmatter defaults.
 * Existing values in the source content win.
 */
export function ensureFrontmatter(
  content: string,
  defaults: Record<string, unknown>,
): string {
  try {
    const parsed = matter(content);
    for (const [key, val] of Object.entries(defaults)) {
      if (parsed.data[key] === undefined) {
        parsed.data[key] = val;
      }
    }
    return matter.stringify(parsed.content, parsed.data);
  } catch {
    // If parsing fails, prepend frontmatter
    const fm = Object.entries(defaults)
      .map(([k, v]) =>
        Array.isArray(v)
          ? `${k}: [${v.join(", ")}]`
          : `${k}: ${typeof v === "string" ? `"${v}"` : v}`,
      )
      .join("\n");
    return `---\n${fm}\n---\n\n${content}`;
  }
}

/**
 * Pull the first markdown H1 from a blob of text.
 */
export function extractMarkdownTitle(content: string): string | null {
  const match = content.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : null;
}

/**
 * Pretty-print a byte size.
 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ── Tag aggregation ───────────────────────────────────

/**
 * Walk a list of wiki page paths and collect their non-coldstart tags.
 */
export function extractAllTags(config: BrainConfig, pagePaths: string[]): string[] {
  const tags = new Set<string>();
  for (const p of pagePaths) {
    const absPath = join(config.root, p);
    if (!existsSync(absPath)) continue;
    try {
      const content = readFileSync(absPath, "utf-8");
      const parsed = matter(content);
      const pageTags = parsed.data.tags;
      if (Array.isArray(pageTags)) {
        for (const t of pageTags) {
          if (typeof t === "string" && t !== "coldstart") tags.add(t);
        }
      }
    } catch {
      continue;
    }
  }
  return [...tags];
}

// ── Suggested questions ───────────────────────────────

/**
 * Generate a small set of starter questions based on the scan result.
 */
export function generateScanQuestions(
  files: ImportPreviewFile[],
  clusters: ColdstartScan["clusters"],
  projects: ImportPreviewProject[],
): string[] {
  const questions: string[] = [];

  const paperCount = files.filter((f) => f.type === "paper").length;
  if (paperCount > 0) {
    questions.push(`What are the main themes across my ${paperCount} papers?`);
    questions.push("Which papers cite each other or share methodology?");
  }

  if (clusters.length > 1) {
    questions.push(
      `How do my ${clusters.length} research areas connect to each other?`,
    );
  }

  if (projects.length > 0) {
    questions.push(
      `Which of my ${projects.length} projects is most active right now?`,
    );
    questions.push("Are there any stalled projects I should revisit?");
  }

  const notebookCount = files.filter(
    (f) => f.type === "experiment",
  ).length;
  if (notebookCount > 0) {
    questions.push("What experiments have I run and what were the results?");
  }

  questions.push("What are the gaps in my research that I should address?");

  return questions.slice(0, 6);
}

// ── Briefing prompt + parse ───────────────────────────

export const FALLBACK_BRIEFING_SYSTEM = `You are a research assistant analyzing a scientist's imported corpus. Generate a structured briefing in JSON format with these fields:

{
  "activeThreads": [{"name": "...", "evidence": ["page paths..."], "confidence": "high|medium|low"}],
  "stalledThreads": [{"name": "...", "lastActivity": "YYYY-MM-DD", "evidence": ["..."]}],
  "centralPapers": [{"title": "...", "path": "...", "whyItMatters": "..."}],
  "suggestedQuestions": ["..."]
}

Rules:
- Active threads: research areas with recent or multi-file evidence
- Stalled threads: areas with old dates or incomplete work markers
- Central papers: papers referenced by multiple other files
- Questions: useful first questions the researcher could ask their brain`;

/**
 * Load the coldstart briefing system template from disk, falling back to
 * the inline default when the template file is missing.
 */
export function loadColdstartTemplate(): string {
  const templatePath = resolveBrainFile("templates", "init", "research-coldstart.md");
  if (existsSync(templatePath)) {
    return readFileSync(templatePath, "utf-8");
  }
  return FALLBACK_BRIEFING_SYSTEM;
}

/**
 * Build the user prompt for the briefing LLM call.
 */
export function buildBriefingPrompt(
  allPages: Array<{ title: string; path: string; type: string; content: string; mtime: string }>,
  paperPages: Array<{ title: string; path: string; content: string }>,
  stats: { papers: number; notes: number; experiments: number; projects: number; totalPages: number },
): string {
  const pageList = allPages
    .slice(0, 50)
    .map((p) => `- [${p.type}] ${p.title} (${p.path}, modified: ${p.mtime.slice(0, 10)})`)
    .join("\n");

  const paperSnippets = paperPages
    .slice(0, 10)
    .map((p) => `### ${p.title}\n${p.content.slice(0, 300)}`)
    .join("\n\n");

  return `Brain stats: ${stats.totalPages} pages (${stats.papers} papers, ${stats.notes} notes, ${stats.experiments} experiments, ${stats.projects} projects)

Pages:
${pageList}

Paper details:
${paperSnippets}

Generate the coldstart briefing JSON.`;
}

/**
 * Parse the LLM briefing response into a `ColdstartBriefing`. Returns null
 * if the response cannot be parsed; callers fall back to the heuristic builder.
 */
export function parseBriefingResponse(
  response: string,
  paperPages: Array<{ title: string; path: string }>,
  stats: ColdstartBriefing["stats"],
): ColdstartBriefing | null {
  try {
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const data = JSON.parse(jsonMatch[0]);
    return {
      generatedAt: new Date().toISOString(),
      activeThreads: Array.isArray(data.activeThreads) ? data.activeThreads : [],
      stalledThreads: Array.isArray(data.stalledThreads) ? data.stalledThreads : [],
      centralPapers: Array.isArray(data.centralPapers) ? data.centralPapers : [],
      suggestedQuestions: Array.isArray(data.suggestedQuestions) ? data.suggestedQuestions : [],
      stats,
    };
  } catch {
    return null;
  }
}

/**
 * Build a heuristic briefing without invoking an LLM.
 */
export function buildHeuristicBriefing(
  allPages: Array<{ title: string; path: string; type: string; content: string; mtime: string }>,
  paperPages: Array<{ title: string; path: string }>,
  stats: ColdstartBriefing["stats"],
): ColdstartBriefing {
  // Sort by mtime descending
  const sorted = [...allPages].sort(
    (a, b) => new Date(b.mtime).getTime() - new Date(a.mtime).getTime(),
  );

  // Active threads: recent pages grouped by type
  const activeThreads: ColdstartBriefing["activeThreads"] = [];
  const recentProjects = sorted.filter((p) => p.type === "project").slice(0, 3);
  for (const proj of recentProjects) {
    activeThreads.push({
      name: proj.title,
      evidence: [proj.path],
      confidence: "medium",
    });
  }

  // If no projects, use recent notes/experiments
  if (activeThreads.length === 0) {
    const recentNonPapers = sorted.filter((p) => p.type !== "paper").slice(0, 3);
    for (const page of recentNonPapers) {
      activeThreads.push({
        name: page.title,
        evidence: [page.path],
        confidence: "low",
      });
    }
  }

  // Central papers: just list them
  const centralPapers = paperPages.slice(0, 5).map((p) => ({
    title: p.title,
    path: p.path,
    whyItMatters: "Imported during coldstart — review for relevance",
  }));

  // Suggested questions
  const suggestedQuestions = [
    "What are the main themes in my research corpus?",
    "Which papers should I read next based on my current work?",
    "What experiments have I completed and what are the outstanding questions?",
  ];

  return {
    generatedAt: new Date().toISOString(),
    activeThreads,
    stalledThreads: [],
    centralPapers,
    suggestedQuestions,
    stats,
  };
}
