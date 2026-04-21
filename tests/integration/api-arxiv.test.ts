import { beforeEach, describe, expect, it, vi } from "vitest";

// We mock the client at the module level so the route under test never
// touches the real network. The library layer has its own unit-level
// coverage in tests/lib/arxiv-client.test.ts; here we only verify the
// route's status-code translation.
const fetchArxivMetadata = vi.hoisted(() => vi.fn());
vi.mock("@/lib/arxiv-client", async () => {
  // The route discriminates errors with `instanceof`, so the mocked module
  // must export the real error classes. We pull them from the actual module
  // and only stub the async function.
  const actual = await vi.importActual<
    typeof import("@/lib/arxiv-client")
  >("@/lib/arxiv-client");
  return { ...actual, fetchArxivMetadata };
});

import {
  ArxivInvalidIdError,
  ArxivNotFoundError,
  ArxivUpstreamError,
} from "@/lib/arxiv-client";
import { GET } from "@/app/api/arxiv/[...id]/route";

function makeRequest(id: string): {
  req: Request;
  ctx: { params: Promise<{ id: string[] }> };
} {
  const segments = id.split("/").filter(Boolean);
  return {
    req: new Request(`http://localhost/api/arxiv/${segments.join("/")}`),
    ctx: { params: Promise.resolve({ id: segments }) },
  };
}

const SAMPLE_METADATA = {
  id: "2301.12345",
  title: "Attention Is All You Need",
  authors: ["Ashish Vaswani", "Noam Shazeer"],
  abstract: "A short summary.",
  categories: ["cs.CL", "cs.LG"],
  published: "2023-01-29T00:00:00Z",
  updated: "2023-02-14T00:00:00Z",
  pdfUrl: "https://arxiv.org/pdf/2301.12345.pdf",
  arxivUrl: "https://arxiv.org/abs/2301.12345",
};

describe("GET /api/arxiv/[...id]", () => {
  beforeEach(() => {
    fetchArxivMetadata.mockReset();
    // Route must never hit the real network even by accident.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network disabled in test")),
    );
  });

  it("returns 200 with metadata on happy path", async () => {
    fetchArxivMetadata.mockResolvedValueOnce(SAMPLE_METADATA);

    const { req, ctx } = makeRequest("2301.12345");
    const res = await GET(req, ctx);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(SAMPLE_METADATA);
    expect(fetchArxivMetadata).toHaveBeenCalledWith("2301.12345");
  });

  it("joins catch-all path segments for old-style arXiv ids", async () => {
    fetchArxivMetadata.mockResolvedValueOnce({
      ...SAMPLE_METADATA,
      id: "cs/0101001",
      pdfUrl: "https://arxiv.org/pdf/cs/0101001.pdf",
      arxivUrl: "https://arxiv.org/abs/cs/0101001",
    });

    const { req, ctx } = makeRequest("cs/0101001");
    const res = await GET(req, ctx);

    expect(res.status).toBe(200);
    expect(fetchArxivMetadata).toHaveBeenCalledWith("cs/0101001");
  });

  it("returns 400 when the client rejects the id format", async () => {
    fetchArxivMetadata.mockRejectedValueOnce(new ArxivInvalidIdError());

    const { req, ctx } = makeRequest("not-a-real-id!");
    const res = await GET(req, ctx);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid arXiv id");
  });

  it("returns 404 when the upstream reports the id as not-found", async () => {
    fetchArxivMetadata.mockRejectedValueOnce(
      new ArxivNotFoundError("ArXiv id 2301.99999 not found"),
    );

    const { req, ctx } = makeRequest("2301.99999");
    const res = await GET(req, ctx);

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain("not found");
  });

  it("returns 502 when the upstream returns a 5xx", async () => {
    fetchArxivMetadata.mockRejectedValueOnce(
      new ArxivUpstreamError("ArXiv request failed: 503"),
    );

    const { req, ctx } = makeRequest("2301.12345");
    const res = await GET(req, ctx);

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toContain("Upstream failure");
    expect(body.error).toContain("503");
  });

  it("returns 502 when the client throws a network error", async () => {
    fetchArxivMetadata.mockRejectedValueOnce(new Error("fetch failed"));

    const { req, ctx } = makeRequest("2301.12345");
    const res = await GET(req, ctx);

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toContain("Upstream failure");
  });
});
