// src/lib/radar/fetch.ts
import type { RadarSource, Signal, SourceAdapter } from "./types"

export type SourceFetcher = (source: RadarSource) => Promise<Signal[]>

export interface FetchResult {
  signals: Signal[]
  failed: string[] // source IDs that failed
}

export async function fetchSignals(
  sources: RadarSource[],
  fetchers: Partial<Record<SourceAdapter, SourceFetcher>>
): Promise<FetchResult> {
  const enabledSources = sources.filter((s) => s.enabled)
  const failed: string[] = []
  const allSignals: Signal[] = []

  const results = await Promise.allSettled(
    enabledSources.map(async (source) => {
      const fetcher = fetchers[source.adapter]
      if (!fetcher) {
        failed.push(source.id)
        return []
      }
      return fetcher(source)
    })
  )

  for (let i = 0; i < results.length; i++) {
    const result = results[i]
    if (result.status === "fulfilled") {
      allSignals.push(...result.value)
    } else {
      failed.push(enabledSources[i].id)
    }
  }

  // Deduplicate by URL
  const seen = new Set<string>()
  const deduped: Signal[] = []
  for (const signal of allSignals) {
    const key = signal.url.toLowerCase()
    if (!seen.has(key)) {
      seen.add(key)
      deduped.push(signal)
    }
  }

  return { signals: deduped, failed }
}
