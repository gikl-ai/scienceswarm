/**
 * Second Brain — Quick-Reply Actions for Briefings
 *
 * Enriches morning briefings with Telegram inline keyboard buttons
 * so scientists can act on briefing items without typing.
 *
 * Telegram callback_data limit: 64 bytes. We use compact JSON encoding
 * to stay within budget.
 */

import { existsSync, mkdirSync, writeFileSync, appendFileSync } from "fs";
import { join } from "path";
import { search } from "./search";
import { formatTelegramBrief } from "./research-briefing";
import type { BrainConfig, MorningBrief } from "./types";
import type { LLMClient } from "./llm";

// ── Types ────────────────────────────────────────────

export type BriefingAction =
  | { type: "save-paper"; arxivId?: string; doi?: string; title: string }
  | { type: "create-task"; title: string; project?: string }
  | { type: "show-evidence"; page: string }
  | { type: "dismiss-item"; itemId: string }
  | { type: "expand-item"; itemId: string }
  | { type: "ingest-paper"; source: string };

export interface BriefingWithActions {
  text: string;
  actions: Array<{
    label: string;
    callbackData: string;
  }>;
}

// ── Compact Serialization ────────────────────────────

/**
 * Encode an action into a compact callback_data string.
 * Telegram limit: 64 bytes. We use short keys and truncate titles.
 *
 * Format: JSON with single-char keys:
 *   t = type, n = title/name, a = arxivId, d = doi, p = project/page, s = source, i = itemId
 */
function encodeAction(action: BriefingAction): string {
  let encoded: string;

  switch (action.type) {
    case "save-paper":
      encoded = JSON.stringify({
        t: "sp",
        ...(action.arxivId ? { a: action.arxivId.slice(0, 20) } : {}),
        ...(action.doi ? { d: action.doi.slice(0, 20) } : {}),
        n: action.title.slice(0, 16),
      });
      break;
    case "create-task":
      encoded = JSON.stringify({
        t: "ct",
        n: action.title.slice(0, 30),
        ...(action.project ? { p: action.project.slice(0, 12) } : {}),
      });
      break;
    case "show-evidence":
      encoded = JSON.stringify({
        t: "se",
        p: action.page.slice(0, 40),
      });
      break;
    case "dismiss-item":
      encoded = JSON.stringify({
        t: "di",
        i: action.itemId.slice(0, 40),
      });
      break;
    case "expand-item":
      encoded = JSON.stringify({
        t: "ei",
        i: action.itemId.slice(0, 40),
      });
      break;
    case "ingest-paper":
      encoded = JSON.stringify({
        t: "ip",
        s: action.source.slice(0, 40),
      });
      break;
  }

  // Final safety truncation to 64 bytes
  const bytes = Buffer.byteLength(encoded, "utf-8");
  if (bytes <= 64) return encoded;

  // Progressively shrink until it fits
  let result = encoded;
  while (Buffer.byteLength(result, "utf-8") > 64 && result.length > 4) {
    result = result.slice(0, result.length - 2) + "}";
    // Re-parse and re-stringify to keep valid JSON
    try {
      const obj = JSON.parse(result);
      result = JSON.stringify(obj);
    } catch {
      // If parse fails, keep truncating
      result = result.slice(0, result.length - 1);
    }
  }
  return result;
}

/**
 * Decode a compact callback_data string back into a BriefingAction.
 */
export function decodeAction(callbackData: string): BriefingAction | null {
  try {
    const obj = JSON.parse(callbackData);
    switch (obj.t) {
      case "sp":
        return {
          type: "save-paper",
          title: obj.n ?? "",
          ...(obj.a ? { arxivId: obj.a } : {}),
          ...(obj.d ? { doi: obj.d } : {}),
        };
      case "ct":
        return {
          type: "create-task",
          title: obj.n ?? "",
          ...(obj.p ? { project: obj.p } : {}),
        };
      case "se":
        return { type: "show-evidence", page: obj.p ?? "" };
      case "di":
        return { type: "dismiss-item", itemId: obj.i ?? "" };
      case "ei":
        return { type: "expand-item", itemId: obj.i ?? "" };
      case "ip":
        return { type: "ingest-paper", source: obj.s ?? "" };
      default:
        return null;
    }
  } catch {
    return null;
  }
}

// ── Enrichment ───────────────────────────────────────

/**
 * Take a morning brief and add action buttons for Telegram inline keyboard.
 */
export function enrichBriefingWithActions(
  brief: MorningBrief,
): BriefingWithActions {
  const text = formatTelegramBrief(brief);
  const actions: BriefingWithActions["actions"] = [];

  // Frontier papers: "Save to brain" button
  for (const item of brief.frontier.slice(0, 3)) {
    const action: BriefingAction = {
      type: "save-paper",
      title: item.title,
    };
    actions.push({
      label: `Save: ${item.title.slice(0, 20)}`,
      callbackData: encodeAction(action),
    });
  }

  // Next-move recommendation: "Create task" button
  if (brief.nextMove.recommendation) {
    const action: BriefingAction = {
      type: "create-task",
      title: brief.nextMove.recommendation.slice(0, 60),
    };
    actions.push({
      label: "Create task: next move",
      callbackData: encodeAction(action),
    });
  }

  // Contradictions: "Show evidence" button
  for (const contradiction of brief.contradictions.slice(0, 2)) {
    const action: BriefingAction = {
      type: "show-evidence",
      page: contradiction.claim1.source,
    };
    actions.push({
      label: `Evidence: ${contradiction.claim1.summary.slice(0, 15)}`,
      callbackData: encodeAction(action),
    });
  }

  // Stale threads: "Dismiss" button
  for (const thread of brief.staleThreads.slice(0, 2)) {
    const action: BriefingAction = {
      type: "dismiss-item",
      itemId: thread.name.slice(0, 30),
    };
    actions.push({
      label: `Archive: ${thread.name.slice(0, 18)}`,
      callbackData: encodeAction(action),
    });
  }

  return { text, actions };
}

// ── Action Handlers ──────────────────────────────────

/**
 * Execute a briefing action and return a confirmation message.
 */
export async function handleBriefingAction(
  config: BrainConfig,
  _llm: LLMClient,
  action: BriefingAction,
): Promise<string> {
  switch (action.type) {
    case "save-paper":
      return handleSavePaper(config, action);
    case "create-task":
      return handleCreateTask(config, action);
    case "show-evidence":
      return handleShowEvidence(config, action);
    case "dismiss-item":
      return handleDismissItem(config, action);
    case "expand-item":
      return handleExpandItem(config, action);
    case "ingest-paper":
      return handleIngestPaper(config, action);
  }
}

async function handleSavePaper(
  config: BrainConfig,
  action: Extract<BriefingAction, { type: "save-paper" }>,
): Promise<string> {
  const slug = action.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 60);
  const date = new Date().toISOString().slice(0, 10);
  const dir = join(config.root, "wiki/entities/papers");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const frontmatter = [
    "---",
    `title: "${action.title.replace(/"/g, '\\"')}"`,
    `date: ${date}`,
    "type: paper",
    "para: resources",
    `tags: [saved-from-briefing]`,
    action.arxivId ? `arxiv: "${action.arxivId}"` : null,
    action.doi ? `doi: "${action.doi}"` : null,
    "---",
  ]
    .filter(Boolean)
    .join("\n");

  const content = `${frontmatter}\n\n# ${action.title}\n\nSaved from morning briefing on ${date}.\n`;
  const filePath = join(dir, `${slug}.md`);
  writeFileSync(filePath, content);

  return `Paper saved: ${action.title} -> ${filePath}`;
}

async function handleCreateTask(
  config: BrainConfig,
  action: Extract<BriefingAction, { type: "create-task" }>,
): Promise<string> {
  const slug = action.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 60);
  const date = new Date().toISOString().slice(0, 10);
  const dir = join(config.root, "wiki/tasks");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const frontmatter = [
    "---",
    `title: "${action.title.replace(/"/g, '\\"')}"`,
    `date: ${date}`,
    "type: task",
    "para: projects",
    "status: open",
    `tags: [from-briefing]`,
    action.project ? `project: "${action.project}"` : null,
    "---",
  ]
    .filter(Boolean)
    .join("\n");

  const content = `${frontmatter}\n\n# ${action.title}\n\nCreated from morning briefing on ${date}.\n`;
  const filePath = join(dir, `${slug}.md`);
  writeFileSync(filePath, content);

  return `Task created: ${action.title} -> ${filePath}`;
}

async function handleShowEvidence(
  config: BrainConfig,
  action: Extract<BriefingAction, { type: "show-evidence" }>,
): Promise<string> {
  const results = await search(config, {
    query: action.page,
    mode: "grep",
    limit: 5,
  });

  if (results.length === 0) {
    return `No evidence found for: ${action.page}`;
  }

  const lines = [`Evidence for: ${action.page}`, ""];
  for (const result of results.slice(0, 3)) {
    lines.push(`- ${result.title}: ${result.snippet}`);
  }
  return lines.join("\n");
}

async function handleDismissItem(
  config: BrainConfig,
  action: Extract<BriefingAction, { type: "dismiss-item" }>,
): Promise<string> {
  // Record dismissal in a state file for future briefings
  const stateDir = join(config.root, "state");
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });

  const dismissalsPath = join(stateDir, "dismissed-items.jsonl");
  const entry = JSON.stringify({
    itemId: action.itemId,
    dismissedAt: new Date().toISOString(),
  });
  appendFileSync(dismissalsPath, entry + "\n");

  return `Dismissed: ${action.itemId}`;
}

async function handleExpandItem(
  config: BrainConfig,
  action: Extract<BriefingAction, { type: "expand-item" }>,
): Promise<string> {
  const results = await search(config, {
    query: action.itemId,
    mode: "grep",
    limit: 5,
  });

  if (results.length === 0) {
    return `No additional details found for: ${action.itemId}`;
  }

  const lines = [`Details for: ${action.itemId}`, ""];
  for (const result of results.slice(0, 5)) {
    lines.push(`- ${result.title}: ${result.snippet}`);
  }
  return lines.join("\n");
}

async function handleIngestPaper(
  config: BrainConfig,
  action: Extract<BriefingAction, { type: "ingest-paper" }>,
): Promise<string> {
  // Create a placeholder page for the paper source; full ingest requires
  // the engine pipeline which depends on LLM calls.
  const slug = action.source
    .replace(/^https?:\/\//, "")
    .replace(/[^a-z0-9]+/gi, "-")
    .slice(0, 60)
    .toLowerCase();
  const date = new Date().toISOString().slice(0, 10);
  const dir = join(config.root, "raw/papers");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const content = [
    "---",
    `title: "Ingested from ${action.source.slice(0, 40)}"`,
    `date: ${date}`,
    "type: paper",
    "para: resources",
    "tags: [ingested-from-briefing]",
    `source: "${action.source}"`,
    "---",
    "",
    `# Source: ${action.source}`,
    "",
    `Queued for full ingestion on ${date}.`,
    "",
  ].join("\n");

  const filePath = join(dir, `${slug}.md`);
  writeFileSync(filePath, content);

  return `Paper queued for ingestion: ${action.source} -> ${filePath}`;
}
