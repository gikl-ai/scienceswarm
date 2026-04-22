/**
 * Warm-start end-to-end regression test.
 *
 * The warm-start (messy-corpus import) path is ScienceSwarm's narrowest
 * product wedge per the gbrain pivot spec. This test pins the wedge: drop
 * a mixed corpus into a temp dir, run the coldstart orchestrator, and
 * assert the right number of pages land in the right MECE buckets.
 *
 * If this test fails the pivot cannot proceed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { scanCorpus, approveAndImport } from "@/brain/coldstart";
import type { BrainConfig, ImportPreview } from "@/brain/types";
import type { LLMClient, LLMResponse } from "@/brain/llm";
import { getProjectLocalImportSummaryPath, getProjectRootPath } from "@/lib/state/project-storage";

const FIXTURES = join(__dirname, "..", "fixtures", "coldstart");

let corpusDir: string;
let brainRoot: string;
let scienceswarmDir: string | null = null;

function newId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

beforeEach(() => {
  const id = newId();
  corpusDir = join(tmpdir(), `warmstart-corpus-${id}`);
  brainRoot = join(tmpdir(), `warmstart-brain-${id}`);
  scienceswarmDir = null;
  mkdirSync(corpusDir, { recursive: true });
  mkdirSync(brainRoot, { recursive: true });
  // Copy the shared coldstart fixtures into a fresh corpus dir so the test
  // is isolated from any previous run.
  cpSync(FIXTURES, corpusDir, { recursive: true });
});

afterEach(() => {
  for (const d of [corpusDir, brainRoot, scienceswarmDir]) {
    if (d && existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
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
 * Simple deterministic mock LLM that returns frontmatter+body markdown for
 * extraction calls and JSON for briefing calls.
 */
function makeMockLLM(): LLMClient {
  return {
    async complete(call): Promise<LLMResponse> {
      const cost = { inputTokens: 50, outputTokens: 50, estimatedUsd: 0.001, model: "test" };
      if (
        call.system.includes("research assistant analyzing") ||
        call.system.includes("coldstart") ||
        call.system.includes("briefing")
      ) {
        return {
          content: JSON.stringify({
            activeThreads: [
              { name: "Coldstart import", evidence: ["wiki/projects/project-alpha.md"], confidence: "medium" },
            ],
            stalledThreads: [],
            centralPapers: [],
            suggestedQuestions: ["What did I just import?"],
          }),
          cost,
        };
      }
      return {
        content: "---\ntitle: \"Mock\"\n---\n\n# Mock\nextracted body",
        cost,
      };
    },
  };
}

/**
 * Cheap recursive directory listing for assertion-side counting.
 */
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

describe("warm-start E2E", () => {
  it("scans the mixed-type fixture corpus and finds every supported file", async () => {
    const scan = await scanCorpus([corpusDir]);
    // The fixture corpus has 10 supported files (1 README + 5 in alpha + 4 in
    // beta) plus unsupported.xyz which the scanner must ignore.
    expect(scan.files.length).toBe(10);
    expect(scan.files.some((f) => f.path.endsWith("unsupported.xyz"))).toBe(false);

    // Bucket counts (papers/notes/data/experiments).
    const byType = (t: string) => scan.files.filter((f) => f.type === t).length;
    expect(byType("paper")).toBe(2); // attention.pdf + 2301.12345.pdf
    expect(byType("experiment")).toBe(1); // experiment.ipynb
    // notes = README.md + notes.md + protocol.md + lab-notebook.txt = 4
    expect(byType("note")).toBe(4);
    // data = results.csv + analysis.py + data.json = 3
    expect(byType("data")).toBe(3);
  });

  it("detects project-alpha and project-beta from directory structure", async () => {
    const scan = await scanCorpus([corpusDir]);
    const slugs = scan.projects.map((p) => p.slug);
    expect(slugs).toContain("project-alpha");
    expect(slugs).toContain("project-beta");
  });

  it("imports the approved preview into the right MECE buckets", async () => {
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

    // Every supported file should have been imported (none skipped).
    expect(result.errors).toEqual([]);
    expect(result.imported).toBe(10);
    expect(result.projectsCreated.length).toBeGreaterThanOrEqual(2);

    // Project landing pages live under wiki/projects/.
    const projectPages = listMd(join(brainRoot, "wiki/projects"));
    expect(projectPages.length).toBeGreaterThanOrEqual(2);

    // Papers go to wiki/entities/papers/.
    const paperPages = listMd(join(brainRoot, "wiki/entities/papers"));
    expect(paperPages.length).toBe(2);

    // Experiments go to wiki/experiments/.
    const experimentPages = listMd(join(brainRoot, "wiki/experiments"));
    expect(experimentPages.length).toBe(1);

    // Notes + data files all land under wiki/resources/.
    const resourcePages = listMd(join(brainRoot, "wiki/resources"));
    // 4 notes + 3 data files = 7 wiki/resources pages.
    expect(resourcePages.length).toBe(7);

    // Briefing must come back populated.
    expect(result.firstBriefing).toBeTruthy();
    expect(result.firstBriefing.stats.totalPages).toBeGreaterThan(0);
  });

  it("is idempotent across two runs (no duplicate pages)", async () => {
    const scan = await scanCorpus([corpusDir]);
    const preview: ImportPreview = {
      analysis: scan.analysis,
      backend: scan.backend,
      files: scan.files,
      projects: scan.projects,
      duplicateGroups: scan.duplicateGroups,
      warnings: scan.warnings,
    };
    const config = makeConfig();
    const llm = makeMockLLM();

    const first = await approveAndImport(config, llm, preview);
    const beforePages = listMd(join(brainRoot, "wiki")).length;

    const second = await approveAndImport(config, llm, preview);
    const afterPages = listMd(join(brainRoot, "wiki")).length;

    expect(first.imported).toBe(10);
    // Second run should not create new pages — every writer is idempotent.
    expect(afterPages).toBe(beforePages);
    // The dispatcher returns null for already-existing pages, so they end up
    // counted as skipped on the second run.
    expect(second.imported).toBeLessThanOrEqual(first.imported);
  });

  it("mirrors project-targeted imports into the active workspace and persists a project summary", async () => {
    scienceswarmDir = join(tmpdir(), `warmstart-project-data-${newId()}`);
    mkdirSync(scienceswarmDir, { recursive: true });
    vi.stubEnv("SCIENCESWARM_DIR", scienceswarmDir);

    const scan = await scanCorpus([corpusDir]);
    const preview: ImportPreview = {
      analysis: scan.analysis,
      backend: scan.backend,
      files: scan.files,
      projects: scan.projects,
      duplicateGroups: scan.duplicateGroups,
      warnings: scan.warnings,
    };

    const result = await approveAndImport(makeConfig(), makeMockLLM(), preview, {
      projectSlug: "project-alpha",
    });

    expect(result.errors).toEqual([]);

    const importSummaryPath = getProjectLocalImportSummaryPath("project-alpha");
    expect(existsSync(importSummaryPath)).toBe(true);
    expect(readFileSync(importSummaryPath, "utf-8")).toContain('"source": "coldstart-project-import"');

    const projectRoot = getProjectRootPath("project-alpha");
    expect(existsSync(join(projectRoot, "papers", "attention.pdf"))).toBe(true);
    expect(existsSync(join(projectRoot, "papers", "2301.12345.pdf"))).toBe(true);
    expect(existsSync(join(projectRoot, "code", "experiment.ipynb"))).toBe(true);
    expect(existsSync(join(projectRoot, "data", "results.csv"))).toBe(true);

  });

  it("partial failure: a missing file in the preview does not abort the batch", async () => {
    const scan = await scanCorpus([corpusDir]);
    const preview: ImportPreview = {
      analysis: scan.analysis,
      backend: scan.backend,
      files: [
        ...scan.files,
        // Inject a file that does not exist on disk.
        {
          path: join(corpusDir, "ghost.md"),
          type: "note",
          size: 100,
          hash: "ghost",
          classification: "note",
          projectCandidates: [],
          warnings: [],
        },
      ],
      projects: scan.projects,
      duplicateGroups: scan.duplicateGroups,
      warnings: scan.warnings,
    };

    const result = await approveAndImport(makeConfig(), makeMockLLM(), preview);
    // The good files still land in the brain.
    expect(result.imported).toBe(10);
    // The ghost file is reported as skipped (importSingleFile returned null).
    expect(result.skipped).toBeGreaterThanOrEqual(1);
  });
});
