import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  resolvePaper,
  batchResolve,
  type SemanticScholarQuery,
} from "../semantic-scholar";
import {
  parseAtomFeed,
  fetchById,
  searchPapers,
  fetchRecent,
} from "../arxiv-collector";

// ── Semantic Scholar Tests ────────────────────────────

describe("Semantic Scholar collector", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("resolvePaper returns ok:false when API returns no results", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );

    const result = await resolvePaper({ query: "nonexistent paper xyz" }, 0);
    expect(result.ok).toBe(false);
    expect(result.paper).toBeNull();
  });

  it("resolvePaper handles API errors gracefully", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("Internal Server Error", { status: 500 }),
    );

    const result = await resolvePaper({ query: "test" }, 0);
    expect(result.ok).toBe(false);
    expect(result.paper).toBeNull();
  });

  it("resolvePaper parses a valid search + detail response", async () => {
    const mockSearch = {
      data: [{ paperId: "abc123", title: "Test Paper" }],
    };

    const mockDetail = {
      paperId: "abc123",
      title: "Attention Is All You Need",
      authors: [
        { authorId: "1", name: "Ashish Vaswani" },
        { authorId: "2", name: "Noam Shazeer" },
      ],
      year: 2017,
      venue: "NeurIPS",
      abstract: "The dominant sequence transduction models...",
      citationCount: 100000,
      referenceCount: 40,
      externalIds: { DOI: "10.5555/3295222.3295349", ArXiv: "1706.03762" },
      url: "https://www.semanticscholar.org/paper/abc123",
      citations: [
        { title: "BERT", year: 2019, authors: [{ name: "Jacob Devlin" }] },
      ],
      references: [
        { title: "Neural Machine Translation", year: 2014, authors: [{ name: "Dzmitry Bahdanau" }] },
      ],
    };

    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(
          new Response(JSON.stringify(mockSearch), { status: 200 }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify(mockDetail), { status: 200 }),
      );
    });

    const result = await resolvePaper({ query: "Attention Is All You Need" }, 0);
    expect(result.ok).toBe(true);
    expect(result.paper).not.toBeNull();
    expect(result.paper!.title).toBe("Attention Is All You Need");
    expect(result.paper!.authors).toHaveLength(2);
    expect(result.paper!.authors[0].name).toBe("Ashish Vaswani");
    expect(result.paper!.year).toBe(2017);
    expect(result.paper!.doi).toBe("10.5555/3295222.3295349");
    expect(result.paper!.arxivId).toBe("1706.03762");
    expect(result.paper!.citationCount).toBe(100000);
    expect(result.paper!.citations).toHaveLength(1);
    expect(result.paper!.references).toHaveLength(1);
  });

  it("resolvePaper routes DOI queries correctly", async () => {
    const mockDetail = {
      paperId: "doi123",
      title: "DOI Paper",
      authors: [],
      year: 2023,
      venue: "Test",
      citationCount: 5,
      referenceCount: 10,
      externalIds: { DOI: "10.1234/test" },
      url: "",
      citations: [],
      references: [],
    };

    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(mockDetail), { status: 200 }),
    );

    const result = await resolvePaper({ doi: "10.1234/test" }, 0);
    expect(result.ok).toBe(true);
    expect(result.paper!.title).toBe("DOI Paper");

    // Verify the URL was correct
    const callArgs = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(callArgs[0]).toContain("DOI:");
  });

  it("resolvePaper routes arXiv queries correctly", async () => {
    const mockDetail = {
      paperId: "arxiv123",
      title: "arXiv Paper",
      authors: [],
      year: 2024,
      venue: "arXiv",
      citationCount: 0,
      referenceCount: 5,
      externalIds: { ArXiv: "2301.08362" },
      url: "",
      citations: [],
      references: [],
    };

    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(mockDetail), { status: 200 }),
    );

    const result = await resolvePaper({ arxivId: "2301.08362" }, 0);
    expect(result.ok).toBe(true);

    const callArgs = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(callArgs[0]).toContain("ARXIV:");
  });

  it("batchResolve processes multiple queries", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );

    const queries: SemanticScholarQuery[] = [
      { query: "paper 1" },
      { query: "paper 2" },
    ];

    const results = await batchResolve(queries, 0);
    expect(results).toHaveLength(2);
    expect(results[0].ok).toBe(false);
    expect(results[1].ok).toBe(false);
  });

  it("handles network errors gracefully", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network failure"));

    const result = await resolvePaper({ query: "test" }, 0);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Network failure");
  });
});

// ── arXiv Tests ───────────────────────────────────────

describe("arXiv collector", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  const SAMPLE_ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"
      xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"
      xmlns:arxiv="http://arxiv.org/schemas/atom">
  <opensearch:totalResults>1</opensearch:totalResults>
  <opensearch:startIndex>0</opensearch:startIndex>
  <opensearch:itemsPerPage>1</opensearch:itemsPerPage>
  <entry>
    <id>http://arxiv.org/abs/2301.08362v2</id>
    <updated>2023-02-15T12:00:00Z</updated>
    <published>2023-01-20T08:00:00Z</published>
    <title>Scalable Diffusion Models with Transformers</title>
    <summary>We explore a new class of diffusion models based on the transformer architecture.</summary>
    <author>
      <name>William Peebles</name>
    </author>
    <author>
      <name>Saining Xie</name>
    </author>
    <category term="cs.CV" scheme="http://arxiv.org/schemas/atom"/>
    <category term="cs.AI" scheme="http://arxiv.org/schemas/atom"/>
    <link title="pdf" href="http://arxiv.org/pdf/2301.08362v2" rel="related" type="application/pdf"/>
    <arxiv:doi>10.1234/test.2023</arxiv:doi>
  </entry>
</feed>`;

  it("parseAtomFeed extracts papers from XML", () => {
    const result = parseAtomFeed(SAMPLE_ATOM);
    expect(result.ok).toBe(true);
    expect(result.totalResults).toBe(1);
    expect(result.papers).toHaveLength(1);

    const paper = result.papers[0];
    expect(paper.id).toBe("2301.08362");
    expect(paper.title).toBe(
      "Scalable Diffusion Models with Transformers",
    );
    expect(paper.authors).toEqual(["William Peebles", "Saining Xie"]);
    expect(paper.abstract).toContain("diffusion models");
    expect(paper.categories).toContain("cs.CV");
    expect(paper.categories).toContain("cs.AI");
    expect(paper.published).toBe("2023-01-20T08:00:00Z");
    expect(paper.doi).toBe("10.1234/test.2023");
  });

  it("parseAtomFeed handles empty feed", () => {
    const emptyFeed = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom"
      xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
  <opensearch:totalResults>0</opensearch:totalResults>
</feed>`;

    const result = parseAtomFeed(emptyFeed);
    expect(result.ok).toBe(true);
    expect(result.papers).toHaveLength(0);
  });

  it("parseAtomFeed strips version suffix from arXiv IDs", () => {
    const result = parseAtomFeed(SAMPLE_ATOM);
    expect(result.papers[0].id).toBe("2301.08362");
    // No "v2" suffix
  });

  it("fetchById calls correct URL and parses response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(SAMPLE_ATOM, { status: 200 }),
    );

    const result = await fetchById("2301.08362", 0);
    expect(result.ok).toBe(true);
    expect(result.papers).toHaveLength(1);

    const callArgs = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(callArgs[0]).toContain("id_list=2301.08362");
  });

  it("searchPapers calls correct URL", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(SAMPLE_ATOM, { status: 200 }),
    );

    const result = await searchPapers("transformer attention", 10, 0);
    expect(result.ok).toBe(true);

    const callArgs = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(callArgs[0]).toContain("search_query=");
    expect(callArgs[0]).toContain("max_results=10");
  });

  it("fetchRecent filters by date window", async () => {
    // Create a paper with a very old date
    const oldFeed = SAMPLE_ATOM.replace(
      "2023-01-20T08:00:00Z",
      "2020-01-01T00:00:00Z",
    );

    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(oldFeed, { status: 200 }),
    );

    const result = await fetchRecent(["cs.AI"], 7, 20, 0);
    expect(result.ok).toBe(true);
    // Paper from 2020 should be filtered out
    expect(result.papers).toHaveLength(0);
  });

  it("handles HTTP errors gracefully", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("Service Unavailable", { status: 503 }),
    );

    const result = await fetchById("2301.08362", 0);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("503");
  });

  it("handles network errors gracefully", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(
      new Error("DNS resolution failed"),
    );

    const result = await fetchById("2301.08362", 0);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("DNS resolution failed");
  });
});
