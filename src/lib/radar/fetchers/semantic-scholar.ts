// src/lib/radar/fetchers/semantic-scholar.ts
import type { RadarSource, Signal } from "../types"

const API_BASE = "https://api.semanticscholar.org/graph/v1"
const FIELDS =
  "paperId,title,url,externalIds,abstract,tldr,authors,citationCount,publicationDate"
const DEFAULT_LOOKBACK_DAYS = 7

interface S2Paper {
  paperId: string
  title: string
  url: string
  externalIds: { ArXiv?: string; DOI?: string }
  abstract: string | null
  tldr: { text: string } | null
  authors: Array<{ name: string }>
  citationCount: number
  publicationDate: string | null
}

export async function fetchSemanticScholar(
  source: RadarSource,
  lookbackDays = DEFAULT_LOOKBACK_DAYS
): Promise<Signal[]> {
  const query = source.query ?? source.url ?? ""
  if (!query) return []

  const params = new URLSearchParams({
    query,
    fields: FIELDS,
    limit: "20",
  })

  const apiKey = process.env.SEMANTIC_SCHOLAR_API_KEY
  const headers: Record<string, string> = {}
  if (apiKey) {
    headers["x-api-key"] = apiKey
  }

  const response = await fetch(
    `${API_BASE}/paper/search?${params.toString()}`,
    { headers }
  )

  if (!response.ok) {
    throw new Error(
      `Semantic Scholar API error: ${response.status} ${response.statusText}`
    )
  }

  const data = await response.json()
  const papers: S2Paper[] = data.data ?? []

  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - lookbackDays)

  return papers
    .filter((paper) => {
      if (!paper.publicationDate) return true
      return new Date(paper.publicationDate) >= cutoff
    })
    .map((paper) => {
      const arxivId = paper.externalIds?.ArXiv
      const url = arxivId
        ? `https://arxiv.org/abs/${arxivId}`
        : paper.url

      return {
        id: `ss-${paper.paperId}`,
        title: paper.title,
        sourceId: source.id,
        url,
        timestamp: paper.publicationDate
          ? new Date(paper.publicationDate).toISOString()
          : new Date().toISOString(),
        content: paper.abstract ?? "",
        metadata: {
          authors: paper.authors.map((a) => a.name),
          citations: paper.citationCount,
          tldr: paper.tldr?.text,
        },
      }
    })
}
