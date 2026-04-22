"use client";

import { useCallback, useEffect, useState } from "react";
import type { DashboardBriefing, DashboardBriefingItem } from "@/lib/radar/deliver";

export function RadarBriefingView() {
  const [briefing, setBriefing] = useState<DashboardBriefing | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchBriefing = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/radar/briefing");
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? "Failed to load briefing.");
        return;
      }
      const data = (await res.json()) as DashboardBriefing | null;
      setBriefing(data ?? null);
    } catch {
      setError("Failed to load briefing.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchBriefing();
  }, [fetchBriefing]);

  async function handleGenerate() {
    setGenerating(true);
    setError(null);
    try {
      const res = await fetch("/api/radar/briefing", { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as
        DashboardBriefing & { error?: string };
      if (!res.ok) {
        setError(data.error ?? "Failed to generate briefing.");
        return;
      }
      setBriefing(data ?? null);
    } catch {
      setError("Failed to generate briefing.");
    } finally {
      setGenerating(false);
    }
  }

  const allItems = briefing
    ? [...(briefing.matters ?? []), ...(briefing.horizon ?? [])]
    : [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted">
            Radar Briefing
          </p>
          {briefing && (
            <p className="text-xs text-muted">
              {new Date(briefing.generatedAt).toLocaleString()}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={handleGenerate}
          disabled={generating || loading}
          className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
        >
          {generating ? "Generating..." : "Generate now"}
        </button>
      </div>

      {error && (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {error}
        </p>
      )}

      {loading && (
        <p className="text-sm text-muted">Loading briefing...</p>
      )}

      {!loading && !briefing && !error && (
        <p className="text-sm text-muted">
          No briefing yet. Hit &quot;Generate now&quot; to create your first radar briefing.
        </p>
      )}

      {!loading && briefing?.nothingToday && allItems.length === 0 && (
        <div className="rounded-xl border border-border bg-surface/50 px-4 py-5 text-center">
          <p className="text-sm font-medium">Quiet day</p>
          <p className="mt-1 text-xs text-muted">
            {briefing.quietReason ?? "Nothing new matched your radar topics today."}
          </p>
        </div>
      )}

      {allItems.map((item) => (
        <BriefingCard
          key={item.signalId}
          item={item}
        />
      ))}

      {briefing && !briefing.nothingToday && briefing.stats && (
        <p className="text-[11px] text-muted">
          {briefing.stats.signalsFetched ?? 0} signals fetched
          {briefing.stats.sourcesFailed?.length
            ? ` · ${briefing.stats.sourcesFailed.length} sources failed`
            : ""}
        </p>
      )}
    </div>
  );
}

function BriefingCard({
  item,
}: {
  item: DashboardBriefingItem;
}) {
  return (
    <div className="rounded-xl border border-border bg-background p-4 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <a
          href={item.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm font-semibold text-accent hover:underline"
        >
          {item.title}
        </a>
        <span className="shrink-0 rounded-full bg-surface px-2 py-0.5 text-[11px] font-mono text-muted">
          {item.source}
        </span>
      </div>

      {item.authors && item.authors.length > 0 && (
        <p className="text-xs text-muted">{item.authors.join(", ")}</p>
      )}

      <p className="text-xs text-foreground leading-relaxed">{item.whyItMatters}</p>

      {item.tldr && (
        <p className="rounded-lg bg-surface/60 px-3 py-2 text-xs text-muted italic">
          {item.tldr}
        </p>
      )}

      {item.matchedTopics && item.matchedTopics.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {item.matchedTopics.map((topic) => (
            <span
              key={topic}
              className="rounded-full border border-border bg-background px-2 py-0.5 text-[11px] text-muted"
            >
              {topic}
            </span>
          ))}
        </div>
      )}

    </div>
  );
}
