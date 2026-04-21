/**
 * Second Brain — Cross-Reference Name Resolution
 *
 * Resolves informal paper/author references to canonical brain pages.
 * "the Anthropic SAE paper" → wiki/entities/papers/anthropic-sae-2024.md
 * "Bricken et al." → wiki/entities/people/bricken.md
 *
 * Used by dream cycle step 4 (fix broken citations) to link informal
 * mentions to canonical pages.
 */

import type { BrainConfig, SearchResult } from "./types";
import { search } from "./search";

// ── Types ─────────────────────────────────────────────

export interface ResolvedReference {
  /** Canonical brain page path */
  path: string;
  /** Page title */
  title: string;
  /** How confident we are (0–1) */
  confidence: number;
  /** Which strategy resolved it */
  strategy: "keyword" | "author" | "fuzzy";
}

// ── Informal Reference Patterns ──────────────────────

/**
 * Regex patterns that match informal paper/author references in text.
 * Each pattern captures the informal name in group 1.
 */
const INFORMAL_PATTERNS: RegExp[] = [
  // "the X paper" / "the X study" / "the X work"
  /the\s+([A-Z][\w\s]+?)\s+(?:paper|study|work|article|report)\b/g,
  // "X et al." with at least one capitalized word
  /([A-Z][a-z]+(?:\s+(?:and|&)\s+[A-Z][a-z]+)?)\s+et\s+al\.?/g,
  // "X's work on Y" / "X's paper on Y"
  /([A-Z][a-z]+(?:'s)?)\s+(?:work|paper|study|research)\s+on\s+([\w\s]+)/g,
];

/**
 * Common stop words to filter when extracting search terms.
 */
const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "is", "was", "are", "were", "be", "been",
  "being", "have", "has", "had", "do", "does", "did", "will", "would",
  "could", "should", "may", "might", "shall", "can", "that", "this",
  "these", "those", "it", "its", "their", "our", "your", "my",
  "paper", "study", "work", "article", "report", "research",
]);

// ── Core Functions ───────────────────────────────────

/**
 * Extract meaningful search terms from an informal reference string.
 */
export function extractKeyTerms(informalName: string): string[] {
  return informalName
    .replace(/['']/g, "'")
    .replace(/[^\w\s'-]/g, " ")
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w.toLowerCase()));
}

/**
 * Detect whether an informal name looks like an author reference.
 * E.g. "Bricken et al.", "Vaswani and Shazeer"
 */
export function isAuthorReference(informalName: string): boolean {
  return /et\s+al\.?/i.test(informalName) ||
    /^[A-Z][a-z]+(?:\s+(?:and|&)\s+[A-Z][a-z]+)+$/.test(informalName.trim());
}

/**
 * Resolve an informal reference to a canonical brain page.
 *
 * Strategy:
 * 1. Extract key terms from the informal name
 * 2. If it looks like an author ref, search people pages first
 * 3. Search brain with combined key terms
 * 4. Rank results by keyword overlap with the informal name
 * 5. Return best match above confidence threshold (0.3)
 */
export async function resolveInformalReference(
  config: BrainConfig,
  informalName: string,
): Promise<ResolvedReference | null> {
  const terms = extractKeyTerms(informalName);
  if (terms.length === 0) return null;

  const isAuthor = isAuthorReference(informalName);

  // Search the brain — try each key term individually, merge results.
  // Grep mode matches the entire query as a literal substring, so
  // "Anthropic SAE" would miss pages where the terms appear separately.
  const resultMap = new Map<string, SearchResult>();
  for (const term of terms) {
    try {
      const hits = await search(config, { query: term, mode: "grep", limit: 20 });
      for (const hit of hits) {
        if (!resultMap.has(hit.path)) resultMap.set(hit.path, hit);
      }
    } catch {
      // Skip terms that error
    }
  }

  const results = Array.from(resultMap.values());
  if (results.length === 0) return null;

  // Score each result by keyword overlap with the informal reference
  const scored = results.map((r) => {
    const haystack = `${r.title} ${r.snippet}`.toLowerCase();
    const termsLower = terms.map((t) => t.toLowerCase());
    let hits = 0;
    for (const term of termsLower) {
      if (haystack.includes(term)) hits++;
    }
    const overlap = terms.length > 0 ? hits / terms.length : 0;

    // Boost author pages for author references
    let boost = 0;
    if (isAuthor && r.type === "person") boost = 0.2;
    // Boost paper pages for "paper" references
    if (!isAuthor && r.type === "paper") boost = 0.1;

    const strategy: ResolvedReference["strategy"] = isAuthor
      ? "author"
      : overlap >= 0.5
        ? "keyword"
        : "fuzzy";

    return {
      path: r.path,
      title: r.title,
      confidence: Math.min(1, overlap + boost),
      strategy,
    };
  });

  // Sort by confidence descending
  scored.sort((a, b) => b.confidence - a.confidence);

  const best = scored[0];
  if (best.confidence < 0.3) return null;

  return best;
}

/**
 * Scan content for informal references and resolve each one.
 *
 * Finds patterns like "the X paper", "X et al.", "X's work on Y"
 * and attempts to resolve each to a canonical brain page.
 */
export async function resolveAllInformalRefs(
  config: BrainConfig,
  content: string,
): Promise<Array<{ informal: string; resolved: ResolvedReference }>> {
  const informalNames = new Set<string>();

  for (const pattern of INFORMAL_PATTERNS) {
    // Reset lastIndex for global regexes
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const name = match[0].trim();
      if (name.length > 3 && name.length < 200) {
        informalNames.add(name);
      }
    }
  }

  const results: Array<{ informal: string; resolved: ResolvedReference }> = [];

  for (const informal of informalNames) {
    const resolved = await resolveInformalReference(config, informal);
    if (resolved) {
      results.push({ informal, resolved });
    }
  }

  return results;
}
