import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "@/app/api/semantic-scholar/[paperId]/route";

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

function makeRequest(encodedId: string): Request {
  return new Request(`http://localhost/api/semantic-scholar/${encodedId}`);
}

function makeParams(encodedId: string): { params: Promise<{ paperId: string }> } {
  return { params: Promise.resolve({ paperId: encodedId }) };
}

describe("GET /api/semantic-scholar/[paperId]", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("happy path: returns the parsed paper for a native S2 id", async () => {
    fetchMock.mockResolvedValueOnce(
      okJson({
        paperId: "649def34",
        title: "Attention Is All You Need",
        authors: [{ authorId: "1", name: "Ashish Vaswani" }],
        year: 2017,
        openAccessPdf: { url: "https://arxiv.org/pdf/1706.03762.pdf" },
        tldr: { text: "Attention replaces recurrence." },
      }),
    );

    const res = await GET(makeRequest("649def34"), makeParams("649def34"));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.title).toBe("Attention Is All You Need");
    expect(body.paperId).toBe("649def34");
    expect(body.openAccessPdfUrl).toBe("https://arxiv.org/pdf/1706.03762.pdf");
    expect(body.tldr).toBe("Attention replaces recurrence.");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("returns 400 for an invalid identifier (leading slash)", async () => {
    const res = await GET(
      makeRequest(encodeURIComponent("/etc/passwd")),
      makeParams(encodeURIComponent("/etc/passwd")),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid paper identifier");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("decodes URL-encoded identifiers before passing to the lib (DOI example)", async () => {
    fetchMock.mockResolvedValueOnce(
      okJson({
        paperId: "doi-paper",
        title: "The DOI Paper",
        authors: [],
        externalIds: { DOI: "10.1145/12345" },
      }),
    );

    const encoded = "DOI%3A10.1145%2F12345"; // decodes to DOI:10.1145/12345
    const res = await GET(makeRequest(encoded), makeParams(encoded));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.title).toBe("The DOI Paper");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain("/paper/DOI:10.1145/12345?fields=");
  });

  it("returns 404 when the upstream API says not found", async () => {
    fetchMock.mockResolvedValueOnce(errorStatus(404));

    const res = await GET(makeRequest("missing"), makeParams("missing"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain("not found");
  });

  it("returns 429 when the upstream API rate-limits", async () => {
    fetchMock.mockResolvedValueOnce(errorStatus(429));

    const res = await GET(makeRequest("busy"), makeParams("busy"));
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toBe("Semantic Scholar rate limit hit");
  });

  it("returns 502 when the upstream API returns 500", async () => {
    fetchMock.mockResolvedValueOnce(errorStatus(500));

    const res = await GET(makeRequest("boom"), makeParams("boom"));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe("Semantic Scholar request failed: 500");
  });

  it("returns 502 when the upstream API returns 503", async () => {
    fetchMock.mockResolvedValueOnce(errorStatus(503));

    const res = await GET(makeRequest("boom"), makeParams("boom"));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe("Semantic Scholar request failed: 503");
  });
});
