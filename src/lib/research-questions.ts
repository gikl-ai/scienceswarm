import * as fs from "node:fs/promises";
import path from "node:path";

/**
 * A research question extracted from a markdown document.
 *
 * Research questions are the structured, numbered (`RQ1:`, `RQ2a:`) variety
 * that typically live under a formal `## Research questions` section. This is
 * intentionally distinct from the loose "open questions" extractor in
 * {@link ../open-questions.ts} — that one handles unstructured trailing-`?`
 * prose anywhere in a doc, while this one expects formal identifiers.
 */
export interface ResearchQuestion {
  /** File path relative to the scanned root. */
  file: string;
  /** 1-indexed line number where the question was found. */
  line: number;
  /**
   * Identifier token for the question (e.g. `"RQ1"`, `"RQ2a"`). Empty string
   * when the question was extracted without a numbered prefix.
   */
  id: string;
  /** Question text with the `RQ\d+:` / `Research question:` prefix stripped. */
  text: string;
  /**
   * Heading text (e.g. `"## Research questions"`) when the question was found
   * inside a research-questions section. Undefined otherwise.
   */
  section?: string;
}

export interface ResearchQuestionScan {
  questions: ResearchQuestion[];
  scannedFiles: number;
  scannedAt: string;
}

const RQ_ID_PREFIX_RE = /^(RQ\d+[a-z]?)\s*:\s*(.*)$/;
const RQ_LABEL_PREFIX_RE = /^research\s+question\s*:\s*(.*)$/i;
const RESEARCH_QUESTIONS_HEADING_RE = /^##\s+research\s+questions\s*$/i;
const ANY_H2_HEADING_RE = /^##\s+/;
const ANY_H1_HEADING_RE = /^#\s+/;
const HEADING_LINE_RE = /^#{1,6}\s+/;
const FENCE_RE = /^```/;
const BULLET_LEAD_RE = /^[-*]\s+(.*)$/;

function stripBulletMarker(line: string): string {
  const match = line.match(BULLET_LEAD_RE);
  return match ? match[1] : line;
}

/**
 * Extract research questions from a single markdown document.
 *
 * Three forms are recognised:
 *   1. An explicit `RQ\d+[a-z]?:` prefix anywhere in the doc — the matched
 *      token (minus the colon) becomes `id`.
 *   2. A `Research question:` (case-insensitive) prefix — `id` is the empty
 *      string.
 *   3. Any line inside a `## Research questions` heading section (up to the
 *      next `## ` heading or EOF) that is either a bullet (`- ...`) or ends
 *      with `?`. `id` is empty unless the same line also matches form 1, in
 *      which case form 1 wins and its id is preserved.
 *
 * Fenced code blocks (``` ... ```) are skipped entirely. Duplicate
 * `(id, text)` pairs on the same line are deduplicated within a file.
 */
export function extractResearchQuestions(
  text: string,
  file: string,
): ResearchQuestion[] {
  const lines = text.split(/\r?\n/);
  const questions: ResearchQuestion[] = [];
  const seen = new Set<string>();

  let inFence = false;
  let currentSection: string | undefined;
  let inResearchQuestionsSection = false;

  function pushQuestion(q: ResearchQuestion): void {
    const key = `${q.line}::${q.id}::${q.text}`;
    if (seen.has(key)) return;
    seen.add(key);
    questions.push(q);
  }

  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i];
    const lineNo = i + 1;
    const trimmed = rawLine.trim();

    if (FENCE_RE.test(trimmed)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    if (HEADING_LINE_RE.test(trimmed)) {
      if (RESEARCH_QUESTIONS_HEADING_RE.test(trimmed)) {
        inResearchQuestionsSection = true;
        currentSection = trimmed;
      } else if (ANY_H1_HEADING_RE.test(trimmed) || ANY_H2_HEADING_RE.test(trimmed)) {
        inResearchQuestionsSection = false;
        currentSection = undefined;
      }
      // Headings themselves are never emitted as questions.
      continue;
    }

    if (!trimmed) continue;

    // Form 1 / Form 2 can appear inside a bullet too, so peel the bullet
    // marker off before probing for an id prefix.
    const debulleted = stripBulletMarker(trimmed);

    // Form 1: `RQ\d+[a-z]?: text` — id wins over the section-only rule.
    const idMatch = debulleted.match(RQ_ID_PREFIX_RE);
    if (idMatch) {
      const id = idMatch[1];
      const body = idMatch[2].trim();
      if (body) {
        pushQuestion({
          file,
          line: lineNo,
          id,
          text: body,
          ...(inResearchQuestionsSection && currentSection
            ? { section: currentSection }
            : {}),
        });
      }
      continue;
    }

    // Form 2: `Research question: text` — id is empty.
    const labelMatch = debulleted.match(RQ_LABEL_PREFIX_RE);
    if (labelMatch) {
      const body = labelMatch[1].trim();
      if (body) {
        pushQuestion({
          file,
          line: lineNo,
          id: "",
          text: body,
          ...(inResearchQuestionsSection && currentSection
            ? { section: currentSection }
            : {}),
        });
      }
      continue;
    }

    // Form 3: bullets and trailing-`?` lines inside the research-questions
    // section.
    if (inResearchQuestionsSection) {
      const bulletMatch = trimmed.match(BULLET_LEAD_RE);
      if (bulletMatch) {
        const body = bulletMatch[1].trim();
        if (body) {
          pushQuestion({
            file,
            line: lineNo,
            id: "",
            text: body,
            section: currentSection,
          });
        }
        continue;
      }
      if (trimmed.endsWith("?")) {
        pushQuestion({
          file,
          line: lineNo,
          id: "",
          text: trimmed,
          section: currentSection,
        });
      }
    }
  }

  return questions;
}

async function walkMarkdown(dir: string, files: string[]): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.name === "node_modules") continue;

    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkMarkdown(abs, files);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      files.push(abs);
    }
  }
}

/**
 * Recursively scan a directory for markdown files and extract research
 * questions from each one. Dotfiles, `node_modules`, and `.claude` are
 * skipped. A missing root returns an empty scan instead of throwing.
 */
export async function scanProjectResearchQuestions(
  root: string,
): Promise<ResearchQuestionScan> {
  const scannedAt = new Date().toISOString();

  let rootStat;
  try {
    rootStat = await fs.stat(root);
  } catch {
    return { questions: [], scannedFiles: 0, scannedAt };
  }

  const files: string[] = [];
  if (rootStat.isDirectory()) {
    await walkMarkdown(root, files);
    files.sort();
  } else if (rootStat.isFile() && root.toLowerCase().endsWith(".md")) {
    files.push(root);
  } else {
    return { questions: [], scannedFiles: 0, scannedAt };
  }

  const questions: ResearchQuestion[] = [];
  let scannedFiles = 0;
  for (const abs of files) {
    let text: string;
    try {
      text = await fs.readFile(abs, "utf-8");
    } catch {
      continue;
    }
    scannedFiles += 1;
    const rel = rootStat.isDirectory() ? path.relative(root, abs) : path.basename(abs);
    questions.push(...extractResearchQuestions(text, rel));
  }

  return {
    questions,
    scannedFiles,
    scannedAt,
  };
}
