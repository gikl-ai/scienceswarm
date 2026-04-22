import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { initBrain } from "@/brain/init";
import {
  buildChatContext,
  formatBrainPrompt,
  extractKeywords,
  estimateTokens,
} from "@/brain/chat-context";
import { injectBrainContext } from "@/brain/chat-inject";
import { resetBrainStore, searchCache, type BrainStore } from "@/brain/store";
import * as brainStoreModule from "@/brain/store";
import type { BrainConfig } from "@/brain/types";

let testRoot = "";

function makeConfig(overrides?: Partial<BrainConfig>): BrainConfig {
  return {
    root: testRoot,
    extractionModel: "test",
    synthesisModel: "test",
    rippleCap: 15,
    paperWatchBudget: 50,
    serendipityRate: 0.2,
    ...overrides,
  };
}

function populateWiki(): void {
  mkdirSync(join(testRoot, "wiki/entities/papers"), { recursive: true });
  mkdirSync(join(testRoot, "wiki/concepts"), { recursive: true });
  mkdirSync(join(testRoot, "wiki/experiments"), { recursive: true });

  writeFileSync(
    join(testRoot, "wiki/entities/papers/chen-2024-cas12a.md"),
    "---\ntype: paper\ntags: [CRISPR, Cas12a]\n---\n# Cas12a Specificity Study\n\nThis paper studies Cas12a off-target effects in human cells.\nGuide RNA design impacts specificity significantly."
  );

  writeFileSync(
    join(testRoot, "wiki/concepts/crispr-off-target.md"),
    "---\ntype: concept\ntags: [CRISPR, off-target]\n---\n# CRISPR Off-Target Effects\n\nOff-target effects are unintended modifications at genomic loci\nsimilar to the intended target. Both Cas9 and Cas12a exhibit\noff-target activity."
  );

  writeFileSync(
    join(testRoot, "wiki/entities/papers/smith-2025-crispr.md"),
    "---\ntype: paper\ntags: [CRISPR, Cas9]\n---\n# Cas9 Context Dependency\n\nCas9 off-target rates vary by cell type and chromatin state."
  );

  writeFileSync(
    join(testRoot, "wiki/experiments/exp-001-cas12a-hela.md"),
    "---\ntype: experiment\nstatus: running\n---\n# HeLa Cas12a Experiment\n\nTesting Cas12a specificity in HeLa cells with three guide RNAs."
  );

  writeFileSync(
    join(testRoot, "wiki/concepts/machine-learning.md"),
    "---\ntype: concept\ntags: [ML, deep-learning]\n---\n# Machine Learning in Genomics\n\nDeep learning models can predict off-target effects\nfor CRISPR guide RNA design."
  );
}

beforeAll(async () => {
  await resetBrainStore();
  searchCache.clear();
  testRoot = mkdtempSync(join(tmpdir(), "scienceswarm-brain-test-chat-"));
  vi.stubEnv("BRAIN_ROOT", testRoot);
  initBrain({ root: testRoot });
  populateWiki();
});

beforeEach(async () => {
  vi.stubEnv("BRAIN_ROOT", testRoot);
  await resetBrainStore();
  searchCache.clear();
  rmSync(join(testRoot, "state/chat"), { recursive: true, force: true });
});

afterEach(async () => {
  await resetBrainStore();
  searchCache.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await resetBrainStore();
  searchCache.clear();
  rmSync(testRoot, { recursive: true, force: true });
  testRoot = "";
});

// ── Keyword Extraction ────────────────────────────────

describe("extractKeywords", () => {
  it("extracts meaningful words and strips stop words", () => {
    const keywords = extractKeywords(
      "What are the off-target effects of CRISPR Cas12a?"
    );
    expect(keywords).toContain("off-target");
    expect(keywords).toContain("crispr");
    expect(keywords).toContain("cas12a");
    // Stop words should be removed
    expect(keywords).not.toContain("what");
    expect(keywords).not.toContain("are");
    expect(keywords).not.toContain("the");
  });

  it("caps at 8 keywords", () => {
    const keywords = extractKeywords(
      "CRISPR Cas12a off-target effects guide RNA design specificity human cells genomic loci chromatin modifications"
    );
    expect(keywords.length).toBeLessThanOrEqual(8);
  });

  it("filters words shorter than 4 chars without digits", () => {
    const keywords = extractKeywords("How can we use editing tools?");
    expect(keywords).not.toContain("how");
    expect(keywords).not.toContain("can");
  });

  it("deduplicates keywords", () => {
    const keywords = extractKeywords("CRISPR CRISPR CRISPR effects effects");
    const unique = new Set(keywords);
    expect(keywords.length).toBe(unique.size);
  });

  it("returns empty array for stop-words-only message", () => {
    const keywords = extractKeywords("What is the best way to do this?");
    // All words are stop words or <= 3 chars
    expect(keywords.length).toBe(0);
  });

  it("extracts quoted multi-word phrases", () => {
    const keywords = extractKeywords(
      'Search for "CRISPR off-target" in the literature'
    );
    expect(keywords).toContain("crispr off-target");
  });

  it("preserves hyphenated terms", () => {
    const keywords = extractKeywords(
      "CRISPR-Cas9 off-target effects"
    );
    expect(keywords).toContain("crispr-cas9");
    expect(keywords).toContain("off-target");
  });

  it("deduplicates substrings of longer keywords", () => {
    const keywords = extractKeywords(
      "CRISPR-Cas9 CRISPR experiments"
    );
    // "crispr" should be removed because "crispr-cas9" contains it
    expect(keywords).toContain("crispr-cas9");
    expect(keywords).not.toContain("crispr");
  });

  it("keeps a later compound term by replacing the earlier generic substring in place", () => {
    const keywords = extractKeywords(
      "crispr alpha beta gamma delta epsilon zeta eta theta crispr-cas9"
    );

    expect(keywords).toContain("crispr-cas9");
    expect(keywords).not.toContain("crispr");
  });

  it("does not drop distinct stems that only overlap as plain substrings", () => {
    const keywords = extractKeywords("gene genes pathway");

    expect(keywords).toContain("gene");
    expect(keywords).toContain("genes");
  });

  it("preserves technical terms with numbers", () => {
    const keywords = extractKeywords("The p53 gene and IL6 pathway");
    expect(keywords).toContain("p53");
    expect(keywords).toContain("il6");
  });
});

// ── Token Estimation ──────────────────────────────────

describe("estimateTokens", () => {
  it("estimates roughly 4 chars per token", () => {
    const text = "a".repeat(400);
    expect(estimateTokens(text)).toBe(100);
  });

  it("rounds up for partial tokens", () => {
    expect(estimateTokens("hello")).toBe(2); // 5/4 = 1.25 -> 2
  });
});

// ── buildChatContext ──────────────────────────────────

describe("buildChatContext", () => {
  it("finds relevant pages for a query", async () => {
    const ctx = await buildChatContext(
      makeConfig({ serendipityRate: 0 }),
      "Tell me about Cas12a off-target effects",
      { serendipityRate: 0 }
    );

    expect(ctx.pages.length).toBeGreaterThan(0);
    const paths = ctx.pages.map((p) => p.path);
    expect(paths.some((p) => p.includes("cas12a") || p.includes("off-target"))).toBe(true);
  });

  it("respects token budget", async () => {
    const ctx = await buildChatContext(
      makeConfig({ serendipityRate: 0 }),
      "Tell me about CRISPR experiments",
      { maxTokens: 2000, serendipityRate: 0 }
    );

    expect(ctx.estimatedTokens).toBeLessThanOrEqual(2000);
  });

  it("clamps maxTokens to valid range (2K-8K)", async () => {
    const ctx = await buildChatContext(
      makeConfig({ serendipityRate: 0 }),
      "CRISPR",
      { maxTokens: 100, serendipityRate: 0 }
    );

    expect(ctx.pages.length).toBeGreaterThan(0);
    expect(ctx.estimatedTokens).toBeGreaterThan(100);
    expect(ctx.estimatedTokens).toBeLessThanOrEqual(2000);
  });

  it("triggers serendipity at rate 1.0", async () => {
    const ctx = await buildChatContext(
      makeConfig({ serendipityRate: 1.0 }),
      "Tell me about Cas12a",
      { serendipityRate: 1.0 }
    );

    expect(ctx.serendipityTriggered).toBe(true);
    expect(ctx.pages.some((p) => p.relevance === "serendipity")).toBe(true);
  });

  it("never triggers serendipity at rate 0.0", async () => {
    // Run multiple times to be confident
    for (let i = 0; i < 10; i++) {
      const ctx = await buildChatContext(
        makeConfig({ serendipityRate: 0 }),
        "Tell me about Cas12a",
        { serendipityRate: 0 }
      );
      expect(ctx.serendipityTriggered).toBe(false);
    }
  });

  it("returns empty context for irrelevant query", async () => {
    const ctx = await buildChatContext(
      makeConfig({ serendipityRate: 0 }),
      "quantum entanglement superconductor",
      { serendipityRate: 0 }
    );

    // No relevant pages (though serendipity might add one, disabled here)
    const relevantPages = ctx.pages.filter((p) => p.relevance !== "serendipity");
    expect(relevantPages.length).toBe(0);
  });

  it("falls back to cached grep results when store is unavailable", async () => {
    await resetBrainStore();
    searchCache.clear();

    const first = await buildChatContext(
      makeConfig({ serendipityRate: 0 }),
      "Tell me about Cas12a off-target effects",
      { serendipityRate: 0 }
    );
    const cacheSizeAfterFirst = searchCache.size;

    const second = await buildChatContext(
      makeConfig({ serendipityRate: 0 }),
      "Tell me about Cas12a off-target effects",
      { serendipityRate: 0 }
    );

    expect(first.pages.map((p) => p.path)).toEqual(second.pages.map((p) => p.path));
    expect(first.pages.some((p) => p.path.includes("cas12a"))).toBe(true);
    expect(cacheSizeAfterFirst).toBeGreaterThan(0);
    expect(searchCache.size).toBe(cacheSizeAfterFirst);
  });

  it("falls back to filesystem content when store page reads time out", async () => {
    vi.useFakeTimers();

    const getPage = vi.fn(() => new Promise<never>(() => {}));
    vi.spyOn(brainStoreModule, "cachedSearchWithSource").mockResolvedValue({
      results: [
        {
          path: "wiki/concepts/crispr-off-target.md",
          title: "CRISPR Off-Target Effects",
          snippet: "Off-target effects are unintended modifications.",
          relevance: 0.9,
          type: "concept",
        },
      ],
      fromStore: true,
    });
    vi.spyOn(brainStoreModule, "getBrainStore").mockReturnValue({
      search: vi.fn(),
      getPage,
      getTimeline: vi.fn().mockResolvedValue([]),
      getLinks: vi.fn().mockResolvedValue([]),
      getBacklinks: vi.fn().mockResolvedValue([]),
      importCorpus: vi.fn(),
      listPages: vi.fn().mockResolvedValue([]),
      health: vi.fn(),
      dispose: vi.fn(),
    });

    const contextPromise = buildChatContext(
      makeConfig({ serendipityRate: 0 }),
      "Tell me about CRISPR off-target effects",
      { serendipityRate: 0 },
    );

    await vi.advanceTimersByTimeAsync(501);
    const context = await contextPromise;

    expect(getPage).toHaveBeenCalledWith("wiki/concepts/crispr-off-target.md");
    expect(context.pages).toHaveLength(1);
    expect(context.pages[0].content).toContain("Off-target effects are unintended");
  });

  it("keeps openclaw-web project context scoped to the exact project root", async () => {
    await resetBrainStore();
    searchCache.clear();

    const getPage = vi.fn(async (pagePath: string) => ({
      path: pagePath,
      title: pagePath,
      type: "note",
      content: `# ${pagePath}\n\nScoped content.`,
      frontmatter: {},
    }));
    vi.spyOn(brainStoreModule, "cachedSearchWithSource").mockResolvedValue({
      results: [
        {
          path: "openclaw-web-alpha-project-other/docs/wrong.md",
          title: "Wrong Project",
          snippet: "This belongs to a prefix-collision project.",
          relevance: 0.99,
          type: "note",
        },
        {
          path: "openclaw-web-alpha-project/docs/right.md",
          title: "Right Project",
          snippet: "This belongs to the exact active project.",
          relevance: 0.8,
          type: "note",
        },
      ],
      fromStore: true,
    });
    vi.spyOn(brainStoreModule, "getBrainStore").mockReturnValue({
      search: vi.fn(),
      getPage,
      getTimeline: vi.fn().mockResolvedValue([]),
      getLinks: vi.fn().mockResolvedValue([]),
      getBacklinks: vi.fn().mockResolvedValue([]),
      importCorpus: vi.fn(),
      listPages: vi.fn().mockResolvedValue([]),
      health: vi.fn(),
      dispose: vi.fn(),
    } as unknown as BrainStore);

    const ctx = await buildChatContext(
      makeConfig({ serendipityRate: 0 }),
      "Summarize the active project revision plan",
      { serendipityRate: 0, projectId: "alpha-project" },
    );

    expect(ctx.pages.map((page) => page.path)).toEqual([
      "openclaw-web-alpha-project/docs/right.md",
    ]);
    expect(getPage).toHaveBeenCalledWith("openclaw-web-alpha-project/docs/right.md");
    expect(getPage).not.toHaveBeenCalledWith("openclaw-web-alpha-project-other/docs/wrong.md");
  });

  it("adds gbrain page inventory for enumeration queries when keyword chunks are missing", async () => {
    await resetBrainStore();
    searchCache.clear();

    const listPages = vi.fn().mockResolvedValue([
      {
        path: "papers/mechanistic-interpretability/review.md",
        title: "Mechanistic Interpretability Review",
        type: "paper",
        content: "",
        frontmatter: {
          source_path:
            "papers/incoming-pdfs/mechanistic-interpretability/review.pdf",
        },
      },
      {
        path: "papers/statistics/bootstrap.md",
        title: "Bootstrap Statistics",
        type: "paper",
        content: "A statistics paper.",
        frontmatter: {},
      },
    ]);
    vi.spyOn(brainStoreModule, "cachedSearchWithSource").mockResolvedValue({
      results: [],
      fromStore: true,
    });
    vi.spyOn(brainStoreModule, "ensureBrainStoreReady").mockResolvedValue();
    vi.spyOn(brainStoreModule, "getActiveBrainRoot").mockReturnValue(testRoot);
    vi.spyOn(brainStoreModule, "getBrainStore").mockReturnValue({
      search: vi.fn().mockResolvedValue([]),
      getPage: vi.fn(),
      importCorpus: vi.fn(),
      listPages,
      health: vi.fn(),
      dispose: vi.fn(),
    } as unknown as BrainStore);

    const context = await buildChatContext(
      makeConfig({ serendipityRate: 0 }),
      "Enumerate the papers in my brain related to mechanistic interpretability",
      { serendipityRate: 0 },
    );

    expect(listPages).toHaveBeenCalledWith({ limit: 5000 });
    expect(context.inventory?.map((entry) => entry.title)).toEqual([
      "Mechanistic Interpretability Review",
    ]);

    const prompt = formatBrainPrompt(context);
    expect(prompt).toContain("### Matching Brain Pages");
    expect(prompt).toContain("Mechanistic Interpretability Review");
    expect(prompt).toContain("[[papers/mechanistic-interpretability/review.md]]");
    expect(prompt).not.toContain("Bootstrap Statistics");
  });

  it("adds paper inventory for folder and location questions", async () => {
    await resetBrainStore();
    searchCache.clear();

    const listPages = vi.fn().mockResolvedValue([
      {
        path: "papers/mechanistic-interpretability/source-paper.md",
        title: "Mechanistic Interpretability Source Paper",
        type: "paper",
        content: "",
        frontmatter: {
          source_path:
            "papers/incoming-pdfs/mechanistic-interpretability/source-paper.pdf",
        },
      },
      {
        path: "notes/mechanistic-interpretability.md",
        title: "Mechanistic Interpretability Notes",
        type: "note",
        content: "",
        frontmatter: {},
      },
    ]);
    vi.spyOn(brainStoreModule, "cachedSearchWithSource").mockResolvedValue({
      results: [],
      fromStore: true,
    });
    vi.spyOn(brainStoreModule, "ensureBrainStoreReady").mockResolvedValue();
    vi.spyOn(brainStoreModule, "getActiveBrainRoot").mockReturnValue(testRoot);
    vi.spyOn(brainStoreModule, "getBrainStore").mockReturnValue({
      search: vi.fn().mockResolvedValue([]),
      getPage: vi.fn(),
      importCorpus: vi.fn(),
      listPages,
      health: vi.fn(),
      dispose: vi.fn(),
    } as unknown as BrainStore);

    const context = await buildChatContext(
      makeConfig({ serendipityRate: 0 }),
      "Where is the folder where the research papers are located?",
      { serendipityRate: 0 },
    );

    expect(listPages).toHaveBeenCalledWith({ limit: 5000 });
    expect(context.inventory?.map((entry) => entry.title)).toEqual([
      "Mechanistic Interpretability Source Paper",
    ]);

    const prompt = formatBrainPrompt(context);
    expect(prompt).toContain("For path or location questions");
    expect(prompt).toContain("[[papers/mechanistic-interpretability/source-paper.md]]");
    expect(prompt).not.toContain("Mechanistic Interpretability Notes");
  });

  it("filters generated artifact pages out of default retrieval", async () => {
    await resetBrainStore();
    searchCache.clear();

    const getPage = vi.fn(async (pagePath: string) => ({
      path: pagePath,
      title: pagePath,
      type: pagePath.includes("artifact") ? "artifact" : "paper",
      content: `# ${pagePath}\n\nContent.`,
      frontmatter: pagePath.includes("artifact")
        ? { artifact_tool: "OpenClaw CLI", project: "alpha-project" }
        : { project: "alpha-project" },
    }));
    vi.spyOn(brainStoreModule, "cachedSearchWithSource").mockResolvedValue({
      results: [
        {
          path: "wiki/entities/artifacts/openclaw-alpha-summary",
          title: "Generated summary",
          snippet: "Generated artifact",
          relevance: 0.99,
          type: "artifact",
        },
        {
          path: "wiki/entities/papers/alpha-source",
          title: "Canonical source",
          snippet: "Canonical source page",
          relevance: 0.8,
          type: "paper",
        },
      ],
      fromStore: true,
    });
    vi.spyOn(brainStoreModule, "getBrainStore").mockReturnValue({
      search: vi.fn(),
      getPage,
      getTimeline: vi.fn().mockResolvedValue([]),
      getLinks: vi.fn().mockResolvedValue([]),
      getBacklinks: vi.fn().mockResolvedValue([]),
      importCorpus: vi.fn(),
      listPages: vi.fn().mockResolvedValue([]),
      health: vi.fn(),
      dispose: vi.fn(),
    } as unknown as BrainStore);

    const ctx = await buildChatContext(
      makeConfig({ serendipityRate: 0 }),
      "Where does the canonical source page live?",
      { serendipityRate: 0, excludeGeneratedArtifacts: true, projectId: "alpha-project" },
    );

    expect(ctx.pages.map((page) => page.path)).toEqual([
      "wiki/entities/papers/alpha-source",
    ]);
    expect(getPage).toHaveBeenCalledWith("wiki/entities/artifacts/openclaw-alpha-summary");
  });

  it("supports inventory-only context for organizer and import prompts", async () => {
    await resetBrainStore();
    searchCache.clear();

    vi.spyOn(brainStoreModule, "cachedSearchWithSource").mockResolvedValue({
      results: [
        {
          path: "wiki/entities/papers/alpha-source",
          title: "Canonical source",
          snippet: "Canonical source page",
          relevance: 0.8,
          type: "paper",
        },
      ],
      fromStore: true,
    });
    vi.spyOn(brainStoreModule, "getBrainStore").mockReturnValue({
      search: vi.fn(),
      getPage: vi.fn(),
      getTimeline: vi.fn().mockResolvedValue([]),
      getLinks: vi.fn().mockResolvedValue([]),
      getBacklinks: vi.fn().mockResolvedValue([]),
      importCorpus: vi.fn(),
      listPages: vi.fn().mockResolvedValue([]),
      health: vi.fn(),
      dispose: vi.fn(),
    } as unknown as BrainStore);

    const ctx = await buildChatContext(
      makeConfig({ serendipityRate: 0.2 }),
      "Organize this project and explain the next move.",
      { serendipityRate: 0, inventoryOnly: true, projectId: "alpha-project" },
    );

    expect(ctx.pages).toEqual([]);
    expect(ctx.serendipityTriggered).toBe(false);
  });
});

// ── formatBrainPrompt ─────────────────────────────────

describe("formatBrainPrompt", () => {
  it("returns empty string for empty context", () => {
    const result = formatBrainPrompt({
      pages: [],
      estimatedTokens: 0,
      serendipityTriggered: false,
    });
    expect(result).toBe("");
  });

  it("formats relevant pages with wikilinks", () => {
    const result = formatBrainPrompt({
      pages: [
        {
          path: "wiki/concepts/crispr.md",
          content: "# CRISPR\n\nContent here",
          relevance: "high",
        },
      ],
      estimatedTokens: 10,
      serendipityTriggered: false,
    });

    expect(result).toContain("## Research Context (from your Second Brain)");
    expect(result).toContain("### Relevant Pages");
    expect(result).toContain("[[wiki/concepts/crispr.md]]");
    expect(result).toContain("relevance: high");
    expect(result).toContain("# CRISPR");
  });

  it("includes serendipity section when triggered", () => {
    const result = formatBrainPrompt({
      pages: [
        {
          path: "wiki/concepts/ml.md",
          content: "# ML\n\nMachine learning",
          relevance: "serendipity",
        },
      ],
      estimatedTokens: 10,
      serendipityTriggered: true,
    });

    expect(result).toContain("### Serendipity Pick");
    expect(result).toContain("spark new connections");
    expect(result).toContain("[[wiki/concepts/ml.md]]");
  });

  it("separates relevant and serendipity pages", () => {
    const result = formatBrainPrompt({
      pages: [
        {
          path: "wiki/concepts/crispr.md",
          content: "CRISPR content",
          relevance: "high",
        },
        {
          path: "wiki/concepts/ml.md",
          content: "ML content",
          relevance: "serendipity",
        },
      ],
      estimatedTokens: 20,
      serendipityTriggered: true,
    });

    expect(result).toContain("### Relevant Pages");
    expect(result).toContain("### Serendipity Pick");
    // Relevant page should appear before serendipity
    const relevantIdx = result.indexOf("### Relevant Pages");
    const serendipityIdx = result.indexOf("### Serendipity Pick");
    expect(relevantIdx).toBeLessThan(serendipityIdx);
  });
});

// ── injectBrainContext ────────────────────────────────

describe("injectBrainContext", () => {
  it("returns original prompt when no brain configured", async () => {
    const originalRoot = process.env.BRAIN_ROOT;
    const originalDataRoot = process.env.SCIENCESWARM_DIR;
    const noBrainRoot = join(tmpdir(), "scienceswarm-no-brain-chat-context");
    rmSync(noBrainRoot, { recursive: true, force: true });
    delete process.env.BRAIN_ROOT;
    process.env.SCIENCESWARM_DIR = noBrainRoot;

    try {
      const prompt = "You are a helpful assistant.";
      const result = await injectBrainContext(prompt, "Tell me about CRISPR");
      expect(result).toBe(prompt);
    } finally {
      if (originalRoot !== undefined) {
        process.env.BRAIN_ROOT = originalRoot;
      } else {
        delete process.env.BRAIN_ROOT;
      }
      if (originalDataRoot !== undefined) {
        process.env.SCIENCESWARM_DIR = originalDataRoot;
      } else {
        delete process.env.SCIENCESWARM_DIR;
      }
    }
  });

  it("appends brain context when brain exists", async () => {
    const originalRoot = process.env.BRAIN_ROOT;
    process.env.BRAIN_ROOT = testRoot;

    try {
      const prompt = "You are a helpful assistant.";
      const result = await injectBrainContext(prompt, "Tell me about Cas12a CRISPR");

      expect(result).toContain(prompt);
      expect(result).toContain("## Gbrain Structure");
      expect(result).toContain("Research Context");
    } finally {
      if (originalRoot !== undefined) {
        process.env.BRAIN_ROOT = originalRoot;
      } else {
        delete process.env.BRAIN_ROOT;
      }
    }
  });

  it("includes recent project conversation from local brain state when projectId is provided", async () => {
    const originalRoot = process.env.BRAIN_ROOT;
    process.env.BRAIN_ROOT = testRoot;
    mkdirSync(join(testRoot, "state/chat"), { recursive: true });
    writeFileSync(
      join(testRoot, "state/chat/demo-project.json"),
      JSON.stringify({
        version: 1,
        project: "demo-project",
        conversationId: "conv-demo",
        messages: [
          {
            id: "u1",
            role: "user",
            content: "hi",
            timestamp: "2026-04-11T10:00:00.000Z",
          },
          {
            id: "a1",
            role: "assistant",
            content: "hello from the remembered thread",
            timestamp: "2026-04-11T10:00:01.000Z",
          },
        ],
      }, null, 2),
      "utf-8",
    );

    try {
      const prompt = "You are a helpful assistant.";
      const result = await injectBrainContext(prompt, "Tell me about Cas12a CRISPR", "demo-project");

      expect(result).toContain("## Recent Project Requests");
      expect(result).toContain("Current project slug: demo-project");
      expect(result).toContain("Project: demo-project");
      expect(result).toContain("- hi");
      expect(result).not.toContain("hello from the remembered thread");
    } finally {
      if (originalRoot !== undefined) {
        process.env.BRAIN_ROOT = originalRoot;
      } else {
        delete process.env.BRAIN_ROOT;
      }
    }
  });

  it("migrates legacy global chat into project-local storage before injecting recent conversation", async () => {
    const originalRoot = process.env.BRAIN_ROOT;
    const originalDataRoot = process.env.SCIENCESWARM_DIR;
    const dataRoot = mkdtempSync(join(tmpdir(), "scienceswarm-chat-context-data-"));
    const globalBrainRoot = join(dataRoot, "brain");
    initBrain({ root: globalBrainRoot });
    delete process.env.BRAIN_ROOT;
    process.env.SCIENCESWARM_DIR = dataRoot;
    mkdirSync(join(globalBrainRoot, "state", "chat"), { recursive: true });
    writeFileSync(
      join(globalBrainRoot, "state", "chat", "demo-project.json"),
      JSON.stringify({
        version: 1,
        project: "demo-project",
        conversationId: "conv-global",
        messages: [
          {
            id: "u1",
            role: "user",
            content: "remember this",
            timestamp: "2026-04-11T10:00:00.000Z",
          },
          {
            id: "a1",
            role: "assistant",
            content: "remembered from legacy global chat",
            timestamp: "2026-04-11T10:00:01.000Z",
          },
        ],
      }, null, 2),
      "utf-8",
    );

    try {
      const prompt = "You are a helpful assistant.";
      const result = await injectBrainContext(prompt, "Tell me about Cas12a CRISPR", "demo-project");

      expect(result).toContain("## Recent Project Requests");
      expect(result).not.toContain("remembered from legacy global chat");
      expect(
        readFileSync(
          join(dataRoot, "projects", "demo-project", ".brain", "state", "chat.json"),
          "utf-8",
        ),
      ).toContain("\"conv-global\"");
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
      if (originalRoot !== undefined) {
        process.env.BRAIN_ROOT = originalRoot;
      } else {
        delete process.env.BRAIN_ROOT;
      }
      if (originalDataRoot !== undefined) {
        process.env.SCIENCESWARM_DIR = originalDataRoot;
      } else {
        delete process.env.SCIENCESWARM_DIR;
      }
    }
  });

  it("returns original prompt on invalid brain root", async () => {
    const originalRoot = process.env.BRAIN_ROOT;
    process.env.BRAIN_ROOT = "/nonexistent/path/brain";

    try {
      const prompt = "You are a helpful assistant.";
      const result = await injectBrainContext(prompt, "anything");
      expect(result).toBe(prompt);
    } finally {
      if (originalRoot !== undefined) {
        process.env.BRAIN_ROOT = originalRoot;
      } else {
        delete process.env.BRAIN_ROOT;
      }
    }
  });
});
