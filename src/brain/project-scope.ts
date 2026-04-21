/**
 * Project-scoped gbrain search helper.
 *
 * Bucket D's FileTree pulls its audit-revise section by querying gbrain
 * with a `project:<slug>` filter. The BrainStore interface takes a
 * `SearchInput` and returns `SearchResult[]`; this module narrows to the
 * fields the FileTree cares about and post-filters by the frontmatter
 * project key (which the search layer does not apply natively).
 */

import { getBrainStore } from "./store";
import type { BrainStore } from "./store";
import type { SearchInput, SearchResult } from "./types";

export interface ProjectSearchResult {
  slug: string;
  title: string;
  type: string;
  snippet: string;
  relevance: number;
}

export interface ProjectSearchOptions {
  project: string;
  query?: string;
  limit?: number;
  store?: BrainStore;
}

/**
 * List audit-revise artifacts for a given project slug. Papers without
 * frontmatter are included; consumers filter by type themselves. The
 * store call is wrapped in a try/catch so a missing brain degrades to
 * an empty list instead of a runtime throw — that matches the dashboard
 * FileTree's "the brain may or may not be wired" expectation.
 */
export async function searchProjectArtifacts(
  options: ProjectSearchOptions,
): Promise<ProjectSearchResult[]> {
  const project = options.project.trim();
  if (!project) return [];

  const store = options.store ?? getBrainStore();
  const input: SearchInput = {
    query: options.query?.trim() || project,
    mode: "list",
    limit: options.limit ?? 100,
  };
  let results: SearchResult[];
  try {
    results = await store.search(input);
  } catch {
    return [];
  }

  const filtered = results.filter((result) =>
    matchesProject(result, project),
  );
  return filtered.map((result) => ({
    slug: result.path,
    title: result.title,
    type: result.type,
    snippet: result.snippet,
    relevance: result.relevance,
  }));
}

/**
 * Post-filter predicate used by the search wrapper. Exported so unit
 * tests can exercise the matching logic without touching the store.
 */
export function matchesProject(
  result: { path: string },
  project: string,
): boolean {
  const slug = result.path;
  if (slug === project) return true;
  if (slug.startsWith(`${project}-`)) return true;
  if (slug.startsWith(`${project}/`)) return true;
  return false;
}

/** Group `ProjectSearchResult`s by artifact type for the FileTree. */
export function groupByType(
  results: ProjectSearchResult[],
): Record<string, ProjectSearchResult[]> {
  const out: Record<string, ProjectSearchResult[]> = {};
  for (const result of results) {
    const type = result.type || "unknown";
    out[type] = out[type] ?? [];
    out[type].push(result);
  }
  return out;
}
