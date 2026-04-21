import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DoiNotFoundError,
  InvalidDoiError,
  fetchDoiMetadata,
} from "@/lib/doi-client";

// Build a minimal CrossRef-shaped response. Any of the inner fields can
// be overridden per test to exercise edge cases.
interface CrossRefLike {
  title?: string[];
  author?: Array<{ given?: string; family?: string }>;
  "container-title"?: string[];
  publisher?: string;
  published?: { "date-parts": number[][] };
  "published-print"?: { "date-parts": number[][] };
  issued?: { "date-parts": number[][] };
  type?: string;
  URL?: string;
  ISSN?: string[];
}

function okResponse(message: CrossRefLike): Response {
  return new Response(JSON.stringify({ status: "ok", message }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(status: number): Response {
  return new Response(JSON.stringify({ status: "error" }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("fetchDoiMetadata", () => {
  const DOI = "10.1145/362384.362685";

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    // Restore the real global `fetch` so stubs don't leak across files
    // when vitest reuses the same worker.
    vi.unstubAllGlobals();
  });

  it("returns parsed metadata for a valid DOI", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      okResponse({
        title: ["The Art of Computer Programming"],
        author: [{ given: "Donald", family: "Knuth" }],
        "container-title": ["Communications of the ACM"],
        publisher: "ACM",
        published: { "date-parts": [[1968]] },
        type: "journal-article",
        URL: "https://doi.org/10.1145/362384.362685",
        ISSN: ["0001-0782"],
      }),
    );

    const meta = await fetchDoiMetadata(DOI);
    expect(meta).toEqual({
      doi: DOI,
      title: "The Art of Computer Programming",
      authors: ["Donald Knuth"],
      journal: "Communications of the ACM",
      publisher: "ACM",
      year: "1968",
      type: "journal-article",
      url: "https://doi.org/10.1145/362384.362685",
      issn: ["0001-0782"],
    });
  });

  it("drops author entries where both name parts are missing", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      okResponse({
        title: ["Partial author record"],
        author: [
          { given: "Alan", family: "Turing" },
          {},
          { family: "Lovelace" },
          { given: "" as string, family: "" as string },
        ],
      }),
    );

    const meta = await fetchDoiMetadata(DOI);
    expect(meta.authors).toEqual(["Alan Turing", "Lovelace"]);
  });

  it("handles multiple authors", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      okResponse({
        title: ["Paxos Made Simple"],
        author: [
          { given: "Leslie", family: "Lamport" },
          { given: "Butler", family: "Lampson" },
          { given: "Nancy", family: "Lynch" },
        ],
        published: { "date-parts": [[2001, 12]] },
      }),
    );

    const meta = await fetchDoiMetadata(DOI);
    expect(meta.authors).toEqual(["Leslie Lamport", "Butler Lampson", "Nancy Lynch"]);
    expect(meta.title).toBe("Paxos Made Simple");
    expect(meta.year).toBe("2001");
  });

  it("does not crash when optional fields are missing", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      okResponse({
        title: ["Bare minimum record"],
      }),
    );

    const meta = await fetchDoiMetadata(DOI);
    expect(meta.title).toBe("Bare minimum record");
    expect(meta.authors).toEqual([]);
    expect(meta.journal).toBeUndefined();
    expect(meta.publisher).toBeUndefined();
    expect(meta.year).toBeUndefined();
    expect(meta.type).toBeUndefined();
    expect(meta.url).toBeUndefined();
    expect(meta.issn).toBeUndefined();
  });

  it("throws InvalidDoiError for malformed input", async () => {
    await expect(fetchDoiMetadata("not-a-doi")).rejects.toBeInstanceOf(InvalidDoiError);
    await expect(fetchDoiMetadata("10.abc/foo")).rejects.toBeInstanceOf(InvalidDoiError);
    await expect(fetchDoiMetadata("")).rejects.toBeInstanceOf(InvalidDoiError);
    // Registrant prefix with trailing slash but no object identifier —
    // degenerate shape that should not reach CrossRef.
    await expect(fetchDoiMetadata("10.1234/")).rejects.toBeInstanceOf(InvalidDoiError);
    await expect(fetchDoiMetadata("10.1145/foo extra")).rejects.toBeInstanceOf(InvalidDoiError);
    await expect(fetchDoiMetadata("not-a-doi")).rejects.toThrow("Invalid DOI");
    // fetch should never have been called for an invalid DOI
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("throws DoiNotFoundError on HTTP 404", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(errorResponse(404));
    await expect(fetchDoiMetadata(DOI)).rejects.toBeInstanceOf(DoiNotFoundError);
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(errorResponse(404));
    await expect(fetchDoiMetadata(DOI)).rejects.toThrow(`DOI ${DOI} not found`);
  });

  it("throws with status code on other non-OK responses", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(errorResponse(500));
    await expect(fetchDoiMetadata(DOI)).rejects.toThrow("CrossRef request failed: 500");
  });

  it("extracts the year from date-parts[0][0]", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      okResponse({
        title: ["Some paper"],
        published: { "date-parts": [[2023, 7, 15]] },
      }),
    );
    const meta = await fetchDoiMetadata(DOI);
    expect(meta.year).toBe("2023");
  });

  it("falls back to issued date-parts when published is missing", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      okResponse({
        title: ["Some paper"],
        issued: { "date-parts": [[1999]] },
      }),
    );
    const meta = await fetchDoiMetadata(DOI);
    expect(meta.year).toBe("1999");
  });

  it("preserves the ISSN array intact", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      okResponse({
        title: ["Multi-ISSN"],
        ISSN: ["0001-0782", "1557-7317"],
      }),
    );
    const meta = await fetchDoiMetadata(DOI);
    expect(meta.issn).toEqual(["0001-0782", "1557-7317"]);
  });

  it("sends the CrossRef User-Agent header and encodes the DOI in the URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ title: ["ok"] }));
    vi.stubGlobal("fetch", fetchMock);
    await fetchDoiMetadata(DOI);
    const call = fetchMock.mock.calls[0];
    expect(call[0]).toBe(`https://api.crossref.org/works/${encodeURIComponent(DOI)}`);
    const headers = call[1].headers as Record<string, string>;
    expect(headers["User-Agent"]).toContain("ScienceSwarm/");
    // AbortSignal.timeout wires in a signal — verify it's attached
    expect(call[1].signal).toBeDefined();
  });
});
