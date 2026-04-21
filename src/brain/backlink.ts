/**
 * Second Brain — Iron Law Back-Linking
 *
 * gbrain iron law: every mention of an entity in any brain file
 * creates a back-link on the entity's page.
 *
 * An unlinked mention is a broken brain.
 *
 * Back-link format: - **YYYY-MM-DD** | Referenced in [page title](path) — context
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  statSync,
} from "fs";
import { join, relative } from "path";
import type { BrainConfig } from "./types";

// ── Public Types ─────────────────────────────────────

export interface BacklinkEntry {
  date: string;
  sourceTitle: string;
  sourcePath: string;
  context: string;
}

export interface BacklinkAuditResult {
  totalPages: number;
  totalWikilinks: number;
  missingBacklinks: Array<{
    sourcePage: string;
    targetPage: string;
    linkText: string;
  }>;
  healthScore: number; // 0-1, 1 = all backlinks present
}

// ── Core Functions ───────────────────────────────────

/**
 * Add a back-link entry to the entity page's timeline/references section.
 * Skips if an identical back-link already exists.
 *
 * Format: - **{date}** | Referenced in [{source title}]({mentionedIn}) — {context}
 */
export function ensureBacklinks(
  config: BrainConfig,
  entityPath: string,
  mentionedIn: string,
  context: string,
  date: string
): void {
  const absPath = join(config.root, entityPath);
  if (!existsSync(absPath)) return;

  const content = readFileSync(absPath, "utf-8");

  // Check if this exact back-link already exists
  const backlinkPattern = `Referenced in [`;
  if (content.includes(mentionedIn) && content.includes(backlinkPattern)) {
    // More precise check: does this specific source already have a backlink?
    const escapedPath = mentionedIn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const existingPattern = new RegExp(
      `Referenced in \\[.*?\\]\\(${escapedPath}\\)`
    );
    if (existingPattern.test(content)) return; // Already linked
  }

  // Extract source title from the mentionedIn path
  const sourceTitle = extractTitleFromPath(mentionedIn);

  // Build the back-link entry
  const entry = `- **${date}** | Referenced in [${sourceTitle}](${mentionedIn}) — ${context}`;

  // Find or create a references/timeline section
  const sectionHeader = findBacklinkSection(content);
  if (sectionHeader) {
    const idx = content.indexOf(sectionHeader);
    const afterHeader = content.indexOf("\n", idx) + 1;
    const nextSection = content.indexOf("\n## ", afterHeader);
    const insertAt = nextSection === -1 ? content.length : nextSection;

    const updated =
      content.slice(0, insertAt).trimEnd() +
      "\n" +
      entry +
      "\n" +
      content.slice(insertAt);
    writeFileSync(absPath, updated);
  } else {
    // Append a new References section
    const section = `\n\n## References\n\n${entry}\n`;
    writeFileSync(absPath, content.trimEnd() + section);
  }
}

/**
 * Audit all brain pages for missing back-links.
 * For each [[wikilink]] found, checks if the target has a back-link to the source.
 *
 * Used by dream cycle for maintenance.
 */
export function auditBacklinks(config: BrainConfig): BacklinkAuditResult {
  const wikiDir = join(config.root, "wiki");
  if (!existsSync(wikiDir)) {
    return { totalPages: 0, totalWikilinks: 0, missingBacklinks: [], healthScore: 1 };
  }

  const allPages = collectMarkdownFiles(wikiDir);
  const wikilinkPattern = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;

  let totalWikilinks = 0;
  const missingBacklinks: BacklinkAuditResult["missingBacklinks"] = [];

  for (const absSourcePath of allPages) {
    const relSourcePath = `wiki/${relative(wikiDir, absSourcePath)}`;
    const content = readFileSync(absSourcePath, "utf-8");

    for (const match of content.matchAll(wikilinkPattern)) {
      totalWikilinks++;
      const target = match[1];

      // Normalize target path
      let targetPath = target;
      if (!targetPath.startsWith("wiki/")) {
        targetPath = `wiki/${targetPath}`;
      }
      if (!targetPath.endsWith(".md")) {
        targetPath += ".md";
      }

      const absTargetPath = join(config.root, targetPath);
      if (!existsSync(absTargetPath)) continue; // Target doesn't exist

      // Check if target has a back-link to source
      const targetContent = readFileSync(absTargetPath, "utf-8");
      if (!targetContent.includes(relSourcePath)) {
        missingBacklinks.push({
          sourcePage: relSourcePath,
          targetPage: targetPath,
          linkText: match[0],
        });
      }
    }
  }

  const healthScore =
    totalWikilinks === 0
      ? 1
      : 1 - missingBacklinks.length / totalWikilinks;

  return {
    totalPages: allPages.length,
    totalWikilinks,
    missingBacklinks,
    healthScore: Math.max(0, Math.min(1, healthScore)),
  };
}

// ── Helpers ──────────────────────────────────────────

/**
 * Find the best section header to insert back-links under.
 */
function findBacklinkSection(content: string): string | null {
  const candidates = [
    "## References",
    "## Timeline",
    "## Back-links",
    "## Backlinks",
    "## Mentions",
  ];

  for (const header of candidates) {
    if (content.includes(header)) return header;
  }

  return null;
}

/**
 * Extract a human-readable title from a brain path.
 */
function extractTitleFromPath(path: string): string {
  const filename = path.split("/").pop() ?? path;
  return filename
    .replace(/\.md$/, "")
    .replace(/[-_]/g, " ")
    .replace(/^\d{4}-\d{2}-\d{2}\s*/, ""); // strip date prefix
}

function collectMarkdownFiles(dir: string): string[] {
  const files: string[] = [];
  const entries = readdirSync(dir);
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      files.push(...collectMarkdownFiles(fullPath));
    } else if (entry.endsWith(".md")) {
      files.push(fullPath);
    }
  }
  return files;
}
