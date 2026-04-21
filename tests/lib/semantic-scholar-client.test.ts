import { beforeEach, describe, expect, it, vi } from "vitest";

import { fetchSemanticScholarPaper } from "@/lib/semantic-scholar-client";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

function okJson(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  };
}

function errorStatus(status: number) {
  return {
    ok: false,
    status,
    json: () => Promise.resolve({}),
    text: () => Promise.resolve(""),
  };
}

describe("fetchSemanticScholarPaper", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("fetches a paper by native S2 id and returns a parsed shape", async () => {
    fetchMock.mockResolvedValueOnce(
      okJson({
        paperId: "649def34f8be52c8b66281af98ae884c09aef38b",
        title: "Attention Is All You Need",
        abstract: "The dominant sequence transduction models are based on...",
        year: 2017,
        venue: "NIPS",
        authors: [
          { authorId: "1699545", name: "Ashish Vaswani" },
          { authorId: "2058141", name: "Noam Shazeer" },
        ],
        citationCount: 50000,
        influentialCitationCount: 5000,
        referenceCount: 40,
        openAccessPdf: { url: "https://arxiv.org/pdf/1706.03762.pdf" },
        externalIds: { DOI: "10.5555/3295222.3295349", ArXiv: "1706.03762" },
        tldr: { text: "Transformer architecture replaces RNNs with attention." },
        url: "https://www.semanticscholar.org/paper/649def34",
      }),
    );

    const paper = await fetchSemanticScholarPaper(
      "649def34f8be52c8b66281af98ae884c09aef38b",
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://api.semanticscholar.org/graph/v1/paper/649def34f8be52c8b66281af98ae884c09aef38b?fields=title,abstract,year,venue,authors,citationCount,influentialCitationCount,referenceCount,openAccessPdf,externalIds,tldr,url",
    );
    const headers = options.headers as Record<string, string>;
    expect(headers["User-Agent"]).toBe(
      "ScienceSwarm/1.0 (https://github.com/gikl-ai/scienceswarm)",
    );
    expect(options.signal).toBeDefined();

    expect(paper.paperId).toBe("649def34f8be52c8b66281af98ae884c09aef38b");
    expect(paper.title).toBe("Attention Is All You Need");
    expect(paper.year).toBe(2017);
    expect(paper.venue).toBe("NIPS");
    expect(paper.citationCount).toBe(50000);
    expect(paper.influentialCitationCount).toBe(5000);
    expect(paper.referenceCount).toBe(40);
    expect(paper.openAccessPdfUrl).toBe("https://arxiv.org/pdf/1706.03762.pdf");
    expect(paper.tldr).toBe("Transformer architecture replaces RNNs with attention.");
    expect(paper.url).toBe("https://www.semanticscholar.org/paper/649def34");
  });

  it("supports ARXIV-prefixed identifiers", async () => {
    fetchMock.mockResolvedValueOnce(
      okJson({
        paperId: "abc123",
        title: "Some arxiv paper",
        authors: [],
      }),
    );

    const paper = await fetchSemanticScholarPaper("ARXIV:2301.12345");

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain("/paper/ARXIV:2301.12345?fields=");
    expect(paper.title).toBe("Some arxiv paper");
  });

  it("supports DOI-prefixed identifiers", async () => {
    fetchMock.mockResolvedValueOnce(
      okJson({
        paperId: "doi-paper",
        title: "A DOI paper",
        authors: [{ authorId: "42", name: "Jane Doe" }],
      }),
    );

    const paper = await fetchSemanticScholarPaper("DOI:10.1145/12345");

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain("/paper/DOI:10.1145/12345?fields=");
    expect(paper.authors).toEqual([{ authorId: "42", name: "Jane Doe" }]);
  });

  it("rejects paper identifiers that would break query-string construction", async () => {
    await expect(fetchSemanticScholarPaper("DOI:10.1145/12345?extra")).rejects.toThrow(
      "Invalid paper identifier",
    );
    await expect(fetchSemanticScholarPaper("ARXIV:2301.12345#frag")).rejects.toThrow(
      "Invalid paper identifier",
    );
    await expect(fetchSemanticScholarPaper("CorpusId:123&fields=paperId")).rejects.toThrow(
      "Invalid paper identifier",
    );
  });

  it("does not crash when optional fields are missing (abstract, tldr, openAccessPdf)", async () => {
    fetchMock.mockResolvedValueOnce(
      okJson({
        paperId: "min-1",
        title: "Minimal Paper",
        authors: [],
        // No abstract, tldr, or openAccessPdf
      }),
    );

    const paper = await fetchSemanticScholarPaper("min-1");
    expect(paper.title).toBe("Minimal Paper");
    expect(paper.abstract).toBeUndefined();
    expect(paper.tldr).toBeUndefined();
    expect(paper.openAccessPdfUrl).toBeUndefined();
    expect(paper.year).toBeUndefined();
    expect(paper.venue).toBeUndefined();
    expect(paper.externalIds).toBeUndefined();
    expect(paper.authors).toEqual([]);
  });

  it("preserves the authors array", async () => {
    fetchMock.mockResolvedValueOnce(
      okJson({
        paperId: "a1",
        title: "Multi-author",
        authors: [
          { authorId: "1", name: "A" },
          { authorId: "2", name: "B" },
          { authorId: "3", name: "C" },
        ],
      }),
    );
    const paper = await fetchSemanticScholarPaper("a1");
    expect(paper.authors).toHaveLength(3);
    expect(paper.authors[0]).toEqual({ authorId: "1", name: "A" });
    expect(paper.authors[2]).toEqual({ authorId: "3", name: "C" });
  });

  it("extracts openAccessPdfUrl from nested openAccessPdf.url", async () => {
    fetchMock.mockResolvedValueOnce(
      okJson({
        paperId: "p1",
        title: "Open access",
        authors: [],
        openAccessPdf: { url: "https://example.com/x.pdf", status: "GOLD" },
      }),
    );
    const paper = await fetchSemanticScholarPaper("p1");
    expect(paper.openAccessPdfUrl).toBe("https://example.com/x.pdf");
  });

  it("extracts tldr from tldr.text and leaves undefined when null", async () => {
    fetchMock.mockResolvedValueOnce(
      okJson({
        paperId: "t1",
        title: "With tldr",
        authors: [],
        tldr: { text: "A concise summary." },
      }),
    );
    let paper = await fetchSemanticScholarPaper("t1");
    expect(paper.tldr).toBe("A concise summary.");

    fetchMock.mockResolvedValueOnce(
      okJson({
        paperId: "t2",
        title: "Null tldr",
        authors: [],
        tldr: null,
      }),
    );
    paper = await fetchSemanticScholarPaper("t2");
    expect(paper.tldr).toBeUndefined();
  });

  it("round-trips externalIds", async () => {
    const ids = {
      DOI: "10.1000/xyz",
      ArXiv: "2108.00001",
      PubMed: "12345",
      MAG: "9999",
    };
    fetchMock.mockResolvedValueOnce(
      okJson({
        paperId: "e1",
        title: "External",
        authors: [],
        externalIds: ids,
      }),
    );
    const paper = await fetchSemanticScholarPaper("e1");
    expect(paper.externalIds).toEqual(ids);
  });

  it("throws 'not found' on 404", async () => {
    fetchMock.mockResolvedValueOnce(errorStatus(404));
    await expect(fetchSemanticScholarPaper("missing")).rejects.toThrow(
      "Semantic Scholar paper missing not found",
    );
  });

  it("throws 'rate limit' on 429", async () => {
    fetchMock.mockResolvedValueOnce(errorStatus(429));
    await expect(fetchSemanticScholarPaper("busy")).rejects.toThrow(
      "Semantic Scholar rate limit hit",
    );
  });

  it("throws a request-failed error with status on other non-OK responses", async () => {
    fetchMock.mockResolvedValueOnce(errorStatus(500));
    await expect(fetchSemanticScholarPaper("boom")).rejects.toThrow(
      "Semantic Scholar request failed: 500",
    );

    fetchMock.mockResolvedValueOnce(errorStatus(503));
    await expect(fetchSemanticScholarPaper("boom")).rejects.toThrow(
      "Semantic Scholar request failed: 503",
    );
  });

  it("throws 'Invalid paper identifier' for empty, leading-slash, whitespace, dot-dot, or non-string inputs", async () => {
    await expect(fetchSemanticScholarPaper("")).rejects.toThrow(
      "Invalid paper identifier",
    );
    await expect(fetchSemanticScholarPaper("/etc/passwd")).rejects.toThrow(
      "Invalid paper identifier",
    );
    await expect(fetchSemanticScholarPaper("foo bar")).rejects.toThrow(
      "Invalid paper identifier",
    );
    await expect(fetchSemanticScholarPaper("foo\tbar")).rejects.toThrow(
      "Invalid paper identifier",
    );
    await expect(fetchSemanticScholarPaper("../secrets")).rejects.toThrow(
      "Invalid paper identifier",
    );
    await expect(fetchSemanticScholarPaper("..")).rejects.toThrow(
      "Invalid paper identifier",
    );
    await expect(fetchSemanticScholarPaper("foo\\bar")).rejects.toThrow(
      "Invalid paper identifier",
    );
    await expect(
      fetchSemanticScholarPaper(undefined as unknown as string),
    ).rejects.toThrow("Invalid paper identifier");

    // None of these should have touched fetch
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
