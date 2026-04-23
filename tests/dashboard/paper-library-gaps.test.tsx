// @vitest-environment jsdom

import type { AnchorHTMLAttributes, ReactNode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PaperLibraryCommandCenter } from "@/components/research/paper-library/command-center";

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: { href: string; children: ReactNode } & AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

function baseScan() {
  return {
    version: 1,
    id: "scan-1",
    project: "demo-project",
    rootPath: "/tmp/library",
    rootRealpath: "/tmp/library",
    status: "ready_for_apply",
    createdAt: "2026-04-23T12:00:00.000Z",
    updatedAt: "2026-04-23T12:05:00.000Z",
    counters: {
      detectedFiles: 4,
      identified: 4,
      needsReview: 0,
      readyForApply: 4,
      failed: 0,
    },
    warnings: [],
    currentPath: null,
    reviewShardIds: ["0001"],
  };
}

describe("PaperLibrary gap suggestions", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders gap suggestions and updates their state from the graph panel", async () => {
    window.localStorage.setItem(
      "scienceswarm.paperLibrary.session.demo-project",
      JSON.stringify({
        step: "graph",
        rootPath: "/tmp/library",
        templateFormat: "{year} - {title}.pdf",
        scanId: "scan-1",
      }),
    );

    let gapState: "open" | "watching" = "open";

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (url === "/api/brain/paper-library/scan?project=demo-project&id=scan-1") {
        return Response.json({ ok: true, scan: baseScan() });
      }

      if (url.startsWith("/api/brain/paper-library/graph?")) {
        return Response.json({
          ok: true,
          nodes: [
            {
              id: "paper:doi:10.1000/local",
              kind: "local_paper",
              paperIds: ["paper-1"],
              title: "Interesting Paper",
              authors: ["Smith"],
              year: 2024,
              venue: "Journal",
              identifiers: { doi: "10.1000/local" },
              local: true,
              suggestion: false,
              sources: ["filename"],
              evidence: [],
            },
          ],
          edges: [],
          sourceRuns: [],
          warnings: [],
          totalCount: 1,
          filteredCount: 1,
        });
      }

      if (url.startsWith("/api/brain/paper-library/clusters?")) {
        return Response.json({
          ok: true,
          clusters: [
            {
              id: "cluster-1",
              label: "Protein Design",
              folderName: "protein-design",
              keywords: ["protein"],
              memberCount: 2,
              confidence: 0.81,
              representativePaperId: "paper-1",
              members: [],
            },
          ],
          unclusteredCount: 0,
          model: {
            id: "paper-library-hash-embedding-v1",
            provider: "local_hash",
            dimensions: 256,
            chunking: "semantic-summary-v1",
            status: "ready",
            cacheHits: 0,
            generatedCount: 2,
            reusedGbrainCount: 0,
            fallbackCount: 2,
          },
          warnings: [],
          totalCount: 1,
          filteredCount: 1,
        });
      }

      if (url.startsWith("/api/brain/paper-library/gaps?")) {
        return Response.json({
          ok: true,
          suggestions: [
            {
              id: "gap-1",
              scanId: "scan-1",
              nodeId: "paper:doi:10.2000/missing",
              title: "Missing Seminal Paper",
              authors: ["Liskov"],
              year: 2025,
              venue: "Nature",
              identifiers: { doi: "10.2000/missing" },
              sources: ["semantic_scholar"],
              state: gapState,
              reasonCodes: ["citation_frequency", "bridge_position"],
              score: {
                overall: 0.88,
                citationFrequency: 0.75,
                bridgePosition: 0.5,
                clusterGap: 0.5,
                recentConnected: 1,
                disagreementPenalty: 0,
              },
              localConnectionCount: 3,
              evidencePaperIds: ["paper-1"],
              evidenceClusterIds: ["cluster-1"],
              evidenceNodeIds: ["paper:doi:10.1000/local"],
              createdAt: "2026-04-23T12:10:00.000Z",
              updatedAt: "2026-04-23T12:10:00.000Z",
            },
          ],
          stateCounts: {
            open: gapState === "open" ? 1 : 0,
            watching: gapState === "watching" ? 1 : 0,
            ignored: 0,
            saved: 0,
            imported: 0,
          },
          warnings: [],
          totalCount: 1,
          filteredCount: 1,
        });
      }

      if (url === "/api/brain/paper-library/gaps" && method === "POST") {
        gapState = "watching";
        return Response.json({
          ok: true,
          suggestion: {
            id: "gap-1",
            state: "watching",
          },
        });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<PaperLibraryCommandCenter projectSlug="demo-project" />);

    expect(await screen.findByText("Gap suggestions")).toBeInTheDocument();
    expect(await screen.findByText("Missing Seminal Paper (2025)")).toBeInTheDocument();
    expect(screen.getByText("citation frequency")).toBeInTheDocument();
    expect(screen.getByText("open")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Watch" }));

    await waitFor(() => {
      expect(screen.getByText("watching")).toBeInTheDocument();
    });
  });
});
