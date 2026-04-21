/**
 * Second Brain — Brain Health Dashboard
 *
 * Scans the brain and produces metrics about coverage, freshness,
 * linking density, and completeness. Scientists use this to understand
 * the quality of their knowledge base and find actionable improvements.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join, relative, basename, resolve } from "path";
import matter from "gray-matter";
import type { BrainConfig, ContentType } from "./types";
import {
  ensureBrainStoreReady,
  getBrainStore,
  resolveBrainStorePglitePath,
  resolveBrainStoreRoot,
  type BrainStoreHealth,
} from "./store";

// ── Public Interface ─────────────────────────────────

export interface BrainHealthReport {
  generatedAt: string;
  source: "gbrain" | "disk-fallback";
  score: number; // 0-100 overall health score
  brainScore?: number; // gbrain's native 0-100 score, when available
  embedCoverage?: number; // gbrain embedding coverage ratio, when available
  issueCounts?: {
    stalePages?: number;
    orphanPages?: number;
    deadLinks?: number;
    missingEmbeddings?: number;
  };
  stats?: {
    chunkCount?: number;
    embeddedCount?: number;
    linkCount?: number;
    tagCount?: number;
    timelineEntryCount?: number;
    syncRepoPath?: string | null;
  };

  coverage: {
    totalPages: number;
    papersWithAbstracts: number;
    papersWithoutAbstracts: number;
    papersWithCitations: number;
    authorPagesCount: number;
    conceptPagesCount: number;
    coveragePercent: number; // papers with full metadata / total papers
  };

  orphans: Array<{ path: string; title: string; reason: string }>;

  stalePages: Array<{
    path: string;
    title: string;
    daysSinceUpdate: number;
    suggestedAction: string;
  }>;

  missingLinks: Array<{
    sourcePage: string;
    mentionedEntity: string;
    suggestedTarget: string;
  }>;

  embeddingGaps: number; // pages without embeddings (if gbrain enabled)

  suggestions: string[]; // actionable improvement suggestions
}

// ── Internal Types ───────────────────────────────────

interface PageInfo {
  path: string;
  title: string;
  type: ContentType;
  content: string;
  frontmatter: Record<string, unknown>;
  lastModified: Date;
  wikiLinks: string[];
  hasAbstract: boolean;
  hasCitations: boolean;
}

// ── Main Function ────────────────────────────────────

/**
 * Generate a full brain health report by scanning the wiki directory.
 */
export function generateHealthReport(config: BrainConfig): BrainHealthReport {
  const now = new Date();
  const wikiDir = join(config.root, "wiki");

  if (!existsSync(wikiDir)) {
    return emptyReport(now);
  }

  const pages = collectAllPages(wikiDir);

  const coverage = computeCoverage(pages);
  const orphans = findOrphans(pages);
  const stalePages = findStalePages(pages, now);
  const missingLinks = findMissingLinks(pages);
  const embeddingGaps = countEmbeddingGaps();
  const suggestions = generateSuggestions(coverage, orphans, stalePages, missingLinks, embeddingGaps);

  const score = computeHealthScore(coverage, pages, orphans, stalePages);

  return {
    generatedAt: now.toISOString(),
    source: "disk-fallback",
    score,
    coverage,
    orphans: orphans.slice(0, 20),
    stalePages: stalePages.slice(0, 20),
    missingLinks: missingLinks.slice(0, 20),
    embeddingGaps,
    issueCounts: {
      stalePages: stalePages.length,
      orphanPages: orphans.length,
      deadLinks: missingLinks.length,
      missingEmbeddings: embeddingGaps,
    },
    suggestions,
  };
}

/**
 * Generate a health report using gbrain as the source of truth when the
 * configured root matches the active BrainStore and its PGLite database is
 * already present. Falls back to the legacy disk scanner for setup tests,
 * uninitialized brains, and backend failures.
 */
export async function generateHealthReportWithGbrain(
  config: BrainConfig,
): Promise<BrainHealthReport> {
  const requestRoot = resolve(config.root);
  const storeRoot = resolve(resolveBrainStoreRoot());
  if (requestRoot !== storeRoot || !existsSync(resolveBrainStorePglitePath())) {
    return generateHealthReport(config);
  }

  try {
    await ensureBrainStoreReady();
    const health = await getBrainStore().health();
    if (!health.ok || health.brainScore === undefined) {
      return generateHealthReport(config);
    }
    return mergeGbrainHealth(health);
  } catch {
    return generateHealthReport(config);
  }
}

function mergeGbrainHealth(
  health: BrainStoreHealth,
): BrainHealthReport {
  const embedCoverage = health.embedCoverage;
  const coveragePercent = embedCoverage === undefined
    ? 0
    : Math.round(Math.max(0, Math.min(1, embedCoverage)) * 100);
  const score = clampScore(health.brainScore ?? 0);
  const stats = {
    chunkCount: health.chunkCount,
    embeddedCount: health.embeddedCount,
    linkCount: health.linkCount,
    tagCount: health.tagCount,
    timelineEntryCount: health.timelineEntryCount,
    syncRepoPath: health.syncRepoPath,
  };

  return {
    generatedAt: new Date().toISOString(),
    source: "gbrain",
    score,
    brainScore: score,
    embedCoverage,
    issueCounts: {
      stalePages: health.stalePages ?? 0,
      orphanPages: health.orphanPages ?? 0,
      deadLinks: health.deadLinks ?? 0,
      missingEmbeddings: health.missingEmbeddings ?? 0,
    },
    stats,
    coverage: {
      totalPages: health.pageCount,
      papersWithAbstracts: 0,
      papersWithoutAbstracts: 0,
      papersWithCitations: 0,
      authorPagesCount: 0,
      conceptPagesCount: 0,
      coveragePercent,
    },
    orphans: [],
    stalePages: [],
    missingLinks: [],
    embeddingGaps: health.missingEmbeddings ?? 0,
    suggestions: generateGbrainSuggestions(health),
  };
}

export function generateGbrainSuggestions(health: BrainStoreHealth): string[] {
  const suggestions: string[] = [];
  if ((health.missingEmbeddings ?? 0) > 0) {
    suggestions.push(
      `${health.missingEmbeddings} chunk(s) lack embeddings. Refresh stale embeddings before relying on semantic search.`,
    );
  }
  if ((health.deadLinks ?? 0) > 0) {
    suggestions.push(
      `${health.deadLinks} link(s) point to missing pages. Run a link repair pass before using graph-heavy workflows.`,
    );
  }
  if ((health.orphanPages ?? 0) > 0) {
    suggestions.push(
      `${health.orphanPages} page(s) have no incoming links. Connect them to projects, papers, or concepts.`,
    );
  }
  if ((health.stalePages ?? 0) > 0) {
    suggestions.push(
      `${health.stalePages} active page(s) are stale. Review and refresh them before relying on current-truth workflows.`,
    );
  }
  if (health.embedCoverage !== undefined && health.embedCoverage < 0.9) {
    suggestions.push(
      `Embedding coverage is ${Math.round(health.embedCoverage * 100)}%. Bring it above 90% for better retrieval.`,
    );
  }
  if (suggestions.length === 0 && (health.brainScore ?? 0) >= 90) {
    suggestions.push("gbrain health is strong. Keep adding linked, embedded research context.");
  }
  if (suggestions.length === 0) {
    suggestions.push(
      `gbrain score is ${clampScore(health.brainScore ?? 0)}. Review health details for the highest-impact maintenance target.`,
    );
  }
  return Array.from(new Set(suggestions));
}

function clampScore(score: number): number {
  return Math.max(0, Math.min(100, Math.round(score)));
}

// ── Page Collection ──────────────────────────────────

function collectAllPages(wikiDir: string): PageInfo[] {
  const pages: PageInfo[] = [];
  walkMarkdown(wikiDir, (absPath) => {
    const relPath = `wiki/${relative(wikiDir, absPath)}`;
    const stat = statSync(absPath);
    const raw = readFileSync(absPath, "utf-8");

    let frontmatter: Record<string, unknown> = {};
    let content = raw;
    try {
      const parsed = matter(raw);
      frontmatter = parsed.data as Record<string, unknown>;
      content = parsed.content;
    } catch {
      // If frontmatter parsing fails, use the raw content
    }

    const title =
      (frontmatter.title as string | undefined) ??
      extractTitle(content) ??
      basename(absPath, ".md");

    const type = inferType(relPath, frontmatter);
    const wikiLinks = extractWikiLinks(raw);
    const contentLower = content.toLowerCase();
    const hasAbstract = Boolean(
      /^##?\s+abstract/m.test(contentLower) ||
      /^abstract[:\s]/m.test(contentLower) ||
      contentLower.includes("## summary"),
    );
    const hasCitations = Boolean(
      (frontmatter.doi as string | undefined) ||
      (frontmatter.arxiv as string | undefined) ||
      content.includes("doi.org") ||
      content.includes("arxiv.org"),
    );

    pages.push({
      path: relPath,
      title,
      type,
      content: raw,
      frontmatter,
      lastModified: stat.mtime,
      wikiLinks,
      hasAbstract,
      hasCitations,
    });
  });
  return pages;
}

function walkMarkdown(dir: string, cb: (absPath: string) => void): void {
  if (!existsSync(dir)) return;
  const entries = readdirSync(dir);
  for (const entry of entries) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walkMarkdown(full, cb);
    } else if (entry.endsWith(".md")) {
      cb(full);
    }
  }
}

// ── Coverage ─────────────────────────────────────────

function computeCoverage(pages: PageInfo[]): BrainHealthReport["coverage"] {
  const papers = pages.filter((p) => p.type === "paper");
  const totalPages = pages.length;
  const papersWithAbstracts = papers.filter((p) => p.hasAbstract).length;
  const papersWithoutAbstracts = papers.length - papersWithAbstracts;
  const papersWithCitations = papers.filter((p) => p.hasCitations).length;
  const authorPagesCount = pages.filter((p) => p.type === "person").length;
  const conceptPagesCount = pages.filter((p) => p.type === "concept").length;

  const papersWithFullMetadata = papers.filter(
    (p) => p.hasAbstract && p.hasCitations,
  ).length;
  const coveragePercent =
    papers.length > 0
      ? Math.round((papersWithFullMetadata / papers.length) * 100)
      : 100; // No papers means nothing to cover

  return {
    totalPages,
    papersWithAbstracts,
    papersWithoutAbstracts,
    papersWithCitations,
    authorPagesCount,
    conceptPagesCount,
    coveragePercent,
  };
}

// ── Orphan Detection ─────────────────────────────────

function findOrphans(
  pages: PageInfo[],
): BrainHealthReport["orphans"] {
  // Build a set of all pages that are linked to from other pages
  const linkedPaths = new Set<string>();
  for (const page of pages) {
    for (const link of page.wikiLinks) {
      // Normalize the link to find matching pages
      linkedPaths.add(link.toLowerCase());
    }
  }

  // Structural pages that are expected to have no incoming links
  const structuralPaths = new Set([
    "wiki/home.md",
    "wiki/index.md",
    "wiki/overview.md",
    "wiki/log.md",
  ]);

  return pages
    .filter((page) => {
      if (structuralPaths.has(page.path)) return false;
      // Check if any page links to this page's title or path
      const pathBase = basename(page.path, ".md").toLowerCase();
      const titleLower = page.title.toLowerCase();
      return !linkedPaths.has(pathBase) && !linkedPaths.has(titleLower);
    })
    .map((page) => ({
      path: page.path,
      title: page.title,
      reason: "No incoming wikilinks from other pages",
    }));
}

// ── Stale Page Detection ─────────────────────────────

function findStalePages(
  pages: PageInfo[],
  now: Date,
): BrainHealthReport["stalePages"] {
  const staleThresholdDays = 14;
  const staleThresholdMs = staleThresholdDays * 24 * 60 * 60 * 1000;

  // Structural pages are expected to be rarely updated
  const structuralPaths = new Set([
    "wiki/home.md",
    "wiki/index.md",
    "wiki/overview.md",
    "wiki/log.md",
  ]);

  // Only check active-type pages: projects, tasks, experiments, hypotheses
  const activeTypes = new Set<ContentType>([
    "project",
    "task",
    "experiment",
    "hypothesis",
  ]);

  return pages
    .filter((page) => {
      if (structuralPaths.has(page.path)) return false;
      if (!activeTypes.has(page.type)) return false;
      const age = now.getTime() - page.lastModified.getTime();
      return age > staleThresholdMs;
    })
    .map((page) => {
      const daysSinceUpdate = Math.floor(
        (now.getTime() - page.lastModified.getTime()) / (24 * 60 * 60 * 1000),
      );
      return {
        path: page.path,
        title: page.title,
        daysSinceUpdate,
        suggestedAction: suggestedStaleAction(page.type, page.title),
      };
    })
    .sort((a, b) => b.daysSinceUpdate - a.daysSinceUpdate);
}

function suggestedStaleAction(type: ContentType, title: string): string {
  switch (type) {
    case "project":
      return `Review project "${title}" status — update or archive if inactive.`;
    case "task":
      return `Open task "${title}" has had no updates — complete, update, or drop it.`;
    case "experiment":
      return `Running experiment "${title}" has no recent observations — check progress.`;
    case "hypothesis":
      return `Hypothesis "${title}" needs re-evaluation — update confidence or test it.`;
    default:
      return `Page "${title}" may be stale — review and update.`;
  }
}

// ── Missing Links Detection ──────────────────────────

function findMissingLinks(
  pages: PageInfo[],
): BrainHealthReport["missingLinks"] {
  // Build a map of known entities (title -> path) for person and concept pages
  const knownEntities = new Map<string, string>();
  for (const page of pages) {
    if (page.type === "person" || page.type === "concept") {
      knownEntities.set(page.title.toLowerCase(), page.path);
    }
  }

  const missing: BrainHealthReport["missingLinks"] = [];

  for (const page of pages) {
    // Skip entity pages themselves to avoid self-referencing suggestions
    if (page.type === "person" || page.type === "concept") continue;

    const existingLinks = new Set(page.wikiLinks.map((l) => l.toLowerCase()));

    for (const [entityName, entityPath] of knownEntities) {
      // Check if the page content mentions this entity but doesn't link to it
      if (
        page.content.toLowerCase().includes(entityName) &&
        !existingLinks.has(entityName) &&
        !existingLinks.has(basename(entityPath, ".md").toLowerCase())
      ) {
        missing.push({
          sourcePage: page.path,
          mentionedEntity: entityName,
          suggestedTarget: entityPath,
        });
      }
    }
  }

  return missing;
}

// ── Embedding Gaps ───────────────────────────────────

function countEmbeddingGaps(): number {
  // TODO: query the PGLite vector store for pages without embeddings
  return 0;
}

// ── Health Score ─────────────────────────────────────

function computeHealthScore(
  coverage: BrainHealthReport["coverage"],
  pages: PageInfo[],
  orphans: BrainHealthReport["orphans"],
  stalePages: BrainHealthReport["stalePages"],
): number {
  if (coverage.totalPages === 0) return 0;

  // Coverage: 30% weight — what percent of papers have full metadata
  const coverageScore = coverage.coveragePercent;

  // Freshness: 25% weight — percent of active pages that are NOT stale
  const activePages = pages.filter((p) =>
    ["project", "task", "experiment", "hypothesis"].includes(p.type),
  );
  const freshnessScore =
    activePages.length > 0
      ? Math.round(
          ((activePages.length - stalePages.length) / activePages.length) * 100,
        )
      : 100;

  // Linking: 25% weight — percent of pages that are NOT orphans
  const linkingScore = Math.round(
    ((pages.length - orphans.length) / pages.length) * 100,
  );

  // Completeness: 20% weight — based on variety of page types
  const typeSet = new Set(pages.map((p) => p.type));
  const expectedTypes = ["paper", "note", "project", "person", "concept"];
  const completenessScore = Math.round(
    (expectedTypes.filter((t) => typeSet.has(t as ContentType)).length /
      expectedTypes.length) *
      100,
  );

  const score = Math.round(
    coverageScore * 0.3 +
      freshnessScore * 0.25 +
      linkingScore * 0.25 +
      completenessScore * 0.2,
  );

  return Math.max(0, Math.min(100, score));
}

// ── Suggestions ──────────────────────────────────────

function generateSuggestions(
  coverage: BrainHealthReport["coverage"],
  orphans: BrainHealthReport["orphans"],
  stalePages: BrainHealthReport["stalePages"],
  missingLinks: BrainHealthReport["missingLinks"],
  embeddingGaps: number,
): string[] {
  const suggestions: string[] = [];

  if (coverage.papersWithoutAbstracts > 0) {
    suggestions.push(
      `${coverage.papersWithoutAbstracts} paper(s) lack abstracts — run enrichment to fill metadata gaps.`,
    );
  }

  if (coverage.authorPagesCount === 0 && coverage.totalPages > 5) {
    suggestions.push(
      "No author/person pages found — create person pages for key collaborators and cited authors.",
    );
  }

  if (coverage.conceptPagesCount === 0 && coverage.totalPages > 10) {
    suggestions.push(
      "No concept pages found — extract key concepts from papers and notes into dedicated pages.",
    );
  }

  if (orphans.length > 0) {
    suggestions.push(
      `${orphans.length} orphan page(s) have no incoming links — add wikilinks from related pages.`,
    );
  }

  if (stalePages.length > 0) {
    suggestions.push(
      `${stalePages.length} active page(s) are stale (14+ days without update) — review and refresh.`,
    );
  }

  if (missingLinks.length > 0) {
    suggestions.push(
      `${missingLinks.length} potential wikilink(s) missing — pages mention entities without linking to them.`,
    );
  }

  if (embeddingGaps > 0) {
    suggestions.push(
      `${embeddingGaps} page(s) lack vector embeddings — run a dream cycle to fill gaps.`,
    );
  }

  if (suggestions.length === 0) {
    suggestions.push("Brain is in good shape. Keep adding and linking content.");
  }

  return suggestions;
}

// ── Helpers ──────────────────────────────────────────

function emptyReport(now: Date): BrainHealthReport {
  return {
    generatedAt: now.toISOString(),
    source: "disk-fallback",
    score: 0,
    coverage: {
      totalPages: 0,
      papersWithAbstracts: 0,
      papersWithoutAbstracts: 0,
      papersWithCitations: 0,
      authorPagesCount: 0,
      conceptPagesCount: 0,
      coveragePercent: 100,
    },
    orphans: [],
    stalePages: [],
    missingLinks: [],
    embeddingGaps: 0,
    suggestions: ["Brain wiki directory not found. Initialize a brain first."],
  };
}

function extractTitle(content: string): string | null {
  const match = content.match(/^# (.+)$/m);
  return match ? match[1].trim() : null;
}

function extractWikiLinks(content: string): string[] {
  const matches = content.match(/\[\[([^\]]+)\]\]/g);
  if (!matches) return [];
  return matches.map((m) => m.slice(2, -2));
}

function inferType(
  path: string,
  frontmatter: Record<string, unknown>,
): ContentType {
  if (frontmatter.type && typeof frontmatter.type === "string") {
    return frontmatter.type as ContentType;
  }
  if (path.includes("entities/papers")) return "paper";
  if (path.includes("entities/people")) return "person";
  if (path.includes("resources/data/")) return "data";
  if (path.includes("experiments")) return "experiment";
  if (path.includes("hypotheses")) return "hypothesis";
  if (path.includes("concepts")) return "concept";
  if (path.includes("/projects/")) return "project";
  if (path.includes("entities/decisions")) return "decision";
  if (path.includes("entities/tasks")) return "task";
  if (path.includes("entities/artifacts")) return "artifact";
  if (path.includes("entities/frontier")) return "frontier_item";
  if (path.includes("observations")) return "observation";
  return "note";
}
