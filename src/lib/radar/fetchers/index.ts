// src/lib/radar/fetchers/index.ts
import type { SourceAdapter } from "../types"
import type { SourceFetcher } from "../fetch"
import { fetchSemanticScholar } from "./semantic-scholar"

export function buildProductionFetchers(): Partial<
  Record<SourceAdapter, SourceFetcher>
> {
  return {
    "semantic-scholar": fetchSemanticScholar,
  }
}
