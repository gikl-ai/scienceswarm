"use client";

import { useEffect, useState } from "react";
import { FileMagnifyingGlass } from "@phosphor-icons/react";
import type { SearchResult } from "@/brain/types";
import { Spinner } from "@/components/spinner";

const BRAIN_SEARCH_DEBOUNCE_MS = 250;

type BrainSearchStatus = "idle" | "loading" | "ready" | "error";
type BrainSearchResult = Pick<
  SearchResult,
  "path" | "title" | "snippet" | "relevance" | "type" | "compiledView"
>;

export function BrainSearchPanel({
  enabled,
  onOpenResult,
}: {
  enabled: boolean;
  onOpenResult: (slug: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<BrainSearchStatus>("idle");
  const [results, setResults] = useState<BrainSearchResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const trimmedQuery = query.trim();
  const showResults = enabled && trimmedQuery.length > 0;

  useEffect(() => {
    if (!showResults) {
      return;
    }

    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      setStatus("loading");
      setError(null);
      const params = new URLSearchParams({
        query: trimmedQuery,
        mode: "list",
        limit: "8",
        detail: "medium",
      });
      fetch(`/api/brain/search?${params.toString()}`, {
        signal: controller.signal,
      })
        .then(async (response) => {
          if (!response.ok) {
            throw new Error("Brain search failed");
          }
          return response.json() as Promise<BrainSearchResult[]>;
        })
        .then((payload) => {
          if (controller.signal.aborted) return;
          setResults(sortBrainSearchResults(payload));
          setStatus("ready");
        })
        .catch(() => {
          if (controller.signal.aborted) return;
          setResults([]);
          setStatus("error");
          setError("Brain search failed. Try again.");
        });
    }, BRAIN_SEARCH_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [showResults, trimmedQuery]);

  return (
    <section className="border-b border-border bg-white px-3 py-2 md:px-4">
      <div className="flex flex-col gap-2 md:flex-row md:items-start">
        <label
          htmlFor="gbrain-search"
          className="flex shrink-0 items-center gap-1.5 pt-2 text-xs font-semibold text-muted"
        >
          <FileMagnifyingGlass size={15} />
          Search brain
        </label>
        <div className="min-w-0 flex-1">
          <input
            id="gbrain-search"
            type="search"
            value={query}
            onChange={(event) => {
              const nextQuery = event.target.value;
              setQuery(nextQuery);
              if (nextQuery.trim().length === 0) {
                setStatus("idle");
                setResults([]);
                setError(null);
              }
            }}
            placeholder="Search current views, papers, tasks, or notes"
            aria-label="Search research brain"
            disabled={!enabled}
            className="h-9 w-full rounded border border-border bg-surface px-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted focus:border-accent focus:bg-white focus:ring-2 focus:ring-accent/20 disabled:cursor-not-allowed disabled:opacity-60"
          />
          {showResults && (
            <div
              className="mt-2 overflow-hidden rounded border border-border bg-white shadow-sm"
              role="region"
              aria-label="Brain search results"
            >
              {status === "loading" && (
                <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted">
                  <Spinner size="h-3.5 w-3.5" testId="brain-search-spinner" />
                  Searching brain...
                </div>
              )}
              {status === "error" && (
                <div className="px-3 py-2 text-xs text-danger">
                  {error ?? "Brain search failed"}
                </div>
              )}
              {status === "ready" && results.length === 0 && (
                <div className="px-3 py-2 text-xs text-muted">
                  {`No brain results for "${query.trim()}".`}
                </div>
              )}
              {status === "ready" && results.length > 0 && (
                <ul className="max-h-60 overflow-y-auto divide-y divide-border">
                  {results.map((result) => (
                    <li key={`${result.path}-${result.title}`}>
                      <button
                        type="button"
                        onClick={() => {
                          const slug = normalizeBrainArtifactSlug(
                            result.compiledView?.pagePath ?? result.path,
                          );
                          if (!slug) return;
                          onOpenResult(slug);
                        }}
                        className="block w-full px-3 py-2 text-left transition-colors hover:bg-surface focus:bg-surface focus:outline-none"
                      >
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                          <span className="truncate text-sm font-semibold text-foreground">
                            {result.title || result.path}
                          </span>
                          <span className="rounded border border-border bg-surface px-1.5 py-0.5 text-[10px] font-semibold uppercase text-muted">
                            {getBrainSearchTypeLabel(result)}
                          </span>
                        </div>
                        <div className="mt-0.5 truncate font-mono text-[10px] text-muted">
                          {result.compiledView?.pagePath ?? result.path}
                        </div>
                        {result.snippet && (
                          <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted">
                            {result.compiledView?.summary ?? result.snippet}
                          </p>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function normalizeBrainArtifactSlug(slug: string | null | undefined): string | null {
  const trimmed = slug?.trim().replace(/^gbrain:/, "");
  if (!trimmed) return null;
  return trimmed.replace(/\.md$/i, "");
}

function getBrainResultRank(result: BrainSearchResult): number {
  if (result.compiledView || result.type === "concept") return 3;
  if (result.type === "hypothesis" || result.type === "experiment" || result.type === "task") return 2;
  if (result.type === "paper" || result.type === "observation") return 1;
  return 0;
}

function sortBrainSearchResults(results: BrainSearchResult[]): BrainSearchResult[] {
  return [...results].sort((left, right) => {
    const rankDelta = getBrainResultRank(right) - getBrainResultRank(left);
    if (rankDelta !== 0) return rankDelta;
    return right.relevance - left.relevance;
  });
}

function getBrainSearchTypeLabel(result: BrainSearchResult): string {
  if (result.compiledView || result.type === "concept") return "Current view";
  return result.type.replace(/_/g, " ");
}
