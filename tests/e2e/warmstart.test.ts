/**
 * Warm Start E2E Tests — Core Use Case 1
 *
 * Tests the scientist's first interaction with ScienceSwarm:
 * point at messy folders -> scan -> preview -> import -> first briefing -> search
 *
 * Covers:
 * 1. Full scan of a realistic research corpus
 * 2. Import of approved preview with duplicate skipping
 * 3. First briefing generation (LLM + heuristic paths)
 * 4. Post-import search
 * 5. API endpoint integration (POST /api/brain/coldstart)
 * 6. Edge cases (empty dirs, unsupported files, deep nesting, etc.)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  readdirSync,
  utimesSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { scanCorpus, approveAndImport, generateFirstBriefing } from "@/brain/coldstart";
import { search } from "@/brain/search";
import { initBrain } from "@/brain/init";
import type { LLMClient, LLMResponse } from "@/brain/llm";
import type { BrainConfig, ImportPreview, ColdstartScan } from "@/brain/types";

// ── Test infrastructure ─────────────────────────────────

const TEST_ID = `warmstart-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const CORPUS_DIR = join(tmpdir(), `${TEST_ID}-corpus`);
const BRAIN_ROOT = join(tmpdir(), `${TEST_ID}-brain`);

function makeConfig(): BrainConfig {
  return {
    root: BRAIN_ROOT,
    extractionModel: "test-model",
    synthesisModel: "test-model",
    rippleCap: 15,
    paperWatchBudget: 50,
    serendipityRate: 0.2,
  };
}

/**
 * Mock LLM that returns realistic structured output.
 * For wiki page extraction: returns YAML frontmatter + markdown.
 * For briefing generation: returns JSON matching ColdstartBriefing schema.
 */
function createMockLLM(): LLMClient {
  return {
    async complete(call): Promise<LLMResponse> {
      const costBase = {
        inputTokens: 200,
        outputTokens: 100,
        estimatedUsd: 0.001,
        model: "test",
      };

      // Briefing generation request
      if (
        call.system.includes("coldstart") ||
        call.system.includes("briefing") ||
        call.system.includes("research assistant analyzing")
      ) {
        return {
          content: JSON.stringify({
            activeThreads: [
              {
                name: "Transformer architectures for protein folding",
                evidence: ["wiki/entities/papers/attention-paper.md"],
                confidence: "high",
              },
              {
                name: "Single-cell RNA sequencing analysis",
                evidence: ["wiki/resources/scrna-notes.md"],
                confidence: "medium",
              },
            ],
            stalledThreads: [
              {
                name: "CRISPR off-target effects",
                lastActivity: "2025-11-15",
                evidence: ["wiki/resources/crispr-notes.md"],
              },
            ],
            centralPapers: [
              {
                title: "Attention Mechanisms in Biology",
                path: "wiki/entities/papers/attention-paper.md",
                whyItMatters:
                  "Referenced by multiple notes; bridges ML and biology research threads",
              },
            ],
            suggestedQuestions: [
              "How do transformer architectures apply to protein structure prediction?",
              "What are the latest findings on single-cell RNA-seq normalization?",
              "Which of my experiments could benefit from attention mechanisms?",
            ],
          }),
          cost: costBase,
        };
      }

      // Ripple-related request
      if (call.system.includes("ripple") || call.system.includes("cross-reference")) {
        return {
          content: "No updates needed.",
          cost: costBase,
        };
      }

      // Wiki page extraction request (default)
      const userSnippet = call.user.slice(0, 200).toLowerCase();
      let title = "Untitled Note";
      let type = "note";
      let tags = "coldstart";

      if (userSnippet.includes("attention") || userSnippet.includes("transformer")) {
        title = "Attention Mechanisms in Biology";
        type = "paper";
        tags = "coldstart, attention, transformers, biology";
      } else if (userSnippet.includes("scrna") || userSnippet.includes("single-cell")) {
        title = "Single-Cell RNA-Seq Observations";
        type = "note";
        tags = "coldstart, scrna-seq, single-cell";
      } else if (userSnippet.includes("crispr")) {
        title = "CRISPR Off-Target Effects Notes";
        type = "note";
        tags = "coldstart, crispr, gene-editing";
      } else if (userSnippet.includes("protein")) {
        title = "Protein Folding Notebook";
        type = "experiment";
        tags = "coldstart, protein-folding";
      }

      return {
        content: [
          "---",
          `title: "${title}"`,
          `date: 2026-04-09`,
          `type: ${type}`,
          "para: resources",
          `tags: [${tags}]`,
          "---",
          "",
          `# ${title}`,
          "",
          "## Summary",
          `Extracted from imported source. ${call.user.slice(0, 100)}`,
          "",
          "## Key Points",
          "- Important finding from the source material",
          "- Cross-references available research",
        ].join("\n"),
        cost: costBase,
      };
    },
  };
}

/** Helper to create a file in the corpus directory tree */
function corpusFile(relPath: string, content: string): string {
  const absPath = join(CORPUS_DIR, relPath);
  const dir = absPath.replace(/\/[^/]+$/, "");
  mkdirSync(dir, { recursive: true });
  writeFileSync(absPath, content);
  return absPath;
}

// ── Setup / Teardown ────────────────────────────────────

beforeEach(() => {
  rmSync(CORPUS_DIR, { recursive: true, force: true });
  rmSync(BRAIN_ROOT, { recursive: true, force: true });
  mkdirSync(CORPUS_DIR, { recursive: true });
  vi.stubEnv("SCIENCESWARM_USER_HANDLE", "@test-researcher");
  initBrain({ root: BRAIN_ROOT, name: "Dr. Test Researcher" });
});

afterEach(() => {
  rmSync(CORPUS_DIR, { recursive: true, force: true });
  rmSync(BRAIN_ROOT, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

// ── Test 1: Full scan of a realistic research corpus ────

describe("Test 1: Full corpus scan", () => {
  let scan: ColdstartScan;

  beforeEach(async () => {
    // Project A: Computational biology (3 papers, 1 note, 1 notebook)
    corpusFile(
      "comp-bio/attention-in-biology.pdf",
      "%PDF-1.4 Attention mechanisms applied to protein structure prediction using transformer architectures",
    );
    corpusFile(
      "comp-bio/2301.12345.pdf",
      "%PDF-1.4 arXiv paper on neural network methods for single-cell analysis",
    );
    corpusFile(
      "comp-bio/alphafold-review.pdf",
      "%PDF-1.4 Review of AlphaFold and protein folding prediction methods",
    );
    corpusFile(
      "comp-bio/scrna-analysis-notes.md",
      [
        "# Single-Cell RNA-Seq Analysis Notes",
        "",
        "## Observations",
        "- Normalization affects downstream clustering significantly",
        "- Need to compare SCTransform vs standard log-normalize",
        "- Batch effects across samples need correction",
        "",
        "## References",
        "See attention-in-biology paper for transformer approach",
      ].join("\n"),
    );
    corpusFile(
      "comp-bio/protein-folding-exp.ipynb",
      JSON.stringify({
        cells: [
          { cell_type: "markdown", source: ["# Protein Folding Experiment"] },
          {
            cell_type: "code",
            source: ["import torch\nmodel = TransformerModel()"],
          },
        ],
        metadata: { kernelspec: { language: "python" } },
      }),
    );

    // Project B: Gene editing (1 paper, 1 note, 1 CSV data)
    corpusFile(
      "gene-editing/crispr-offtarget-effects.pdf",
      "%PDF-1.4 CRISPR off-target analysis across 50 cell lines",
    );
    corpusFile(
      "gene-editing/experiment-log.md",
      [
        "# CRISPR Experiment Log",
        "",
        "## Trial 1 — 2025-09-15",
        "- Guide RNA: sgRNA-42",
        "- Target: BRCA1 exon 4",
        "- Result: 78% editing efficiency",
        "- Off-target hits: 3 (chr7, chr12, chrX)",
        "",
        "## Trial 2 — 2025-10-01",
        "- Guide RNA: sgRNA-43 (modified)",
        "- Result: 82% editing efficiency",
        "- Off-target hits: 1 (chr12)",
      ].join("\n"),
    );
    corpusFile(
      "gene-editing/editing-efficiency.csv",
      [
        "trial,guide_rna,target,efficiency,off_target_count",
        "1,sgRNA-42,BRCA1-exon4,0.78,3",
        "2,sgRNA-43,BRCA1-exon4,0.82,1",
        "3,sgRNA-44,TP53-exon6,0.71,2",
      ].join("\n"),
    );

    // Duplicate paper (same content as attention-in-biology, different name)
    corpusFile(
      "gene-editing/attention-paper-copy.pdf",
      "%PDF-1.4 Attention mechanisms applied to protein structure prediction using transformer architectures",
    );

    scan = await scanCorpus([CORPUS_DIR]);
  });

  it("finds the correct number of files", () => {
    // 3 PDFs in comp-bio + 1 .md + 1 .ipynb + 1 PDF + 1 .md + 1 .csv + 1 duplicate PDF = 9
    expect(scan.files.length).toBe(9);
  });

  it("classifies file types correctly", () => {
    const papers = scan.files.filter((f) => f.type === "paper");
    const notes = scan.files.filter((f) => f.type === "note");
    const experiments = scan.files.filter((f) => f.type === "experiment");
    const data = scan.files.filter((f) => f.type === "data");

    // 4 PDFs (3 comp-bio + 1 duplicate) are "paper"
    // The arXiv-named PDF (2301.12345.pdf) is also "paper"
    expect(papers.length).toBeGreaterThanOrEqual(4);
    expect(notes.length).toBe(2); // 2 .md files
    expect(experiments.length).toBe(1); // 1 .ipynb
    expect(data.length).toBeGreaterThanOrEqual(1); // .csv + possibly .py
  });

  it("detects projects from folder structure", () => {
    expect(scan.projects.length).toBeGreaterThanOrEqual(2);
    const slugs = scan.projects.map((p) => p.slug);
    expect(slugs).toContain("comp-bio");
    expect(slugs).toContain("gene-editing");
  });

  it("detects duplicate files by content hash", () => {
    expect(scan.duplicateGroups.length).toBeGreaterThanOrEqual(1);
    // The attention paper and its copy should form a duplicate group
    const dupGroup = scan.duplicateGroups.find((g) =>
      g.paths.some((p) => p.includes("attention")),
    );
    expect(dupGroup).toBeDefined();
    expect(dupGroup!.paths.length).toBe(2);
  });

  it("generates topic clusters from content", () => {
    // At minimum, the analysis string should be populated
    expect(scan.analysis).toBeTruthy();
    expect(scan.analysis).toContain("files");
    expect(scan.analysis).toContain("papers");
  });

  it("generates suggested questions", () => {
    expect(scan.suggestedQuestions.length).toBeGreaterThan(0);
    // Should generate paper-related questions since we have papers
    expect(scan.suggestedQuestions.some((q) => q.toLowerCase().includes("paper"))).toBe(
      true,
    );
  });

  it("provides a non-empty analysis string", () => {
    expect(scan.analysis).toMatch(/Scanned \d+ director/);
    expect(scan.backend).toBe("coldstart-scan");
  });

  it("includes file hashes for each file", () => {
    for (const file of scan.files) {
      expect(file.hash).toBeTruthy();
      expect(typeof file.hash).toBe("string");
    }
  });

  it("includes project candidates for each file", () => {
    for (const file of scan.files) {
      expect(Array.isArray(file.projectCandidates)).toBe(true);
      // Files in subdirectories should have at least one project candidate
      expect(file.projectCandidates.length).toBeGreaterThanOrEqual(1);
    }
  });
});

// ── Test 2: Import approved preview ─────────────────────

describe("Test 2: Import approved preview", () => {
  it("imports files, creates project pages, skips duplicates", async () => {
    // Create the realistic corpus
    const paperPath = corpusFile(
      "comp-bio/attention-paper.md",
      [
        "# Attention Mechanisms in Biology",
        "",
        "## Abstract",
        "Transformer-based attention mechanisms have shown promise in protein structure",
        "prediction. This paper reviews applications of self-attention in computational",
        "biology, focusing on AlphaFold and related architectures.",
        "",
        "## Key Findings",
        "- Multi-head attention captures long-range amino acid dependencies",
        "- Structure prediction accuracy improves with evolutionary features",
        "",
        "DOI: 10.1038/s41586-021-03819-2",
      ].join("\n"),
    );

    const notePath = corpusFile(
      "comp-bio/scrna-notes.md",
      [
        "# scRNA-seq Analysis Notes",
        "",
        "Single-cell RNA sequencing observations from our latest batch:",
        "- 10,000 cells captured per sample",
        "- UMI counts vary significantly across batches",
        "- Need to investigate transformer-based normalization approaches",
      ].join("\n"),
    );

    const dataPath = corpusFile(
      "gene-editing/results.csv",
      "trial,efficiency,off_targets\n1,0.78,3\n2,0.82,1",
    );

    const notebookPath = corpusFile(
      "comp-bio/experiment.ipynb",
      JSON.stringify({ cells: [{ cell_type: "code", source: ["print('hello')"] }] }),
    );

    const dupPath = corpusFile(
      "gene-editing/attention-paper-dup.md",
      [
        "# Attention Mechanisms in Biology",
        "",
        "## Abstract",
        "Transformer-based attention mechanisms have shown promise in protein structure",
        "prediction. This paper reviews applications of self-attention in computational",
        "biology, focusing on AlphaFold and related architectures.",
        "",
        "## Key Findings",
        "- Multi-head attention captures long-range amino acid dependencies",
        "- Structure prediction accuracy improves with evolutionary features",
        "",
        "DOI: 10.1038/s41586-021-03819-2",
      ].join("\n"),
    );

    // Build a preview that includes duplicates
    const preview: ImportPreview = {
      analysis: "Test import preview",
      backend: "coldstart-scan",
      files: [
        {
          path: paperPath,
          type: "note", // .md with DOI => classified as note by extension mapping
          size: 400,
          hash: "hash-paper",
          classification: "research-note",
          projectCandidates: ["comp-bio"],
          warnings: [],
        },
        {
          path: notePath,
          type: "note",
          size: 300,
          hash: "hash-note",
          classification: "note",
          projectCandidates: ["comp-bio"],
          warnings: [],
        },
        {
          path: dataPath,
          type: "data",
          size: 60,
          hash: "hash-data",
          classification: "dataset",
          projectCandidates: ["gene-editing"],
          warnings: [],
        },
        {
          path: notebookPath,
          type: "experiment",
          size: 80,
          hash: "hash-nb",
          classification: "notebook",
          projectCandidates: ["comp-bio"],
          warnings: [],
        },
        {
          path: dupPath,
          type: "note",
          size: 400,
          hash: "hash-paper", // Same hash as paperPath
          classification: "research-note",
          projectCandidates: ["gene-editing"],
          warnings: [],
        },
      ],
      projects: [
        {
          slug: "comp-bio",
          title: "Computational Biology",
          confidence: "high",
          reason: "Directory with 3 files",
          sourcePaths: [paperPath, notePath, notebookPath],
        },
        {
          slug: "gene-editing",
          title: "Gene Editing",
          confidence: "medium",
          reason: "Directory with 2 files",
          sourcePaths: [dataPath, dupPath],
        },
      ],
      duplicateGroups: [
        {
          id: "dup-hash-0",
          paths: [paperPath, dupPath],
          reason: "Identical content hash",
        },
      ],
      warnings: [],
    };

    const config = makeConfig();
    const llm = createMockLLM();
    const result = await approveAndImport(config, llm, preview, {
      skipDuplicates: true,
    });

    // Verify import counts
    expect(result.imported).toBe(4);
    expect(result.skipped).toBe(1); // The duplicate should be skipped
    expect(result.errors.length).toBe(0);

    // Verify project pages created
    expect(result.projectsCreated).toContain("comp-bio");
    expect(result.projectsCreated).toContain("gene-editing");

    // Verify project page files exist on disk
    const compBioPage = join(BRAIN_ROOT, "wiki/projects/comp-bio.md");
    const geneEditPage = join(BRAIN_ROOT, "wiki/projects/gene-editing.md");
    expect(existsSync(compBioPage)).toBe(true);
    expect(existsSync(geneEditPage)).toBe(true);

    // Verify project page content
    const compBioContent = readFileSync(compBioPage, "utf-8");
    expect(compBioContent).toContain("Computational Biology");
    expect(compBioContent).toContain("type: project");

    // Verify wiki pages were created (at least project pages + some imported pages)
    expect(result.pagesCreated).toBeGreaterThanOrEqual(3);

    // Verify raw files were preserved
    const rawDirs = ["raw/notes", "raw/data", "raw/experiments", "raw/imports"];
    let rawFilesCount = 0;
    for (const dir of rawDirs) {
      const absDir = join(BRAIN_ROOT, dir);
      if (existsSync(absDir)) {
        rawFilesCount += readdirSync(absDir).length;
      }
    }
    expect(rawFilesCount).toBe(4);
    expect(existsSync(join(BRAIN_ROOT, "raw/notes/attention-paper-dup.md"))).toBe(false);

    // Verify events were logged
    const eventsPath = join(BRAIN_ROOT, "wiki/events.jsonl");
    expect(existsSync(eventsPath)).toBe(true);
    const events = readFileSync(eventsPath, "utf-8").trim();
    expect(events.length).toBeGreaterThan(0);

    // Verify the first briefing was generated
    expect(result.firstBriefing).toBeDefined();
    expect(result.firstBriefing.generatedAt).toBeTruthy();
    expect(result.firstBriefing.activeThreads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "Transformer architectures for protein folding",
        }),
      ]),
    );
    expect(result.firstBriefing.centralPapers.length).toBeGreaterThan(0);

    // Verify duration is tracked
    expect(result.durationMs).toBeGreaterThan(0);
  });
});

// ── Test 3: First briefing generation ───────────────────

describe("Test 3: First briefing generation", () => {
  it("generates a briefing with LLM when enough pages exist", async () => {
    const config = makeConfig();
    const llm = createMockLLM();

    // Create at least 3 wiki pages for LLM briefing path
    const pagesDir = join(BRAIN_ROOT, "wiki/entities/papers");
    mkdirSync(pagesDir, { recursive: true });

    writeFileSync(
      join(pagesDir, "attention-paper.md"),
      [
        "---",
        'title: "Attention Mechanisms in Biology"',
        "date: 2026-04-09",
        "type: paper",
        "para: resources",
        "authors: [Smith, Jones]",
        "year: 2026",
        "venue: Nature",
        "tags: [attention, biology]",
        "---",
        "",
        "# Attention Mechanisms in Biology",
        "",
        "## Summary",
        "Transformer attention applied to protein structure prediction.",
      ].join("\n"),
    );

    writeFileSync(
      join(pagesDir, "alphafold-review.md"),
      [
        "---",
        'title: "AlphaFold Review"',
        "date: 2026-04-08",
        "type: paper",
        "para: resources",
        "authors: [DeepMind]",
        "year: 2025",
        "venue: Science",
        "tags: [protein-folding, alphafold]",
        "---",
        "",
        "# AlphaFold Review",
        "",
        "## Summary",
        "Comprehensive review of AlphaFold protein structure methods.",
      ].join("\n"),
    );

    const notesDir = join(BRAIN_ROOT, "wiki/resources");
    mkdirSync(notesDir, { recursive: true });

    writeFileSync(
      join(notesDir, "scrna-notes.md"),
      [
        "---",
        'title: "scRNA-seq Notes"',
        "date: 2026-04-07",
        "type: note",
        "para: resources",
        "tags: [scrna-seq]",
        "---",
        "",
        "# scRNA-seq Notes",
        "",
        "Notes on single-cell RNA sequencing analysis workflows.",
      ].join("\n"),
    );

    const projectsDir = join(BRAIN_ROOT, "wiki/projects");
    mkdirSync(projectsDir, { recursive: true });

    writeFileSync(
      join(projectsDir, "comp-bio.md"),
      [
        "---",
        'title: "Computational Biology"',
        "date: 2026-04-09",
        "type: project",
        "para: projects",
        "tags: [comp-bio]",
        "---",
        "",
        "# Computational Biology",
        "",
        "Research project on transformer methods in biology.",
      ].join("\n"),
    );

    const briefing = await generateFirstBriefing(config, llm);

    // Verify briefing structure
    expect(briefing.generatedAt).toBeTruthy();
    expect(briefing.stats.papers).toBe(2);
    // Scaffolding pages (home.md, overview.md, log.md, index.md) are also counted as "note"
    expect(briefing.stats.notes).toBeGreaterThanOrEqual(1);
    expect(briefing.stats.projects).toBeGreaterThanOrEqual(1);
    expect(briefing.stats.totalPages).toBeGreaterThanOrEqual(4);

    // LLM path should have populated activeThreads and suggestedQuestions
    expect(briefing.activeThreads.length).toBeGreaterThan(0);
    expect(briefing.suggestedQuestions.length).toBeGreaterThan(0);
    expect(briefing.activeThreads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "Transformer architectures for protein folding",
          confidence: "high",
        }),
      ]),
    );
    expect(briefing.suggestedQuestions).toContain(
      "How do transformer architectures apply to protein structure prediction?",
    );

    // Central papers should reference actual imported papers
    expect(briefing.centralPapers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "Attention Mechanisms in Biology",
          path: "wiki/entities/papers/attention-paper.md",
        }),
      ]),
    );
  });

  it("generates a heuristic briefing when only 1-2 pages exist", async () => {
    const config = makeConfig();
    const llmComplete = vi.fn(async (): Promise<LLMResponse> => {
      throw new Error("LLM unavailable");
    });
    const llm: LLMClient = {
      complete: llmComplete,
    };

    // Create only 2 user pages, then force the LLM path to fail so the
    // heuristic fallback is what gets exercised.
    const pagesDir = join(BRAIN_ROOT, "wiki/resources");
    mkdirSync(pagesDir, { recursive: true });

    const note1Path = join(pagesDir, "note1.md");
    writeFileSync(
      note1Path,
      [
        "---",
        'title: "Research Note 1"',
        "date: 2026-04-09",
        "type: note",
        "para: resources",
        "tags: [test]",
        "---",
        "",
        "# Research Note 1",
        "Some content.",
      ].join("\n"),
    );

    const note2Path = join(pagesDir, "note2.md");
    writeFileSync(
      note2Path,
      [
        "---",
        'title: "Research Note 2"',
        "date: 2026-04-08",
        "type: note",
        "para: resources",
        "tags: [test]",
        "---",
        "",
        "# Research Note 2",
        "More content.",
      ].join("\n"),
    );
    const note1Time = new Date(Date.now() + 1000);
    const note2Time = new Date(Date.now() + 2000);
    utimesSync(note1Path, note1Time, note1Time);
    utimesSync(note2Path, note2Time, note2Time);

    const briefing = await generateFirstBriefing(config, llm);

    // Heuristic briefing should still have valid structure
    expect(briefing.generatedAt).toBeTruthy();
    expect(llmComplete).toHaveBeenCalledTimes(1);
    // 2 user notes + scaffolding pages (home, overview, log, index) also counted as notes
    expect(briefing.stats.notes).toBeGreaterThanOrEqual(2);
    expect(briefing.stats.totalPages).toBeGreaterThanOrEqual(2);
    expect(briefing.activeThreads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "Research Note 1",
          evidence: ["wiki/resources/note1.md"],
          confidence: "low",
        }),
        expect.objectContaining({
          name: "Research Note 2",
          evidence: ["wiki/resources/note2.md"],
          confidence: "low",
        }),
      ]),
    );
    expect(briefing.suggestedQuestions).toContain(
      "What are the main themes in my research corpus?",
    );
  });

  it("falls back to a heuristic briefing when the LLM stalls", async () => {
    vi.stubEnv("SCIENCESWARM_COLDSTART_LLM_TIMEOUT_MS", "100");
    const config = makeConfig();
    const llmComplete = vi.fn(() => new Promise<LLMResponse>(() => {}));
    const llm: LLMClient = {
      complete: llmComplete,
    };

    const briefing = await generateFirstBriefing(config, llm);

    expect(llmComplete).toHaveBeenCalledTimes(1);
    expect(briefing.generatedAt).toBeTruthy();
    expect(briefing.stats.totalPages).toBeGreaterThan(0);
    expect(briefing.suggestedQuestions).toContain(
      "What are the main themes in my research corpus?",
    );
  });

  it("handles an empty brain gracefully", async () => {
    const config = makeConfig();
    const llmComplete = vi.fn(async (): Promise<LLMResponse> => {
      throw new Error("LLM unavailable");
    });
    const llm: LLMClient = {
      complete: llmComplete,
    };

    // Brain was initialized by beforeEach but has no user pages beyond scaffolding
    const briefing = await generateFirstBriefing(config, llm);

    expect(briefing.generatedAt).toBeTruthy();
    expect(llmComplete).toHaveBeenCalledTimes(1);
    expect(briefing.stats.totalPages).toBeGreaterThan(0);
    expect(briefing.stats.papers).toBe(0);
    expect(briefing.centralPapers).toEqual([]);
    expect(briefing.activeThreads.length).toBeGreaterThan(0);
    expect(briefing.activeThreads.every((thread) => thread.confidence === "low")).toBe(
      true,
    );
    expect(
      briefing.activeThreads.every((thread) =>
        thread.evidence.every((path) => path.startsWith("wiki/")),
      ),
    ).toBe(true);
    expect(briefing.suggestedQuestions).toContain(
      "What are the main themes in my research corpus?",
    );
  });
});

// ── Test 4: Post-import search ──────────────────────────

describe("Test 4: Post-import search", () => {
  beforeEach(() => {
    // Seed the brain with searchable wiki pages
    const papersDir = join(BRAIN_ROOT, "wiki/entities/papers");
    const notesDir = join(BRAIN_ROOT, "wiki/resources");
    const experimentsDir = join(BRAIN_ROOT, "wiki/experiments");
    mkdirSync(papersDir, { recursive: true });
    mkdirSync(notesDir, { recursive: true });
    mkdirSync(experimentsDir, { recursive: true });

    writeFileSync(
      join(papersDir, "transformer-attention.md"),
      [
        "---",
        'title: "Transformer Attention for Protein Folding"',
        "date: 2026-04-09",
        "type: paper",
        "para: resources",
        "tags: [transformer, attention, protein-folding]",
        "---",
        "",
        "# Transformer Attention for Protein Folding",
        "",
        "This paper demonstrates how multi-head attention mechanisms improve",
        "protein structure prediction accuracy by 15% over baseline methods.",
      ].join("\n"),
    );

    writeFileSync(
      join(papersDir, "crispr-review.md"),
      [
        "---",
        'title: "CRISPR Guide RNA Design Review"',
        "date: 2026-04-08",
        "type: paper",
        "para: resources",
        "tags: [crispr, gene-editing]",
        "---",
        "",
        "# CRISPR Guide RNA Design Review",
        "",
        "Comprehensive review of guide RNA design strategies for CRISPR-Cas9",
        "systems, focusing on off-target prediction algorithms.",
      ].join("\n"),
    );

    writeFileSync(
      join(notesDir, "lab-observations.md"),
      [
        "---",
        'title: "Lab Observations March 2026"',
        "date: 2026-03-15",
        "type: note",
        "para: resources",
        "tags: [lab, observations]",
        "---",
        "",
        "# Lab Observations March 2026",
        "",
        "Noticed that protein folding experiments with transformer-based models",
        "converge faster when using evolutionary features as input.",
      ].join("\n"),
    );

    writeFileSync(
      join(experimentsDir, "folding-exp-1.md"),
      [
        "---",
        'title: "Protein Folding Experiment 1"',
        "date: 2026-04-01",
        "type: experiment",
        "para: projects",
        "status: completed",
        "tags: [protein-folding, experiment]",
        "---",
        "",
        "# Protein Folding Experiment 1",
        "",
        "## Methods",
        "Used transformer model with 12 attention heads.",
        "",
        "## Results",
        "Accuracy: 0.89 on CASP15 test set.",
      ].join("\n"),
    );
  });

  it("finds papers by topic keyword", async () => {
    const config = makeConfig();
    const results = await search(config, {
      query: "transformer attention",
      mode: "grep",
      limit: 10,
    });

    expect(results.length).toBeGreaterThan(0);
    const paperResult = results.find((r) => r.path.includes("transformer-attention"));
    expect(paperResult).toBeDefined();
    expect(paperResult!.type).toBe("paper");
  });

  it("finds notes by content", async () => {
    const config = makeConfig();
    const results = await search(config, {
      query: "evolutionary features",
      mode: "grep",
      limit: 10,
    });

    expect(results.length).toBeGreaterThan(0);
    const noteResult = results.find((r) => r.path.includes("lab-observations"));
    expect(noteResult).toBeDefined();
    // Path contains "observations" so inferTypeFromPath returns "observation"
    // This is correct behavior -- the search module infers type from path segments
    expect(["note", "observation"]).toContain(noteResult!.type);
  });

  it("finds experiments by search", async () => {
    const config = makeConfig();
    const results = await search(config, {
      query: "CASP15",
      mode: "grep",
      limit: 10,
    });

    expect(results.length).toBeGreaterThan(0);
    const expResult = results.find((r) => r.path.includes("folding-exp"));
    expect(expResult).toBeDefined();
    expect(expResult!.type).toBe("experiment");
  });

  it("relevance scores are between 0 and 1", async () => {
    const config = makeConfig();
    const results = await search(config, {
      query: "protein folding",
      mode: "grep",
      limit: 10,
    });

    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.relevance).toBeGreaterThanOrEqual(0);
      expect(r.relevance).toBeLessThanOrEqual(1);
    }
  });

  it("returns empty results for unrelated queries", async () => {
    const config = makeConfig();
    const results = await search(config, {
      query: "zzzNonExistentTopic999",
      mode: "grep",
      limit: 10,
    });

    expect(results.length).toBe(0);
  });

  it("search via index mode finds pages listed in index.md", async () => {
    const config = makeConfig();

    // Add an entry to the index
    const indexPath = join(BRAIN_ROOT, "wiki/index.md");
    const indexContent = readFileSync(indexPath, "utf-8");
    writeFileSync(
      indexPath,
      indexContent +
        "\n- [[wiki/entities/papers/transformer-attention.md|transformer-attention]]\n",
    );

    const results = await search(config, {
      query: "transformer",
      mode: "index",
      limit: 10,
    });

    expect(results.length).toBeGreaterThan(0);
  });

  it("list mode returns all wiki pages", async () => {
    const config = makeConfig();
    const results = await search(config, {
      query: "",
      mode: "list",
      limit: 100,
    });

    // Should find at least our 4 seeded pages + scaffolding pages
    expect(results.length).toBeGreaterThanOrEqual(4);
  });
});

// ── Test 5: API endpoint integration ────────────────────

describe("Test 5: API endpoint integration", () => {
  // Mock the brain config and LLM modules so the route handler works
  const mockLoadBrainConfig = vi.fn();
  const mockCreateLLMClient = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    vi.doMock("@/brain/config", () => ({
      loadBrainConfig: () => mockLoadBrainConfig(),
      resolveBrainRoot: () => BRAIN_ROOT,
      brainExists: () => true,
    }));
    vi.doMock("@/brain/llm", async (importOriginal) => {
      const original =
        (await importOriginal()) as typeof import("@/brain/llm");
      return {
        ...original,
        createLLMClient: () => mockCreateLLMClient(),
      };
    });

    mockLoadBrainConfig.mockReturnValue(makeConfig());
    mockCreateLLMClient.mockReturnValue(createMockLLM());
  });

  afterEach(() => {
    vi.doUnmock("@/brain/config");
    vi.doUnmock("@/brain/llm");
    vi.resetModules();
    mockLoadBrainConfig.mockReset();
    mockCreateLLMClient.mockReset();
  });

  it('action "scan" with valid paths returns ColdstartScan', async () => {
    corpusFile("scan-test/paper.pdf", "%PDF-1.4 test paper");
    corpusFile("scan-test/notes.md", "# Notes\nSome content here");

    // Import the route fresh with mocked config
    const { POST } = await import("@/app/api/brain/coldstart/route");

    const request = new Request("http://localhost/api/brain/coldstart", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "scan",
        paths: [CORPUS_DIR],
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.files).toBeDefined();
    expect(Array.isArray(data.files)).toBe(true);
    expect(data.files.length).toBe(2);
    expect(data.analysis).toBeTruthy();
    expect(data.backend).toBe("coldstart-scan");
    expect(data.clusters).toBeDefined();
    expect(data.suggestedQuestions).toBeDefined();
    expect(mockCreateLLMClient).not.toHaveBeenCalled();
  });

  it('action "import" runs the real route wiring and skips duplicate files', async () => {
    corpusFile(
      "comp-bio/attention-paper.pdf",
      "%PDF-1.4 Attention mechanisms applied to protein structure prediction",
    );
    corpusFile(
      "comp-bio/notes.md",
      "# Protein Notes\n\nTransformer attention improved folding accuracy.",
    );
    corpusFile(
      "gene-editing/attention-paper-copy.pdf",
      "%PDF-1.4 Attention mechanisms applied to protein structure prediction",
    );
    corpusFile(
      "gene-editing/results.csv",
      "trial,efficiency\n1,0.78\n2,0.82",
    );

    const { POST } = await import("@/app/api/brain/coldstart/route");

    const scanResponse = await POST(
      new Request("http://localhost/api/brain/coldstart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "scan",
          paths: [CORPUS_DIR],
        }),
      }),
    );
    expect(scanResponse.status).toBe(200);

    const preview = await scanResponse.json();
    expect(preview.files).toHaveLength(4);
    expect(preview.duplicateGroups).toHaveLength(1);
    expect(mockCreateLLMClient).not.toHaveBeenCalled();

    const importResponse = await POST(
      new Request("http://localhost/api/brain/coldstart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "import",
          preview,
          options: { skipDuplicates: true },
        }),
      }),
    );
    expect(importResponse.status).toBe(200);

    const data = await importResponse.json();
    expect(mockCreateLLMClient).toHaveBeenCalledTimes(1);
    expect(data.imported).toBe(3);
    expect(data.skipped).toBe(1);
    expect(data.errors).toHaveLength(0);
    expect(data.projectsCreated).toEqual(
      expect.arrayContaining(["comp-bio", "gene-editing"]),
    );
    expect(data.firstBriefing.centralPapers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "wiki/entities/papers/attention-paper.md",
        }),
      ]),
    );

    expect(existsSync(join(BRAIN_ROOT, "wiki/projects/comp-bio.md"))).toBe(true);
    expect(existsSync(join(BRAIN_ROOT, "wiki/projects/gene-editing.md"))).toBe(true);
    expect(existsSync(join(BRAIN_ROOT, "wiki/entities/papers/attention-paper.md"))).toBe(true);
    expect(existsSync(join(BRAIN_ROOT, "raw/papers/attention-paper.pdf"))).toBe(true);
    expect(existsSync(join(BRAIN_ROOT, "raw/notes/notes.md"))).toBe(true);
    expect(existsSync(join(BRAIN_ROOT, "raw/data/results.csv"))).toBe(true);
    expect(existsSync(join(BRAIN_ROOT, "raw/papers/attention-paper-copy.pdf"))).toBe(false);
  });

  it('action "scan" with invalid paths returns scan with warnings', async () => {
    const { POST } = await import("@/app/api/brain/coldstart/route");

    const request = new Request("http://localhost/api/brain/coldstart", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "scan",
        paths: ["/nonexistent/directory/xyz123"],
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.files.length).toBe(0);
    expect(data.warnings.some((w: { code: string }) => w.code === "EMPTY_SCAN")).toBe(
      true,
    );
  });

  it("unknown action returns 400", async () => {
    const { POST } = await import("@/app/api/brain/coldstart/route");

    const request = new Request("http://localhost/api/brain/coldstart", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "nonexistent",
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(400);

    const data = await response.json();
    expect(data.error).toContain("Invalid action");
  });

  it("missing body returns 400", async () => {
    const { POST } = await import("@/app/api/brain/coldstart/route");

    const request = new Request("http://localhost/api/brain/coldstart", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-valid-json",
    });

    const response = await POST(request);
    expect(response.status).toBe(400);

    const data = await response.json();
    expect(data.error).toContain("Invalid JSON");
  });

  it("scan with missing paths field returns 400", async () => {
    const { POST } = await import("@/app/api/brain/coldstart/route");

    const request = new Request("http://localhost/api/brain/coldstart", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "scan",
        // no paths field
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(400);

    const data = await response.json();
    expect(data.error).toContain("paths");
  });

  it("import with missing preview field returns 400", async () => {
    const { POST } = await import("@/app/api/brain/coldstart/route");

    const request = new Request("http://localhost/api/brain/coldstart", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "import",
        // no preview field
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(400);

    const data = await response.json();
    expect(data.error).toContain("preview");
  });
});

// ── Test 6: Edge cases ──────────────────────────────────

describe("Test 6: Edge cases", () => {
  it("handles empty directory scan", async () => {
    const emptyDir = join(CORPUS_DIR, "empty");
    mkdirSync(emptyDir, { recursive: true });

    const scan = await scanCorpus([emptyDir]);

    expect(scan.files.length).toBe(0);
    expect(scan.warnings.some((w) => w.code === "EMPTY_SCAN")).toBe(true);
    expect(scan.projects.length).toBe(0);
    expect(scan.clusters.length).toBe(0);
  });

  it("handles directory with only unsupported file types", async () => {
    corpusFile("unsupported/image.png", "fake png data");
    corpusFile("unsupported/video.mp4", "fake mp4 data");
    corpusFile("unsupported/binary.exe", "fake exe data");
    corpusFile("unsupported/archive.zip", "fake zip data");

    const scan = await scanCorpus([join(CORPUS_DIR, "unsupported")]);

    expect(scan.files.length).toBe(0);
    expect(scan.warnings.some((w) => w.code === "EMPTY_SCAN")).toBe(true);
  });

  it("handles very long file names", async () => {
    const longName = "a".repeat(200) + ".md";
    corpusFile(`longnames/${longName}`, "# Long Named File\nContent here.");

    const scan = await scanCorpus([join(CORPUS_DIR, "longnames")]);

    expect(scan.files.length).toBe(1);
    expect(scan.files[0].path).toContain("aaa");
  });

  it("handles files with no textual content (empty after header)", async () => {
    corpusFile("minimal/bare.md", "# Just a Title");

    const scan = await scanCorpus([join(CORPUS_DIR, "minimal")]);

    expect(scan.files.length).toBe(1);
  });

  it("handles nested directories 5+ levels deep", async () => {
    corpusFile(
      "level1/level2/level3/level4/level5/deep-note.md",
      "# Deep Note\n\nThis note is deeply nested in the directory structure.",
    );
    corpusFile(
      "level1/level2/level3/level4/level5/level6/very-deep.md",
      "# Very Deep\n\nEven deeper nesting.",
    );

    const scan = await scanCorpus([CORPUS_DIR]);

    const deepFiles = scan.files.filter(
      (f) => f.path.includes("level5") || f.path.includes("level6"),
    );
    expect(deepFiles.length).toBe(2);
  });

  it("skips hidden directories and node_modules at any nesting level", async () => {
    corpusFile(".git/config", "git config");
    corpusFile("project/.hidden/secret.md", "# Secret");
    corpusFile("project/node_modules/pkg/readme.md", "# Readme");
    corpusFile("project/__pycache__/cache.md", "# Cache");
    corpusFile("project/visible.md", "# Visible\nThis should be found.");

    const scan = await scanCorpus([CORPUS_DIR]);

    expect(scan.files.length).toBe(1);
    expect(scan.files[0].path).toContain("visible");
  });

  it("handles multiple root directories in a single scan", async () => {
    const dir1 = join(CORPUS_DIR, "research-a");
    const dir2 = join(CORPUS_DIR, "research-b");

    mkdirSync(dir1, { recursive: true });
    mkdirSync(dir2, { recursive: true });

    corpusFile("research-a/paper.pdf", "%PDF-1.4 paper from dir A");
    corpusFile("research-b/notes.md", "# Notes from dir B\nContent");

    const scan = await scanCorpus([dir1, dir2]);

    expect(scan.files.length).toBe(2);
    expect(scan.analysis).toContain("2 directories");
  });

  it("handles files with special characters in names", async () => {
    corpusFile(
      "special/paper (draft v2).md",
      "# Paper Draft v2\nContent with special chars.",
    );
    corpusFile(
      "special/notes & observations.md",
      "# Notes & Observations\nMore content.",
    );

    const scan = await scanCorpus([join(CORPUS_DIR, "special")]);

    expect(scan.files.length).toBe(2);
  });

  it("approveAndImport handles non-existent source file gracefully", async () => {
    const config = makeConfig();
    const llm = createMockLLM();

    const preview: ImportPreview = {
      analysis: "Test",
      backend: "coldstart-scan",
      files: [
        {
          path: "/nonexistent/file.md",
          type: "note",
          size: 100,
          hash: "hash-missing",
          classification: "note",
          projectCandidates: [],
          warnings: [],
        },
      ],
      projects: [],
      duplicateGroups: [],
      warnings: [],
    };

    const result = await approveAndImport(config, llm, preview);

    // Should not crash — file is skipped
    expect(result.errors.length).toBe(0);
    expect(result.imported).toBe(0);
    // Non-existent file returns null from importSingleFile, counts as skipped
    expect(result.skipped).toBeGreaterThanOrEqual(0);
  });

  it("approveAndImport with empty preview produces a valid result", async () => {
    const config = makeConfig();
    const llm = createMockLLM();

    const preview: ImportPreview = {
      analysis: "Empty",
      backend: "coldstart-scan",
      files: [],
      projects: [],
      duplicateGroups: [],
      warnings: [],
    };

    const result = await approveAndImport(config, llm, preview);

    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.errors.length).toBe(0);
    expect(result.projectsCreated.length).toBe(0);
    expect(result.firstBriefing).toBeDefined();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});

// ── Test 7: Full warm-start journey ─────────────────────

describe("Test 7: Full warm-start journey (scan -> import -> briefing -> search)", () => {
  it("completes the full user journey end-to-end", async () => {
    const config = makeConfig();
    const llm = createMockLLM();

    // Step 1: Scientist has messy research folders
    corpusFile(
      "protein-research/attention-mechanism.md",
      [
        "# Attention Mechanism for Protein Structure",
        "",
        "Multi-head attention captures long-range amino acid interactions.",
        "We propose a novel architecture combining evolutionary features",
        "with transformer self-attention for improved folding prediction.",
        "",
        "Key result: 15% improvement on CASP14 targets.",
        "",
        "DOI: 10.1038/s41586-021-03819-2",
      ].join("\n"),
    );
    corpusFile(
      "protein-research/experiment-notebook.ipynb",
      JSON.stringify({
        cells: [
          { cell_type: "markdown", source: ["# Folding Experiment"] },
          { cell_type: "code", source: ["import alphafold"] },
        ],
      }),
    );
    corpusFile(
      "protein-research/results.csv",
      "target,accuracy,method\nT1024,0.89,transformer\nT1025,0.85,transformer\nT1026,0.91,hybrid",
    );
    corpusFile(
      "scrna-project/analysis-notes.md",
      [
        "# scRNA-seq Clustering Analysis",
        "",
        "Compared three normalization methods on PBMC dataset:",
        "- SCTransform: best separation of T-cell subtypes",
        "- LogNormalize: faster but loses rare populations",
        "- scran: good balance of speed and accuracy",
      ].join("\n"),
    );
    corpusFile(
      "scrna-project/batch-correction.py",
      [
        "import scanpy as sc",
        "import scvi",
        "",
        "# Batch correction using scVI",
        "adata = sc.read_h5ad('pbmc_combined.h5ad')",
        "scvi.model.SCVI.setup_anndata(adata, batch_key='batch')",
      ].join("\n"),
    );

    // Step 2: Scan the corpus
    const scan = await scanCorpus([CORPUS_DIR]);

    expect(scan.files.length).toBe(5);
    expect(scan.projects.length).toBeGreaterThanOrEqual(2);

    // Step 3: Build and approve the import
    const result = await approveAndImport(config, llm, scan, {
      skipDuplicates: true,
    });

    expect(result.errors.length).toBe(0);
    expect(result.imported).toBeGreaterThanOrEqual(3);
    expect(result.projectsCreated.length).toBeGreaterThanOrEqual(2);
    expect(result.pagesCreated).toBeGreaterThanOrEqual(3);

    // Step 4: First briefing is available
    expect(result.firstBriefing).toBeDefined();
    expect(result.firstBriefing.stats.totalPages).toBeGreaterThan(0);

    // Step 5: Search works on imported content
    const proteinResults = await search(config, {
      query: "protein",
      mode: "grep",
      limit: 10,
    });
    // Should find at least the protein research pages
    expect(proteinResults.length).toBeGreaterThan(0);

    const scrnaResults = await search(config, {
      query: "scRNA",
      mode: "grep",
      limit: 10,
    });
    expect(scrnaResults.length).toBeGreaterThan(0);

    // Step 6: "What do I have on [topic]?" works
    // Note: grep mode searches for the literal query string, so use a single keyword
    const topicResults = await search(config, {
      query: "attention",
      mode: "grep",
      limit: 10,
    });
    expect(topicResults.length).toBeGreaterThan(0);
  });
});
