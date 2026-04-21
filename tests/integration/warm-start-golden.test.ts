/**
 * Warm-start golden corpus — messy grad student archetype.
 *
 * Purpose (Spec 5 of docs/testing/POST_PIVOT_TEST_PLAN.md):
 * catch classifier drift and silent mis-filing on realistic scientist
 * corpora. Drops a curated ~30-file "messy grad student" corpus through
 * `scanCorpus` + `approveAndImport` and asserts the filing matches a
 * golden manifest pinned at
 * `tests/fixtures/real-corpora/messy-grad-student/expected-filing.json`.
 *
 * The manifest pins three invariants:
 *   1. Scanner bucket counts (paper/note/experiment/data) on a corpus
 *      whose content we control. If the classifier drifts, the counts
 *      move and the test fails with a pointer to the drift.
 *   2. For every expected wiki page, the writer actually created a
 *      markdown file matching a pattern we compute from the source
 *      filename + today's date + the writer's slug derivation
 *      (`[^a-z0-9]+ -> -`, slice 60). This is where slug collisions
 *      from unicode filenames would show up as missing pages.
 *   3. Duplicate suppression: the fixture contains a byte-identical copy
 *      of `watson-crick-1953.md` under a different filename. When the
 *      preview is imported with `skipDuplicates: true`, the scanner's
 *      content-hash grouping must route it to the `skipped` bucket
 *      rather than overwriting the first copy.
 *
 * Edge cases the corpus exercises (triage-guide sources):
 *   - `empty.md` (zero-byte)       — must be filtered by the scanner
 *     (`stat.size === 0` guard) and never reach the preview/importer.
 *   - `corrupt-binary.md`          — non-UTF8 bytes in a `.md` extension.
 *     The writer's `readFileSync(..., "utf-8")` will mangle them; the
 *     test requires that this does NOT crash `approveAndImport` and
 *     still produces a fallback page.
 *   - `notes-☃.md`, `résumé-ideas.md`
 *                                  — unicode filenames. The writer's
 *     slug derivation strips non-`[a-z0-9]` runs to `-`, so these must
 *     land at deterministic slug paths without colliding with real
 *     research notes.
 *   - `Untitled 1.md`              — space in the filename, Finder-style.
 *     Slug becomes `untitled-1`. No inbox routing exists in the
 *     current coldstart surface — every note lands under
 *     `wiki/resources/`. The test asserts the expected final path.
 *   - `large-dump.md` (~95 KB)     — size-tier check. Must process
 *     without truncation or OOM. (Not the 10 MB tier the plan mentions —
 *     deliberately kept under the fixture-size budget.)
 *   - `shannon-1948-information-theory.pdf`
 *                                  — minimal valid PDF to exercise the
 *     paper-routing path via `createPaperPageFromPdf` fallback.
 *     (Docling conversion is expected to fail in a test environment;
 *     the filename-only stub page must still land under
 *     `wiki/entities/papers/`.)
 *
 * Deliberate substitutions vs. the original plan:
 *   - PDFs -> 15 markdown research notes. PDFs are binary and bloat the
 *     repo; coldstart handles markdown natively through the text
 *     pipeline. One tiny valid PDF is retained as an edge case.
 *   - "10 MB file" -> ~95 KB dump. Keeps the fixture small while still
 *     testing a distinct size tier.
 *   - "inbox routing" -> asserts the deterministic `wiki/resources/`
 *     path that the current writer actually uses. No inbox dir exists
 *     in the current writer surface.
 *
 * If an assertion here fails, first question: did a real bug just
 * surface (triage per the spec: mis-filing = fix classifier, crash =
 * fix writer, slug collision = HIGH severity)? If the classifier drift
 * is intentional, update `expected-filing.json` in the same commit and
 * leave a git log entry explaining why.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { scanCorpus, approveAndImport } from "@/brain/coldstart";
import type { BrainConfig, ImportPreview } from "@/brain/types";
import type { LLMClient, LLMResponse } from "@/brain/llm";

const CORPUS_FIXTURES = join(
  __dirname,
  "..",
  "fixtures",
  "real-corpora",
  "messy-grad-student",
);
const MANIFEST_PATH = join(CORPUS_FIXTURES, "expected-filing.json");

interface ExpectedPage {
  source_filename: string;
  kind: "text" | "pdf" | "ipynb";
  wiki_dir: string;
  slug: string;
  required_title_substring?: string;
}

interface ExpectedManifest {
  total_files_on_disk: number;
  expected_scanner_files: number;
  expected_scanner_bucket_counts: Record<string, number>;
  skipped_by_scanner: string[];
  expected_pages: ExpectedPage[];
  expected_duplicate_source_filenames: string[];
  expected_duplicate_skip_count: number;
}

const EXPECTED: ExpectedManifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"));

function newId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

let corpusDir: string;
let brainRoot: string;

beforeEach(() => {
  const id = newId();
  corpusDir = join(tmpdir(), `golden-corpus-${id}`);
  brainRoot = join(tmpdir(), `golden-brain-${id}`);
  mkdirSync(corpusDir, { recursive: true });
  mkdirSync(brainRoot, { recursive: true });
  cpSync(CORPUS_FIXTURES, corpusDir, { recursive: true });
  // Remove the manifest from the isolated corpus copy so the scanner
  // does not treat it as a data file and inflate the bucket counts.
  const manifestInCopy = join(corpusDir, "expected-filing.json");
  if (existsSync(manifestInCopy)) rmSync(manifestInCopy);
});

afterEach(() => {
  for (const d of [corpusDir, brainRoot]) {
    if (existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
});

function makeConfig(): BrainConfig {
  return {
    root: brainRoot,
    extractionModel: "test-extraction",
    synthesisModel: "test-synthesis",
    rippleCap: 5,
    paperWatchBudget: 10,
    serendipityRate: 0.1,
  };
}

/**
 * Deterministic mock LLM. The writer's `createWikiPageFromText` calls
 * the extraction model and then runs `ensureFrontmatter` over the
 * response, so we return a minimal markdown body that will survive
 * that transform. Briefing calls return JSON.
 */
function makeMockLLM(): LLMClient {
  return {
    async complete(call): Promise<LLMResponse> {
      const cost = {
        inputTokens: 10,
        outputTokens: 10,
        estimatedUsd: 0.0001,
        model: "test",
      };
      if (
        call.system.includes("research assistant analyzing") ||
        call.system.includes("coldstart") ||
        call.system.includes("briefing")
      ) {
        return {
          content: JSON.stringify({
            activeThreads: [],
            stalledThreads: [],
            centralPapers: [],
            suggestedQuestions: [],
          }),
          cost,
        };
      }
      return {
        content: "---\ntitle: \"Mock extraction\"\n---\n\n# Mock extraction\n\nbody\n",
        cost,
      };
    },
  };
}

function listMd(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    for (const entry of readdirSync(cur, { withFileTypes: true })) {
      const p = join(cur, entry.name);
      if (entry.isDirectory()) stack.push(p);
      else if (entry.name.endsWith(".md")) out.push(p);
    }
  }
  return out;
}

describe("warm-start golden: messy grad student", () => {
  it("scanner sees the right number of supported files and bucket counts", async () => {
    const scan = await scanCorpus([corpusDir]);

    // Every non-skipped fixture file must be reachable. The scanner
    // filters zero-byte files, so `empty.md` is expected to be absent.
    expect(scan.files.length).toBe(EXPECTED.expected_scanner_files);

    const byType: Record<string, number> = {};
    for (const f of scan.files) {
      byType[f.type] = (byType[f.type] ?? 0) + 1;
    }
    // Deep equality pins the classifier's bucket-count behavior. Any
    // drift in `SCIENCE_EXTENSIONS` or `classifyFile` changes these
    // numbers and fails loudly instead of silently.
    expect(byType).toEqual(EXPECTED.expected_scanner_bucket_counts);

    // Scanner-skipped files must not be in the preview at all.
    for (const skipped of EXPECTED.skipped_by_scanner) {
      const matched = scan.files.some((f) => f.path.endsWith(`/${skipped}`));
      expect(matched, `Scanner unexpectedly included skipped file ${skipped}`).toBe(false);
    }
  });

  it("approveAndImport writes the expected wiki pages without crashing on edge cases", async () => {
    const scan = await scanCorpus([corpusDir]);
    const preview: ImportPreview = {
      analysis: scan.analysis,
      backend: scan.backend,
      files: scan.files,
      projects: scan.projects,
      duplicateGroups: scan.duplicateGroups,
      warnings: scan.warnings,
    };

    const result = await approveAndImport(makeConfig(), makeMockLLM(), preview);

    // Edge cases (corrupt binary, unicode filenames, large file, tiny
    // PDF) must not throw. The importer reports per-file errors in
    // `result.errors` rather than aborting, so we require it to be
    // empty — a populated errors list is a real bug.
    expect(result.errors).toEqual([]);

    // Date prefix used by the text-file writer. The writer calls
    // `new Date().toISOString().slice(0, 10)` once per file, which is
    // stable to the millisecond on a local run.
    const today = new Date().toISOString().slice(0, 10);

    for (const expected of EXPECTED.expected_pages) {
      const expectedRelPath =
        expected.kind === "pdf"
          ? `${expected.wiki_dir}/${expected.slug}.md`
          : `${expected.wiki_dir}/${today}-${expected.slug}.md`;
      const absPath = join(brainRoot, expectedRelPath);
      expect(
        existsSync(absPath),
        `Missing expected wiki page for ${expected.source_filename} at ${expectedRelPath}`,
      ).toBe(true);

      if (expected.required_title_substring) {
        const body = readFileSync(absPath, "utf-8");
        expect(
          body,
          `Page for ${expected.source_filename} missing expected title substring`,
        ).toMatch(new RegExp(expected.required_title_substring, "i"));
      }
    }

    // Sanity check: every expected page is a subset of what actually
    // landed on disk. We do not require the wiki count to equal the
    // manifest exactly (the writer also emits project landing pages
    // when clusters are detected), only that the golden ones exist.
    const allWikiPages = listMd(join(brainRoot, "wiki"));
    expect(allWikiPages.length).toBeGreaterThanOrEqual(EXPECTED.expected_pages.length);
  });

  it("duplicate files are detected and skipped when skipDuplicates is on", async () => {
    const scan = await scanCorpus([corpusDir]);

    // The scanner should have found at least one duplicate group
    // covering the byte-identical watson-crick pair.
    expect(scan.duplicateGroups.length).toBeGreaterThanOrEqual(1);
    const dupPaths = scan.duplicateGroups.flatMap((g) => g.paths.map((p) => p.split("/").pop()!));
    for (const name of EXPECTED.expected_duplicate_source_filenames) {
      expect(
        dupPaths,
        `Duplicate group missing expected filename ${name}`,
      ).toContain(name);
    }

    const preview: ImportPreview = {
      analysis: scan.analysis,
      backend: scan.backend,
      files: scan.files,
      projects: scan.projects,
      duplicateGroups: scan.duplicateGroups,
      warnings: scan.warnings,
    };

    const result = await approveAndImport(makeConfig(), makeMockLLM(), preview, {
      skipDuplicates: true,
    });
    expect(result.errors).toEqual([]);
    // With skipDuplicates: true, the second copy of each duplicate
    // group is routed to `skipped`. At minimum that's the expected
    // count from the manifest.
    expect(result.skipped).toBeGreaterThanOrEqual(EXPECTED.expected_duplicate_skip_count);
  });
});
