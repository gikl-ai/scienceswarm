import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ArxivInvalidIdError,
  ArxivNotFoundError,
  ArxivUpstreamError,
  fetchArxivMetadata,
} from "@/lib/arxiv-client";

// Minimal Atom feed with a single entry, multi-author and multi-category,
// plus deliberately-noisy whitespace in title/summary so the collapse step
// is exercised. Keeping this inline (instead of a fixture file) makes the
// parser contract obvious from the test file alone.
function buildFeed(entries: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>arXiv Query: id_list=test</title>
  ${entries}
</feed>`;
}

const SAMPLE_ENTRY = `
  <entry>
    <id>http://arxiv.org/abs/2301.12345v2</id>
    <updated>2023-02-14T00:00:00Z</updated>
    <published>2023-01-29T00:00:00Z</published>
    <title>
      Attention
      Is   All   You   Need
    </title>
    <summary>
      We propose a new simple network architecture,
      the Transformer, based solely on attention
      mechanisms.
    </summary>
    <author><name>Ashish Vaswani</name></author>
    <author><name>Noam Shazeer</name></author>
    <author><name>Niki Parmar</name></author>
    <category term="cs.CL" scheme="http://arxiv.org/schemas/atom"/>
    <category term="cs.LG" scheme="http://arxiv.org/schemas/atom"/>
  </entry>
`;

function stubFetchWithXml(xml: string, init: ResponseInit = { status: 200 }) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(xml, {
        ...init,
        headers: { "content-type": "application/atom+xml" },
      }),
    ),
  );
}

describe("fetchArxivMetadata", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    // Ensure the real `fetch` is restored so another test file running in
    // the same Vitest worker isn't poisoned by the last mock set here.
    vi.unstubAllGlobals();
  });

  it("parses a valid single-entry feed", async () => {
    stubFetchWithXml(buildFeed(SAMPLE_ENTRY));

    const meta = await fetchArxivMetadata("2301.12345");

    expect(meta.id).toBe("2301.12345");
    expect(meta.published).toBe("2023-01-29T00:00:00Z");
    expect(meta.updated).toBe("2023-02-14T00:00:00Z");
    expect(meta.title.length).toBeGreaterThan(0);
  });

  it("throws not-found when the feed has zero entries", async () => {
    stubFetchWithXml(buildFeed("")); // no <entry> inside
    await expect(fetchArxivMetadata("2301.99999")).rejects.toBeInstanceOf(
      ArxivNotFoundError,
    );
    stubFetchWithXml(buildFeed(""));
    await expect(fetchArxivMetadata("2301.99999")).rejects.toThrow(
      "ArXiv id 2301.99999 not found",
    );
  });

  it("throws with the upstream status on non-OK responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("boom", { status: 503 })),
    );

    await expect(fetchArxivMetadata("2301.12345")).rejects.toBeInstanceOf(
      ArxivUpstreamError,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("boom", { status: 503 })),
    );
    await expect(fetchArxivMetadata("2301.12345")).rejects.toThrow(
      "ArXiv request failed: 503",
    );
  });

  it("rejects syntactically-invalid ids before calling fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchArxivMetadata("not a real id!")).rejects.toBeInstanceOf(
      ArxivInvalidIdError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("collects every author in document order", async () => {
    stubFetchWithXml(buildFeed(SAMPLE_ENTRY));

    const meta = await fetchArxivMetadata("2301.12345");

    expect(meta.authors).toEqual([
      "Ashish Vaswani",
      "Noam Shazeer",
      "Niki Parmar",
    ]);
  });

  it("collects every category term", async () => {
    stubFetchWithXml(buildFeed(SAMPLE_ENTRY));

    const meta = await fetchArxivMetadata("2301.12345");

    expect(meta.categories).toEqual(["cs.CL", "cs.LG"]);
  });

  it("collapses internal whitespace in title and abstract", async () => {
    stubFetchWithXml(buildFeed(SAMPLE_ENTRY));

    const meta = await fetchArxivMetadata("2301.12345");

    // Multi-line / multi-space input should become a single clean line.
    expect(meta.title).toBe("Attention Is All You Need");
    expect(meta.abstract).toBe(
      "We propose a new simple network architecture, the Transformer, based solely on attention mechanisms.",
    );
    // Guarantee there are no consecutive whitespace runs left over.
    expect(/\s{2,}/.test(meta.title)).toBe(false);
    expect(/\s{2,}/.test(meta.abstract)).toBe(false);
  });

  it("derives pdfUrl and arxivUrl from the id", async () => {
    stubFetchWithXml(buildFeed(SAMPLE_ENTRY));

    const meta = await fetchArxivMetadata("2301.12345v2");

    expect(meta.pdfUrl).toBe("https://arxiv.org/pdf/2301.12345v2.pdf");
    expect(meta.arxivUrl).toBe("https://arxiv.org/abs/2301.12345v2");
  });

  it("accepts old-style ids like cs/0101001", async () => {
    const oldEntry = `
      <entry>
        <id>http://arxiv.org/abs/cs/0101001</id>
        <updated>2001-01-15T00:00:00Z</updated>
        <published>2001-01-15T00:00:00Z</published>
        <title>Old Paper</title>
        <summary>Ancient preprint.</summary>
        <author><name>Alan Turing</name></author>
        <category term="cs.AI" scheme="http://arxiv.org/schemas/atom"/>
      </entry>
    `;
    stubFetchWithXml(buildFeed(oldEntry));

    const meta = await fetchArxivMetadata("cs/0101001");

    expect(meta.id).toBe("cs/0101001");
    expect(meta.authors).toEqual(["Alan Turing"]);
    expect(meta.pdfUrl).toBe("https://arxiv.org/pdf/cs/0101001.pdf");
    expect(meta.arxivUrl).toBe("https://arxiv.org/abs/cs/0101001");
  });

  it("decodes numeric and named character references in title/abstract", async () => {
    // ArXiv summaries routinely include hex (&#x2019;), decimal (&#8212;),
    // and named (&amp;) entities. All three must be decoded — leaving them
    // verbatim would corrupt downstream display.
    const entityEntry = `
      <entry>
        <id>http://arxiv.org/abs/2401.00001</id>
        <updated>2024-01-01T00:00:00Z</updated>
        <published>2024-01-01T00:00:00Z</published>
        <title>Don&#x2019;t Panic &amp; Carry On</title>
        <summary>An em-dash—right here—and an &amp;-sign.</summary>
        <author><name>Jane O&apos;Neil</name></author>
        <category term="cs.AI" scheme="http://arxiv.org/schemas/atom"/>
      </entry>
    `;
    stubFetchWithXml(buildFeed(entityEntry));

    const meta = await fetchArxivMetadata("2401.00001");

    expect(meta.title).toBe("Don\u2019t Panic & Carry On");
    expect(meta.abstract).toBe("An em-dash\u2014right here\u2014and an &-sign.");
    expect(meta.authors).toEqual(["Jane O'Neil"]);
  });

  it("hits the expected Atom API URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(buildFeed(SAMPLE_ENTRY), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await fetchArxivMetadata("2301.12345");

    const calledWith = fetchMock.mock.calls[0]?.[0] as string;
    expect(calledWith).toContain("export.arxiv.org/api/query");
    expect(calledWith).toContain("id_list=2301.12345");
  });
});
