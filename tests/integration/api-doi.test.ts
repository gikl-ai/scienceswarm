import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "@/app/api/doi/route";

function okCrossRef(message: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ status: "ok", message }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function crossRefStatus(status: number): Response {
  return new Response(JSON.stringify({ status: "error" }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeRequest(path: string): Request {
  return new Request(`http://localhost${path}`);
}

describe("GET /api/doi", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    // Restore the real global `fetch` so stubs don't leak across files
    // when vitest reuses the same worker.
    vi.unstubAllGlobals();
  });

  it("returns DOI metadata for a valid id", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      okCrossRef({
        title: ["Structured Programming With Go To Statements"],
        author: [{ given: "Donald", family: "Knuth" }],
        "container-title": ["ACM Computing Surveys"],
        publisher: "ACM",
        published: { "date-parts": [[1974]] },
        type: "journal-article",
        URL: "https://doi.org/10.1145/12345",
        ISSN: ["0360-0300"],
      }),
    );

    const res = await GET(makeRequest("/api/doi?id=10.1145/12345"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.doi).toBe("10.1145/12345");
    expect(body.title).toBe("Structured Programming With Go To Statements");
    expect(body.authors).toEqual(["Donald Knuth"]);
    expect(body.year).toBe("1974");
    expect(body.publisher).toBe("ACM");
    expect(body.journal).toBe("ACM Computing Surveys");
  });

  it("returns 400 when id is missing", async () => {
    const res = await GET(makeRequest("/api/doi"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/missing/i);
    expect(body.status).toBe(400);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("returns 400 when the DOI is malformed", async () => {
    const res = await GET(makeRequest("/api/doi?id=not-a-doi"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid DOI");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("returns 400 when the DOI has trailing garbage", async () => {
    const res = await GET(makeRequest("/api/doi?id=10.1145/foo%20extra"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid DOI");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("returns 404 when CrossRef says the DOI doesn't exist", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(crossRefStatus(404));
    const res = await GET(makeRequest("/api/doi?id=10.9999/missing"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain("not found");
    expect(body.status).toBe(404);
  });

  it("returns 502 when CrossRef returns a 500", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(crossRefStatus(500));
    const res = await GET(makeRequest("/api/doi?id=10.1145/12345"));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toContain("500");
    expect(body.status).toBe(502);
  });

  it("returns 502 when fetch itself rejects", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("ECONNREFUSED"));
    const res = await GET(makeRequest("/api/doi?id=10.1145/12345"));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toContain("ECONNREFUSED");
  });
});
