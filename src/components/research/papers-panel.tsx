"use client";

import { useState } from "react";

export interface Paper {
  id: string;
  title: string;
  authors: string;
  year: number;
  venue?: string;
  status: "unread" | "reading" | "reviewed" | "cited";
  tags: string[];
  notes?: string;
  file?: string;
}

const statusColors: Record<string, string> = {
  unread: "bg-zinc-100 text-zinc-600 border-zinc-200",
  reading: "bg-amber-50 text-amber-700 border-amber-200",
  reviewed: "bg-green-50 text-green-700 border-green-200",
  cited: "bg-accent/10 text-accent border-accent/20",
};

export function PapersPanel({
  papers,
  onSelectPaper,
  onAddPaper,
  onUseInChat,
}: {
  papers: Paper[];
  onSelectPaper: (paper: Paper) => void;
  onAddPaper: () => void;
  onUseInChat?: (paper: Paper) => void;
}) {
  const [filter, setFilter] = useState<string>("all");
  const [search, setSearch] = useState("");

  const filtered = papers.filter((p) => {
    if (filter !== "all" && p.status !== filter) return false;
    if (search && !p.title.toLowerCase().includes(search.toLowerCase()) &&
        !p.authors.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const counts = {
    all: papers.length,
    unread: papers.filter((p) => p.status === "unread").length,
    reading: papers.filter((p) => p.status === "reading").length,
    reviewed: papers.filter((p) => p.status === "reviewed").length,
    cited: papers.filter((p) => p.status === "cited").length,
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="p-4 border-b-2 border-border">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-bold">Literature</h2>
          <button
            onClick={onAddPaper}
            className="text-sm bg-accent text-white px-3 py-1.5 rounded-lg hover:bg-accent-hover transition-colors font-medium"
          >
            + Add Paper
          </button>
        </div>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search papers..."
          className="w-full bg-surface border-2 border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-accent transition-colors"
        />
      </div>

      {/* Filter tabs */}
      <div className="flex gap-1 px-4 py-2 border-b border-border/50 overflow-x-auto">
        {(["all", "unread", "reading", "reviewed", "cited"] as const).map((s) => (
          <button
            key={s}
            onClick={() => setFilter(s)}
            className={`text-xs px-2.5 py-1 rounded-full font-medium transition-colors whitespace-nowrap ${
              filter === s
                ? "bg-accent text-white"
                : "text-muted hover:text-foreground hover:bg-surface"
            }`}
          >
            {s.charAt(0).toUpperCase() + s.slice(1)} ({counts[s]})
          </button>
        ))}
      </div>

      {/* Paper list */}
      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="p-8 text-center text-muted text-sm">
            {search ? "No papers match your search." : "No papers yet. Upload PDFs to start your literature review."}
          </div>
        ) : (
          <div className="divide-y divide-border/50">
            {filtered.map((paper) => (
              <div
                key={paper.id}
                className="group flex items-center gap-3 px-4 py-2 hover:bg-surface/50 transition-colors"
              >
                <button
                  type="button"
                  onClick={() => onSelectPaper(paper)}
                  className="flex min-w-0 flex-1 items-center gap-3 text-left"
                  title={`${paper.title}\n${paper.authors} (${paper.year})${paper.venue ? ` · ${paper.venue}` : ""}`}
                >
                  <span className="flex-shrink-0 text-sm" aria-hidden="true">📄</span>
                  <div className="min-w-0 flex-1">
                    <h3 className="truncate text-sm font-semibold leading-tight">{paper.title}</h3>
                    <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-muted">
                      <span className="min-w-0 truncate">
                        {paper.authors} ({paper.year}){paper.venue ? ` · ${paper.venue}` : ""}
                      </span>
                      <span className={`flex-shrink-0 rounded-full border px-1.5 py-0 text-[10px] font-medium leading-4 ${statusColors[paper.status]}`}>
                        {paper.status}
                      </span>
                      {paper.tags.slice(0, 2).map((tag) => (
                        <span
                          key={tag}
                          className="flex-shrink-0 rounded-full bg-accent/5 px-1.5 py-0 text-[10px] leading-4 text-accent"
                        >
                          {tag}
                        </span>
                      ))}
                      {paper.tags.length > 2 && (
                        <span className="flex-shrink-0 text-[10px] text-muted/70">
                          +{paper.tags.length - 2}
                        </span>
                      )}
                    </div>
                  </div>
                </button>
                {onUseInChat && paper.file && (
                  <button
                    type="button"
                    onClick={() => onUseInChat(paper)}
                    title={`Use "${paper.title}" in chat`}
                    aria-label="Use in chat"
                    className="flex-shrink-0 rounded-md border border-border bg-white px-2 py-1 text-[10px] font-semibold text-foreground opacity-0 transition-opacity hover:border-accent hover:text-accent group-hover:opacity-100 focus:opacity-100"
                  >
                    Use
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
