import { join } from "node:path";

import type { BrainConfig } from "./types";
import type { BrainPage, BrainStore } from "./store";
import { ensureBrainStoreReady, getBrainStore } from "./store";
import { buildProjectBrief } from "./briefing";
import { extractKeywords } from "./original-clustering";
import {
  readProjectImportSummary,
  type ProjectImportSummary,
} from "@/lib/state/project-import-summary";
import { isDefaultScienceSwarmBrainRoot } from "@/lib/scienceswarm-paths";
import { getProjectStateRootForBrainRoot } from "@/lib/state/project-storage";
import { buildArtifactSourceSnapshotFromPage } from "@/lib/artifact-source-snapshots";
import { normalizeArtifactSourceSnapshots } from "@/lib/artifact-provenance";
import { buildProjectImportDuplicateGroups } from "@/brain/import-registry";
import { detectDuplicatePaperCandidates, type PaperCandidate } from "@/lib/paper-dedupe";
import type {
  ProjectOrganizerDuplicate,
  ProjectOrganizerReadout,
  ProjectOrganizerStaleExport,
  ProjectOrganizerThread,
} from "@/lib/project-organizer-summary";
import { buildProjectOrganizerSuggestedPrompts } from "@/lib/project-organizer-summary";

const GENERIC_THREAD_KEYWORDS = new Set([
  "project",
  "projects",
  "paper",
  "papers",
  "task",
  "tasks",
  "note",
  "notes",
  "artifact",
  "artifacts",
  "frontier",
  "frontier-item",
  "frontieritem",
  "decision",
  "decisions",
  "dataset",
  "datasets",
  "data",
  "code",
  "import",
  "imports",
  "meeting",
  "meetings",
  "openclaw",
  "openhands",
  "gbrain",
  "compiled",
  "enriched",
  "summary",
  "summaries",
  "review",
  "analysis",
  "results",
  "result",
  "wiki",
]);

const PROJECT_ORGANIZER_PAGE_SCAN_LIMIT = 5000;

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeKeyword(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
}

function humanizeKeyword(value: string): string {
  return value
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function projectKeywords(project: string): Set<string> {
  return new Set(
    project
      .split(/[^a-z0-9]+/i)
      .map((part) => normalizeKeyword(part))
      .filter(Boolean),
  );
}

export function filterProjectPages(pages: BrainPage[], project: string): BrainPage[] {
  return pages.filter((page) => {
    const frontmatter = page.frontmatter ?? {};
    return frontmatter.project === project
      || (Array.isArray(frontmatter.projects) && frontmatter.projects.includes(project));
  });
}

function pageKeywords(page: BrainPage, project: string): string[] {
  const generic = new Set([...GENERIC_THREAD_KEYWORDS, ...projectKeywords(project)]);
  const tags = normalizeStringArray(page.frontmatter?.tags);
  const topic = typeof page.frontmatter?.topic === "string"
    ? [page.frontmatter.topic]
    : [];
  const titleKeywords = Array.from(extractKeywords(page.title)).slice(0, 6);

  return [...new Set([...tags, ...topic, ...titleKeywords].map(normalizeKeyword))]
    .filter((keyword) => keyword.length >= 3 && !generic.has(keyword));
}

export function buildProjectThreadClusters(
  pages: BrainPage[],
  project: string,
): ProjectOrganizerThread[] {
  const buckets = new Map<string, {
    pages: Map<string, { path: string; title: string; type: string }>;
    pageTypes: Set<string>;
    keywordCounts: Map<string, number>;
  }>();

  for (const page of pages) {
    const keywords = pageKeywords(page, project);
    if (keywords.length === 0) continue;

    for (const keyword of keywords) {
      const bucket = buckets.get(keyword) ?? {
        pages: new Map<string, { path: string; title: string; type: string }>(),
        pageTypes: new Set<string>(),
        keywordCounts: new Map<string, number>(),
      };
      bucket.pages.set(page.path, {
        path: page.path,
        title: page.title,
        type: page.type,
      });
      bucket.pageTypes.add(page.type);
      for (const relatedKeyword of keywords) {
        bucket.keywordCounts.set(
          relatedKeyword,
          (bucket.keywordCounts.get(relatedKeyword) ?? 0) + 1,
        );
      }
      buckets.set(keyword, bucket);
    }
  }

  const maxDominantSize = Math.max(2, Math.floor(pages.length * 0.8));
  return [...buckets.entries()]
    .filter(([, bucket]) => bucket.pages.size >= 2 && bucket.pages.size <= maxDominantSize)
    .sort((left, right) => {
      const pageDelta = right[1].pages.size - left[1].pages.size;
      if (pageDelta !== 0) return pageDelta;
      return left[0].localeCompare(right[0]);
    })
    .slice(0, 5)
    .map(([keyword, bucket]) => {
      const keywords = [...bucket.keywordCounts.entries()]
        .sort((left, right) => {
          const countDelta = right[1] - left[1];
          if (countDelta !== 0) return countDelta;
          return left[0].localeCompare(right[0]);
        })
        .map(([value]) => value)
        .filter((value) => value !== keyword)
        .slice(0, 3);

      const confidence: ProjectOrganizerThread["confidence"] =
        bucket.pages.size >= 5 || bucket.pageTypes.size >= 3
          ? "high"
          : bucket.pages.size >= 3
            ? "medium"
            : "low";

      return {
        label: humanizeKeyword(keyword),
        confidence,
        pageCount: bucket.pages.size,
        pageTypes: [...bucket.pageTypes].sort(),
        keywords: [keyword, ...keywords].map(humanizeKeyword),
        evidence: [...bucket.pages.values()].slice(0, 4),
      };
    });
}

function isProjectPaperPage(page: BrainPage): boolean {
  return page.type === "paper"
    || typeof page.frontmatter?.doi === "string"
    || page.path.includes("/papers/");
}

function paperCandidateFromPage(page: BrainPage): PaperCandidate {
  const relativePath =
    typeof page.frontmatter?.relative_path === "string" && page.frontmatter.relative_path.trim().length > 0
      ? page.frontmatter.relative_path.trim()
      : typeof page.frontmatter?.source_filename === "string" && page.frontmatter.source_filename.trim().length > 0
        ? page.frontmatter.source_filename.trim()
        : page.path;

  const candidate: PaperCandidate = {
    file: relativePath,
    title: page.title,
  };
  if (typeof page.frontmatter?.doi === "string" && page.frontmatter.doi.trim().length > 0) {
    candidate.doi = page.frontmatter.doi.trim();
  }
  return candidate;
}

function duplicatePapersFromPages(pages: BrainPage[]): ProjectOrganizerDuplicate[] {
  const candidates = pages
    .filter(isProjectPaperPage)
    .map(paperCandidateFromPage);
  return detectDuplicatePaperCandidates(candidates).duplicates;
}

function artifactProjectPath(page: BrainPage): string {
  return (
    typeof page.frontmatter?.relative_path === "string" && page.frontmatter.relative_path.trim().length > 0
      ? page.frontmatter.relative_path.trim()
      : typeof page.frontmatter?.source_filename === "string" && page.frontmatter.source_filename.trim().length > 0
        ? page.frontmatter.source_filename.trim()
        : page.path
  );
}

function artifactGeneratedAt(page: BrainPage): string | undefined {
  const frontmatter = page.frontmatter ?? {};
  return typeof frontmatter.uploaded_at === "string" && frontmatter.uploaded_at.trim().length > 0
    ? frontmatter.uploaded_at.trim()
    : typeof frontmatter.created_at === "string" && frontmatter.created_at.trim().length > 0
      ? frontmatter.created_at.trim()
      : undefined;
}

function staleExportsFromPages(
  allPages: BrainPage[],
  projectPages: BrainPage[],
): {
  trackedExportCount: number;
  staleExports: ProjectOrganizerStaleExport[];
} {
  const pagesByPath = new Map(allPages.map((page) => [page.path, page]));
  let trackedExportCount = 0;
  const staleExports: ProjectOrganizerStaleExport[] = [];

  for (const page of projectPages) {
    const snapshots = normalizeArtifactSourceSnapshots(
      page.frontmatter?.artifact_source_snapshots,
    );
    if (snapshots.length === 0) {
      continue;
    }

    trackedExportCount += 1;
    const staleSources: ProjectOrganizerStaleExport["staleSources"] = [];
    for (const snapshot of snapshots) {
      const currentPage = pagesByPath.get(snapshot.slug);
      if (!currentPage) {
        staleSources.push({
          slug: snapshot.slug,
          title: snapshot.title,
          reason: "missing-source" as const,
          ...(snapshot.workspacePath ? { workspacePath: snapshot.workspacePath } : {}),
        });
        continue;
      }

      const currentSnapshot = buildArtifactSourceSnapshotFromPage(currentPage);
      if (currentSnapshot.fingerprint === snapshot.fingerprint) {
        continue;
      }

      staleSources.push({
        slug: snapshot.slug,
        title: currentPage.title,
        reason: "updated-source" as const,
        ...(currentSnapshot.workspacePath ? { workspacePath: currentSnapshot.workspacePath } : {}),
        ...(currentSnapshot.observedAt ? { observedAt: currentSnapshot.observedAt } : {}),
      });
    }

    if (staleSources.length === 0) {
      continue;
    }

    staleExports.push({
      slug: page.path,
      projectPath: artifactProjectPath(page),
      title: page.title,
      ...(artifactGeneratedAt(page) ? { generatedAt: artifactGeneratedAt(page) } : {}),
      trackedSourceCount: snapshots.length,
      staleSources,
    });
  }

  staleExports.sort((left, right) => {
    const staleDelta = right.staleSources.length - left.staleSources.length;
    if (staleDelta !== 0) return staleDelta;
    return left.projectPath.localeCompare(right.projectPath);
  });

  return { trackedExportCount, staleExports };
}

function countPagesByType(pages: BrainPage[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const page of pages) {
    const key = page.type || "unknown";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Object.fromEntries(
    [...counts.entries()].sort((left, right) => {
      const countDelta = right[1] - left[1];
      if (countDelta !== 0) return countDelta;
      return left[0].localeCompare(right[0]);
    }),
  );
}

async function loadProjectImportSummaryForConfig(
  config: BrainConfig,
  project: string,
): Promise<ProjectImportSummary | null> {
  try {
    if (isDefaultScienceSwarmBrainRoot(config.root)) {
      const canonicalSummaryRecord = await readProjectImportSummary(project);
      if (canonicalSummaryRecord) {
        return canonicalSummaryRecord.lastImport;
      }
    }

    const summaryRecord = await readProjectImportSummary(
      project,
      getProjectStateRootForBrainRoot(project, config.root),
    );
    if (summaryRecord) {
      return summaryRecord.lastImport;
    }
    const legacyRecord = await readProjectImportSummary(project, join(config.root, "state"));
    return legacyRecord?.lastImport ?? null;
  } catch {
    return null;
  }
}

export async function buildProjectOrganizerReadout(input: {
  config: BrainConfig;
  project: string;
  store?: BrainStore;
}): Promise<ProjectOrganizerReadout> {
  if (!input.store) {
    await ensureBrainStoreReady();
  }
  const store = input.store ?? getBrainStore();
  const [pages, brief, importSummary] = await Promise.all([
    store.listPages({ limit: PROJECT_ORGANIZER_PAGE_SCAN_LIMIT }),
    buildProjectBrief({ config: input.config, project: input.project }).catch(() => null),
    loadProjectImportSummaryForConfig(input.config, input.project),
  ]);

  const projectPages = filterProjectPages(pages, input.project);
  const { trackedExportCount, staleExports } = staleExportsFromPages(pages, projectPages);
  const pageScanLimitReached = pages.length >= PROJECT_ORGANIZER_PAGE_SCAN_LIMIT;
  const baseReadout = {
    project: input.project,
    generatedAt: new Date().toISOString(),
    pageCount: projectPages.length,
    pageScanLimit: PROJECT_ORGANIZER_PAGE_SCAN_LIMIT,
    pageScanLimitReached,
    pageCountsByType: countPagesByType(projectPages),
    importSummary,
    threads: buildProjectThreadClusters(projectPages, input.project),
    duplicatePapers: duplicatePapersFromPages(projectPages),
    importDuplicateGroups: buildProjectImportDuplicateGroups(projectPages, importSummary, input.project),
    trackedExportCount,
    staleExports,
    nextMove: brief?.nextMove,
    dueTasks: brief?.dueTasks ?? [],
    frontier: brief?.frontier ?? [],
  };

  return {
    ...baseReadout,
    suggestedPrompts: buildProjectOrganizerSuggestedPrompts(baseReadout),
  };
}
