/**
 * Unit tests for `src/brain/coldstart/transformer.ts`.
 *
 * Verifies pure shape/text transformations: frontmatter merging, suggested
 * questions, briefing prompt + parse, heuristic briefing fallback. No
 * filesystem writes happen here other than the temp brain root used by
 * `extractAllTags`.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  ensureFrontmatter,
  extractMarkdownTitle,
  formatSize,
  extractAllTags,
  generateScanQuestions,
  buildBriefingPrompt,
  parseBriefingResponse,
  buildHeuristicBriefing,
  loadColdstartTemplate,
  FALLBACK_BRIEFING_SYSTEM,
} from "@/brain/coldstart/transformer";
import type {
  BrainConfig,
  ColdstartBriefing,
  ColdstartScan,
  ImportPreviewFile,
  ImportPreviewProject,
} from "@/brain/types";

let brainRoot: string;

beforeEach(() => {
  brainRoot = join(tmpdir(), `xform-unit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(brainRoot, { recursive: true });
});

afterEach(() => {
  if (existsSync(brainRoot)) {
    rmSync(brainRoot, { recursive: true, force: true });
  }
});

function makeConfig(): BrainConfig {
  return {
    root: brainRoot,
    extractionModel: "test",
    synthesisModel: "test",
    rippleCap: 5,
    paperWatchBudget: 10,
    serendipityRate: 0.1,
  };
}

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

// ── ensureFrontmatter ─────────────────────────────────

describe("ensureFrontmatter", () => {
  it("adds default frontmatter when none exists", () => {
    const out = ensureFrontmatter("# Body", { date: "2026-01-01", type: "note" });
    // gray-matter may quote dates; just verify the value made it through.
    expect(out).toContain("2026-01-01");
    expect(out).toContain("type: note");
  });

  it("does not override existing frontmatter values", () => {
    const src = "---\ntype: paper\n---\n# x";
    const out = ensureFrontmatter(src, { type: "note" });
    expect(out).toContain("type: paper");
    expect(out).not.toContain("type: note");
  });

  it("handles malformed input by prepending a frontmatter block", () => {
    // gray-matter is fairly tolerant; this still produces a frontmatter block.
    const src = "no frontmatter here";
    const out = ensureFrontmatter(src, { tags: ["coldstart"], title: "X" });
    expect(out).toContain("coldstart");
  });
});

describe("extractMarkdownTitle", () => {
  it("returns the first H1", () => {
    expect(extractMarkdownTitle("# Hello\n\nbody")).toBe("Hello");
  });

  it("returns null when no H1 is present", () => {
    expect(extractMarkdownTitle("just text")).toBeNull();
  });
});

describe("formatSize", () => {
  it("uses bytes for tiny files", () => {
    expect(formatSize(512)).toBe("512 B");
  });

  it("uses KB for medium files", () => {
    expect(formatSize(2048)).toBe("2.0 KB");
  });

  it("uses MB for large files", () => {
    expect(formatSize(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});

// ── extractAllTags ────────────────────────────────────

describe("extractAllTags", () => {
  it("returns tags from existing wiki pages, skipping the coldstart marker", () => {
    const config = makeConfig();
    const dir = join(config.root, "wiki/notes");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "a.md"),
      "---\ntags:\n  - coldstart\n  - alpha\n---\n# A",
    );
    writeFileSync(
      join(dir, "b.md"),
      "---\ntags:\n  - beta\n  - gamma\n---\n# B",
    );
    const tags = extractAllTags(config, ["wiki/notes/a.md", "wiki/notes/b.md"]);
    expect(tags).toContain("alpha");
    expect(tags).toContain("beta");
    expect(tags).toContain("gamma");
    expect(tags).not.toContain("coldstart");
  });

  it("ignores nonexistent paths", () => {
    const config = makeConfig();
    const tags = extractAllTags(config, ["wiki/none.md"]);
    expect(tags).toEqual([]);
  });
});

// ── generateScanQuestions ─────────────────────────────

describe("generateScanQuestions", () => {
  const emptyClusters: ColdstartScan["clusters"] = [];
  const emptyProjects: ImportPreviewProject[] = [];

  it("returns at most six questions", () => {
    const files: ImportPreviewFile[] = [];
    expect(generateScanQuestions(files, emptyClusters, emptyProjects).length).toBeLessThanOrEqual(6);
  });

  it("includes paper-themed questions when papers exist", () => {
    const files = [makeFile("/x.pdf", "paper")];
    const qs = generateScanQuestions(files, emptyClusters, emptyProjects);
    expect(qs.some((q) => q.toLowerCase().includes("paper"))).toBe(true);
  });

  it("includes project questions when projects exist", () => {
    const projects: ImportPreviewProject[] = [
      { slug: "p", title: "P", confidence: "high", reason: "r", sourcePaths: [] },
    ];
    const qs = generateScanQuestions([], emptyClusters, projects);
    expect(qs.some((q) => q.toLowerCase().includes("project"))).toBe(true);
  });

  it("always includes the gaps fallback question", () => {
    const qs = generateScanQuestions([], emptyClusters, emptyProjects);
    expect(qs.some((q) => q.toLowerCase().includes("gaps"))).toBe(true);
  });
});

// ── briefing prompt + parse + heuristic ───────────────

const BRIEFING_STATS = { papers: 2, notes: 3, experiments: 1, projects: 1, totalPages: 7 };

describe("buildBriefingPrompt", () => {
  it("includes brain stats and pages", () => {
    const allPages = [
      { title: "A", path: "wiki/a.md", type: "paper", content: "body", mtime: "2026-01-01T00:00:00Z" },
    ];
    const paperPages = [{ title: "A", path: "wiki/a.md", content: "body" }];
    const prompt = buildBriefingPrompt(allPages, paperPages, BRIEFING_STATS);
    expect(prompt).toContain("Brain stats");
    expect(prompt).toContain("7 pages");
    expect(prompt).toContain("[paper] A");
  });
});

describe("parseBriefingResponse", () => {
  it("parses a valid JSON response", () => {
    const json = JSON.stringify({
      activeThreads: [{ name: "x", evidence: ["wiki/x.md"], confidence: "high" }],
      stalledThreads: [],
      centralPapers: [],
      suggestedQuestions: ["What next?"],
    });
    const parsed = parseBriefingResponse(json, [], BRIEFING_STATS);
    expect(parsed).not.toBeNull();
    expect(parsed?.activeThreads.length).toBe(1);
    expect(parsed?.stats).toBe(BRIEFING_STATS);
  });

  it("returns null for unparseable output", () => {
    expect(parseBriefingResponse("not json", [], BRIEFING_STATS)).toBeNull();
  });

  it("coerces missing array fields to empty arrays", () => {
    const parsed = parseBriefingResponse("{}", [], BRIEFING_STATS);
    expect(parsed?.activeThreads).toEqual([]);
    expect(parsed?.stalledThreads).toEqual([]);
    expect(parsed?.centralPapers).toEqual([]);
    expect(parsed?.suggestedQuestions).toEqual([]);
  });
});

describe("buildHeuristicBriefing", () => {
  it("returns a briefing with stats and central papers", () => {
    const allPages = [
      { title: "Project X", path: "wiki/projects/x.md", type: "project", content: "", mtime: new Date().toISOString() },
      { title: "Paper A", path: "wiki/entities/papers/a.md", type: "paper", content: "", mtime: new Date().toISOString() },
    ];
    const paperPages = [{ title: "Paper A", path: "wiki/entities/papers/a.md" }];
    const briefing: ColdstartBriefing = buildHeuristicBriefing(allPages, paperPages, BRIEFING_STATS);
    expect(briefing.stats).toBe(BRIEFING_STATS);
    expect(briefing.centralPapers.length).toBe(1);
    expect(briefing.activeThreads.length).toBeGreaterThan(0);
    expect(briefing.suggestedQuestions.length).toBeGreaterThan(0);
  });

  it("falls back to recent non-paper pages when no project pages exist", () => {
    const allPages = [
      { title: "Note 1", path: "wiki/n1.md", type: "note", content: "", mtime: new Date().toISOString() },
    ];
    const briefing = buildHeuristicBriefing(allPages, [], BRIEFING_STATS);
    expect(briefing.activeThreads[0].confidence).toBe("low");
  });
});

// ── template loader ───────────────────────────────────

describe("loadColdstartTemplate", () => {
  it("returns a non-empty string (template or fallback)", () => {
    const t = loadColdstartTemplate();
    expect(typeof t).toBe("string");
    expect(t.length).toBeGreaterThan(0);
  });

  it("FALLBACK_BRIEFING_SYSTEM mentions the briefing JSON schema", () => {
    expect(FALLBACK_BRIEFING_SYSTEM).toContain("activeThreads");
    expect(FALLBACK_BRIEFING_SYSTEM).toContain("stalledThreads");
  });
});
