import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import matter from "gray-matter";
import {
  parseBibtex,
  parseRIS,
  parseBibtexAuthors,
  deduplicateReferences,
  importReferences,
  jaccardSimilarity,
} from "@/brain/bibtex-import";
import type { BrainConfig } from "@/brain/types";

// ── Fixtures ──────────────────────────────────────────

const SAMPLE_BIBTEX = `
@article{vaswani2017attention,
  title     = {Attention Is All You Need},
  author    = {Vaswani, Ashish and Shazeer, Noam and Parmar, Niki and Uszkoreit, Jakob and Jones, Llion and Gomez, Aidan N and Kaiser, Lukasz and Polosukhin, Illia},
  journal   = {Advances in Neural Information Processing Systems},
  volume    = {30},
  year      = {2017},
  doi       = {10.48550/arXiv.1706.03762},
  keywords  = {transformers, attention, deep learning},
  abstract  = {The dominant sequence transduction models are based on complex recurrent or convolutional neural networks.}
}

@inproceedings{devlin2019bert,
  title     = {BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding},
  author    = {Devlin, Jacob and Chang, Ming-Wei and Lee, Kenton and Toutanova, Kristina},
  booktitle = {Proceedings of NAACL-HLT},
  year      = {2019},
  doi       = {10.18653/v1/N19-1423},
  abstract  = {We introduce a new language representation model called BERT.}
}

@misc{brown2020gpt3,
  title         = {Language Models are Few-Shot Learners},
  author        = {Brown, Tom B. and Mann, Benjamin and Ryder, Nick},
  year          = {2020},
  eprint        = {2005.14165},
  archiveprefix = {arXiv},
  primaryclass  = {cs.CL}
}

@book{bishop2006pattern,
  title     = {Pattern Recognition and Machine Learning},
  author    = {Bishop, Christopher M.},
  year      = {2006},
  publisher = {Springer},
  keywords  = {machine learning, pattern recognition, statistics}
}

@phdthesis{mikolov2012thesis,
  title   = {Statistical Language Models Based on Neural Networks},
  author  = {Mikolov, Tom\\'{a}\\v{s}},
  year    = {2012},
  school  = {Brno University of Technology}
}

@article{lecun1998gradient,
  title   = {Gradient-based learning applied to document recognition},
  author  = {LeCun, Yann and Bottou, L{\\'e}on and Bengio, Yoshua and Haffner, Patrick},
  journal = {Proceedings of the IEEE},
  year    = {1998},
  volume  = {86},
  number  = {11},
  doi     = {10.1109/5.726791}
}
`;

const SAMPLE_RIS = `TY  - JOUR
TI  - Attention Is All You Need
AU  - Vaswani, Ashish
AU  - Shazeer, Noam
AU  - Parmar, Niki
PY  - 2017
JO  - Advances in Neural Information Processing Systems
DO  - 10.48550/arXiv.1706.03762
AB  - The dominant sequence transduction models are based on complex recurrent or convolutional neural networks.
KW  - transformers
KW  - attention
ER  -

TY  - CONF
TI  - BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding
AU  - Devlin, Jacob
AU  - Chang, Ming-Wei
AU  - Lee, Kenton
AU  - Toutanova, Kristina
PY  - 2019
T2  - Proceedings of NAACL-HLT
DO  - 10.18653/v1/N19-1423
KW  - NLP
KW  - pre-training
ER  -

TY  - GEN
TI  - Language Models are Few-Shot Learners
AU  - Brown, Tom B.
AU  - Mann, Benjamin
PY  - 2020
UR  - https://arxiv.org/abs/2005.14165
ER  -
`;

// ── Test helpers ──────────────────────────────────────

function makeBrainDir(): string {
  const root = join(tmpdir(), `brain-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(join(root, "wiki/entities/papers"), { recursive: true });
  writeFileSync(join(root, "BRAIN.md"), "# Test Brain\n");
  return root;
}

function makeConfig(root: string): BrainConfig {
  return {
    root,
    extractionModel: "gpt-4.1-mini",
    synthesisModel: "gpt-4.1",
    rippleCap: 15,
    paperWatchBudget: 50,
    serendipityRate: 0.2,
  };
}

function mockLLM() {
  return {
    complete: vi.fn().mockResolvedValue({
      content: "mock response",
      cost: { inputTokens: 0, outputTokens: 0, estimatedUsd: 0, model: "mock" },
    }),
  };
}

// ── BibTeX parsing tests ──────────────────────────────

describe("parseBibtex", () => {
  it("parses 6 entries from realistic BibTeX", () => {
    const refs = parseBibtex(SAMPLE_BIBTEX);
    expect(refs).toHaveLength(6);
  });

  it("extracts correct fields from @article", () => {
    const refs = parseBibtex(SAMPLE_BIBTEX);
    const vaswani = refs.find((r) => r.bibtexKey === "vaswani2017attention");
    expect(vaswani).toBeDefined();
    expect(vaswani!.title).toBe("Attention Is All You Need");
    expect(vaswani!.authors).toContain("Ashish Vaswani");
    expect(vaswani!.authors).toContain("Noam Shazeer");
    expect(vaswani!.authors).toHaveLength(8);
    expect(vaswani!.year).toBe(2017);
    expect(vaswani!.venue).toBe("Advances in Neural Information Processing Systems");
    expect(vaswani!.doi).toBe("10.48550/arXiv.1706.03762");
    expect(vaswani!.entryType).toBe("article");
    expect(vaswani!.keywords).toContain("transformers");
    expect(vaswani!.keywords).toContain("attention");
    expect(vaswani!.abstract).toContain("dominant sequence transduction");
  });

  it("extracts correct fields from @inproceedings", () => {
    const refs = parseBibtex(SAMPLE_BIBTEX);
    const bert = refs.find((r) => r.bibtexKey === "devlin2019bert");
    expect(bert).toBeDefined();
    expect(bert!.title).toBe("BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding");
    expect(bert!.authors).toHaveLength(4);
    expect(bert!.venue).toBe("Proceedings of NAACL-HLT");
    expect(bert!.entryType).toBe("inproceedings");
  });

  it("extracts arXiv ID from eprint field", () => {
    const refs = parseBibtex(SAMPLE_BIBTEX);
    const gpt3 = refs.find((r) => r.bibtexKey === "brown2020gpt3");
    expect(gpt3).toBeDefined();
    expect(gpt3!.arxiv).toBe("2005.14165");
    expect(gpt3!.entryType).toBe("misc");
  });

  it("extracts correct fields from @book", () => {
    const refs = parseBibtex(SAMPLE_BIBTEX);
    const bishop = refs.find((r) => r.bibtexKey === "bishop2006pattern");
    expect(bishop).toBeDefined();
    expect(bishop!.title).toBe("Pattern Recognition and Machine Learning");
    expect(bishop!.authors).toEqual(["Christopher M. Bishop"]);
    expect(bishop!.year).toBe(2006);
    expect(bishop!.venue).toBe("Springer");
    expect(bishop!.entryType).toBe("book");
  });

  it("handles LaTeX escape sequences in author names", () => {
    const refs = parseBibtex(SAMPLE_BIBTEX);
    const lecun = refs.find((r) => r.bibtexKey === "lecun1998gradient");
    expect(lecun).toBeDefined();
    // L\\'e -> should decode the e-acute in "Leon"
    const leonAuthor = lecun!.authors.find((a) => a.includes("on"));
    expect(leonAuthor).toBeDefined();
    // Should have the accent character or at minimum be cleaned
    expect(leonAuthor).toMatch(/L.on/); // L + some char + on
  });

  it("preserves rawEntry for provenance", () => {
    const refs = parseBibtex(SAMPLE_BIBTEX);
    for (const ref of refs) {
      expect(ref.rawEntry.length).toBeGreaterThan(10);
      expect(ref.rawEntry).toContain(ref.bibtexKey ?? "");
    }
  });

  it("skips entries without titles", () => {
    const broken = `@article{notitle, author={Smith, John}, year={2023}}`;
    const refs = parseBibtex(broken);
    expect(refs).toHaveLength(0);
  });

  it("handles missing optional fields gracefully", () => {
    const minimal = `@article{minimal2023, title={A Minimal Entry}, author={Doe, Jane}, year={2023}}`;
    const refs = parseBibtex(minimal);
    expect(refs).toHaveLength(1);
    expect(refs[0].title).toBe("A Minimal Entry");
    expect(refs[0].doi).toBeUndefined();
    expect(refs[0].arxiv).toBeUndefined();
    expect(refs[0].abstract).toBeUndefined();
    expect(refs[0].keywords).toEqual([]);
    expect(refs[0].venue).toBe("");
  });

  it("handles special characters in titles", () => {
    const special = `@article{special2023,
      title={The \\"{u}ber-effect: A \\& B in \\$10\\% of cases},
      author={M\\"{u}ller, Hans},
      year={2023}
    }`;
    const refs = parseBibtex(special);
    expect(refs).toHaveLength(1);
    expect(refs[0].title).toContain("ber-effect");
    expect(refs[0].title).toContain("&");
  });
});

describe("parseBibtexAuthors", () => {
  it("parses Last, First and Last, First format", () => {
    const authors = parseBibtexAuthors("Vaswani, Ashish and Shazeer, Noam");
    expect(authors).toEqual(["Ashish Vaswani", "Noam Shazeer"]);
  });

  it("parses First Last and First Last format", () => {
    const authors = parseBibtexAuthors("Ashish Vaswani and Noam Shazeer");
    expect(authors).toEqual(["Ashish Vaswani", "Noam Shazeer"]);
  });

  it("handles single author", () => {
    const authors = parseBibtexAuthors("Bishop, Christopher M.");
    expect(authors).toEqual(["Christopher M. Bishop"]);
  });

  it("handles empty string", () => {
    const authors = parseBibtexAuthors("");
    expect(authors).toEqual([]);
  });

  it("handles multi-part last names with comma format", () => {
    const authors = parseBibtexAuthors("Van der Waals, Johannes");
    expect(authors).toEqual(["Johannes Van der Waals"]);
  });
});

// ── RIS parsing tests ─────────────────────────────────

describe("parseRIS", () => {
  it("parses 3 entries from realistic RIS", () => {
    const refs = parseRIS(SAMPLE_RIS);
    expect(refs).toHaveLength(3);
  });

  it("extracts correct fields from JOUR entry", () => {
    const refs = parseRIS(SAMPLE_RIS);
    const vaswani = refs.find((r) => r.title === "Attention Is All You Need");
    expect(vaswani).toBeDefined();
    expect(vaswani!.authors).toEqual(["Ashish Vaswani", "Noam Shazeer", "Niki Parmar"]);
    expect(vaswani!.year).toBe(2017);
    expect(vaswani!.venue).toBe("Advances in Neural Information Processing Systems");
    expect(vaswani!.doi).toBe("10.48550/arXiv.1706.03762");
    expect(vaswani!.entryType).toBe("article");
    expect(vaswani!.keywords).toContain("transformers");
    expect(vaswani!.keywords).toContain("attention");
    expect(vaswani!.abstract).toContain("dominant sequence transduction");
  });

  it("extracts correct fields from CONF entry", () => {
    const refs = parseRIS(SAMPLE_RIS);
    const bert = refs.find((r) => r.title.includes("BERT"));
    expect(bert).toBeDefined();
    expect(bert!.authors).toHaveLength(4);
    expect(bert!.venue).toBe("Proceedings of NAACL-HLT");
    expect(bert!.entryType).toBe("inproceedings");
  });

  it("extracts arXiv ID from URL field", () => {
    const refs = parseRIS(SAMPLE_RIS);
    const gpt3 = refs.find((r) => r.title.includes("Few-Shot"));
    expect(gpt3).toBeDefined();
    expect(gpt3!.arxiv).toBe("2005.14165");
  });

  it("preserves rawEntry for provenance", () => {
    const refs = parseRIS(SAMPLE_RIS);
    for (const ref of refs) {
      expect(ref.rawEntry).toContain("TY");
      expect(ref.rawEntry).toContain("ER");
    }
  });

  it("handles entries with missing titles gracefully", () => {
    const broken = `TY  - JOUR\nAU  - Smith, John\nPY  - 2023\nER  -\n`;
    const refs = parseRIS(broken);
    expect(refs).toHaveLength(0);
  });

  it("handles RIS with Windows line endings", () => {
    const winRIS = "TY  - JOUR\r\nTI  - Windows Test\r\nAU  - Smith, John\r\nPY  - 2023\r\nER  -\r\n";
    const refs = parseRIS(winRIS);
    expect(refs).toHaveLength(1);
    expect(refs[0].title).toBe("Windows Test");
  });
});

// ── Jaccard similarity tests ──────────────────────────

describe("jaccardSimilarity", () => {
  it("returns 1.0 for identical strings", () => {
    expect(jaccardSimilarity("Attention Is All You Need", "Attention Is All You Need")).toBe(1);
  });

  it("returns 0 for completely different strings", () => {
    const score = jaccardSimilarity("Attention Is All You Need", "Quantum Computing Fundamentals");
    expect(score).toBe(0);
  });

  it("returns high score for near-identical titles", () => {
    const score = jaccardSimilarity(
      "Attention Is All You Need",
      "Attention is All You Need"
    );
    expect(score).toBeGreaterThan(0.8);
  });

  it("returns moderate score for partially overlapping titles", () => {
    const score = jaccardSimilarity(
      "Deep Learning for Natural Language Processing",
      "Deep Learning Methods for Computer Vision"
    );
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(0.8);
  });

  it("handles empty strings", () => {
    expect(jaccardSimilarity("", "anything")).toBe(0);
    expect(jaccardSimilarity("anything", "")).toBe(0);
    expect(jaccardSimilarity("", "")).toBe(0);
  });
});

// ── Deduplication tests ───────────────────────────────

describe("deduplicateReferences", () => {
  let brainRoot: string;
  let config: BrainConfig;

  beforeEach(() => {
    brainRoot = makeBrainDir();
    config = makeConfig(brainRoot);
  });

  afterEach(() => {
    rmSync(brainRoot, { recursive: true, force: true });
  });

  it("marks all refs as new when brain is empty", async () => {
    const refs = parseBibtex(SAMPLE_BIBTEX);
    const result = await deduplicateReferences(refs, config);
    expect(result.newRefs).toHaveLength(refs.length);
    expect(result.matchedRefs).toHaveLength(0);
    expect(result.stats.total).toBe(refs.length);
    expect(result.stats.new).toBe(refs.length);
    expect(result.stats.matched).toBe(0);
  });

  it("detects exact DOI match", async () => {
    // Create existing page with matching DOI
    const existingPage = matter.stringify(
      "# Attention Is All You Need\n\nExisting page.",
      {
        title: "Attention Is All You Need",
        date: "2024-01-01",
        type: "paper",
        para: "resources",
        tags: [],
        authors: ["Ashish Vaswani"],
        year: 2017,
        venue: "NeurIPS",
        doi: "10.48550/arXiv.1706.03762",
      }
    );
    writeFileSync(
      join(brainRoot, "wiki/entities/papers/vaswani-2017-attention.md"),
      existingPage
    );

    const refs = parseBibtex(SAMPLE_BIBTEX);
    const result = await deduplicateReferences(refs, config);

    const doiMatch = result.matchedRefs.find((m) => m.matchType === "doi");
    expect(doiMatch).toBeDefined();
    expect(doiMatch!.ref.title).toBe("Attention Is All You Need");
    expect(doiMatch!.existingPath).toBe("wiki/entities/papers/vaswani-2017-attention.md");
    expect(result.stats.matched).toBeGreaterThanOrEqual(1);
    expect(result.stats.new).toBe(result.stats.total - result.stats.matched);
  });

  it("detects arXiv ID match", async () => {
    const existingPage = matter.stringify(
      "# GPT-3\n\nExisting page.",
      {
        title: "Language Models are Few-Shot Learners",
        date: "2024-01-01",
        type: "paper",
        para: "resources",
        tags: [],
        authors: ["Tom B. Brown"],
        year: 2020,
        venue: "NeurIPS",
        arxiv: "2005.14165",
      }
    );
    writeFileSync(
      join(brainRoot, "wiki/entities/papers/brown-2020-gpt3.md"),
      existingPage
    );

    const refs = parseBibtex(SAMPLE_BIBTEX);
    const result = await deduplicateReferences(refs, config);

    const arxivMatch = result.matchedRefs.find((m) => m.matchType === "arxiv");
    expect(arxivMatch).toBeDefined();
    expect(arxivMatch!.ref.arxiv).toBe("2005.14165");
    expect(arxivMatch!.existingPath).toBe("wiki/entities/papers/brown-2020-gpt3.md");
  });

  it("detects fuzzy title match", async () => {
    const existingPage = matter.stringify(
      "# Pattern Recognition\n\nExisting page.",
      {
        title: "Pattern Recognition and Machine Learning",
        date: "2024-01-01",
        type: "paper",
        para: "resources",
        tags: [],
        authors: ["Christopher Bishop"],
        year: 2006,
        venue: "Springer",
      }
    );
    writeFileSync(
      join(brainRoot, "wiki/entities/papers/bishop-2006-pattern.md"),
      existingPage
    );

    const refs = parseBibtex(SAMPLE_BIBTEX);
    const result = await deduplicateReferences(refs, config);

    const titleMatch = result.matchedRefs.find((m) => m.matchType === "title");
    expect(titleMatch).toBeDefined();
    expect(titleMatch!.ref.title).toBe("Pattern Recognition and Machine Learning");
  });

  it("does not false-positive on dissimilar titles", async () => {
    const existingPage = matter.stringify(
      "# Quantum Supremacy\n\nExisting page.",
      {
        title: "Quantum Supremacy Using a Programmable Superconducting Processor",
        date: "2024-01-01",
        type: "paper",
        para: "resources",
        tags: [],
        authors: ["Frank Arute"],
        year: 2019,
        venue: "Nature",
      }
    );
    writeFileSync(
      join(brainRoot, "wiki/entities/papers/arute-2019-quantum.md"),
      existingPage
    );

    const refs = parseBibtex(SAMPLE_BIBTEX);
    const result = await deduplicateReferences(refs, config);

    // None of the BibTeX entries should match the quantum paper
    const falseMatch = result.matchedRefs.find(
      (m) => m.existingPath === "wiki/entities/papers/arute-2019-quantum.md"
    );
    expect(falseMatch).toBeUndefined();
  });
});

// ── Import flow tests ─────────────────────────────────

describe("importReferences", () => {
  let brainRoot: string;
  let config: BrainConfig;

  beforeEach(() => {
    brainRoot = makeBrainDir();
    config = makeConfig(brainRoot);
  });

  afterEach(() => {
    rmSync(brainRoot, { recursive: true, force: true });
  });

  it("creates paper pages for new references", async () => {
    const refs = parseBibtex(SAMPLE_BIBTEX);
    const llm = mockLLM();

    const result = await importReferences(config, llm, refs);

    expect(result.pagesCreated).toHaveLength(6);
    expect(result.pagesSkipped).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    // Verify files were actually written
    for (const pagePath of result.pagesCreated) {
      const absPath = join(brainRoot, pagePath);
      expect(existsSync(absPath)).toBe(true);

      // Verify frontmatter
      const content = readFileSync(absPath, "utf-8");
      const parsed = matter(content);
      expect(parsed.data.type).toBe("paper");
      expect(parsed.data.title).toBeTruthy();
      expect(parsed.data.authors).toBeInstanceOf(Array);
      expect((parsed.data.authors as string[]).length).toBeGreaterThan(0);
      expect(typeof parsed.data.year).toBe("number");
    }
  });

  it("creates pages with correct slug format", async () => {
    const refs = parseBibtex(`@article{test2023, title={Hello World Test}, author={Smith, John}, year={2023}}`);
    const llm = mockLLM();

    const result = await importReferences(config, llm, refs);

    expect(result.pagesCreated).toHaveLength(1);
    expect(result.pagesCreated[0]).toMatch(/wiki\/entities\/papers\/smith-2023-hello/);
  });

  it("skips duplicates and reports them", async () => {
    // Create existing page
    const existingPage = matter.stringify("# Existing\n", {
      title: "Attention Is All You Need",
      date: "2024-01-01",
      type: "paper",
      para: "resources",
      tags: [],
      authors: ["Ashish Vaswani"],
      year: 2017,
      venue: "NeurIPS",
      doi: "10.48550/arXiv.1706.03762",
    });
    writeFileSync(
      join(brainRoot, "wiki/entities/papers/vaswani-2017-attention.md"),
      existingPage
    );

    const refs = parseBibtex(SAMPLE_BIBTEX);
    const llm = mockLLM();

    const result = await importReferences(config, llm, refs);

    // 1 matched (DOI match for vaswani) = 1 skipped, 5 created
    expect(result.pagesCreated).toHaveLength(5);
    expect(result.pagesSkipped).toBe(1);
  });

  it("enriches matched pages when enrichMatches is true", async () => {
    // Create existing page WITHOUT doi but with matching title
    const existingPage = matter.stringify("# Existing\n", {
      title: "Pattern Recognition and Machine Learning",
      date: "2024-01-01",
      type: "paper",
      para: "resources",
      tags: ["ml"],
      authors: ["Christopher Bishop"],
      year: 2006,
      venue: "Springer",
    });
    const existingPath = join(brainRoot, "wiki/entities/papers/bishop-2006-pattern.md");
    writeFileSync(existingPath, existingPage);

    // The BibTeX entry has keywords that should be merged
    const refs = parseBibtex(SAMPLE_BIBTEX);
    const llm = mockLLM();

    const result = await importReferences(config, llm, refs, { enrichMatches: true });

    // Bishop entry should be enriched (new keywords added)
    expect(result.pagesEnriched.length).toBeGreaterThanOrEqual(1);

    // Read back the enriched file and check tags were merged
    const enrichedContent = readFileSync(existingPath, "utf-8");
    const enrichedParsed = matter(enrichedContent);
    const tags = enrichedParsed.data.tags as string[];
    expect(tags).toContain("ml"); // original tag preserved
    expect(tags).toContain("machine learning"); // new keyword added
  });

  it("includes abstract in generated page when available", async () => {
    const refs = parseBibtex(SAMPLE_BIBTEX);
    const llm = mockLLM();

    const result = await importReferences(config, llm, refs);
    const vaswaniPath = result.pagesCreated.find((p) => p.includes("vaswani"));
    expect(vaswaniPath).toBeDefined();

    const content = readFileSync(join(brainRoot, vaswaniPath!), "utf-8");
    expect(content).toContain("## Abstract");
    expect(content).toContain("dominant sequence transduction");
  });

  it("records bibtexKey in source_refs", async () => {
    const refs = parseBibtex(`@article{smith2023test, title={Test Paper}, author={Smith, John}, year={2023}}`);
    const llm = mockLLM();

    const result = await importReferences(config, llm, refs);
    const content = readFileSync(join(brainRoot, result.pagesCreated[0]), "utf-8");
    const parsed = matter(content);
    const sourceRefs = parsed.data.source_refs as Array<{ kind: string; ref: string }>;
    expect(sourceRefs).toBeDefined();
    expect(sourceRefs).toHaveLength(1);
    expect(sourceRefs[0].kind).toBe("import");
    expect(sourceRefs[0].ref).toBe("bibtex:smith2023test");
  });
});

// ── API route tests ───────────────────────────────────

describe("POST /api/brain/import-references", () => {
  let brainRoot: string;

  beforeEach(() => {
    vi.resetModules();
    brainRoot = makeBrainDir();
    vi.stubEnv("BRAIN_ROOT", brainRoot);
    vi.stubEnv("OPENAI_API_KEY", "sk-test-key");
  });

  afterEach(() => {
    vi.resetModules();
    rmSync(brainRoot, { recursive: true, force: true });
  });

  it("returns parsed dedup preview for bibtex without skipDuplicates", async () => {
    const { POST } = await import("@/app/api/brain/import-references/route");
    const req = new Request("http://localhost/api/brain/import-references", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: SAMPLE_BIBTEX, format: "bibtex" }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.stats).toBeDefined();
    expect(body.stats.total).toBe(6);
    expect(body.stats.new).toBe(6);
    expect(body.stats.matched).toBe(0);
    expect(body.newRefs).toHaveLength(6);
    expect(body.matchedRefs).toHaveLength(0);
  });

  it("imports references when skipDuplicates is true", async () => {
    const { POST } = await import("@/app/api/brain/import-references/route");
    const req = new Request("http://localhost/api/brain/import-references", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: `@article{test2023, title={API Test Paper}, author={Doe, Jane}, year={2023}, journal={Test Journal}}`,
        format: "bibtex",
        options: { skipDuplicates: true },
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.pagesCreated).toHaveLength(1);
    expect(body.pagesCreated[0]).toMatch(/wiki\/entities\/papers\//);
    expect(body.pagesSkipped).toBe(0);
    expect(body.errors).toHaveLength(0);
    expect(typeof body.durationMs).toBe("number");

    // Verify file was written to disk
    const filePath = join(brainRoot, body.pagesCreated[0]);
    expect(existsSync(filePath)).toBe(true);
  });

  it("parses RIS format correctly via API", async () => {
    const { POST } = await import("@/app/api/brain/import-references/route");
    const req = new Request("http://localhost/api/brain/import-references", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: SAMPLE_RIS, format: "ris" }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.stats.total).toBe(3);
    expect(body.newRefs).toHaveLength(3);
  });

  it("returns 400 for missing content", async () => {
    const { POST } = await import("@/app/api/brain/import-references/route");
    const req = new Request("http://localhost/api/brain/import-references", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ format: "bibtex" }),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toContain("content");
  });

  it("returns 400 for invalid format", async () => {
    const { POST } = await import("@/app/api/brain/import-references/route");
    const req = new Request("http://localhost/api/brain/import-references", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "test", format: "csv" }),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toContain("format");
  });

  it("returns 400 for invalid JSON body", async () => {
    const { POST } = await import("@/app/api/brain/import-references/route");
    const req = new Request("http://localhost/api/brain/import-references", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });

    const res = await POST(req);
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toBe("Invalid JSON body");
  });

  it("returns 422 for content with no valid references", async () => {
    const { POST } = await import("@/app/api/brain/import-references/route");
    const req = new Request("http://localhost/api/brain/import-references", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "not a bibtex file at all", format: "bibtex" }),
    });

    const res = await POST(req);
    expect(res.status).toBe(422);

    const body = await res.json();
    expect(body.error).toContain("No valid references");
  });
});
