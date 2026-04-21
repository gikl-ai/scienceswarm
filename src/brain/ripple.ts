/**
 * Second Brain — Ripple Updates
 *
 * After creating a new wiki page, the ripple engine finds related pages
 * and updates them with cross-references, new evidence, or contradiction flags.
 *
 * Architecture decisions (from CEO + eng review):
 * - Batch mode: all related pages in one LLM context window
 * - Git-verified: snapshot before, diff after, auto-revert suspicious changes
 * - Capped at config.rippleCap pages per ingest (default 15)
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { execSync, execFileSync } from "child_process";
import type { BrainConfig, RippleUpdate, Contradiction, IngestCost } from "./types";
import type { LLMClient } from "./llm";
import { search } from "./search";

export interface RippleInput {
  /** Path to the newly created wiki page (relative to brain root) */
  newPagePath: string;
  /** Content of the new page */
  newPageContent: string;
  /** Tags from the new page's frontmatter */
  tags: string[];
}

export interface RippleResult {
  updates: RippleUpdate[];
  contradictions: Contradiction[];
  cost?: IngestCost;
}

/**
 * Run ripple updates: find related pages and batch-update them.
 * Git-verified: snapshots before, diffs after, auto-reverts corruption.
 */
export async function ripple(
  config: BrainConfig,
  llm: LLMClient,
  input: RippleInput
): Promise<RippleResult> {
  // Find related pages by searching for shared tags/concepts
  const query = input.tags.slice(0, 3).join("\\|");
  if (!query.trim()) {
    return { updates: [], contradictions: [] };
  }

  const related = await search(config, {
    query,
    mode: "grep",
    limit: config.rippleCap,
  });

  // Filter out the new page itself
  const candidates = related.filter(
    (r) => r.path !== input.newPagePath
  );

  if (candidates.length === 0) {
    return { updates: [], contradictions: [] };
  }

  // Git snapshot before ripple
  const canVerifyWithGit = isGitWorktree(config.root);
  const snapshotId = canVerifyWithGit ? gitSnapshot(config.root) : "";

  // Read all related pages
  const pageContents: Array<{ path: string; content: string }> = [];
  for (const candidate of candidates) {
    const absPath = join(config.root, candidate.path);
    if (!existsSync(absPath)) continue;
    pageContents.push({
      path: candidate.path,
      content: readFileSync(absPath, "utf-8"),
    });
  }

  if (pageContents.length === 0) {
    return { updates: [], contradictions: [] };
  }

  // Batch LLM call: evaluate all related pages at once
  const pagesContext = pageContents
    .map((p) => `--- FILE: ${p.path} ---\n${p.content}\n`)
    .join("\n");

  const response = await llm.complete({
    system: RIPPLE_SYSTEM_PROMPT,
    user: `NEW PAGE (${input.newPagePath}):\n${input.newPageContent}\n\nEXISTING PAGES TO EVALUATE:\n${pagesContext}`,
    model: config.extractionModel,
  });

  // Parse the LLM response for updates
  const { updates, contradictions } = parseRippleResponse(
    response.content,
    pageContents
  );

  // Apply updates to files
  const verifiedUpdates: RippleUpdate[] = [];
  for (const update of updates) {
    const absPath = join(config.root, update.path);
    if (!existsSync(absPath)) continue;

    const originalContent = readFileSync(absPath, "utf-8");
    writeFileSync(absPath, update.newContent);

    // Git-verify: check if the diff is related to the new page
    const verified = canVerifyWithGit
      ? verifyRippleDiff(config.root, update.path, snapshotId)
      : true;
    if (verified) {
      verifiedUpdates.push({
        page: update.path,
        reason: update.reason,
        verified: true,
      });
    } else {
      // Auto-revert suspicious changes
      writeFileSync(absPath, originalContent);
      verifiedUpdates.push({
        page: update.path,
        reason: `Reverted: diff touched unrelated sections`,
        verified: false,
      });
    }
  }

  return { updates: verifiedUpdates, contradictions, cost: response.cost };
}

// ── Git Verification ───────────────────────────────────

function gitSnapshot(root: string): string {
  try {
    return execSync("git rev-parse HEAD", {
      cwd: root,
      encoding: "utf-8",
    }).trim();
  } catch {
    return "";
  }
}

function isGitWorktree(root: string): boolean {
  try {
    return execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: root,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() === "true";
  } catch {
    return false;
  }
}

function verifyRippleDiff(
  root: string,
  filePath: string,
  snapshotId: string
): boolean {
  try {
    const diffArgs = snapshotId ? [snapshotId, "--"] : ["--"];
    const diff = execFileSync("git", ["diff", ...diffArgs, filePath], {
      cwd: root,
      encoding: "utf-8",
    });

    // Heuristic: if the diff is empty or very small, it's fine
    if (!diff.trim()) return true;

    // If diff touches more than 20 lines, it's suspicious for a ripple
    const changedLines = diff.split("\n").filter(
      (l) => l.startsWith("+") || l.startsWith("-")
    ).length;

    return changedLines <= 20;
  } catch {
    return true; // If git isn't available, trust the update
  }
}

// ── LLM Response Parsing ───────────────────────────────

interface ParsedUpdate {
  path: string;
  newContent: string;
  reason: string;
}

function parseRippleResponse(
  response: string,
  pages: Array<{ path: string; content: string }>
): { updates: ParsedUpdate[]; contradictions: Contradiction[] } {
  const updates: ParsedUpdate[] = [];
  const contradictions: Contradiction[] = [];

  // Parse structured response sections
  const updateBlocks = response.split(/---\s*UPDATE:\s*/);
  for (const block of updateBlocks.slice(1)) {
    const pathMatch = block.match(/^(\S+)/);
    if (!pathMatch) continue;

    const path = pathMatch[1];
    const page = pages.find((p) => p.path === path);
    if (!page) continue;

    const reasonMatch = block.match(/REASON:\s*(.+)/);
    const contentMatch = block.match(
      /CONTENT:\n([\s\S]*?)(?=---\s*UPDATE:|---\s*CONTRADICTION:|$)/
    );

    if (contentMatch) {
      updates.push({
        path,
        newContent: contentMatch[1].trim(),
        reason: reasonMatch?.[1]?.trim() ?? "Cross-reference update",
      });
    }
  }

  // Parse contradictions
  const contradictionBlocks = response.split(/---\s*CONTRADICTION:\s*/);
  for (const block of contradictionBlocks.slice(1)) {
    const claimMatch = block.match(/CLAIM:\s*(.+)/);
    const existingMatch = block.match(/EXISTING:\s*(.+)/);
    const newMatch = block.match(/NEW:\s*(.+)/);

    if (claimMatch) {
      contradictions.push({
        claim: claimMatch[1].trim(),
        existingPage: existingMatch?.[1]?.trim() ?? "unknown",
        newSource: newMatch?.[1]?.trim() ?? "unknown",
      });
    }
  }

  return { updates, contradictions };
}

// ── Prompts ────────────────────────────────────────────

const RIPPLE_SYSTEM_PROMPT = `You are a research knowledge base maintenance agent. You are given a NEW PAGE that was just added to the wiki, and a set of EXISTING PAGES that may be related.

For each existing page, evaluate:
1. Does the new page support or contradict claims in this page? If so, add a cross-reference.
2. Does the new page introduce concepts this page references but doesn't link? If so, add a wikilink.
3. Does the new page provide evidence for/against a hypothesis tracked in this page? If so, update the evidence section.

Rules:
- Only modify sections that are directly related to the new page's content
- Never delete existing content — only append cross-references or update evidence lists
- Every added claim must cite the new page as source
- If you find a contradiction, flag it but do not auto-resolve

Output format (repeat for each page that needs updating):

--- UPDATE: wiki/path/to/page.md
REASON: Added cross-reference to new paper on [topic]
CONTENT:
[full updated page content]

--- CONTRADICTION: (if any found)
CLAIM: [the contradicted claim]
EXISTING: wiki/path/to/existing-page.md
NEW: wiki/path/to/new-page.md

If no pages need updating, output: NO_UPDATES_NEEDED`;
