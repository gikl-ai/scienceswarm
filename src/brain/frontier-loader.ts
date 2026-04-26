/**
 * Second Brain — Frontier Watch Loader
 *
 * Loads frontier items from the watch store for all active studys,
 * converting RankedWatchItems into SearchResult format for use in
 * the morning brief's frontier scoring pipeline.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join, basename } from "path";
import matter from "gray-matter";
import type { BrainConfig, SearchResult, ProjectManifest } from "./types";
import { assertSafeProjectSlug, InvalidSlugError, listProjectManifests } from "@/lib/state/project-manifests";
import { getProjectBrainRootForBrainRoot } from "@/lib/state/project-storage";

/**
 * Load frontier watch items from the watch store for the given project
 * (or all active studys if no filter). Returns them as SearchResult[]
 * so they can merge into the existing frontier scoring pipeline.
 */
export async function loadFrontierWatchItems(
  config: BrainConfig,
  projectFilter: string,
): Promise<SearchResult[]> {
  const projectSlugs = projectFilter
    ? normalizeProjectFilter(projectFilter)
    : await listActiveProjectSlugs(config);

  const results: SearchResult[] = [];

  for (const slug of projectSlugs) {
    // Load frontier pages — works whether or not a watch config exists.
    // Pages may have been created by the watch system or manually.
    const frontierDir = join(
      getProjectBrainRootForBrainRoot(slug, config.root),
      "wiki",
      "entities",
      "frontier",
    );
    if (!existsSync(frontierDir)) continue;

    const entries = readdirSync(frontierDir);
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;

      const fullPath = join(frontierDir, entry);
      const stat = statSync(fullPath);
      if (!stat.isFile()) continue;

      try {
        const raw = readFileSync(fullPath, "utf-8");
        const parsed = matter(raw);
        const title =
          (parsed.data.title as string | undefined) ??
          basename(entry, ".md");
        const status = parsed.data.status as string | undefined;
        const pageProject = parsed.data.project as string | undefined;

        // Always filter by the current slug — prevents duplicates when
        // iterating over multiple active studys in all-projects mode.
        const tags = Array.isArray(parsed.data.tags) ? parsed.data.tags : [];
        const matchesProject =
          pageProject === slug ||
          entry.includes(slug) ||
          tags.some((t: unknown) => String(t) === slug);
        if (!matchesProject) continue;

        // Prefer promoted/staged items from the watch system
        if (status === "promoted" || status === "staged") {
          const confidence = parsed.data.confidence as string | undefined;
          const relevance =
            status === "promoted" ? 0.85 : confidence === "high" ? 0.7 : 0.55;

          results.push({
            path: `wiki/entities/frontier/${entry}`,
            title,
            snippet:
              extractSnippet(parsed.content) ||
              `Frontier item for project ${slug}`,
            relevance,
            type: "frontier_item",
          });
        }
      } catch {
        // Skip malformed files
      }
    }
  }

  // Sort by relevance descending
  results.sort((a, b) => b.relevance - a.relevance);
  return results;
}

function normalizeProjectFilter(projectFilter: string): string[] {
  try {
    return [assertSafeProjectSlug(projectFilter)];
  } catch (error) {
    if (error instanceof InvalidSlugError) {
      return [];
    }
    throw error;
  }
}

/**
 * List active study slugs from canonical project roots plus any remaining
 * legacy manifests under the configured brain root.
 */
async function listActiveProjectSlugs(config: BrainConfig): Promise<string[]> {
  const slugs = new Set<string>();

  for (const manifest of await listProjectManifests()) {
    if (manifest.status === "active") {
      slugs.add(manifest.slug);
    }
  }

  const legacyProjectsDir = join(config.root, "state", "projects");
  if (!existsSync(legacyProjectsDir)) {
    return Array.from(slugs).sort();
  }

  const entries = readdirSync(legacyProjectsDir);

  for (const entry of entries) {
    const manifestPath = join(legacyProjectsDir, entry, "manifest.json");
    if (!existsSync(manifestPath)) continue;

    try {
      const raw = readFileSync(manifestPath, "utf-8");
      const manifest = JSON.parse(raw) as ProjectManifest;
      if (manifest.status === "active") {
        slugs.add(manifest.slug);
      }
    } catch {
      // Skip malformed manifests
    }
  }

  return Array.from(slugs).sort();
}

function extractSnippet(content: string): string {
  // Strip leading headings and whitespace, return first meaningful line
  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#") && !trimmed.startsWith("---")) {
      return trimmed.slice(0, 150);
    }
  }
  return "";
}
