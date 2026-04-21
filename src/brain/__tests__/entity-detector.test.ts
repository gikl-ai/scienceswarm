/**
 * Tests for the Science Entity Detection system.
 *
 * Covers:
 * - Fast-path regex detection (arXiv, DOIs, authors, methods, datasets)
 * - Original thinking detection (via mocked LLM)
 * - Back-link creation
 * - Duplicate original detection
 * - Full onChatMessage flow with mocked LLM
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { fastDetect, detectEntities, slugify } from "../entity-detector";
import { saveOriginal, updateOriginal, searchOriginals } from "../originals";
import { ensureBacklinks, auditBacklinks } from "../backlink";
import { onChatMessage } from "../chat-entity-hook";
import type { BrainConfig } from "../types";
import type { LLMClient } from "../llm";

// ── Test Fixtures ────────────────────────────────────

const TEST_ROOT = join(__dirname, "__test-brain__");

function makeConfig(): BrainConfig {
  return {
    root: TEST_ROOT,
    extractionModel: "gpt-4.1-mini",
    synthesisModel: "gpt-4.1",
    rippleCap: 5,
    paperWatchBudget: 10,
    serendipityRate: 0,
  };
}

function mockLLM(response: string): LLMClient {
  return {
    async complete() {
      return {
        content: response,
        cost: {
          inputTokens: 100,
          outputTokens: 50,
          estimatedUsd: 0.001,
          model: "gpt-4.1-mini",
        },
      };
    },
  };
}

function setupTestBrain(): void {
  mkdirSync(join(TEST_ROOT, "wiki/originals"), { recursive: true });
  mkdirSync(join(TEST_ROOT, "wiki/entities/papers"), { recursive: true });
  mkdirSync(join(TEST_ROOT, "wiki/entities/people"), { recursive: true });
  mkdirSync(join(TEST_ROOT, "wiki/concepts"), { recursive: true });
  mkdirSync(join(TEST_ROOT, "wiki/resources/data"), { recursive: true });
}

function teardownTestBrain(): void {
  if (existsSync(TEST_ROOT)) {
    rmSync(TEST_ROOT, { recursive: true, force: true });
  }
}

// ── Fast-Path Regex Detection ────────────────────────

describe("fastDetect", () => {
  it("detects arXiv IDs", () => {
    const result = fastDetect(
      "Check out the paper at arXiv:2301.12345v2 for more details"
    );
    const papers = result.filter((e) => e.type === "paper");
    expect(papers.length).toBeGreaterThanOrEqual(1);

    const arxivPaper = papers.find((e) => e.identifiers.arxiv);
    expect(arxivPaper).toBeDefined();
    expect(arxivPaper!.identifiers.arxiv).toBe("2301.12345v2");
    expect(arxivPaper!.confidence).toBe("high");
  });

  it("detects bare arXiv IDs without prefix", () => {
    const result = fastDetect("The paper 2401.08890 is really interesting");
    const papers = result.filter(
      (e) => e.type === "paper" && e.identifiers.arxiv
    );
    expect(papers.length).toBe(1);
    expect(papers[0].identifiers.arxiv).toBe("2401.08890");
  });

  it("detects DOIs", () => {
    const result = fastDetect(
      "Published at 10.1038/s41586-023-06747-5 in Nature"
    );
    const papers = result.filter((e) => e.identifiers.doi);
    expect(papers.length).toBe(1);
    expect(papers[0].identifiers.doi).toBe("10.1038/s41586-023-06747-5");
    expect(papers[0].confidence).toBe("high");
  });

  it("detects Author et al. references", () => {
    const result = fastDetect(
      "As shown by Vaswani et al. (2017), attention is all you need"
    );
    const authors = result.filter((e) => e.type === "author");
    expect(authors.length).toBeGreaterThanOrEqual(1);
    expect(authors[0].name).toBe("Vaswani");
  });

  it("detects Author (Year) references", () => {
    const result = fastDetect(
      "Building on the work of Hinton (2012) and LeCun (1998)"
    );
    const authors = result.filter((e) => e.type === "author");
    expect(authors.length).toBe(2);
    expect(authors.map((a) => a.name).sort()).toEqual(["Hinton", "LeCun"]);
  });

  it("detects ML methods", () => {
    const result = fastDetect(
      "We used a transformer with flash attention and LoRA fine-tuning"
    );
    const methods = result.filter((e) => e.type === "method");
    expect(methods.length).toBeGreaterThanOrEqual(2);
    const names = methods.map((m) => m.name.toLowerCase());
    expect(names).toContain("transformer");
    expect(names).toContain("flash attention");
  });

  it("detects bio methods", () => {
    const result = fastDetect(
      "We ran CRISPR-Cas9 knockouts and confirmed with Western blot"
    );
    const methods = result.filter((e) => e.type === "method");
    expect(methods.length).toBeGreaterThanOrEqual(2);
    const names = methods.map((m) => m.name.toLowerCase());
    expect(names).toContain("crispr-cas9");
    expect(names).toContain("western blot");
  });

  it("detects datasets", () => {
    const result = fastDetect(
      "We evaluated on MMLU, ImageNet, and GSM8K benchmarks"
    );
    const datasets = result.filter((e) => e.type === "dataset");
    expect(datasets.length).toBe(3);
    const names = datasets.map((d) => d.name.toLowerCase());
    expect(names).toContain("mmlu");
    expect(names).toContain("imagenet");
    expect(names).toContain("gsm8k");
  });

  it("deduplicates entities", () => {
    const result = fastDetect(
      "The arXiv:2301.12345 paper by arXiv:2301.12345 authors"
    );
    const arxivPapers = result.filter(
      (e) => e.type === "paper" && e.identifiers.arxiv === "2301.12345"
    );
    expect(arxivPapers.length).toBe(1);
  });

  it("returns empty for operational messages", async () => {
    const result = await detectEntities("git push origin main");
    expect(result.isOperational).toBe(true);
    expect(result.entities).toHaveLength(0);
  });

  it("returns empty for short messages", async () => {
    const result = await detectEntities("ok");
    expect(result.isOperational).toBe(true);
  });
});

// ── LLM Detection ────────────────────────────────────

describe("detectEntities with LLM", () => {
  it("detects original thinking via LLM", async () => {
    const llm = mockLLM(
      JSON.stringify({
        entities: [],
        originals: [
          {
            verbatim:
              "retrieval beats reasoning because knowledge lives in weights",
            kind: "hypothesis",
            suggestedSlug:
              "retrieval-beats-reasoning-because-knowledge-in-weights",
            relatedEntities: ["RAG", "transformer"],
          },
        ],
      })
    );

    const result = await detectEntities(
      "I think retrieval beats reasoning because knowledge lives in weights",
      { llm }
    );

    expect(result.originals.length).toBe(1);
    expect(result.originals[0].kind).toBe("hypothesis");
    expect(result.originals[0].verbatim).toContain("retrieval beats reasoning");
  });

  it("merges fast and LLM entities without duplicates", async () => {
    const llm = mockLLM(
      JSON.stringify({
        entities: [
          {
            type: "concept",
            name: "attention mechanism",
            identifiers: {},
            confidence: "high",
            span: "attention",
          },
          {
            type: "author",
            name: "Hinton",
            identifiers: {},
            confidence: "medium",
            span: "Hinton",
          },
        ],
        originals: [],
      })
    );

    const result = await detectEntities(
      "The transformer architecture by Hinton (2020) uses attention",
      { llm }
    );

    // Should not have duplicate transformers or Hintons
    const transformers = result.entities.filter(
      (e) => e.name.toLowerCase() === "transformer"
    );
    expect(transformers.length).toBeLessThanOrEqual(1);
  });

  it("gracefully handles LLM errors", async () => {
    const llm: LLMClient = {
      async complete() {
        throw new Error("API error");
      },
    };

    const result = await detectEntities(
      "Check the Vaswani et al. (2017) paper on transformers",
      { llm }
    );

    // Should still have fast-path results
    expect(result.entities.length).toBeGreaterThan(0);
    expect(result.originals).toHaveLength(0);
  });
});

// ── Originals ────────────────────────────────────────

describe("originals", () => {
  beforeEach(setupTestBrain);
  afterEach(teardownTestBrain);

  it("saves a new original", () => {
    const config = makeConfig();
    const path = saveOriginal(
      config,
      {
        verbatim: "meatsuit maintenance is the real bottleneck",
        kind: "hot_take",
        suggestedSlug: "meatsuit-maintenance-bottleneck",
        relatedEntities: [],
      },
      "chat about productivity"
    );

    expect(path).toBe("wiki/originals/meatsuit-maintenance-bottleneck.md");
    const content = readFileSync(join(TEST_ROOT, path), "utf-8");
    expect(content).toContain("meatsuit maintenance is the real bottleneck");
    expect(content).toContain("## Compiled Truth");
    expect(content).toContain("## Timeline");
    expect(content).toContain("First captured");
  });

  it("appends to existing original on duplicate", () => {
    const config = makeConfig();
    const original = {
      verbatim: "meatsuit maintenance is the real bottleneck",
      kind: "hot_take" as const,
      suggestedSlug: "meatsuit-maintenance-bottleneck",
      relatedEntities: [],
    };

    // First save
    const path1 = saveOriginal(config, original, "first chat");

    // Second save with same content
    const path2 = saveOriginal(config, original, "second chat");

    // Should update existing rather than create new
    expect(path2).toBe(path1);
    const content = readFileSync(join(TEST_ROOT, path1), "utf-8");
    expect(content).toContain("Mentioned again");
  });

  it("updates an existing original timeline", () => {
    const config = makeConfig();
    const path = saveOriginal(
      config,
      {
        verbatim: "test original thought",
        kind: "observation",
        suggestedSlug: "test-original-thought",
        relatedEntities: [],
      },
      "initial context"
    );

    updateOriginal(config, path, {
      date: "2025-01-15",
      context: "followup conversation",
      verbatim: "test original thought, but stronger",
    });

    const content = readFileSync(join(TEST_ROOT, path), "utf-8");
    expect(content).toContain("2025-01-15");
    expect(content).toContain("followup conversation");
  });

  it("searches originals folder", () => {
    const config = makeConfig();
    saveOriginal(
      config,
      {
        verbatim: "protein folding is underrated",
        kind: "hot_take",
        suggestedSlug: "protein-folding-underrated",
        relatedEntities: [],
      },
      "chat"
    );

    const results = searchOriginals(config, "protein folding");
    expect(results.length).toBe(1);
    expect(results[0].path).toContain("protein-folding");
  });
});

// ── Back-links ───────────────────────────────────────

describe("backlinks", () => {
  beforeEach(setupTestBrain);
  afterEach(teardownTestBrain);

  it("adds a back-link to an entity page", () => {
    const config = makeConfig();

    // Create a target entity page
    const entityPath = "wiki/entities/papers/test-paper.md";
    writeFileSync(
      join(TEST_ROOT, entityPath),
      "# Test Paper\n\n## Summary\nA test paper.\n"
    );

    ensureBacklinks(
      config,
      entityPath,
      "wiki/originals/my-thought.md",
      "Discussed this paper's methodology",
      "2025-01-10"
    );

    const content = readFileSync(join(TEST_ROOT, entityPath), "utf-8");
    expect(content).toContain("## References");
    expect(content).toContain("2025-01-10");
    expect(content).toContain("my-thought.md");
    expect(content).toContain("Discussed this paper's methodology");
  });

  it("does not duplicate back-links", () => {
    const config = makeConfig();

    const entityPath = "wiki/entities/papers/test-paper.md";
    writeFileSync(
      join(TEST_ROOT, entityPath),
      "# Test Paper\n\n## Summary\nA test paper.\n"
    );

    ensureBacklinks(
      config,
      entityPath,
      "wiki/originals/my-thought.md",
      "context",
      "2025-01-10"
    );
    ensureBacklinks(
      config,
      entityPath,
      "wiki/originals/my-thought.md",
      "context",
      "2025-01-10"
    );

    const content = readFileSync(join(TEST_ROOT, entityPath), "utf-8");
    const matches = content.match(/Referenced in/g);
    expect(matches?.length).toBe(1);
  });

  it("appends to existing timeline section", () => {
    const config = makeConfig();

    const entityPath = "wiki/entities/papers/test-paper.md";
    writeFileSync(
      join(TEST_ROOT, entityPath),
      "# Test Paper\n\n## Summary\nA test paper.\n\n## Timeline\n\n- **2025-01-01** | Paper ingested\n"
    );

    ensureBacklinks(
      config,
      entityPath,
      "wiki/originals/my-thought.md",
      "Referenced this paper",
      "2025-01-10"
    );

    const content = readFileSync(join(TEST_ROOT, entityPath), "utf-8");
    expect(content).toContain("## Timeline");
    expect(content).toContain("2025-01-10");
    // Should not create a duplicate References section
    expect(content.match(/## References/g)).toBeNull();
  });

  it("audits missing back-links", () => {
    const config = makeConfig();

    // Create a page with a wikilink
    writeFileSync(
      join(TEST_ROOT, "wiki/concepts/attention.md"),
      "# Attention\n\nSee also [[concepts/transformer]].\n"
    );

    // Create the target without a back-link
    writeFileSync(
      join(TEST_ROOT, "wiki/concepts/transformer.md"),
      "# Transformer\n\nA neural network architecture.\n"
    );

    const audit = auditBacklinks(config);
    expect(audit.totalPages).toBe(2);
    expect(audit.totalWikilinks).toBeGreaterThanOrEqual(1);
    expect(audit.missingBacklinks.length).toBeGreaterThanOrEqual(1);
    expect(audit.healthScore).toBeLessThan(1);
  });
});

// ── Chat Entity Hook ─────────────────────────────────

describe("onChatMessage", () => {
  beforeEach(setupTestBrain);
  afterEach(teardownTestBrain);

  it("returns entity context for a science message", async () => {
    const config = makeConfig();
    const llm = mockLLM(JSON.stringify({ entities: [], originals: [] }));

    // Create a page that will match
    writeFileSync(
      join(TEST_ROOT, "wiki/concepts/transformer.md"),
      "# Transformer\n\nA neural network architecture using attention.\n"
    );

    const context = await onChatMessage(
      config,
      llm,
      "How does the transformer handle long sequences?"
    );

    // Should detect transformer as a method entity
    expect(
      context.knownEntities.length + context.newEntities.length
    ).toBeGreaterThanOrEqual(1);
  });

  it("returns empty context for operational messages", async () => {
    const config = makeConfig();
    const llm = mockLLM(JSON.stringify({ entities: [], originals: [] }));

    const context = await onChatMessage(
      config,
      llm,
      "git push origin main"
    );

    expect(context.relevantPages).toHaveLength(0);
    expect(context.knownEntities).toHaveLength(0);
    expect(context.newEntities).toHaveLength(0);
  });
});

// ── Slugify ──────────────────────────────────────────

describe("slugify", () => {
  it("converts text to a URL-safe slug", () => {
    expect(slugify("Hello World!")).toBe("hello-world");
    expect(slugify("arXiv:2301.12345")).toBe("arxiv-2301-12345");
    expect(slugify("  leading/trailing  ")).toBe("leading-trailing");
  });

  it("truncates long slugs", () => {
    const long = "a".repeat(200);
    expect(slugify(long).length).toBeLessThanOrEqual(80);
  });
});
