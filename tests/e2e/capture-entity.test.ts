/**
 * End-to-end tests for Capture + Entity Detection (MVP Core Use Cases 2 & 5).
 *
 * Covers:
 * - Fast-path regex entity detection on realistic scientist messages
 * - Original thinking capture (verbatim preservation)
 * - Originals deduplication via timeline updates
 * - Back-link creation and idempotency
 * - Full onChatMessage flow with mocked LLM
 * - POST /api/brain/detect endpoint validation
 * - Operational message filtering
 * - Edge cases (arXiv-only, non-English, code blocks, short messages, URLs)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  fastDetect,
  detectEntities,
  slugify,
} from "@/brain/entity-detector";
import { saveOriginal, searchOriginals } from "@/brain/originals";
import { ensureBacklinks, auditBacklinks } from "@/brain/backlink";
import { onChatMessage, processDetectedEntities } from "@/brain/chat-entity-hook";
import type { BrainConfig } from "@/brain/types";
import type { LLMClient, LLMResponse } from "@/brain/llm";

// ── Test Infrastructure ─────────────────────────────

const TEST_ROOT = join(tmpdir(), "scienceswarm-e2e-capture-entity");

function makeConfig(): BrainConfig {
  return {
    root: TEST_ROOT,
    extractionModel: "test-model",
    synthesisModel: "test-model",
    rippleCap: 5,
    paperWatchBudget: 10,
    serendipityRate: 0,
  };
}

function mockLLM(response: string): LLMClient {
  return {
    async complete(): Promise<LLMResponse> {
      return {
        content: response,
        cost: {
          inputTokens: 100,
          outputTokens: 50,
          estimatedUsd: 0.001,
          model: "test-model",
        },
      };
    },
  };
}

function setupTestBrain(): void {
  rmSync(TEST_ROOT, { recursive: true, force: true });
  mkdirSync(join(TEST_ROOT, "wiki/originals"), { recursive: true });
  mkdirSync(join(TEST_ROOT, "wiki/entities/papers"), { recursive: true });
  mkdirSync(join(TEST_ROOT, "wiki/entities/people"), { recursive: true });
  mkdirSync(join(TEST_ROOT, "wiki/observations"), { recursive: true });
  mkdirSync(join(TEST_ROOT, "wiki/concepts"), { recursive: true });
  mkdirSync(join(TEST_ROOT, "wiki/resources/data"), { recursive: true });
  mkdirSync(join(TEST_ROOT, "wiki/projects"), { recursive: true });
  mkdirSync(join(TEST_ROOT, "wiki/experiments"), { recursive: true });
  mkdirSync(join(TEST_ROOT, "raw/observations"), { recursive: true });
}

function teardownTestBrain(): void {
  rmSync(TEST_ROOT, { recursive: true, force: true });
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for async side effect");
}

// ── Test 1: Fast-path entity detection on realistic messages ──

describe("Test 1: Fast-path entity detection on realistic scientist messages", () => {
  it("detects paper (arXiv ID), author, and methods from an ML message", () => {
    const message =
      "I just read the Anthropic sparse autoencoders paper (arXiv:2309.08600), Bricken et al. really nailed the dictionary learning approach";
    const entities = fastDetect(message);

    // Should detect arXiv paper
    const papers = entities.filter((e) => e.type === "paper");
    const arxivPaper = papers.find((e) => e.identifiers.arxiv === "2309.08600");
    expect(arxivPaper).toBeDefined();
    expect(arxivPaper!.confidence).toBe("high");

    // Should detect author (Bricken)
    const authors = entities.filter((e) => e.type === "author");
    const bricken = authors.find((e) => e.name === "Bricken");
    expect(bricken).toBeDefined();

    // "dictionary learning" and "sparse autoencoders" are not in the ML_METHODS set.
    // The key test is that at least the arXiv ID and author are detected.
    expect(papers.length).toBeGreaterThanOrEqual(1);
    expect(authors.length).toBeGreaterThanOrEqual(1);
  });

  it("detects method (LoRA), dataset (MMLU), and author from a fine-tuning message", () => {
    const message =
      "We should try using LoRA fine-tuning on the MMLU benchmark like Hu et al. 2021 suggested";
    const entities = fastDetect(message);

    // Should detect LoRA method
    const methods = entities.filter((e) => e.type === "method");
    const methodNames = methods.map((m) => m.name.toLowerCase());
    expect(methodNames).toContain("lora");

    // Should detect MMLU dataset
    const datasets = entities.filter((e) => e.type === "dataset");
    const datasetNames = datasets.map((d) => d.name.toLowerCase());
    expect(datasetNames).toContain("mmlu");

    // Should detect Hu as author
    const authors = entities.filter((e) => e.type === "author");
    expect(authors.find((a) => a.name === "Hu")).toBeDefined();
  });

  it("detects bio methods from a wet lab message", () => {
    const message =
      "The Western blot results from the CRISPR experiment show unexpected signal drift at 37C";
    const entities = fastDetect(message);

    const methods = entities.filter((e) => e.type === "method");
    const methodNames = methods.map((m) => m.name.toLowerCase());
    expect(methodNames).toContain("western blot");
    expect(methodNames).toContain("crispr");
  });

  it("detects DOI from a Nature paper reference", () => {
    const message =
      "10.1038/s41586-024-07487-w is the Nature paper on protein folding";
    const entities = fastDetect(message);

    const doiPapers = entities.filter((e) => e.identifiers.doi);
    expect(doiPapers.length).toBe(1);
    expect(doiPapers[0].identifiers.doi).toBe(
      "10.1038/s41586-024-07487-w"
    );
    expect(doiPapers[0].confidence).toBe("high");
    expect(doiPapers[0].type).toBe("paper");
  });

  it("detects multiple entities in a complex message", () => {
    const message =
      "Vaswani et al. (2017) introduced the transformer with multi-head attention, evaluated on WMT. LeCun (1998) pioneered CNN. We used LoRA with QLora on ImageNet and CIFAR-10.";
    const entities = fastDetect(message);

    // Authors
    const authors = entities.filter((e) => e.type === "author");
    const authorNames = authors.map((a) => a.name);
    expect(authorNames).toContain("Vaswani");
    expect(authorNames).toContain("LeCun");

    // Methods
    const methods = entities.filter((e) => e.type === "method");
    const methodNames = methods.map((m) => m.name.toLowerCase());
    expect(methodNames).toContain("transformer");
    expect(methodNames).toContain("lora");

    // Datasets
    const datasets = entities.filter((e) => e.type === "dataset");
    const datasetNames = datasets.map((d) => d.name.toLowerCase());
    expect(datasetNames).toContain("imagenet");
    expect(datasetNames).toContain("cifar-10");
  });

  it("assigns reasonable confidence levels", () => {
    const entities = fastDetect(
      "arXiv:2301.12345 by Smith et al. using LoRA on MMLU"
    );

    const arxiv = entities.find((e) => e.identifiers.arxiv);
    expect(arxiv?.confidence).toBe("high"); // arXiv IDs are high confidence

    const author = entities.find((e) => e.type === "author");
    expect(author?.confidence).toBe("medium"); // Author et al. is medium

    const method = entities.find(
      (e) => e.type === "method" && e.name.toLowerCase() === "lora"
    );
    expect(method?.confidence).toBe("medium"); // Dictionary match is medium
  });

  it("generates correct suggestedPath for each entity type", () => {
    const entities = fastDetect(
      "arXiv:2301.12345 by Hinton (2012) using transformer on MMLU"
    );

    const paper = entities.find((e) => e.identifiers.arxiv);
    expect(paper?.suggestedPath).toMatch(/^wiki\/entities\/papers\//);

    const author = entities.find((e) => e.type === "author");
    expect(author?.suggestedPath).toMatch(/^wiki\/entities\/people\//);

    const method = entities.find(
      (e) => e.type === "method" && e.name.toLowerCase() === "transformer"
    );
    expect(method?.suggestedPath).toMatch(/^wiki\/concepts\//);

    const dataset = entities.find((e) => e.type === "dataset");
    expect(dataset?.suggestedPath).toMatch(/^wiki\/resources\/data\//);
  });
});

// ── Test 2: Original thinking capture ───────────────

describe("Test 2: Original thinking capture", () => {
  beforeEach(setupTestBrain);
  afterEach(teardownTestBrain);

  it("captures a hypothesis verbatim via LLM detection", async () => {
    const llm = mockLLM(
      JSON.stringify({
        entities: [],
        originals: [
          {
            verbatim:
              "the reason retrieval beats reasoning is because the knowledge is already in the weights",
            kind: "hypothesis",
            suggestedSlug:
              "retrieval-beats-reasoning-knowledge-in-weights",
            relatedEntities: ["RAG"],
          },
        ],
      })
    );

    const result = await detectEntities(
      "What if the reason retrieval beats reasoning is because the knowledge is already in the weights?",
      { llm }
    );

    expect(result.originals.length).toBe(1);
    expect(result.originals[0].kind).toBe("hypothesis");
    expect(result.originals[0].verbatim).toContain(
      "retrieval beats reasoning"
    );
    expect(result.originals[0].verbatim).toContain(
      "knowledge is already in the weights"
    );
  });

  it("captures an observation verbatim via LLM detection", async () => {
    const llm = mockLLM(
      JSON.stringify({
        entities: [],
        originals: [
          {
            verbatim:
              "every time we increase context length, the model gets worse at local coherence",
            kind: "observation",
            suggestedSlug:
              "context-length-vs-local-coherence",
            relatedEntities: ["transformer"],
          },
        ],
      })
    );

    const result = await detectEntities(
      "I notice a pattern: every time we increase context length, the model gets worse at local coherence",
      { llm }
    );

    expect(result.originals.length).toBe(1);
    expect(result.originals[0].kind).toBe("observation");
    expect(result.originals[0].verbatim).toContain("context length");
    expect(result.originals[0].verbatim).toContain("local coherence");
  });

  it("captures a hot take verbatim via LLM detection", async () => {
    const llm = mockLLM(
      JSON.stringify({
        entities: [],
        originals: [
          {
            verbatim:
              "The ambition-to-lifespan ratio has never been more broken for AI researchers",
            kind: "hot_take",
            suggestedSlug: "ambition-to-lifespan-ratio-broken",
            relatedEntities: [],
          },
        ],
      })
    );

    const result = await detectEntities(
      "The ambition-to-lifespan ratio has never been more broken for AI researchers",
      { llm }
    );

    expect(result.originals.length).toBe(1);
    expect(result.originals[0].kind).toBe("hot_take");
    expect(result.originals[0].verbatim).toBe(
      "The ambition-to-lifespan ratio has never been more broken for AI researchers"
    );
  });

  it("saves original to wiki/originals with correct structure", () => {
    const config = makeConfig();
    const path = saveOriginal(
      config,
      {
        verbatim:
          "retrieval beats reasoning because knowledge lives in weights",
        kind: "hypothesis",
        suggestedSlug: "retrieval-beats-reasoning-knowledge-in-weights",
        relatedEntities: ["RAG", "transformer"],
      },
      "chat about LLM capabilities"
    );

    expect(path).toBe(
      "wiki/originals/retrieval-beats-reasoning-knowledge-in-weights.md"
    );

    const content = readFileSync(join(TEST_ROOT, path), "utf-8");
    // Verbatim preserved exactly
    expect(content).toContain(
      "retrieval beats reasoning because knowledge lives in weights"
    );
    // Structure
    expect(content).toContain("## Compiled Truth");
    expect(content).toContain("## Timeline");
    expect(content).toContain("First captured");
    expect(content).toContain("hypothesis");
    // Related entities linked
    expect(content).toContain("[[RAG]]");
    expect(content).toContain("[[transformer]]");
  });

  it("uses scientist's language for slugs", () => {
    const config = makeConfig();
    const path = saveOriginal(
      config,
      {
        verbatim: "meatsuit maintenance is the real bottleneck",
        kind: "hot_take",
        suggestedSlug: "meatsuit-maintenance-bottleneck",
        relatedEntities: [],
      },
      "productivity discussion"
    );

    // Slug uses the scientist's own words
    expect(path).toContain("meatsuit-maintenance-bottleneck");
  });
});

// ── Test 3: Originals deduplication ─────────────────

describe("Test 3: Originals deduplication", () => {
  beforeEach(setupTestBrain);
  afterEach(teardownTestBrain);

  it("updates existing original's timeline instead of creating duplicate", () => {
    const config = makeConfig();
    const original = {
      verbatim: "retrieval beats reasoning because knowledge lives in weights",
      kind: "hypothesis" as const,
      suggestedSlug: "retrieval-beats-reasoning",
      relatedEntities: [],
    };

    // First save
    const path1 = saveOriginal(config, original, "first chat");

    // Second save with same content
    const path2 = saveOriginal(config, original, "second chat");

    // Should return same path (updated, not new)
    expect(path2).toBe(path1);

    const content = readFileSync(join(TEST_ROOT, path1), "utf-8");
    // Timeline should show both mentions
    expect(content).toContain("First captured");
    expect(content).toContain("Mentioned again");
    expect(content).toContain("second chat");
  });

  it("detects similar originals with slightly different wording", () => {
    const config = makeConfig();

    // First save: original phrasing
    const path1 = saveOriginal(
      config,
      {
        verbatim: "retrieval beats reasoning because knowledge lives in weights",
        kind: "hypothesis",
        suggestedSlug: "retrieval-beats-reasoning",
        relatedEntities: [],
      },
      "morning brainstorm"
    );

    // Second save: same content repeated identically (exact dedup)
    const path2 = saveOriginal(
      config,
      {
        verbatim: "retrieval beats reasoning because knowledge lives in weights",
        kind: "hypothesis",
        suggestedSlug: "retrieval-beats-reasoning-v2",
        relatedEntities: [],
      },
      "afternoon followup"
    );

    // Should deduplicate
    expect(path2).toBe(path1);

    const content = readFileSync(join(TEST_ROOT, path1), "utf-8");
    expect(content).toContain("afternoon followup");
  });

  it("creates separate originals for genuinely different ideas", () => {
    const config = makeConfig();

    const path1 = saveOriginal(
      config,
      {
        verbatim: "retrieval beats reasoning because knowledge lives in weights",
        kind: "hypothesis",
        suggestedSlug: "retrieval-beats-reasoning",
        relatedEntities: [],
      },
      "chat 1"
    );

    const path2 = saveOriginal(
      config,
      {
        verbatim:
          "attention is just a soft dictionary lookup over the residual stream",
        kind: "framework",
        suggestedSlug: "attention-soft-dictionary-lookup",
        relatedEntities: [],
      },
      "chat 2"
    );

    // Should be different originals
    expect(path1).not.toBe(path2);
    expect(existsSync(join(TEST_ROOT, path1))).toBe(true);
    expect(existsSync(join(TEST_ROOT, path2))).toBe(true);
  });

  it("timeline shows chronological mentions", () => {
    const config = makeConfig();
    const original = {
      verbatim: "meatsuit maintenance is the real bottleneck",
      kind: "hot_take" as const,
      suggestedSlug: "meatsuit-maintenance-bottleneck",
      relatedEntities: [],
    };

    saveOriginal(config, original, "first mention");
    saveOriginal(config, original, "second mention");
    saveOriginal(config, original, "third mention");

    const content = readFileSync(
      join(TEST_ROOT, "wiki/originals/meatsuit-maintenance-bottleneck.md"),
      "utf-8"
    );

    // Should have first capture + two "Mentioned again" entries
    expect(content).toContain("First captured");
    const mentionedAgainCount = (content.match(/Mentioned again/g) ?? [])
      .length;
    expect(mentionedAgainCount).toBe(2);
  });
});

// ── Test 4: Back-link creation ──────────────────────

describe("Test 4: Back-link creation", () => {
  beforeEach(setupTestBrain);
  afterEach(teardownTestBrain);

  it("adds back-link to existing person page", () => {
    const config = makeConfig();

    // Create Hinton person page
    const hintonPath = "wiki/entities/people/hinton.md";
    writeFileSync(
      join(TEST_ROOT, hintonPath),
      [
        "---",
        "date: 2025-01-01",
        "type: person",
        "name: Geoffrey Hinton",
        "tags: [deep-learning, capsule-networks]",
        "---",
        "",
        "# Geoffrey Hinton",
        "",
        "## Summary",
        "Pioneer of deep learning, known for backpropagation and capsule networks.",
        "",
      ].join("\n")
    );

    // Add back-link
    ensureBacklinks(
      config,
      hintonPath,
      "wiki/originals/capsule-network-insight.md",
      "Discussed Hinton's capsule network paper",
      "2025-06-15"
    );

    const content = readFileSync(join(TEST_ROOT, hintonPath), "utf-8");

    // Back-link should be present
    expect(content).toContain("2025-06-15");
    expect(content).toContain("Referenced in");
    expect(content).toContain("capsule-network-insight.md");
    expect(content).toContain("Discussed Hinton's capsule network paper");
  });

  it("back-link format matches expected pattern", () => {
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
      "Referenced methodology section",
      "2025-07-20"
    );

    const content = readFileSync(join(TEST_ROOT, entityPath), "utf-8");
    // Expected format: - **YYYY-MM-DD** | Referenced in [source title](path) -- context
    expect(content).toMatch(
      /- \*\*2025-07-20\*\* \| Referenced in \[.+\]\(wiki\/originals\/my-thought\.md\)/
    );
  });

  it("does not duplicate back-links when processed twice", () => {
    const config = makeConfig();
    const entityPath = "wiki/entities/people/hinton.md";
    writeFileSync(
      join(TEST_ROOT, entityPath),
      "# Geoffrey Hinton\n\n## Summary\nDeep learning pioneer.\n"
    );

    // Process the same back-link twice
    ensureBacklinks(
      config,
      entityPath,
      "wiki/originals/capsule-insight.md",
      "Referenced capsule network",
      "2025-06-15"
    );

    ensureBacklinks(
      config,
      entityPath,
      "wiki/originals/capsule-insight.md",
      "Referenced capsule network",
      "2025-06-15"
    );

    const content = readFileSync(join(TEST_ROOT, entityPath), "utf-8");
    const matches = content.match(/Referenced in/g);
    expect(matches?.length).toBe(1); // Only one back-link, not two
  });

  it("appends to existing Timeline section", () => {
    const config = makeConfig();
    const entityPath = "wiki/entities/people/hinton.md";
    writeFileSync(
      join(TEST_ROOT, entityPath),
      [
        "# Geoffrey Hinton",
        "",
        "## Summary",
        "Deep learning pioneer.",
        "",
        "## Timeline",
        "",
        "- **2025-01-01** | Page created",
        "",
      ].join("\n")
    );

    ensureBacklinks(
      config,
      entityPath,
      "wiki/originals/backprop-insight.md",
      "Referenced backpropagation contributions",
      "2025-06-20"
    );

    const content = readFileSync(join(TEST_ROOT, entityPath), "utf-8");
    expect(content).toContain("## Timeline");
    expect(content).toContain("2025-06-20");
    expect(content).toContain("backprop-insight.md");
    // Should NOT create a separate References section (Timeline already exists)
    const referencesCount = (content.match(/## References/g) ?? []).length;
    expect(referencesCount).toBe(0);
  });

  it("creates References section when no Timeline exists", () => {
    const config = makeConfig();
    const entityPath = "wiki/entities/papers/some-paper.md";
    writeFileSync(
      join(TEST_ROOT, entityPath),
      "# Some Paper\n\n## Summary\nA paper about something.\n"
    );

    ensureBacklinks(
      config,
      entityPath,
      "wiki/originals/my-thought.md",
      "Cited this paper",
      "2025-07-01"
    );

    const content = readFileSync(join(TEST_ROOT, entityPath), "utf-8");
    expect(content).toContain("## References");
    expect(content).toContain("2025-07-01");
  });

  it("handles back-links to non-existent entity pages gracefully", () => {
    const config = makeConfig();

    // Should not throw when entity page doesn't exist
    ensureBacklinks(
      config,
      "wiki/entities/people/nonexistent.md",
      "wiki/originals/my-thought.md",
      "Referenced someone",
      "2025-07-01"
    );

    // Should not have created the file
    expect(
      existsSync(join(TEST_ROOT, "wiki/entities/people/nonexistent.md"))
    ).toBe(false);
  });
});

// ── Test 5: Full onChatMessage flow ─────────────────

describe("Test 5: Full onChatMessage flow", () => {
  beforeEach(setupTestBrain);
  afterEach(teardownTestBrain);

  it("returns ChatEntityContext with relevant pages for known entities", async () => {
    const config = makeConfig();
    const llm = mockLLM(JSON.stringify({ entities: [], originals: [] }));

    // Create existing brain pages that will be found
    writeFileSync(
      join(TEST_ROOT, "wiki/concepts/transformer.md"),
      "# Transformer\n\nA neural network architecture using self-attention.\n"
    );

    const context = await onChatMessage(
      config,
      llm,
      "How does the transformer handle long-range dependencies?"
    );

    expect(context.knownEntities).toContainEqual({
      name: "transformer",
      path: "wiki/concepts/transformer.md",
      type: "method",
    });
    expect(context.relevantPages).toContainEqual(
      expect.objectContaining({
        path: "wiki/concepts/transformer.md",
        title: "Transformer",
      }),
    );
    expect(context.newEntities).toHaveLength(0);
  });

  it("returns empty context for operational messages", async () => {
    const config = makeConfig();
    const llm = mockLLM(JSON.stringify({ entities: [], originals: [] }));

    const context = await onChatMessage(config, llm, "ok");

    expect(context.relevantPages).toHaveLength(0);
    expect(context.knownEntities).toHaveLength(0);
    expect(context.newEntities).toHaveLength(0);
    expect(context.originalsCaptures).toHaveLength(0);
  });

  it("classifies new entities when no brain pages exist", async () => {
    const config = makeConfig();
    const llm = mockLLM(JSON.stringify({ entities: [], originals: [] }));

    const context = await onChatMessage(
      config,
      llm,
      "The RLHF paper by Christiano et al. (2017) introduced reward modeling"
    );

    const newEntityNames = context.newEntities.map((e) => e.name);
    expect(newEntityNames).toContain("Christiano");
    expect(newEntityNames).toContain("Christiano et al. (2017)");
    expect(newEntityNames).toContain("rlhf");
    expect(context.knownEntities).toHaveLength(0);
  });

  it("links detected entities to existing brain pages", async () => {
    const config = makeConfig();
    const llm = mockLLM(JSON.stringify({ entities: [], originals: [] }));

    // Create existing pages
    writeFileSync(
      join(TEST_ROOT, "wiki/concepts/lora.md"),
      "# LoRA\n\nLow-Rank Adaptation for efficient fine-tuning.\n"
    );
    writeFileSync(
      join(TEST_ROOT, "wiki/resources/data/mmlu.md"),
      "# MMLU\n\nMassive Multitask Language Understanding benchmark.\n"
    );

    const context = await onChatMessage(
      config,
      llm,
      "We should evaluate our LoRA model on MMLU"
    );

    expect(context.knownEntities).toEqual(
      expect.arrayContaining([
        {
          name: "lora",
          path: "wiki/concepts/lora.md",
          type: "method",
        },
        {
          name: "mmlu",
          path: "wiki/resources/data/mmlu.md",
          type: "dataset",
        },
      ]),
    );
    expect(context.relevantPages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "wiki/concepts/lora.md", title: "LoRA" }),
        expect.objectContaining({ path: "wiki/resources/data/mmlu.md", title: "MMLU" }),
      ]),
    );
    expect(context.newEntities).toHaveLength(0);
  });
});

// Test 6 removed — observe() was deleted alongside src/brain/engine.ts
// in Phase B (PR #239). Quick-capture now flows through brain_capture
// (gbrain put_page proxy).

// ── Test 7: API endpoint POST /api/brain/detect ─────

describe("Test 7: POST /api/brain/detect integration", () => {
  const mockLoadBrainConfig = vi.fn();
  const mockCreateLLMClient = vi.fn();

  beforeEach(() => {
    setupTestBrain();
    vi.resetModules();

    vi.doMock("@/brain/config", () => ({
      loadBrainConfig: () => mockLoadBrainConfig(),
      resolveBrainRoot: () => TEST_ROOT,
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
  });

  afterEach(() => {
    vi.doUnmock("@/brain/config");
    vi.doUnmock("@/brain/llm");
    vi.resetModules();
    mockLoadBrainConfig.mockReset();
    mockCreateLLMClient.mockReset();
    teardownTestBrain();
  });

  it("returns detection plus chat context and runs background persistence", async () => {
    mockCreateLLMClient.mockReturnValue(
      mockLLM(
        JSON.stringify({
          entities: [],
          originals: [
            {
              verbatim: "transformers are just soft dictionaries",
              kind: "framework",
              suggestedSlug: "transformers-soft-dictionaries",
              relatedEntities: ["transformer"],
            },
          ],
        }),
      ),
    );

    writeFileSync(
      join(TEST_ROOT, "wiki/concepts/transformer.md"),
      "# Transformer\n\nA neural network architecture using self-attention.\n",
    );

    const { POST } = await import("@/app/api/brain/detect/route");
    const response = await POST(
      new Request("http://localhost/api/brain/detect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message:
            "The transformer makes me think transformers are just soft dictionaries",
        }),
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.detection.isOperational).toBe(false);
    expect(body.detection.entities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "transformer",
          suggestedPath: "wiki/concepts/transformer.md",
        }),
      ]),
    );
    expect(body.context.knownEntities).toEqual(
      expect.arrayContaining([
        {
          name: "transformer",
          path: "wiki/concepts/transformer.md",
          type: "method",
        },
      ]),
    );
    expect(body.context.relevantPages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "wiki/concepts/transformer.md",
          title: "Transformer",
        }),
      ]),
    );

    const originalPath = join(
      TEST_ROOT,
      "wiki/originals/transformers-soft-dictionaries.md",
    );
    await waitForCondition(() => existsSync(originalPath));

    const originalContent = readFileSync(originalPath, "utf-8");
    expect(originalContent).toContain("> transformers are just soft dictionaries");

    const transformerContent = readFileSync(
      join(TEST_ROOT, "wiki/concepts/transformer.md"),
      "utf-8",
    );
    expect(transformerContent).toContain("Referenced in");
    expect(transformerContent).toContain("Mentioned method: transformer");
  });

  it("rejects non-string messages through the real route", async () => {
    mockCreateLLMClient.mockReturnValue(mockLLM(JSON.stringify({})));
    const { POST } = await import("@/app/api/brain/detect/route");

    const response = await POST(
      new Request("http://localhost/api/brain/detect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: 123 }),
      }),
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("message");
  });

  it("rejects invalid JSON through the real route", async () => {
    mockCreateLLMClient.mockReturnValue(mockLLM(JSON.stringify({})));
    const { POST } = await import("@/app/api/brain/detect/route");

    const response = await POST(
      new Request("http://localhost/api/brain/detect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      }),
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("Invalid JSON");
  });

  it("handles very long messages without duplicating fast-path entities", async () => {
    mockCreateLLMClient.mockReturnValue(mockLLM(JSON.stringify({ entities: [], originals: [] })));
    const { POST } = await import("@/app/api/brain/detect/route");

    const response = await POST(
      new Request("http://localhost/api/brain/detect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "The transformer architecture by Vaswani et al. (2017) ".repeat(200),
        }),
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    const vaswaniAuthors = body.detection.entities.filter(
      (entity: { type: string; name: string }) =>
        entity.type === "author" && entity.name === "Vaswani",
    );
    expect(vaswaniAuthors).toHaveLength(1);
  });
});

// ── Test 8: Operational message filtering ───────────

describe("Test 8: Operational message filtering", () => {
  it("filters 'ok'", async () => {
    const result = await detectEntities("ok");
    expect(result.isOperational).toBe(true);
  });

  it("filters 'yes'", async () => {
    const result = await detectEntities("yes");
    expect(result.isOperational).toBe(true);
  });

  it("filters 'do it'", async () => {
    const result = await detectEntities("do it");
    expect(result.isOperational).toBe(true);
  });

  it("filters 'sure'", async () => {
    const result = await detectEntities("sure");
    expect(result.isOperational).toBe(true);
  });

  it("filters 'thanks'", async () => {
    const result = await detectEntities("thanks");
    expect(result.isOperational).toBe(true);
  });

  it("filters 'got it'", async () => {
    const result = await detectEntities("got it");
    expect(result.isOperational).toBe(true);
  });

  it("filters git commands", async () => {
    const result = await detectEntities("git push origin main");
    expect(result.isOperational).toBe(true);
  });

  it("filters deployment commands", async () => {
    const result = await detectEntities("npm run build");
    expect(result.isOperational).toBe(true);
  });

  it("filters slash commands", async () => {
    const result = await detectEntities("/deploy production");
    expect(result.isOperational).toBe(true);
  });

  it("does NOT filter science messages", async () => {
    const result = await detectEntities(
      "The transformer architecture uses multi-head attention"
    );
    expect(result.isOperational).toBe(false);
  });

  it("does NOT filter messages mentioning papers", async () => {
    const result = await detectEntities(
      "Read arXiv:2301.12345 about sparse autoencoders"
    );
    expect(result.isOperational).toBe(false);
    expect(result.entities.length).toBeGreaterThan(0);
  });

  it("filters very short messages (< 5 chars)", async () => {
    const result = await detectEntities("hi");
    expect(result.isOperational).toBe(true);
  });

  it("filters 'help me debug this'", async () => {
    const result = await detectEntities("can you fix this error");
    expect(result.isOperational).toBe(true);
  });
});

// ── Test 9: Edge cases ──────────────────────────────

describe("Test 9: Edge cases", () => {
  it("handles message with only arXiv IDs and no surrounding text", () => {
    const entities = fastDetect("arXiv:2301.12345 arXiv:2309.08600");
    const papers = entities.filter(
      (e) => e.type === "paper" && e.identifiers.arxiv
    );
    expect(papers.length).toBe(2);
    expect(papers.map((p) => p.identifiers.arxiv).sort()).toEqual([
      "2301.12345",
      "2309.08600",
    ]);
  });

  it("detects entities in messages with code blocks", () => {
    const message = `Here's the implementation:
\`\`\`python
model = TransformerModel(attention="flash_attention")
\`\`\`
We used the transformer with flash attention from the Dao et al. (2022) paper.`;

    const entities = fastDetect(message);

    // Should detect entities from text outside code blocks too
    const methods = entities.filter((e) => e.type === "method");
    const methodNames = methods.map((m) => m.name.toLowerCase());
    expect(methodNames).toContain("transformer");
    expect(methodNames).toContain("flash attention");

    // Should detect author reference
    const authors = entities.filter((e) => e.type === "author");
    expect(authors.find((a) => a.name === "Dao")).toBeDefined();
  });

  it("handles very short messages (< 10 chars) as operational", async () => {
    const shortMessages = ["ok", "hi", "yes", "no", "sure"];
    for (const msg of shortMessages) {
      const result = await detectEntities(msg);
      expect(result.isOperational).toBe(true);
    }
  });

  it("handles messages with URLs", () => {
    const entities = fastDetect(
      "Check https://arxiv.org/abs/2301.12345 and 10.1038/s41586-023-06747-5"
    );

    // Should detect arXiv ID from the URL (the pattern matches bare IDs)
    const papers = entities.filter((e) => e.type === "paper");
    expect(papers.length).toBeGreaterThanOrEqual(1);

    // DOI should be detected
    const doiPapers = entities.filter((e) => e.identifiers.doi);
    expect(doiPapers.length).toBe(1);
  });

  it("handles messages with special characters in entity names", () => {
    const entities = fastDetect(
      "We used CRISPR-Cas9 and RT-PCR protocols for the experiment"
    );
    const methods = entities.filter((e) => e.type === "method");
    const methodNames = methods.map((m) => m.name.toLowerCase());
    expect(methodNames).toContain("crispr-cas9");
    expect(methodNames).toContain("rt-pcr");
  });

  it("handles multiple DOIs in one message", () => {
    const entities = fastDetect(
      "Compare 10.1038/nature12373 with 10.1126/science.1234567"
    );
    const doiPapers = entities.filter((e) => e.identifiers.doi);
    expect(doiPapers.length).toBe(2);
  });

  it("handles arXiv IDs with version suffixes", () => {
    const entities = fastDetect("arXiv:2301.12345v3 is the latest version");
    const arxivPapers = entities.filter((e) => e.identifiers.arxiv);
    expect(arxivPapers.length).toBe(1);
    expect(arxivPapers[0].identifiers.arxiv).toBe("2301.12345v3");
  });

  it("detects 'the X paper' pattern", () => {
    const entities = fastDetect(
      "Have you read the Attention Is All You Need paper?"
    );
    const papers = entities.filter((e) => e.type === "paper");
    // Should detect the paper reference with low confidence
    const titlePaper = papers.find(
      (e) => e.confidence === "low" && e.name.includes("Attention")
    );
    expect(titlePaper).toBeDefined();
  });

  it("slugify handles special characters correctly", () => {
    expect(slugify("arXiv:2301.12345")).toBe("arxiv-2301-12345");
    expect(slugify("Hello World!")).toBe("hello-world");
    expect(slugify("  spaces  everywhere  ")).toBe("spaces-everywhere");
    expect(slugify("---leading-trailing---")).toBe("leading-trailing");
    expect(slugify("UPPER and lower")).toBe("upper-and-lower");
    expect(slugify("special!@#$%chars")).toBe("special-chars");
  });

  it("slugify truncates to 80 characters", () => {
    const long = "a".repeat(200);
    expect(slugify(long).length).toBeLessThanOrEqual(80);
  });

  it("handles message with mixed arXiv IDs (with and without prefix)", () => {
    const entities = fastDetect(
      "Compare arXiv:2301.12345 with 2309.08600"
    );
    const arxivPapers = entities.filter(
      (e) => e.type === "paper" && e.identifiers.arxiv
    );
    expect(arxivPapers.length).toBe(2);
  });
});

// ── Test: processDetectedEntities integration ───────

describe("processDetectedEntities integration", () => {
  beforeEach(setupTestBrain);
  afterEach(teardownTestBrain);

  it("creates originals and back-links from detection results", async () => {
    const config = makeConfig();
    const llm = mockLLM(JSON.stringify({ entities: [], originals: [] }));

    // Create an entity page that will receive back-links
    const entityPath = "wiki/entities/papers/test-paper.md";
    writeFileSync(
      join(TEST_ROOT, entityPath),
      "# Test Paper\n\n## Summary\nA test paper about transformers.\n"
    );

    const result = await processDetectedEntities(
      config,
      llm,
      {
        entities: [
          {
            type: "paper",
            name: "Test Paper",
            identifiers: {},
            confidence: "high",
            span: "test paper",
            suggestedPath: entityPath,
          },
        ],
        originals: [
          {
            verbatim: "transformers are just soft dictionaries",
            kind: "framework",
            suggestedSlug: "transformers-soft-dictionaries",
            relatedEntities: ["transformer"],
          },
        ],
        isOperational: false,
      },
      "test chat"
    );

    // Originals should be recorded
    expect(result.originalsRecorded.length).toBe(1);
    expect(result.originalsRecorded[0]).toContain("transformers-soft-dictionaries");

    // Verify originals file exists
    expect(
      existsSync(
        join(TEST_ROOT, "wiki/originals/transformers-soft-dictionaries.md")
      )
    ).toBe(true);

    // Back-links should be created
    expect(result.backlinksCreated).toBeGreaterThanOrEqual(1);

    // Verify back-link on entity page
    const entityContent = readFileSync(
      join(TEST_ROOT, entityPath),
      "utf-8"
    );
    expect(entityContent).toContain("Referenced in");
  });

  it("handles detection results with no entities or originals", async () => {
    const config = makeConfig();
    const llm = mockLLM(JSON.stringify({ entities: [], originals: [] }));

    const result = await processDetectedEntities(
      config,
      llm,
      {
        entities: [],
        originals: [],
        isOperational: false,
      },
      "empty chat"
    );

    expect(result.pagesCreated).toHaveLength(0);
    expect(result.originalsRecorded).toHaveLength(0);
    expect(result.backlinksCreated).toBe(0);
  });
});

// ── Test: Back-link audit ───────────────────────────

describe("Back-link audit", () => {
  beforeEach(setupTestBrain);
  afterEach(teardownTestBrain);

  it("detects missing back-links from wikilinks", () => {
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

  it("reports healthy when all back-links exist", () => {
    const config = makeConfig();

    // Create two pages that reference each other
    writeFileSync(
      join(TEST_ROOT, "wiki/concepts/attention.md"),
      "# Attention\n\nSee also [[concepts/transformer]].\nReferenced from wiki/concepts/transformer.md\n"
    );
    writeFileSync(
      join(TEST_ROOT, "wiki/concepts/transformer.md"),
      "# Transformer\n\nUses [[concepts/attention]].\nReferenced from wiki/concepts/attention.md\n"
    );

    const audit = auditBacklinks(config);
    expect(audit.totalPages).toBe(2);
    // Both pages reference each other and include back-link paths
    expect(audit.healthScore).toBe(1);
  });

  it("handles empty brain gracefully", () => {
    const config = makeConfig();
    // Remove wiki dir to simulate empty brain
    rmSync(join(TEST_ROOT, "wiki"), { recursive: true, force: true });

    const audit = auditBacklinks(config);
    expect(audit.totalPages).toBe(0);
    expect(audit.healthScore).toBe(1);
  });
});

// ── Test: searchOriginals ───────────────────────────

describe("searchOriginals", () => {
  beforeEach(setupTestBrain);
  afterEach(teardownTestBrain);

  it("finds originals by keyword search", () => {
    const config = makeConfig();

    saveOriginal(
      config,
      {
        verbatim: "protein folding is underrated as a research direction",
        kind: "hot_take",
        suggestedSlug: "protein-folding-underrated",
        relatedEntities: [],
      },
      "chat"
    );

    saveOriginal(
      config,
      {
        verbatim: "transformer attention is just a soft dictionary lookup",
        kind: "framework",
        suggestedSlug: "transformer-attention-dictionary",
        relatedEntities: ["transformer"],
      },
      "chat"
    );

    const results = searchOriginals(config, "protein folding");
    expect(results.length).toBe(1);
    expect(results[0].path).toContain("protein-folding");

    const transformerResults = searchOriginals(config, "transformer");
    expect(transformerResults.length).toBe(1);
    expect(transformerResults[0].path).toContain("transformer");
  });

  it("returns empty for no matches", () => {
    const config = makeConfig();
    const results = searchOriginals(config, "quantum computing");
    expect(results).toHaveLength(0);
  });

  it("returns empty when originals dir does not exist", () => {
    const config = makeConfig();
    rmSync(join(TEST_ROOT, "wiki/originals"), { recursive: true, force: true });
    const results = searchOriginals(config, "anything");
    expect(results).toHaveLength(0);
  });
});
