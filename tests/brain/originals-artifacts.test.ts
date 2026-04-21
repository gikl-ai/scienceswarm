import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
  existsSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { LLMClient, LLMResponse } from "@/brain/llm";
import type { BrainConfig } from "@/brain/types";

const TEST_ROOT = join(tmpdir(), "scienceswarm-originals-artifacts-test");

// ── Mocks ─────────────────────────────────────────────

const mockLoadBrainConfig = vi.fn();
vi.mock("@/brain/config", () => ({
  loadBrainConfig: () => mockLoadBrainConfig(),
  resolveBrainRoot: () => TEST_ROOT,
  brainExists: () => true,
}));

vi.mock("@/brain/llm", () => ({
  createLLMClient: () => mockLLM(),
}));

// ── Helpers ───────────────────────────────────────────

function makeConfig(): BrainConfig {
  return {
    root: TEST_ROOT,
    extractionModel: "test-model",
    synthesisModel: "test-model",
    rippleCap: 15,
    paperWatchBudget: 50,
    serendipityRate: 0.2,
  };
}

function mockLLM(): LLMClient {
  return {
    async complete(): Promise<LLMResponse> {
      // Return a compiled blog post artifact
      const content = [
        "# Neural Scaling and Emergent Behavior",
        "",
        "## Introduction",
        "",
        "Recent observations point to a fascinating pattern in neural networks.",
        "",
        "## Key Insights",
        "",
        "### Scaling Changes Everything",
        "",
        '> scaling laws predict loss but not capability jumps',
        "",
        "This insight challenges our understanding of how capabilities emerge.",
        "",
        "### Emergent Properties",
        "",
        '> emergence is a phase transition not a smooth curve',
        "",
        "The discontinuous nature of emergent behavior suggests deeper mechanisms.",
        "",
        "### Critical Mass",
        "",
        '> networks need critical mass of parameters before reasoning appears',
        "",
        "This threshold effect has major implications for architecture design.",
        "",
        "## Conclusion",
        "",
        "These originals converge on a unified theory of capability emergence.",
        "",
        "## References",
        "",
        "- Kaplan et al. (2020) on scaling laws",
        "- Wei et al. (2022) on emergent abilities",
      ].join("\n");
      return {
        content,
        cost: {
          inputTokens: 500,
          outputTokens: 300,
          estimatedUsd: 0.02,
          model: "test",
        },
      };
    },
  };
}

/**
 * Write a synthetic original page to the originals folder.
 */
function writeOriginal(
  slug: string,
  verbatim: string,
  kind: string,
  date: string,
  extraWords: string[] = []
): void {
  const originalsDir = join(TEST_ROOT, "wiki/originals");
  mkdirSync(originalsDir, { recursive: true });

  const extraContent = extraWords.length > 0
    ? `\n\nAdditional context: ${extraWords.join(" ")}\n`
    : "";

  const content = [
    "---",
    `date: ${date}`,
    "type: note",
    "para: resources",
    `tags: [original, ${kind}]`,
    `title: "${verbatim.slice(0, 100)}"`,
    "---",
    "",
    `# ${verbatim.slice(0, 120)}`,
    "",
    "## Compiled Truth",
    "",
    `> ${verbatim}`,
    "",
    `**Kind**: ${kind}`,
    "",
    "## Timeline",
    "",
    `- **${date}** | First captured`,
    extraContent,
  ].join("\n");

  writeFileSync(join(originalsDir, `${slug}.md`), content);
}

function setupTestBrain(): void {
  rmSync(TEST_ROOT, { recursive: true, force: true });
  mkdirSync(join(TEST_ROOT, "wiki/originals"), { recursive: true });
  mkdirSync(join(TEST_ROOT, "wiki/entities/artifacts"), { recursive: true });
  mockLoadBrainConfig.mockReturnValue(makeConfig());
}

function teardownTestBrain(): void {
  rmSync(TEST_ROOT, { recursive: true, force: true });
  mockLoadBrainConfig.mockReset();
}

// ── Tests: findCompilableThemes ──────────────────────

describe("findCompilableThemes", () => {
  beforeEach(() => {
    vi.resetModules();
    setupTestBrain();
  });

  afterEach(() => {
    vi.resetModules();
    teardownTestBrain();
  });

  it("detects 2 themes from 6 originals (3+ each)", async () => {
    // Theme A: neural scaling (3 originals share many scaling/neural/network/parameters words)
    writeOriginal(
      "scaling-laws-predict-loss",
      "neural network scaling laws predict loss but not capability jumps in parameters",
      "observation",
      "2026-03-01",
      ["neural", "network", "parameters", "scaling", "training", "loss", "capability"]
    );
    writeOriginal(
      "emergence-phase-transition",
      "neural network scaling shows emergence as a phase transition not a smooth curve in parameters",
      "hypothesis",
      "2026-03-05",
      ["neural", "network", "scaling", "parameters", "capability", "emergent", "loss"]
    );
    writeOriginal(
      "critical-mass-parameters",
      "neural networks need critical mass of scaling parameters before reasoning capability appears",
      "observation",
      "2026-03-10",
      ["neural", "network", "parameters", "scaling", "reasoning", "capability", "loss"]
    );

    // Theme B: protein folding (3 originals share many protein/folding/structure/prediction words)
    writeOriginal(
      "alphafold-not-design",
      "protein folding structure prediction alphafold solves but not protein design",
      "hot_take",
      "2026-03-02",
      ["protein", "folding", "structure", "prediction", "design", "alphafold", "conformation"]
    );
    writeOriginal(
      "folding-landscape-energy",
      "protein folding structure landscape shaped by energy not sequence for prediction",
      "hypothesis",
      "2026-03-06",
      ["protein", "folding", "structure", "prediction", "energy", "landscape", "conformation"]
    );
    writeOriginal(
      "structure-function-gap",
      "protein folding structure prediction versus function prediction gap remains wide",
      "observation",
      "2026-03-11",
      ["protein", "folding", "structure", "prediction", "function", "conformation", "alphafold"]
    );

    const { findCompilableThemes } = await import(
      "@/brain/originals-artifacts"
    );
    const themes = await findCompilableThemes(makeConfig());

    expect(themes.length).toBe(2);

    // Each theme should have exactly 3 originals
    expect(themes[0].originals.length).toBe(3);
    expect(themes[1].originals.length).toBe(3);

    // Each theme should have a non-empty theme string
    expect(themes[0].theme.length).toBeGreaterThan(0);
    expect(themes[1].theme.length).toBeGreaterThan(0);

    // Themes should be different
    expect(themes[0].theme).not.toBe(themes[1].theme);
  });

  it("returns no themes when all originals are unique", async () => {
    // 4 originals with completely different vocabularies — zero overlap
    writeOriginal(
      "quantum-computing-supremacy",
      "qubit decoherence prevents practical quantum supremacy",
      "hot_take",
      "2026-01-01",
      ["qubit", "decoherence", "supremacy", "topological", "annealing"]
    );
    writeOriginal(
      "climate-model-resolution",
      "kilometer convection resolution captures mesoscale weather",
      "observation",
      "2026-02-01",
      ["kilometer", "convection", "mesoscale", "precipitation", "cyclone"]
    );
    writeOriginal(
      "crispr-off-target",
      "guide rna specificity determines off-target mutagenesis frequency",
      "hypothesis",
      "2026-03-01",
      ["crispr", "mutagenesis", "specificity", "nuclease", "indel"]
    );
    writeOriginal(
      "dark-matter-detection",
      "xenon detector sensitivity insufficient for wimp cross-section",
      "observation",
      "2026-04-01",
      ["xenon", "wimp", "cross-section", "bolometer", "scintillation"]
    );

    const { findCompilableThemes } = await import(
      "@/brain/originals-artifacts"
    );
    const themes = await findCompilableThemes(makeConfig());

    expect(themes.length).toBe(0);
  });

  it("returns empty when originals folder is empty", async () => {
    // originalsDir exists but has no files
    const { findCompilableThemes } = await import(
      "@/brain/originals-artifacts"
    );
    const themes = await findCompilableThemes(makeConfig());
    expect(themes).toEqual([]);
  });

  it("returns empty when originals folder does not exist", async () => {
    rmSync(join(TEST_ROOT, "wiki/originals"), {
      recursive: true,
      force: true,
    });

    const { findCompilableThemes } = await import(
      "@/brain/originals-artifacts"
    );
    const themes = await findCompilableThemes(makeConfig());
    expect(themes).toEqual([]);
  });

  it("returns empty with a single original", async () => {
    writeOriginal(
      "lone-thought",
      "machine learning is just statistics with GPUs",
      "hot_take",
      "2026-04-01",
      ["machine", "learning", "statistics"]
    );

    const { findCompilableThemes } = await import(
      "@/brain/originals-artifacts"
    );
    const themes = await findCompilableThemes(makeConfig());
    expect(themes).toEqual([]);
  });
});

// ── Tests: compileOriginals ──────────────────────────

describe("compileOriginals", () => {
  beforeEach(() => {
    vi.resetModules();
    setupTestBrain();
  });

  afterEach(() => {
    vi.resetModules();
    teardownTestBrain();
  });

  it("blog-post format has title, sections, and references", async () => {
    const { compileOriginals } = await import("@/brain/originals-artifacts");

    const cluster = {
      theme: "neural scaling",
      originals: [
        {
          path: "wiki/originals/scaling-laws.md",
          verbatim: "scaling laws predict loss but not capability jumps",
          kind: "observation",
          date: "2026-03-01",
        },
        {
          path: "wiki/originals/emergence.md",
          verbatim: "emergence is a phase transition not a smooth curve",
          kind: "hypothesis",
          date: "2026-03-05",
        },
        {
          path: "wiki/originals/critical-mass.md",
          verbatim: "networks need critical mass of parameters before reasoning appears",
          kind: "observation",
          date: "2026-03-10",
        },
      ],
      relatedPapers: ["wiki/entities/papers/kaplan-2020.md"],
      relatedConcepts: ["wiki/concepts/scaling-laws.md"],
    };

    const artifact = await compileOriginals(
      makeConfig(),
      mockLLM(),
      cluster,
      "blog-post"
    );

    // Title must be a specific non-empty string
    expect(artifact.title).toBe("Neural Scaling and Emergent Behavior");
    expect(artifact.format).toBe("blog-post");

    // Content must contain section markers expected in a blog post
    expect(artifact.content).toContain("# Neural Scaling");
    expect(artifact.content).toContain("## Introduction");
    expect(artifact.content).toContain("## Conclusion");
    expect(artifact.content).toContain("## References");

    // Verbatim quotes must be preserved
    expect(artifact.content).toContain(
      "scaling laws predict loss but not capability jumps"
    );
    expect(artifact.content).toContain(
      "emergence is a phase transition not a smooth curve"
    );
    expect(artifact.content).toContain(
      "networks need critical mass of parameters before reasoning appears"
    );

    // Source paths must match the input
    expect(artifact.sourcePaths).toEqual([
      "wiki/originals/scaling-laws.md",
      "wiki/originals/emergence.md",
      "wiki/originals/critical-mass.md",
    ]);

    // Related pages must include both papers and concepts
    expect(artifact.relatedPages).toContain(
      "wiki/entities/papers/kaplan-2020.md"
    );
    expect(artifact.relatedPages).toContain(
      "wiki/concepts/scaling-laws.md"
    );

    // Word count must be positive and specific
    expect(artifact.wordCount).toBeGreaterThan(50);
  });

  it("memo format produces content with executive summary and key insights", async () => {
    // Override the mock to return memo-style content
    const memoLLM: LLMClient = {
      async complete(): Promise<LLMResponse> {
        return {
          content: [
            "# Scaling Laws Memo",
            "",
            "## Executive Summary",
            "",
            "Three observations converge on scaling behavior in neural networks.",
            "",
            "## Key Insights",
            "",
            "1. Scaling predicts loss, not capabilities",
            '> scaling laws predict loss but not capability jumps',
            "",
            "2. Emergence is discontinuous",
            '> emergence is a phase transition not a smooth curve',
            "",
            "3. Parameter thresholds matter",
            '> networks need critical mass of parameters before reasoning appears',
            "",
            "## Evidence",
            "",
            "All three observations were made during analysis of language model benchmarks.",
            "",
            "## Implications",
            "",
            "Training budgets should account for capability thresholds, not just loss curves.",
          ].join("\n"),
          cost: {
            inputTokens: 400,
            outputTokens: 250,
            estimatedUsd: 0.015,
            model: "test",
          },
        };
      },
    };

    const { compileOriginals } = await import("@/brain/originals-artifacts");

    const cluster = {
      theme: "scaling + neural",
      originals: [
        {
          path: "wiki/originals/a.md",
          verbatim: "scaling laws predict loss but not capability jumps",
          kind: "observation",
          date: "2026-03-01",
        },
        {
          path: "wiki/originals/b.md",
          verbatim: "emergence is a phase transition not a smooth curve",
          kind: "hypothesis",
          date: "2026-03-05",
        },
        {
          path: "wiki/originals/c.md",
          verbatim:
            "networks need critical mass of parameters before reasoning appears",
          kind: "observation",
          date: "2026-03-10",
        },
      ],
      relatedPapers: [],
      relatedConcepts: [],
    };

    const artifact = await compileOriginals(
      makeConfig(),
      memoLLM,
      cluster,
      "memo"
    );

    expect(artifact.format).toBe("memo");
    expect(artifact.title).toBe("Scaling Laws Memo");
    expect(artifact.content).toContain("## Executive Summary");
    expect(artifact.content).toContain("## Key Insights");
    // Verbatim quotes preserved
    expect(artifact.content).toContain(
      "scaling laws predict loss but not capability jumps"
    );
    expect(artifact.content).toContain(
      "emergence is a phase transition not a smooth curve"
    );
  });

  it("preserves verbatim quotes in the output", async () => {
    const { compileOriginals } = await import("@/brain/originals-artifacts");

    const verbatim1 = "scaling laws predict loss but not capability jumps";
    const verbatim2 = "emergence is a phase transition not a smooth curve";
    const verbatim3 =
      "networks need critical mass of parameters before reasoning appears";

    const cluster = {
      theme: "scaling",
      originals: [
        {
          path: "wiki/originals/a.md",
          verbatim: verbatim1,
          kind: "observation",
          date: "2026-03-01",
        },
        {
          path: "wiki/originals/b.md",
          verbatim: verbatim2,
          kind: "hypothesis",
          date: "2026-03-05",
        },
        {
          path: "wiki/originals/c.md",
          verbatim: verbatim3,
          kind: "observation",
          date: "2026-03-10",
        },
      ],
      relatedPapers: [],
      relatedConcepts: [],
    };

    const artifact = await compileOriginals(
      makeConfig(),
      mockLLM(),
      cluster,
      "blog-post"
    );

    // Each verbatim must appear somewhere in the artifact content
    expect(artifact.content).toContain(verbatim1);
    expect(artifact.content).toContain(verbatim2);
    expect(artifact.content).toContain(verbatim3);
  });
});

// ── Tests: saveArtifact ──────────────────────────────

describe("saveArtifact", () => {
  beforeEach(() => {
    vi.resetModules();
    setupTestBrain();
  });

  afterEach(() => {
    vi.resetModules();
    teardownTestBrain();
  });

  it("saves artifact to disk with correct frontmatter and back-links", async () => {
    const { saveArtifact } = await import("@/brain/originals-artifacts");

    const artifact = {
      title: "Neural Scaling and Emergent Behavior",
      format: "blog-post" as const,
      content: "# Neural Scaling\n\nThis is the compiled artifact content.",
      sourcePaths: [
        "wiki/originals/scaling-laws.md",
        "wiki/originals/emergence.md",
        "wiki/originals/critical-mass.md",
      ],
      relatedPages: [
        "wiki/entities/papers/kaplan-2020.md",
        "wiki/concepts/scaling-laws.md",
      ],
      wordCount: 42,
    };

    const savedPath = saveArtifact(makeConfig(), artifact);

    // Path should be in the artifacts directory
    expect(savedPath).toMatch(
      /^wiki\/entities\/artifacts\/\d{4}-\d{2}-\d{2}-neural-scaling-and-emergent-behavior\.md$/
    );

    // File must exist on disk
    const absPath = join(TEST_ROOT, savedPath);
    expect(existsSync(absPath)).toBe(true);

    // Read back and verify content
    const content = readFileSync(absPath, "utf-8");

    // Frontmatter checks
    expect(content).toContain("type: artifact");
    expect(content).toContain("format: blog-post");
    expect(content).toContain("tags: [artifact, blog-post, compiled]");
    expect(content).toContain(
      'title: "Neural Scaling and Emergent Behavior"'
    );
    expect(content).toContain("word_count: 42");

    // Back-links to source originals
    expect(content).toContain("[[wiki/originals/scaling-laws.md]]");
    expect(content).toContain("[[wiki/originals/emergence.md]]");
    expect(content).toContain("[[wiki/originals/critical-mass.md]]");

    // Related pages
    expect(content).toContain("[[wiki/entities/papers/kaplan-2020.md]]");
    expect(content).toContain("[[wiki/concepts/scaling-laws.md]]");

    // Artifact content is present
    expect(content).toContain("# Neural Scaling");
    expect(content).toContain(
      "This is the compiled artifact content."
    );
  });
});

// ── Tests: API routes ────────────────────────────────

describe("GET /api/brain/compile-originals", () => {
  beforeEach(() => {
    vi.resetModules();
    setupTestBrain();
  });

  afterEach(() => {
    vi.resetModules();
    teardownTestBrain();
  });

  it("returns compilable themes", async () => {
    // Write 3 originals in the same theme with heavy word overlap
    writeOriginal(
      "scaling-a",
      "neural network scaling laws predict loss but not capability jumps in parameters",
      "observation",
      "2026-03-01",
      ["neural", "network", "scaling", "parameters", "training", "loss", "capability"]
    );
    writeOriginal(
      "scaling-b",
      "neural network scaling shows emergence as phase transition not smooth curve in parameters",
      "hypothesis",
      "2026-03-05",
      ["neural", "network", "scaling", "parameters", "capability", "emergent", "loss"]
    );
    writeOriginal(
      "scaling-c",
      "neural networks need critical mass of scaling parameters before reasoning capability appears",
      "observation",
      "2026-03-10",
      ["neural", "network", "scaling", "parameters", "reasoning", "capability", "loss"]
    );

    const { GET } = await import(
      "@/app/api/brain/compile-originals/route"
    );
    const response = await GET();

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.themes).toBeDefined();
    expect(Array.isArray(data.themes)).toBe(true);
    expect(data.themes.length).toBeGreaterThan(0);

    // Each theme should have 3+ originals
    for (const theme of data.themes) {
      expect(theme.originals.length).toBeGreaterThanOrEqual(3);
      expect(typeof theme.theme).toBe("string");
      expect(theme.theme.length).toBeGreaterThan(0);
    }
  });

  it("returns empty themes array when no compilable clusters exist", async () => {
    // Only 1 original — not enough for a cluster
    writeOriginal(
      "lone-thought",
      "a single lonely idea",
      "observation",
      "2026-04-01",
      ["unique", "standalone"]
    );

    const { GET } = await import(
      "@/app/api/brain/compile-originals/route"
    );
    const response = await GET();

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.themes).toEqual([]);
  });
});

describe("POST /api/brain/compile-originals", () => {
  beforeEach(() => {
    vi.resetModules();
    setupTestBrain();
  });

  afterEach(() => {
    vi.resetModules();
    teardownTestBrain();
  });

  it("compiles originals and returns artifact with savedPath", async () => {
    // Write 3 originals in a theme with heavy word overlap
    writeOriginal(
      "scaling-a",
      "neural network scaling laws predict loss but not capability jumps in parameters",
      "observation",
      "2026-03-01",
      ["neural", "network", "scaling", "parameters", "training", "loss", "capability"]
    );
    writeOriginal(
      "scaling-b",
      "neural network scaling shows emergence as phase transition not smooth curve in parameters",
      "hypothesis",
      "2026-03-05",
      ["neural", "network", "scaling", "parameters", "capability", "emergent", "loss"]
    );
    writeOriginal(
      "scaling-c",
      "neural networks need critical mass of scaling parameters before reasoning capability appears",
      "observation",
      "2026-03-10",
      ["neural", "network", "scaling", "parameters", "reasoning", "capability", "loss"]
    );

    // First, get the theme name
    const { GET, POST } = await import(
      "@/app/api/brain/compile-originals/route"
    );
    const getResponse = await GET();
    const { themes } = await getResponse.json();
    const themeName = themes[0].theme;

    // Now compile
    const request = new Request(
      "http://localhost/api/brain/compile-originals",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ theme: themeName, format: "blog-post" }),
      }
    );

    const response = await POST(request);
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.artifact).toBeDefined();
    expect(data.artifact.title).toBe(
      "Neural Scaling and Emergent Behavior"
    );
    expect(data.artifact.format).toBe("blog-post");
    expect(data.artifact.wordCount).toBeGreaterThan(0);
    expect(data.artifact.sourcePaths.length).toBe(3);

    expect(data.savedPath).toBeDefined();
    expect(data.savedPath).toMatch(/^wiki\/entities\/artifacts\//);

    // Verify the file was actually saved to disk
    const absPath = join(TEST_ROOT, data.savedPath);
    expect(existsSync(absPath)).toBe(true);
    const savedContent = readFileSync(absPath, "utf-8");
    expect(savedContent).toContain("type: artifact");
    expect(savedContent).toContain("format: blog-post");
  });

  it("returns 400 for missing theme", async () => {
    const { POST } = await import(
      "@/app/api/brain/compile-originals/route"
    );

    const request = new Request(
      "http://localhost/api/brain/compile-originals",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ format: "memo" }),
      }
    );

    const response = await POST(request);
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain("theme");
  });

  it("returns 400 for invalid format", async () => {
    const { POST } = await import(
      "@/app/api/brain/compile-originals/route"
    );

    const request = new Request(
      "http://localhost/api/brain/compile-originals",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          theme: "neural scaling",
          format: "invalid-format",
        }),
      }
    );

    const response = await POST(request);
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain("Invalid format");
  });

  it("returns 404 when theme does not match any cluster", async () => {
    // Write 3 originals in one theme but request a different theme
    writeOriginal(
      "scaling-a",
      "neural network scaling laws predict loss but not capability jumps in parameters",
      "observation",
      "2026-03-01",
      ["neural", "network", "scaling", "parameters", "training", "loss", "capability"]
    );
    writeOriginal(
      "scaling-b",
      "neural network scaling shows emergence as phase transition not smooth curve in parameters",
      "hypothesis",
      "2026-03-05",
      ["neural", "network", "scaling", "parameters", "capability", "emergent", "loss"]
    );
    writeOriginal(
      "scaling-c",
      "neural networks need critical mass of scaling parameters before reasoning capability appears",
      "observation",
      "2026-03-10",
      ["neural", "network", "scaling", "parameters", "reasoning", "capability", "loss"]
    );

    const { POST } = await import(
      "@/app/api/brain/compile-originals/route"
    );

    const request = new Request(
      "http://localhost/api/brain/compile-originals",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          theme: "nonexistent theme xyz",
          format: "memo",
        }),
      }
    );

    const response = await POST(request);
    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error).toContain("No compilable theme found");
  });

  it("returns 400 for invalid JSON body", async () => {
    const { POST } = await import(
      "@/app/api/brain/compile-originals/route"
    );

    const request = new Request(
      "http://localhost/api/brain/compile-originals",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not-json",
      }
    );

    const response = await POST(request);
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain("Invalid JSON");
  });
});

// ── Tests: jaccardSimilarity ─────────────────────────

describe("jaccardSimilarity", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("returns 1.0 for identical sets", async () => {
    const { jaccardSimilarity } = await import(
      "@/brain/originals-artifacts"
    );
    const a = new Set(["neural", "network", "scaling"]);
    const b = new Set(["neural", "network", "scaling"]);
    expect(jaccardSimilarity(a, b)).toBe(1.0);
  });

  it("returns 0 for completely disjoint sets", async () => {
    const { jaccardSimilarity } = await import(
      "@/brain/originals-artifacts"
    );
    const a = new Set(["neural", "network"]);
    const b = new Set(["protein", "folding"]);
    expect(jaccardSimilarity(a, b)).toBe(0);
  });

  it("returns 0 for two empty sets", async () => {
    const { jaccardSimilarity } = await import(
      "@/brain/originals-artifacts"
    );
    expect(jaccardSimilarity(new Set(), new Set())).toBe(0);
  });

  it("computes correct partial overlap", async () => {
    const { jaccardSimilarity } = await import(
      "@/brain/originals-artifacts"
    );
    // {a, b, c} vs {b, c, d} => intersection=2, union=4 => 0.5
    const a = new Set(["a", "b", "c"]);
    const b = new Set(["b", "c", "d"]);
    expect(jaccardSimilarity(a, b)).toBe(0.5);
  });
});
