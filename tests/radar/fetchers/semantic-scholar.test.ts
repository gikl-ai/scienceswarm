// tests/radar/fetchers/semantic-scholar.test.ts
import { describe, it, expect, vi, afterEach } from "vitest"
import { fetchSemanticScholar } from "@/lib/radar/fetchers/semantic-scholar"
import type { RadarSource } from "@/lib/radar/types"

// Mock global fetch
const mockFetch = vi.fn()
vi.stubGlobal("fetch", mockFetch)

afterEach(() => {
  vi.restoreAllMocks()
})

describe("fetchSemanticScholar", () => {
  const source: RadarSource = {
    id: "arxiv-cs-ai",
    type: "arxiv",
    adapter: "semantic-scholar",
    query: "mechanistic interpretability",
    enabled: true,
  }

  it("fetches and normalizes papers from Semantic Scholar", async () => {
    // Compute a publicationDate that sits safely inside the default
    // 7-day lookback window. Hardcoding a literal like "2026-04-08"
    // silently stops working once CI clock crosses 7 days past that
    // date — the filter uses `>= Date.now() - 7*day`, which trips at
    // midnight UTC and produces an empty result array.
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
      .toISOString()
      .split("T")[0]
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          {
            paperId: "abc123",
            title: "Understanding Transformer Circuits",
            url: "https://www.semanticscholar.org/paper/abc123",
            externalIds: { ArXiv: "2401.00001" },
            abstract: "We analyze attention head circuits...",
            tldr: { text: "Novel circuit analysis in transformers" },
            authors: [{ name: "Alice" }, { name: "Bob" }],
            citationCount: 42,
            publicationDate: threeDaysAgo,
          },
        ],
      }),
    })

    const signals = await fetchSemanticScholar(source)

    expect(signals).toHaveLength(1)
    expect(signals[0].title).toBe("Understanding Transformer Circuits")
    expect(signals[0].metadata.authors).toEqual(["Alice", "Bob"])
    expect(signals[0].metadata.citations).toBe(42)
    expect(signals[0].metadata.tldr).toBe("Novel circuit analysis in transformers")
    expect(signals[0].url).toContain("arxiv.org")
  })

  it("handles API errors gracefully", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
    })

    await expect(fetchSemanticScholar(source)).rejects.toThrow()
  })

  it("filters papers older than 7 days by default", async () => {
    const oldDate = new Date()
    oldDate.setDate(oldDate.getDate() - 10)
    const oldDateStr = oldDate.toISOString().split("T")[0]

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          {
            paperId: "old1",
            title: "Old Paper",
            url: "https://example.com",
            externalIds: {},
            abstract: "Old stuff",
            tldr: null,
            authors: [],
            citationCount: 0,
            publicationDate: oldDateStr,
          },
        ],
      }),
    })

    const signals = await fetchSemanticScholar(source)
    expect(signals).toHaveLength(0)
  })
})
