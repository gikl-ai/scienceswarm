/**
 * Second Brain — Automatic Task Extraction
 *
 * Detects task-like patterns in scientist captures and creates
 * task wiki pages automatically. Uses fast regex path (no LLM needed).
 *
 * Patterns detected:
 * - Explicit markers: TODO, FIXME, "remind me to"
 * - Implicit intent: "need to", "should", "have to", "must"
 * - Scientific tasks: "test whether", "check if", "verify that", "compare X and Y"
 * - Relative dates: "by Friday", "by next week", "before the deadline"
 */

import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { randomBytes } from "crypto";
import matter from "gray-matter";
import type { BrainConfig, Confidence } from "./types";
import { getCurrentUserHandle } from "@/lib/setup/gbrain-installer";
import { resolvePgliteDatabasePath } from "@/lib/capture/materialize-memory";
import { createRuntimeEngine } from "./stores/gbrain-runtime.mjs";
import { chunkText } from "./stores/gbrain-chunker";

// ── Types ─────────────────────────────────────────────

export interface ExtractedTask {
  title: string;
  description: string;
  project: string | null;
  dueDate: string | null;
  priority: "high" | "medium" | "low";
  sourceCapture: string;
  confidence: Confidence;
}

// ── Task Pattern Definitions ──────────────────────────

interface TaskPattern {
  regex: RegExp;
  confidence: Confidence;
  priority: "high" | "medium" | "low";
  /** Extract meaningful title from the match */
  titleExtractor: (match: RegExpMatchArray) => string;
}

const TASK_PATTERNS: TaskPattern[] = [
  // Explicit markers — high confidence
  {
    regex: /\bTODO:\s*(.+?)(?:\.|$)/gim,
    confidence: "high",
    priority: "high",
    titleExtractor: (m) => m[1].trim(),
  },
  {
    regex: /\bFIXME:\s*(.+?)(?:\.|$)/gim,
    confidence: "high",
    priority: "high",
    titleExtractor: (m) => m[1].trim(),
  },
  {
    regex: /\bremind me to\s+(.+?)(?:\.|$)/gim,
    confidence: "high",
    priority: "medium",
    titleExtractor: (m) => m[1].trim(),
  },
  {
    regex: /\bdon'?t forget to\s+(.+?)(?:\.|$)/gim,
    confidence: "high",
    priority: "medium",
    titleExtractor: (m) => m[1].trim(),
  },

  // Scientific tasks — medium confidence
  {
    regex: /\btest whether\s+(.+?)(?:\.|$)/gim,
    confidence: "medium",
    priority: "medium",
    titleExtractor: (m) => `Test whether ${m[1].trim()}`,
  },
  {
    regex: /\bcheck if\s+(.+?)(?:\.|$)/gim,
    confidence: "medium",
    priority: "medium",
    titleExtractor: (m) => `Check if ${m[1].trim()}`,
  },
  {
    regex: /\bverify that\s+(.+?)(?:\.|$)/gim,
    confidence: "medium",
    priority: "medium",
    titleExtractor: (m) => `Verify that ${m[1].trim()}`,
  },
  {
    regex: /\bcompare\s+(.+?)\s+and\s+(.+?)(?:\.|$)/gim,
    confidence: "medium",
    priority: "medium",
    titleExtractor: (m) => `Compare ${m[1].trim()} and ${m[2].trim()}`,
  },

  // Implicit intent — medium confidence
  {
    regex: /\b(?:we\s+)?need to\s+(.+?)(?:\.|$)/gim,
    confidence: "medium",
    priority: "medium",
    titleExtractor: (m) => m[1].trim(),
  },
  {
    regex: /\b(?:we\s+)?must\s+(.+?)(?:\.|$)/gim,
    confidence: "medium",
    priority: "high",
    titleExtractor: (m) => m[1].trim(),
  },
  {
    regex: /\b(?:we\s+)?have to\s+(.+?)(?:\.|$)/gim,
    confidence: "medium",
    priority: "medium",
    titleExtractor: (m) => m[1].trim(),
  },
  {
    regex: /\b(?:we\s+)?should\s+(?!have\b|be\b|not\b)(.+?)(?:\.|$)/gim,
    confidence: "medium",
    priority: "low",
    titleExtractor: (m) => m[1].trim(),
  },
];

// ── Due Date Resolution ───────────────────────────────

// Due-date cues. Accept "by <X>", "on <X>", "next <X>", "this <X>", or a
// bare weekday preceded by a common temporal preposition. Scientists write
// "remind me to X next Tuesday" far more often than "by Tuesday".
const DUE_DATE_PATTERNS: Array<{
  regex: RegExp;
  resolver: (match: RegExpMatchArray, referenceDate: Date) => Date;
}> = [
  {
    regex:
      /\b(?:by|on|this|next)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
    resolver: (match, ref) => resolveNextWeekday(match[1], ref),
  },
  {
    regex: /\bnext\s+week\b/i,
    resolver: (_match, ref) => {
      const d = new Date(ref);
      d.setDate(d.getDate() + (7 - d.getDay() + 1));
      return d;
    },
  },
  {
    regex: /\b(?:by\s+)?end\s+of\s+(?:the\s+)?week\b/i,
    resolver: (_match, ref) => {
      const d = new Date(ref);
      const daysUntilFriday = (5 - d.getDay() + 7) % 7 || 7;
      d.setDate(d.getDate() + daysUntilFriday);
      return d;
    },
  },
  {
    regex: /\b(?:by\s+)?tomorrow\b/i,
    resolver: (_match, ref) => {
      const d = new Date(ref);
      d.setDate(d.getDate() + 1);
      return d;
    },
  },
  {
    regex: /\bnext\s+month\b/i,
    resolver: (_match, ref) => {
      const d = new Date(ref);
      d.setMonth(d.getMonth() + 1, 1);
      return d;
    },
  },
  {
    regex: /\b(?:by|on)\s+(\d{4}-\d{2}-\d{2})\b/,
    resolver: (match) => new Date(match[1]),
  },
];

function resolveNextWeekday(dayName: string, reference: Date): Date {
  const dayMap: Record<string, number> = {
    sunday: 0,
    monday: 1,
    tuesday: 2,
    wednesday: 3,
    thursday: 4,
    friday: 5,
    saturday: 6,
  };
  const target = dayMap[dayName.toLowerCase()];
  if (target === undefined) return reference;

  const d = new Date(reference);
  const current = d.getDay();
  const daysAhead = (target - current + 7) % 7 || 7;
  d.setDate(d.getDate() + daysAhead);
  return d;
}

function resolveDueDate(content: string, referenceDate?: Date): string | null {
  const ref = referenceDate ?? new Date();
  for (const { regex, resolver } of DUE_DATE_PATTERNS) {
    const match = content.match(regex);
    if (match) {
      const resolved = resolver(match, ref);
      return resolved.toISOString().slice(0, 10);
    }
  }
  return null;
}

// ── Extraction ────────────────────────────────────────

/**
 * Extract tasks from content using fast regex matching.
 * No LLM calls — purely deterministic.
 */
export function extractTasks(
  content: string,
  options?: { project?: string; referenceDate?: Date },
): ExtractedTask[] {
  const tasks: ExtractedTask[] = [];
  const seenTitles = new Set<string>();

  for (const pattern of TASK_PATTERNS) {
    // Reset the regex lastIndex for global patterns
    pattern.regex.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = pattern.regex.exec(content)) !== null) {
      const rawTitle = pattern.titleExtractor(match);

      // Skip very short or empty extractions
      if (rawTitle.length < 5) continue;

      // Normalize title for deduplication
      const titleKey = rawTitle.toLowerCase().trim();
      if (seenTitles.has(titleKey)) continue;
      seenTitles.add(titleKey);

      const title = truncateAtWord(rawTitle, 80);

      const context = extractContext(content, match.index);

      tasks.push({
        title: capitalizeFirst(title),
        description: context,
        project: options?.project ?? null,
        dueDate: resolveDueDate(context, options?.referenceDate),
        priority: pattern.priority,
        sourceCapture: "",
        confidence: pattern.confidence,
      });
    }
  }

  return tasks;
}

// ── Task Page Creation ────────────────────────────────

/**
 * Create task pages for extracted tasks with confidence >= medium.
 *
 * Track C.2 migration: this writer now emits into gbrain via
 * `engine.putPage` + `engine.upsertChunks` (wrapped in a transaction
 * so search sees the page on the next keyword query) AND still writes
 * a disk mirror at `<brainRoot>/wiki/tasks/<slug>.md` so briefing.ts's
 * disk-backed `loadPage` keeps finding the tasks while the remaining
 * downstream readers migrate in Track C.3.
 *
 * Attribution: every task write threads `getCurrentUserHandle()` into
 * the gbrain frontmatter (`captured_by`) so the multi-user story from
 * the spec stays intact. `getCurrentUserHandle()` throws loudly when
 * `SCIENCESWARM_USER_HANDLE` is unset — we catch the throw and fall
 * back to disk-only so legacy callers that never set the env var (the
 * legacy capture pipeline tests) do not start failing mid-flight.
 *
 * Returns the array of pseudo-paths stored in the project manifest so
 * `buildProjectBrief` / briefing callers keep receiving stable
 * identifiers.
 */
export async function createTaskPages(
  config: BrainConfig,
  tasks: ExtractedTask[],
): Promise<string[]> {
  const createdPaths: string[] = [];
  const taskDir = join(config.root, "wiki/tasks");
  mkdirSync(taskDir, { recursive: true });

  const qualifiedTasks = tasks.filter(
    (t) => t.confidence === "high" || t.confidence === "medium",
  );

  // Resolve the ScienceSwarm user handle once per batch. If unset we
  // degrade to disk-only writes — this mirrors how the legacy tests
  // exercised task extraction without attribution env vars set, and
  // preserves the `gbrain-installer.ts` attribution contract (we never
  // write an unattributed row to gbrain).
  let userHandle: string | null = null;
  try {
    userHandle = getCurrentUserHandle();
  } catch {
    userHandle = null;
  }

  // Resolve a shared gbrain engine for the whole batch so we pay the
  // connect cost once per capture-fanout. We only connect when we have
  // a user handle to attribute the write — unattributed gbrain writes
  // violate the attribution contract, so when `userHandle` is null we
  // fall back to disk-only and leave the gbrain engine disconnected.
  let engine: RuntimeEngineLike | null = null;
  if (userHandle) {
    try {
      engine = await connectEngineForTaskWrite(config.root);
    } catch {
      engine = null;
    }
  }

  try {
    for (const task of qualifiedTasks) {
      const slug = slugify(task.title);
      const date = new Date().toISOString().slice(0, 10);
      const suffix = randomBytes(4).toString("hex");
      const fileName = `${date}-${slug}-${suffix}.md`;
      const wikiPath = `wiki/tasks/${fileName}`;
      const pageSlug = `${date}-${slug}-${suffix}`;

      const frontmatter: Record<string, unknown> = {
        title: task.title,
        date,
        type: "task",
        para: task.project ? "projects" : "resources",
        tags: [],
        status: "open",
        priority: task.priority,
        confidence: task.confidence,
        source_refs: task.sourceCapture
          ? [{ kind: "capture", ref: task.sourceCapture }]
          : [],
      };

      if (task.project) {
        frontmatter.study = task.project;
        frontmatter.study_slug = task.project;
        frontmatter.legacy_project_slug = task.project;
      }
      if (task.dueDate) {
        frontmatter.due_date = task.dueDate;
      }
      if (userHandle) {
        frontmatter.captured_by = userHandle;
      }

      const body = [
        `# ${task.title}`,
        "",
        "## Description",
        task.description,
        "",
        task.sourceCapture
          ? `## Source\nExtracted from: [[${task.sourceCapture}]]`
          : null,
        "",
        task.dueDate ? `## Due Date\n${task.dueDate}` : null,
      ]
        .filter((line): line is string => line !== null)
        .join("\n");

      // Disk mirror — still load-bearing for briefing.ts until the
      // downstream migration in Track C.3 is complete.
      const page = matter.stringify(body, frontmatter);
      writeFileSync(join(config.root, wikiPath), page);
      createdPaths.push(wikiPath);

      // gbrain write — wraps putPage + upsertChunks in a transaction
      // (same pattern seedBrainPage / importCorpus use) so keyword
      // search surfaces the page on the next query. We gate on
      // `userHandle` as well as `engine` so the attribution contract
      // is enforced at the write site, not just at connect time.
      if (engine && userHandle) {
        try {
          const chunks: Array<{
            chunk_index: number;
            chunk_text: string;
            chunk_source: "compiled_truth" | "timeline";
          }> = [];
          let chunkIndex = 0;
          for (const chunk of chunkText(body)) {
            chunks.push({
              chunk_index: chunkIndex,
              chunk_text: chunk.text,
              chunk_source: "compiled_truth",
            });
            chunkIndex += 1;
          }

          await engine.transaction(async (tx) => {
            await tx.putPage(pageSlug, {
              type: "task",
              title: task.title,
              compiled_truth: body,
              timeline: "",
              frontmatter,
            });
            if (chunks.length > 0) {
              await tx.upsertChunks(pageSlug, chunks);
            }
          });
        } catch {
          // Best-effort: task extraction must not fail the capture.
          // Disk mirror is still in place so briefing.ts keeps working.
        }
      }
    }
  } finally {
    if (engine) {
      try {
        await engine.disconnect();
      } catch {
        // Non-fatal.
      }
    }
  }

  return createdPaths;
}

// ── gbrain engine bridge ─────────────────────────────
//
// Narrow structural shape of the gbrain BrainEngine surface used by
// the task writer. Kept inline (not imported from gbrain) so drift in
// gbrain's exported types does not silently change expectations —
// `tests/integration/gbrain-contract.test.ts` is the canonical pin.

interface RuntimeEngineLike {
  connect(config: { engine: "pglite"; database_path: string }): Promise<void>;
  disconnect(): Promise<void>;
  initSchema(): Promise<void>;
  transaction<T>(fn: (tx: RuntimeEngineLike) => Promise<T>): Promise<T>;
  putPage(
    slug: string,
    page: {
      type: string;
      title: string;
      compiled_truth: string;
      timeline?: string;
      frontmatter?: Record<string, unknown>;
      content_hash?: string;
    },
  ): Promise<unknown>;
  upsertChunks(
    slug: string,
    chunks: Array<{
      chunk_index: number;
      chunk_text: string;
      chunk_source: "compiled_truth" | "timeline";
    }>,
  ): Promise<void>;
}

async function connectEngineForTaskWrite(
  brainRoot: string,
): Promise<RuntimeEngineLike> {
  const databasePath = resolvePgliteDatabasePath(brainRoot);
  const engine = (await createRuntimeEngine({
    engine: "pglite",
    database_path: databasePath,
  })) as RuntimeEngineLike;
  await engine.connect({ engine: "pglite", database_path: databasePath });
  await engine.initSchema();
  return engine;
}

// ── Helpers ───────────────────────────────────────────

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || "task";
}

function capitalizeFirst(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Extract the sentence containing the match position.
 * Uses period-based sentence boundaries so due dates in neighboring
 * sentences do not bleed into unrelated tasks.
 */
function extractContext(
  content: string,
  matchIndex: number,
): string {
  // Find the start of the sentence (after the previous period, or start of string)
  const searchStart = Math.max(0, matchIndex - 1);
  const prevPeriod = content.lastIndexOf(".", searchStart);
  const sentenceStart = prevPeriod === -1 ? 0 : prevPeriod + 1;

  // Find the end of the sentence (the period that ends the matched clause)
  // Look for a period starting from the match start (not match end), since
  // the regex match itself may already include the trailing period.
  const nextPeriod = content.indexOf(".", matchIndex);
  const sentenceEnd =
    nextPeriod === -1 ? content.length : nextPeriod + 1;

  const context = content.slice(sentenceStart, sentenceEnd).trim();
  return truncateAtWord(context, 300);
}

function truncateAtWord(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const slice = value.slice(0, maxChars);
  const lastSpace = slice.lastIndexOf(" ");
  return lastSpace > maxChars / 2 ? slice.slice(0, lastSpace).trimEnd() : slice;
}
