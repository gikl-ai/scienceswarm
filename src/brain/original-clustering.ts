/**
 * Second Brain — Original Thinking Clustering
 *
 * Weekly theme detection across wiki/originals/.
 * Groups the scientist's original thoughts by keyword overlap
 * and generates a report of recurring themes.
 *
 * Integrated into dream cycle step 5 (consolidate).
 */

import { readFileSync, existsSync, readdirSync } from "fs";
import { join, basename } from "path";
import matter from "gray-matter";
import type { BrainConfig } from "./types";

// ── Types ─────────────────────────────────────────────

export interface OriginalCluster {
  /** Human-readable cluster name derived from common keywords */
  name: string;
  /** Keywords that define this cluster */
  keywords: string[];
  /** Paths to originals in this cluster */
  members: string[];
  /** Number of originals in the cluster */
  size: number;
  /** ISO date of the most recent original in the cluster */
  mostRecent: string;
  /** Brief excerpts from members */
  excerpts: string[];
}

interface OriginalEntry {
  path: string;
  title: string;
  keywords: Set<string>;
  date: string;
  excerpt: string;
}

// ── Keyword Extraction ───────────────────────────────

/**
 * Common words to ignore when extracting keywords.
 */
const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "is", "was", "are", "were", "be", "been",
  "being", "have", "has", "had", "do", "does", "did", "will", "would",
  "could", "should", "may", "might", "shall", "can", "that", "this",
  "these", "those", "it", "its", "they", "their", "our", "your", "my",
  "we", "you", "he", "she", "not", "no", "so", "if", "as", "about",
  "what", "which", "who", "how", "when", "where", "why", "all", "each",
  "than", "then", "just", "also", "more", "some", "any", "other",
  "into", "over", "such", "too", "very", "only",
  // Brain-specific stops
  "original", "idea", "thought", "note", "first", "captured",
  "mentioned", "again", "compiled", "truth", "kind", "related",
  "timeline", "date", "type", "para", "tags", "resources",
]);

/**
 * Extract meaningful keywords from a piece of text.
 * Returns lowercase tokens with stop words removed.
 */
export function extractKeywords(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));

  return new Set(words);
}

// ── Similarity ───────────────────────────────────────

/**
 * Jaccard similarity between two sets: |A ∩ B| / |A ∪ B|
 */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;

  let intersection = 0;
  for (const word of a) {
    if (b.has(word)) intersection++;
  }

  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ── Clustering ───────────────────────────────────────

/**
 * Read all originals from wiki/originals/ and extract keywords from each.
 */
function readOriginals(config: BrainConfig): OriginalEntry[] {
  const originalsDir = join(config.root, "wiki/originals");
  if (!existsSync(originalsDir)) return [];

  const files = readdirSync(originalsDir).filter((f) => f.endsWith(".md"));
  const entries: OriginalEntry[] = [];

  for (const file of files) {
    const absPath = join(originalsDir, file);
    const raw = readFileSync(absPath, "utf-8");

    let title = basename(file, ".md").replace(/-/g, " ");
    let date = "1970-01-01";

    try {
      const parsed = matter(raw);
      if (parsed.data.title) title = String(parsed.data.title);
      if (parsed.data.date) {
        const d = parsed.data.date;
        // gray-matter auto-parses YAML dates to Date objects
        date = d instanceof Date
          ? d.toISOString().slice(0, 10)
          : String(d).slice(0, 10);
      }
    } catch {
      // If frontmatter parsing fails, use defaults
    }

    // Extract the blockquote (the verbatim thought)
    const quoteMatch = raw.match(/^>\s+(.+)$/m);
    const excerpt = quoteMatch
      ? quoteMatch[1].slice(0, 120)
      : raw.slice(0, 120).replace(/---[\s\S]*?---/, "").trim();

    const keywords = extractKeywords(`${title} ${raw}`);

    entries.push({
      path: `wiki/originals/${file}`,
      title,
      keywords,
      date,
      excerpt,
    });
  }

  return entries;
}

/**
 * Cluster originals by keyword overlap using single-linkage clustering
 * with Jaccard similarity threshold.
 */
export async function clusterOriginals(
  config: BrainConfig,
  similarityThreshold = 0.15,
): Promise<OriginalCluster[]> {
  const entries = readOriginals(config);
  if (entries.length === 0) return [];

  // Union-find for clustering
  const parent = entries.map((_, i) => i);

  function find(i: number): number {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]]; // path compression
      i = parent[i];
    }
    return i;
  }

  function union(i: number, j: number): void {
    const ri = find(i);
    const rj = find(j);
    if (ri !== rj) parent[ri] = rj;
  }

  // Compare all pairs and union those above threshold
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const sim = jaccardSimilarity(entries[i].keywords, entries[j].keywords);
      if (sim >= similarityThreshold) {
        union(i, j);
      }
    }
  }

  // Group by cluster root
  const groups = new Map<number, number[]>();
  for (let i = 0; i < entries.length; i++) {
    const root = find(i);
    const group = groups.get(root) ?? [];
    group.push(i);
    groups.set(root, group);
  }

  // Build cluster objects (only clusters with 2+ members)
  const clusters: OriginalCluster[] = [];

  for (const memberIndices of groups.values()) {
    if (memberIndices.length < 2) continue;

    const members = memberIndices.map((i) => entries[i]);

    // Find most common keywords across members
    const keywordCounts = new Map<string, number>();
    for (const member of members) {
      for (const kw of member.keywords) {
        keywordCounts.set(kw, (keywordCounts.get(kw) ?? 0) + 1);
      }
    }

    // Sort keywords by frequency, take top 5
    const sortedKeywords = Array.from(keywordCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([kw]) => kw);

    // Cluster name from top 3 keywords
    const name = sortedKeywords.slice(0, 3).join(" + ");

    // Most recent date
    const mostRecent = members
      .map((m) => m.date)
      .sort()
      .reverse()[0];

    clusters.push({
      name,
      keywords: sortedKeywords,
      members: members.map((m) => m.path),
      size: members.length,
      mostRecent,
      excerpts: members.slice(0, 3).map((m) => m.excerpt),
    });
  }

  // Sort clusters by size (largest first)
  clusters.sort((a, b) => b.size - a.size);

  return clusters;
}

/**
 * Generate a markdown report from clusters.
 */
export function generateClusterReport(clusters: OriginalCluster[]): string {
  if (clusters.length === 0) {
    return "## Original Thinking Clusters\n\nNo clusters detected yet — keep capturing original thoughts!\n";
  }

  const sections = clusters.map((cluster, i) => {
    const excerptLines = cluster.excerpts
      .map((e) => `  > ${e}`)
      .join("\n");

    return [
      `### ${i + 1}. ${cluster.name}`,
      `- **Size**: ${cluster.size} originals`,
      `- **Most recent**: ${cluster.mostRecent}`,
      `- **Keywords**: ${cluster.keywords.join(", ")}`,
      `- **Key excerpts**:`,
      excerptLines,
    ].join("\n");
  });

  return [
    "## Original Thinking Clusters",
    "",
    `Found **${clusters.length}** theme${clusters.length === 1 ? "" : "s"} across your original thoughts.`,
    "",
    ...sections,
  ].join("\n");
}
