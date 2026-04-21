/**
 * Unit tests for `src/brain/coldstart/classifier.ts`.
 *
 * Covers MECE bucket assignment, academic source detection, project / cluster
 * detection, and type mapping helpers.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  classifyFile,
  classifyAcademicSource,
  classifyTextFile,
  hasArxivIdInName,
  hasDoiInName,
  detectDuplicates,
  detectClusters,
  detectProjects,
  inferProjectCandidates,
  mapClassificationToContentType,
  getRawSubdir,
  inferTypeFromPath,
  TITLE_SIMILARITY_THRESHOLD,
} from "@/brain/coldstart/classifier";
import type { ImportPreviewFile } from "@/brain/types";

let tempDir: string;

beforeEach(() => {
  tempDir = join(
    tmpdir(),
    `classifier-unit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

function touch(rel: string, content = ""): string {
  const abs = join(tempDir, rel);
  const dir = abs.replace(/\/[^/]+$/, "");
  mkdirSync(dir, { recursive: true });
  writeFileSync(abs, content);
  return abs;
}

// ── classifyFile (MECE buckets) ───────────────────────

describe("classifyFile", () => {
  it("classifies plain PDFs as paper", () => {
    expect(classifyFile(touch("docs/random.pdf", "%PDF"))).toBe("paper");
  });

  it("classifies arXiv-named PDFs as arxiv-paper", () => {
    expect(classifyFile(touch("papers/2301.12345.pdf", "%PDF"))).toBe("arxiv-paper");
  });

  it("classifies DOI-named PDFs as doi-paper", () => {
    expect(classifyFile(touch("papers/10.1038-nature01234.pdf", "%PDF"))).toBe("doi-paper");
  });

  it("classifies notebooks under experiment/ as experiment-notebook", () => {
    expect(classifyFile(touch("experiment/run1.ipynb", "{}"))).toBe("experiment-notebook");
  });

  it("classifies notebooks elsewhere as notebook", () => {
    expect(classifyFile(touch("nb/explore.ipynb", "{}"))).toBe("notebook");
  });

  it("classifies csv as dataset", () => {
    expect(classifyFile(touch("data/x.csv", "a,b\n1,2"))).toBe("dataset");
  });

  it("classifies package.json as config (extension/MIME-style mismatch)", () => {
    expect(classifyFile(touch("repo/package.json", "{}"))).toBe("config");
  });

  it("classifies python under analysis/ as analysis-script", () => {
    expect(classifyFile(touch("analysis/run.py", "import pandas"))).toBe("analysis-script");
  });

  it("classifies python under utils/ as utility-script", () => {
    expect(classifyFile(touch("utils/helpers.py", "def x(): pass"))).toBe("utility-script");
  });

  it("classifies main.tex as manuscript", () => {
    expect(classifyFile(touch("paper/main.tex", "\\documentclass"))).toBe("manuscript");
  });

  it("classifies generic .tex as tex-source", () => {
    expect(classifyFile(touch("paper/supplement.tex", "\\section{x}"))).toBe("tex-source");
  });

  it("classifies .bib as bibliography", () => {
    expect(classifyFile(touch("refs/lib.bib", "@article{}"))).toBe("bibliography");
  });

  it("classifies pptx as presentation", () => {
    expect(classifyFile(touch("talks/slides.pptx", "PK"))).toBe("presentation");
  });

  it("classifies docx in protocol dir as protocol", () => {
    expect(classifyFile(touch("protocols/dna.docx", "PK"))).toBe("protocol");
  });

  it("classifies docx in manuscript dir as manuscript", () => {
    expect(classifyFile(touch("manuscript/draft.docx", "PK"))).toBe("manuscript");
  });

  it("classifies generic docx as document", () => {
    expect(classifyFile(touch("notes/report.docx", "PK"))).toBe("document");
  });

  it("classifies plain markdown as note", () => {
    expect(classifyFile(touch("notes/todo.md", "# Todo\n- groceries"))).toBe("note");
  });

  it("classifies wet-lab markdown as protocol", () => {
    const p = touch(
      "protocols/dna.md",
      "# DNA Extraction\n\n## Materials\n- Buffer\n## Procedure\nStep 1: Incubate at 37C, then centrifuge\n",
    );
    expect(classifyFile(p)).toBe("protocol");
  });

  it("classifies LaTeX-flavored markdown as research-note", () => {
    const p = touch(
      "notes/derivation.md",
      "# Derivation\n\\begin{equation} x \\end{equation}\nAs in \\cite{foo}",
    );
    expect(classifyFile(p)).toBe("research-note");
  });

  it("returns 'unknown' for completely unknown extensions", () => {
    expect(classifyFile("/dir/file.unknownext")).toBe("unknown");
  });
});

// ── classifyAcademicSource ────────────────────────────

describe("classifyAcademicSource", () => {
  it("detects arXiv IDs in source paths", () => {
    expect(classifyAcademicSource("/papers/2401.99999.pdf")).toBe("paper");
  });

  it("detects DOI numbers in source paths", () => {
    expect(classifyAcademicSource("/papers/10.1038-something.pdf")).toBe("paper");
  });

  it("returns null for plain readme content", () => {
    expect(classifyAcademicSource("readme.md", "# Hello")).toBe(null);
  });

  it("detects DOI in body content", () => {
    expect(classifyAcademicSource("notes.md", "see 10.1038/s41586-021-03819-2")).toBe("paper");
  });

  it("detects bibtex entries in body content", () => {
    expect(classifyAcademicSource("refs.txt", '@article{x, title="t"}')).toBe("paper");
  });

  it("detects protocol-style content as experiment", () => {
    expect(
      classifyAcademicSource(
        "p.md",
        "## Materials\n- buffer\n## Methods\nstep 1 incubate, pipette 10uL",
      ),
    ).toBe("experiment");
  });
});

// ── classifyTextFile ──────────────────────────────────

describe("classifyTextFile", () => {
  it("returns note for trivial text", () => {
    expect(classifyTextFile(touch("a.md", "# hello"))).toBe("note");
  });

  it("returns lab-note for experiment-style text", () => {
    const p = touch(
      "lab.md",
      "experiment trial control treatment\nresult observation measure data",
    );
    expect(classifyTextFile(p)).toBe("lab-note");
  });

  it("returns meeting-note for files in meeting/", () => {
    const p = touch("meeting/2024-01-week.md", "Attendees: Alice");
    expect(classifyTextFile(p)).toBe("meeting-note");
  });

  it("returns note when the file cannot be read", () => {
    expect(classifyTextFile("/no/such/path.md")).toBe("note");
  });
});

// ── arXiv / DOI helpers ───────────────────────────────

describe("hasArxivIdInName", () => {
  it("matches modern arXiv IDs", () => {
    expect(hasArxivIdInName("2301.12345.pdf")).toBe(true);
    expect(hasArxivIdInName("paper-2301.12345v3.pdf")).toBe(true);
  });

  it("rejects non-arXiv filenames", () => {
    expect(hasArxivIdInName("attention.pdf")).toBe(false);
  });
});

describe("hasDoiInName", () => {
  it("matches DOI prefixes", () => {
    expect(hasDoiInName("10.1038-foo.pdf")).toBe(true);
  });

  it("rejects names without a DOI prefix", () => {
    expect(hasDoiInName("foo.pdf")).toBe(false);
  });
});

// ── Project / cluster / duplicate detection ──────────

function makeFile(path: string, type: string): ImportPreviewFile {
  return {
    path,
    type,
    size: 100,
    hash: "h",
    classification: type,
    projectCandidates: [],
    warnings: [],
  };
}

describe("inferProjectCandidates", () => {
  it("returns the top-level subdirectory when present", () => {
    const candidates = inferProjectCandidates("/root/proj-a/sub/file.md", ["/root"]);
    expect(candidates).toContain("proj-a");
  });

  it("returns empty when the file is at the directory root", () => {
    expect(inferProjectCandidates("/root/file.md", ["/root"])).toEqual([]);
  });
});

describe("detectDuplicates", () => {
  it("groups files with identical content hashes", () => {
    const hashes = new Map<string, string[]>([
      ["abc", ["/a.md", "/b.md"]],
      ["def", ["/c.md"]],
    ]);
    const titles = new Map<string, string[]>();
    const groups = detectDuplicates(hashes, titles);
    expect(groups.length).toBe(1);
    expect(groups[0].paths).toEqual(["/a.md", "/b.md"]);
    expect(groups[0].reason).toContain("hash");
  });

  it("groups files with similar titles when not already hash-grouped", () => {
    const hashes = new Map<string, string[]>([
      ["h1", ["/a.md"]],
      ["h2", ["/b.md"]],
    ]);
    const titles = new Map<string, string[]>([
      ["foo bar", ["/a.md", "/b.md"]],
    ]);
    const groups = detectDuplicates(hashes, titles);
    expect(groups.length).toBe(1);
    expect(groups[0].reason).toContain("Similar titles");
  });

  it("does not double-count files already grouped by hash", () => {
    const hashes = new Map<string, string[]>([
      ["h", ["/a.md", "/b.md"]],
    ]);
    const titles = new Map<string, string[]>([
      ["foo", ["/a.md", "/b.md"]],
    ]);
    expect(detectDuplicates(hashes, titles).length).toBe(1);
  });
});

describe("detectClusters", () => {
  it("returns no clusters for a corpus with no shared keywords", () => {
    const files = [makeFile("/x.md", "note"), makeFile("/y.md", "note")];
    const idx = new Map<string, Set<string>>([
      ["alpha", new Set(["/x.md"])],
      ["beta", new Set(["/y.md"])],
    ]);
    expect(detectClusters(idx, files)).toEqual([]);
  });

  it("clusters files that share a keyword", () => {
    const files = [
      makeFile("/x.md", "note"),
      makeFile("/y.md", "note"),
      makeFile("/z.md", "note"),
    ];
    const idx = new Map<string, Set<string>>([
      ["transformer", new Set(["/x.md", "/y.md"])],
    ]);
    const clusters = detectClusters(idx, files);
    expect(clusters.length).toBeGreaterThanOrEqual(1);
    expect(clusters[0].filePaths.sort()).toEqual(["/x.md", "/y.md"]);
  });
});

describe("detectProjects", () => {
  it("detects projects from top-level subdirectories", () => {
    const subA = join(tempDir, "proj-a");
    const subB = join(tempDir, "proj-b");
    mkdirSync(subA, { recursive: true });
    mkdirSync(subB, { recursive: true });
    const files = [
      makeFile(join(subA, "x.md"), "note"),
      makeFile(join(subA, "y.md"), "note"),
      makeFile(join(subB, "z.md"), "note"),
    ];
    const projects = detectProjects(files, [], [tempDir]);
    const slugs = projects.map((p) => p.slug);
    expect(slugs).toContain("proj-a");
    expect(slugs).toContain("proj-b");
  });

  it("falls back to clusters when directories don't cover them", () => {
    const files = [
      makeFile("/loose/x.md", "note"),
      makeFile("/loose/y.md", "note"),
    ];
    const clusters: Parameters<typeof detectProjects>[1] = [
      {
        name: "Topic",
        keywords: ["topic"],
        filePaths: ["/loose/x.md", "/loose/y.md"],
        confidence: "medium",
      },
    ];
    const projects = detectProjects(files, clusters, ["/no/such/dir"]);
    expect(projects.length).toBe(1);
    expect(projects[0].title).toBe("Topic");
  });
});

// ── Type mapping helpers ──────────────────────────────

describe("mapClassificationToContentType", () => {
  it("preserves paper/experiment/data", () => {
    expect(mapClassificationToContentType("paper")).toBe("paper");
    expect(mapClassificationToContentType("experiment")).toBe("experiment");
    expect(mapClassificationToContentType("data")).toBe("data");
  });

  it("falls everything else back to note (the inbox)", () => {
    expect(mapClassificationToContentType("unknown")).toBe("note");
    expect(mapClassificationToContentType("protocol")).toBe("note");
    expect(mapClassificationToContentType("notebook")).toBe("note");
  });
});

describe("getRawSubdir", () => {
  it("maps content types to raw subdirs", () => {
    expect(getRawSubdir("paper")).toBe("papers");
    expect(getRawSubdir("note")).toBe("notes");
    expect(getRawSubdir("experiment")).toBe("experiments");
    expect(getRawSubdir("data")).toBe("data");
  });
});

describe("inferTypeFromPath", () => {
  it("picks paper for entities/papers paths", () => {
    expect(inferTypeFromPath("wiki/entities/papers/foo.md")).toBe("paper");
  });

  it("picks project for projects/", () => {
    expect(inferTypeFromPath("wiki/projects/x.md")).toBe("project");
  });

  it("falls back to note", () => {
    expect(inferTypeFromPath("wiki/random/x.md")).toBe("note");
  });
});

describe("constants", () => {
  it("TITLE_SIMILARITY_THRESHOLD is 0.7", () => {
    expect(TITLE_SIMILARITY_THRESHOLD).toBe(0.7);
  });
});
