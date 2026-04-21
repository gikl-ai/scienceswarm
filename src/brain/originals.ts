/**
 * Second Brain — Originals Folder Manager
 *
 * The originals folder captures WHAT THE SCIENTIST THINKS, not what they found.
 * This is the highest-value content in the brain.
 *
 * Uses the scientist's own language for slugs and titles.
 * Never paraphrases — captures verbatim.
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
} from "fs";
import { join, basename } from "path";
import type { BrainConfig, SearchResult } from "./types";
import type { DetectedOriginal } from "./entity-detector";
import { slugify } from "./entity-detector";

// ── Public Types ─────────────────────────────────────

export interface OriginalPage {
  slug: string;
  verbatim: string;
  kind: DetectedOriginal["kind"];
  relatedEntities: string[];
  createdAt: string;
  mentions: Array<{ date: string; context: string }>;
}

// ── Core Functions ───────────────────────────────────

/**
 * Save an original thought to wiki/originals/{slug}.md.
 * Uses the scientist's own language for the slug.
 *
 * If an original with similar content already exists, APPENDS to its timeline
 * instead of creating a duplicate.
 */
export function saveOriginal(
  config: BrainConfig,
  original: DetectedOriginal,
  sourceContext: string
): string {
  const originalsDir = join(config.root, "wiki/originals");
  mkdirSync(originalsDir, { recursive: true });

  const slug = original.suggestedSlug || slugify(original.verbatim);
  const pagePath = `wiki/originals/${slug}.md`;
  const absPath = join(config.root, pagePath);
  const date = new Date().toISOString().slice(0, 10);

  // Check if a similar original already exists
  const existing = findSimilarOriginal(config, original.verbatim);
  if (existing) {
    updateOriginal(config, existing, {
      date,
      context: sourceContext,
      verbatim: original.verbatim,
    });
    return existing;
  }

  // Build the new original page
  const entityLinks = original.relatedEntities
    .map((e) => `[[${e}]]`)
    .join(", ");

  const content = [
    "---",
    `date: ${date}`,
    "type: note",
    "para: resources",
    `tags: [original, ${original.kind}]`,
    `title: "${escapeYaml(original.verbatim.slice(0, 100))}"`,
    "---",
    "",
    `# ${original.verbatim.slice(0, 120)}`,
    "",
    "## Compiled Truth",
    "",
    `> ${original.verbatim}`,
    "",
    `**Kind**: ${original.kind}`,
    entityLinks ? `**Related**: ${entityLinks}` : "",
    "",
    "## Timeline",
    "",
    `- **${date}** | First captured — ${sourceContext}`,
    "",
  ]
    .filter(Boolean)
    .join("\n");

  writeFileSync(absPath, content);
  return pagePath;
}

/**
 * Append a new mention to an existing original's timeline.
 */
export function updateOriginal(
  config: BrainConfig,
  existingPath: string,
  newMention: { date: string; context: string; verbatim: string }
): void {
  const absPath = join(config.root, existingPath);
  if (!existsSync(absPath)) return;

  const content = readFileSync(absPath, "utf-8");
  const timelineHeader = "## Timeline";
  const idx = content.indexOf(timelineHeader);

  if (idx === -1) {
    // No timeline section — append one
    const entry = `\n\n## Timeline\n\n- **${newMention.date}** | Mentioned again — ${newMention.context}\n  > ${newMention.verbatim}\n`;
    writeFileSync(absPath, content + entry);
    return;
  }

  // Insert after the timeline header
  const afterHeader = content.indexOf("\n", idx) + 1;
  const nextSection = content.indexOf("\n## ", afterHeader);
  const insertAt = nextSection === -1 ? content.length : nextSection;

  const entry = `- **${newMention.date}** | Mentioned again — ${newMention.context}\n  > ${newMention.verbatim}\n`;
  const updated =
    content.slice(0, insertAt).trimEnd() +
    "\n" +
    entry +
    "\n" +
    content.slice(insertAt);

  writeFileSync(absPath, updated);
}

/**
 * Search only the originals folder.
 */
export function searchOriginals(
  config: BrainConfig,
  query: string
): SearchResult[] {
  const originalsDir = join(config.root, "wiki/originals");
  if (!existsSync(originalsDir)) return [];

  const queryLower = query.toLowerCase();
  const results: SearchResult[] = [];

  const files = readdirSync(originalsDir).filter((f) => f.endsWith(".md"));
  for (const file of files) {
    const absPath = join(originalsDir, file);
    const content = readFileSync(absPath, "utf-8");

    if (!content.toLowerCase().includes(queryLower)) continue;

    const titleMatch = content.match(/^# (.+)$/m);
    const title = titleMatch ? titleMatch[1].trim() : basename(file, ".md");

    // Extract snippet around the match
    const matchIdx = content.toLowerCase().indexOf(queryLower);
    const start = Math.max(0, matchIdx - 40);
    const end = Math.min(content.length, matchIdx + query.length + 80);
    const snippet = content.slice(start, end).trim();

    results.push({
      path: `wiki/originals/${file}`,
      title,
      snippet,
      relevance: 0.8,
      type: "note",
    });
  }

  return results;
}

// ── Helpers ──────────────────────────────────────────

/**
 * Check if a similar original already exists by comparing verbatim text.
 * Returns the path to the existing original, or null if none found.
 */
function findSimilarOriginal(
  config: BrainConfig,
  verbatim: string
): string | null {
  const originalsDir = join(config.root, "wiki/originals");
  if (!existsSync(originalsDir)) return null;

  const verbatimLower = verbatim.toLowerCase();
  const files = readdirSync(originalsDir).filter((f) => f.endsWith(".md"));

  for (const file of files) {
    const absPath = join(originalsDir, file);
    const content = readFileSync(absPath, "utf-8");

    // Check if the verbatim text appears in the compiled truth section
    if (content.toLowerCase().includes(verbatimLower)) {
      return `wiki/originals/${file}`;
    }

    // Check for high overlap (>80% of words match)
    const existingQuote = extractQuote(content);
    if (existingQuote && wordOverlap(existingQuote, verbatim) > 0.8) {
      return `wiki/originals/${file}`;
    }
  }

  return null;
}

function extractQuote(content: string): string | null {
  const match = content.match(/^>\s+(.+)$/m);
  return match ? match[1].trim() : null;
}

function wordOverlap(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let overlap = 0;
  for (const word of wordsA) {
    if (wordsB.has(word)) overlap++;
  }

  return overlap / Math.max(wordsA.size, wordsB.size);
}

function escapeYaml(text: string): string {
  return text.replace(/"/g, '\\"').replace(/\n/g, " ");
}
