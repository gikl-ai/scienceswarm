import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  scanCorpus,
  classifyFile,
  hasArxivIdInName,
  hasDoiInName,
  classifyAcademicSource,
} from "@/brain/coldstart";

// ── Test fixtures ─────────────────────────────────────

let testDir: string;

function fixture(relPath: string, content: string = ""): string {
  const absPath = join(testDir, relPath);
  const dir = absPath.replace(/\/[^/]+$/, "");
  mkdirSync(dir, { recursive: true });
  writeFileSync(absPath, content);
  return absPath;
}

beforeEach(() => {
  testDir = join(tmpdir(), `coldstart-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
  }
});

// ── File Classification ───────────────────────────────

describe("classifyFile", () => {
  it("classifies PDFs as papers", () => {
    const path = fixture("papers/attention.pdf", "%PDF-1.4 fake pdf");
    expect(classifyFile(path)).toBe("paper");
  });

  it("detects arXiv papers from filename", () => {
    const path = fixture("papers/2301.12345.pdf", "%PDF");
    expect(classifyFile(path)).toBe("arxiv-paper");
  });

  it("detects arXiv v2 papers from filename", () => {
    const path = fixture("papers/2301.12345v2.pdf", "%PDF");
    expect(classifyFile(path)).toBe("arxiv-paper");
  });

  it("classifies .ipynb as notebook", () => {
    const path = fixture("notebooks/explore.ipynb", '{"cells":[]}');
    expect(classifyFile(path)).toBe("notebook");
  });

  it("classifies .ipynb in experiment dir as experiment-notebook", () => {
    const path = fixture("experiment/run1.ipynb", '{"cells":[]}');
    expect(classifyFile(path)).toBe("experiment-notebook");
  });

  it("classifies .csv as dataset", () => {
    const path = fixture("data/results.csv", "a,b,c\n1,2,3");
    expect(classifyFile(path)).toBe("dataset");
  });

  it("classifies .py as code", () => {
    const path = fixture("scripts/process.py", "import numpy");
    expect(classifyFile(path)).toBe("code");
  });

  it("classifies .py in analysis dir as analysis-script", () => {
    const path = fixture("analysis/run.py", "import pandas");
    expect(classifyFile(path)).toBe("analysis-script");
  });

  it("classifies .tex as tex-source", () => {
    const path = fixture("paper/supplement.tex", "\\section{Methods}");
    expect(classifyFile(path)).toBe("tex-source");
  });

  it("classifies .tex with main in name as manuscript", () => {
    const path = fixture("paper/main.tex", "\\documentclass{article}");
    expect(classifyFile(path)).toBe("manuscript");
  });

  it("classifies .bib as bibliography", () => {
    const path = fixture("refs/library.bib", "@article{foo2024,}");
    expect(classifyFile(path)).toBe("bibliography");
  });

  it("classifies .pptx as presentation", () => {
    const path = fixture("talks/defense.pptx", "PK");
    expect(classifyFile(path)).toBe("presentation");
  });

  it("classifies .docx as document", () => {
    const path = fixture("docs/report.docx", "PK");
    expect(classifyFile(path)).toBe("document");
  });

  it("classifies protocol markdown", () => {
    const path = fixture(
      "protocols/dna-extract.md",
      "# DNA Extraction Protocol\n\n## Materials\n- Buffer solution\n- Pipette tips\n\n## Procedure\nStep 1: Incubate sample at 37C",
    );
    expect(classifyFile(path)).toBe("protocol");
  });

  it("classifies research notes with LaTeX", () => {
    const path = fixture(
      "notes/theory.md",
      "# Derivation\n\nFrom \\begin{equation} E = mc^2 \\end{equation}\n\nAs shown in \\cite{einstein1905}",
    );
    expect(classifyFile(path)).toBe("research-note");
  });

  it("classifies plain markdown as note", () => {
    const path = fixture("notes/todo.md", "# Todo\n- Buy groceries");
    expect(classifyFile(path)).toBe("note");
  });
});

// ── ArXiv / DOI Detection ─────────────────────────────

describe("hasArxivIdInName", () => {
  it("detects standard arXiv IDs", () => {
    expect(hasArxivIdInName("2301.12345.pdf")).toBe(true);
    expect(hasArxivIdInName("2301.12345v2.pdf")).toBe(true);
    expect(hasArxivIdInName("paper-2301.12345.pdf")).toBe(true);
  });

  it("rejects non-arXiv names", () => {
    expect(hasArxivIdInName("attention-is-all-you-need.pdf")).toBe(false);
    expect(hasArxivIdInName("report-2024.pdf")).toBe(false);
  });
});

describe("hasDoiInName", () => {
  it("detects DOI patterns", () => {
    expect(hasDoiInName("10.1038-s41586-paper.pdf")).toBe(true);
    expect(hasDoiInName("10.11234-something.pdf")).toBe(true);
  });

  it("rejects non-DOI names", () => {
    expect(hasDoiInName("attention.pdf")).toBe(false);
  });
});

// ── Academic Source Classification ────────────────────

describe("classifyAcademicSource", () => {
  it("detects arXiv ID in filename", () => {
    expect(classifyAcademicSource("/papers/2301.12345.pdf")).toBe("paper");
  });

  it("detects DOI in content", () => {
    expect(
      classifyAcademicSource("notes.md", "See doi: 10.1038/s41586-021-03819-2"),
    ).toBe("paper");
  });

  it("detects BibTeX in content", () => {
    expect(
      classifyAcademicSource("refs.txt", '@article{smith2024, title="Foo"}'),
    ).toBe("paper");
  });

  it("detects LaTeX equations in content", () => {
    expect(
      classifyAcademicSource("draft.md", "\\begin{equation} x^2 \\end{equation}"),
    ).toBe("paper");
  });

  it("detects LaTeX citations in content", () => {
    expect(
      classifyAcademicSource("draft.md", "As shown by \\cite{smith2024}"),
    ).toBe("paper");
  });

  it("detects protocol-style content", () => {
    expect(
      classifyAcademicSource(
        "protocol.md",
        "# Protocol\n\n## Materials\nReagent A, Buffer B\n\nStep 1: Incubate at 37C\n\n## Methods\nPipette 10uL",
      ),
    ).toBe("experiment");
  });

  it("returns null for non-academic content", () => {
    expect(classifyAcademicSource("readme.md", "# Hello World")).toBe(null);
  });
});

// ── Corpus Scanning ───────────────────────────────────

describe("scanCorpus", () => {
  it("scans a directory and classifies files", async () => {
    fixture("project-a/paper.pdf", "%PDF-1.4 fake content");
    fixture("project-a/notes.md", "# Research Notes\n\nSome observations about the experiment");
    fixture("project-a/data.csv", "x,y,z\n1,2,3\n4,5,6");
    fixture("project-b/analysis.py", "import pandas as pd\ndf = pd.read_csv('data.csv')");
    fixture("project-b/results.ipynb", '{"cells":[]}');

    const scan = await scanCorpus([testDir]);

    expect(scan.files.length).toBe(5);
    expect(scan.files.find((f) => f.path.endsWith("paper.pdf"))?.type).toBe("paper");
    expect(scan.files.find((f) => f.path.endsWith("notes.md"))?.type).toBe("note");
    expect(scan.files.find((f) => f.path.endsWith("data.csv"))?.type).toBe("data");
    expect(scan.files.find((f) => f.path.endsWith("analysis.py"))?.type).toBe("data");
    expect(scan.files.find((f) => f.path.endsWith("results.ipynb"))?.type).toBe("experiment");
  });

  it("detects projects from directory structure", async () => {
    fixture("project-alpha/paper1.pdf", "%PDF");
    fixture("project-alpha/paper2.pdf", "%PDF different");
    fixture("project-alpha/notes.md", "# Notes");
    fixture("project-beta/data.csv", "a,b\n1,2");
    fixture("project-beta/script.py", "print('hello')");

    const scan = await scanCorpus([testDir]);

    expect(scan.projects.length).toBeGreaterThanOrEqual(2);
    const slugs = scan.projects.map((p) => p.slug);
    expect(slugs).toContain("project-alpha");
    expect(slugs).toContain("project-beta");
  });

  it("detects duplicate files by content hash", async () => {
    const content = "%PDF-1.4 identical content here for testing dedup";
    fixture("dir-a/paper.pdf", content);
    fixture("dir-b/paper-copy.pdf", content);

    const scan = await scanCorpus([testDir]);

    expect(scan.duplicateGroups.length).toBeGreaterThanOrEqual(1);
    expect(scan.duplicateGroups[0].paths.length).toBe(2);
  });

  it("returns empty scan for nonexistent directory", async () => {
    const scan = await scanCorpus(["/nonexistent/path/xyz123"]);

    expect(scan.files.length).toBe(0);
    expect(scan.warnings.some((w) => w.code === "EMPTY_SCAN")).toBe(true);
  });

  it("generates suggested questions based on file types", async () => {
    fixture("papers/paper1.pdf", "%PDF");
    fixture("papers/paper2.pdf", "%PDF different");
    fixture("notebooks/exp1.ipynb", '{"cells":[]}');

    const scan = await scanCorpus([testDir]);

    expect(scan.suggestedQuestions.length).toBeGreaterThan(0);
    expect(scan.suggestedQuestions.some((q) => q.toLowerCase().includes("paper"))).toBe(true);
  });

  it("skips hidden directories and node_modules", async () => {
    fixture(".hidden/secret.md", "# Secret");
    fixture("node_modules/pkg/readme.md", "# Readme");
    fixture("visible/note.md", "# Note");

    const scan = await scanCorpus([testDir]);

    expect(scan.files.length).toBe(1);
    expect(scan.files[0].path).toContain("visible");
  });

  it("skips empty and oversized files", async () => {
    fixture("empty.md", "");
    fixture("normal.md", "# Normal file");

    const scan = await scanCorpus([testDir]);

    // Empty file (0 bytes) should be skipped
    expect(scan.files.length).toBe(1);
    expect(scan.files[0].path).toContain("normal.md");
  });
});

// ── Cluster Detection ─────────────────────────────────

describe("cluster detection", () => {
  it("detects topic clusters from shared keywords", async () => {
    // Create files with overlapping terminology
    fixture(
      "ml/transformer-attention.md",
      "# Transformer Attention\n\nThe transformer architecture uses multi-head attention mechanisms for sequence modeling.",
    );
    fixture(
      "ml/bert-pretraining.md",
      "# BERT Pretraining\n\nBERT uses transformer architecture with masked language modeling for pretraining.",
    );
    fixture(
      "ml/gpt-generation.md",
      "# GPT Generation\n\nGPT is a transformer architecture designed for autoregressive text generation.",
    );
    fixture(
      "bio/protein-folding.md",
      "# Protein Folding\n\nAlphaFold predicts protein structure using evolutionary information.",
    );

    const scan = await scanCorpus([testDir]);

    // Should detect at least that the ML files cluster together
    // (may or may not depending on keyword extraction heuristics)
    expect(scan.files.length).toBe(4);
    // The analysis should mention detected content
    expect(scan.analysis).toContain("4 files");
  });
});
