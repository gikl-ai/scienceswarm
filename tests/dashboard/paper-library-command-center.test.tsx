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

function baseScan(overrides?: Partial<Record<string, unknown>>) {
  return {
    version: 1,
    id: "scan-1",
    project: "demo-project",
    rootPath: "/tmp/library",
    rootRealpath: "/tmp/library",
    status: "ready_for_review",
    createdAt: "2026-04-23T12:00:00.000Z",
    updatedAt: "2026-04-23T12:05:00.000Z",
    counters: {
      detectedFiles: 4,
      identified: 3,
      needsReview: 1,
      readyForApply: 0,
      failed: 0,
    },
    warnings: [],
    currentPath: null,
    reviewShardIds: ["0001"],
    ...overrides,
  };
}

function baseReviewItem() {
  return {
    id: "review-1",
    scanId: "scan-1",
    paperId: "paper-1",
    state: "needs_review",
    reasonCodes: ["low_confidence_title"],
    source: {
      relativePath: "2024 - Smith - Interesting Paper.pdf",
      rootRealpath: "/tmp/library",
      size: 12,
      mtimeMs: 1000,
      fingerprint: "quick-fingerprint",
      fingerprintStrength: "quick",
      symlink: false,
    },
    candidates: [
      {
        id: "candidate-1",
        identifiers: { doi: "10.1000/interesting" },
        title: "Interesting Paper",
        authors: ["Smith"],
        year: 2024,
        venue: "Journal of Interesting Results",
        source: "filename",
        confidence: 0.82,
        evidence: [],
        conflicts: [],
      },
    ],
    selectedCandidateId: "candidate-1",
    version: 1,
    updatedAt: "2026-04-23T12:05:00.000Z",
  };
}

describe("PaperLibraryCommandCenter", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("starts a scan and routes into the review queue", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (url === "/api/brain/paper-library/scan" && method === "POST") {
        return Response.json({ ok: true, scanId: "scan-1" });
      }

      if (url === "/api/brain/paper-library/scan?project=demo-project&id=scan-1") {
        return Response.json({
          ok: true,
          scan: baseScan(),
        });
      }

      if (url.startsWith("/api/brain/paper-library/review?")) {
        return Response.json({
          ok: true,
          items: [baseReviewItem()],
          totalCount: 1,
          filteredCount: 1,
        });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<PaperLibraryCommandCenter projectSlug="demo-project" />);

    fireEvent.change(screen.getByPlaceholderText("/Users/you/Research Papers"), {
      target: { value: "/tmp/library" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start dry-run scan" }));

    expect(await screen.findByText("ready for review")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open review queue" }));
    expect(await screen.findByText("Interesting Paper (2024)")).toBeInTheDocument();
  });

  it("supports accept, plan, approve, apply, and undo through the command center", async () => {
    window.localStorage.setItem(
      "scienceswarm.paperLibrary.session.demo-project",
      JSON.stringify({
        step: "review",
        rootPath: "/tmp/library",
        templateFormat: "{year} - {title}.pdf",
        scanId: "scan-1",
      }),
    );

    let scanStatus: "review" | "apply" | "applied" | "undone" = "review";
    let approved = false;
    let applied = false;
    let undone = false;

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (url === "/api/brain/paper-library/scan?project=demo-project&id=scan-1") {
        return Response.json({
          ok: true,
          scan: baseScan({
            status: scanStatus === "review" ? "ready_for_review" : "ready_for_apply",
            counters: {
              detectedFiles: 4,
              identified: 4,
              needsReview: scanStatus === "review" ? 1 : 0,
              readyForApply: 1,
              failed: 0,
            },
            applyPlanId: scanStatus === "review" ? undefined : "plan-1",
          }),
        });
      }

      if (url.startsWith("/api/brain/paper-library/review?")) {
        return Response.json({
          ok: true,
          items: scanStatus === "review" ? [baseReviewItem()] : [],
          totalCount: scanStatus === "review" ? 1 : 0,
          filteredCount: scanStatus === "review" ? 1 : 0,
        });
      }

      if (url === "/api/brain/paper-library/review" && method === "POST") {
        scanStatus = "apply";
        return Response.json({ ok: true, remainingCount: 0 });
      }

      if (url === "/api/brain/paper-library/apply-plan" && method === "POST") {
        return Response.json({ ok: true, applyPlanId: "plan-1" });
      }

      if (url.startsWith("/api/brain/paper-library/apply-plan?")) {
        return Response.json({
          ok: true,
          plan: {
            version: 1,
            id: "plan-1",
            scanId: "scan-1",
            project: "demo-project",
            status: applied ? "applied" : approved ? "approved" : "validated",
            rootPath: "/tmp/library",
            rootRealpath: "/tmp/library",
            templateFormat: "{year} - {title}.pdf",
            operationCount: 1,
            conflictCount: 0,
            operationShardIds: ["0001"],
            planDigest: "digest",
            approvalTokenHash: approved ? "token-hash" : undefined,
            approvalExpiresAt: approved ? "2026-04-23T13:00:00.000Z" : undefined,
            approvedAt: approved ? "2026-04-23T12:30:00.000Z" : undefined,
            manifestId: applied ? "manifest-1" : undefined,
            createdAt: "2026-04-23T12:20:00.000Z",
            updatedAt: "2026-04-23T12:20:00.000Z",
          },
          operations: [
            {
              id: "operation-1",
              paperId: "paper-1",
              kind: "rename",
              source: baseReviewItem().source,
              destinationRelativePath: "2024 - Interesting Paper.pdf",
              reason: "Paper library template proposal",
              confidence: 0.82,
              conflictCodes: [],
            },
          ],
          totalCount: 1,
          filteredCount: 1,
        });
      }

      if (url === "/api/brain/paper-library/apply-plan/approve" && method === "POST") {
        approved = true;
        return Response.json({
          ok: true,
          approvalToken: "approval-token",
          expiresAt: "2026-04-23T13:00:00.000Z",
        });
      }

      if (url === "/api/brain/paper-library/apply" && method === "POST") {
        applied = true;
        scanStatus = "applied";
        return Response.json({
          ok: true,
          manifestId: "manifest-1",
        });
      }

      if (url.startsWith("/api/brain/paper-library/manifest?")) {
        return Response.json({
          ok: true,
          manifest: {
            version: 1,
            id: "manifest-1",
            project: "demo-project",
            applyPlanId: "plan-1",
            status: undone ? "undone" : "applied",
            rootRealpath: "/tmp/library",
            planDigest: "digest",
            operationCount: 1,
            appliedCount: 1,
            failedCount: 0,
            undoneCount: undone ? 1 : 0,
            operationShardIds: ["0001"],
            warnings: [],
            createdAt: "2026-04-23T12:31:00.000Z",
            updatedAt: "2026-04-23T12:31:00.000Z",
          },
          operations: [
            {
              operationId: "operation-1",
              paperId: "paper-1",
              sourceRelativePath: "2024 - Smith - Interesting Paper.pdf",
              destinationRelativePath: "2024 - Interesting Paper.pdf",
              status: undone ? "undone" : "verified",
              appliedAt: "2026-04-23T12:31:00.000Z",
              undoneAt: undone ? "2026-04-23T12:35:00.000Z" : undefined,
            },
          ],
          totalCount: 1,
          filteredCount: 1,
        });
      }

      if (url === "/api/brain/paper-library/undo" && method === "POST") {
        undone = true;
        scanStatus = "undone";
        return Response.json({ ok: true });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<PaperLibraryCommandCenter projectSlug="demo-project" />);

    expect(await screen.findByText("Interesting Paper (2024)")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Accept selected" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Apply/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Apply1" }));
    fireEvent.click(await screen.findByRole("button", { name: /preview/i }));
    expect(await screen.findByText("1 operations")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Approve plan" }));
    expect(await screen.findByText(/Plan approved until/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Apply approved plan" }));
    expect(await screen.findByText("Manifest and undo")).toBeInTheDocument();
    expect(await screen.findByText("applied")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Undo changes" }));
    expect(await screen.findAllByText("undone")).toHaveLength(2);
  });

  it("renders bounded graph and cluster windows with visible failure states", async () => {
    window.localStorage.setItem(
      "scienceswarm.paperLibrary.session.demo-project",
      JSON.stringify({
        step: "graph",
        rootPath: "/tmp/library",
        templateFormat: "{year} - {title}.pdf",
        scanId: "scan-1",
      }),
    );

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (url === "/api/brain/paper-library/scan?project=demo-project&id=scan-1") {
        return Response.json({
          ok: true,
          scan: baseScan({
            status: "ready_for_apply",
            counters: {
              detectedFiles: 24,
              identified: 20,
              needsReview: 0,
              readyForApply: 20,
              failed: 0,
            },
          }),
        });
      }

      if (url.startsWith("/api/brain/paper-library/graph?")) {
        const search = new URL(url, "http://localhost");
        const cursor = search.searchParams.get("cursor");
        return Response.json({
          ok: true,
          nodes: cursor
            ? [
                {
                  id: "node-2",
                  kind: "external_paper",
                  paperIds: [],
                  title: "Bridge Paper",
                  authors: ["Lee"],
                  local: false,
                  suggestion: true,
                  sources: ["semantic_scholar"],
                },
              ]
            : [
                {
                  id: "node-1",
                  kind: "local_paper",
                  paperIds: ["paper-1"],
                  title: "Interesting Paper",
                  authors: ["Smith"],
                  local: true,
                  suggestion: false,
                  sources: ["filename"],
                },
              ],
          edges: [],
          sourceRuns: [
            {
              id: "run-1",
              source: "semantic_scholar",
              status: "rate_limited",
              attempts: 2,
              fetchedCount: 0,
              cacheHits: 0,
              startedAt: "2026-04-23T12:00:00.000Z",
              completedAt: "2026-04-23T12:00:05.000Z",
              message: "Retry after quota reset.",
            },
          ],
          warnings: ["Semantic Scholar paused for this scan."],
          totalCount: 2,
          filteredCount: 2,
          nextCursor: cursor ? undefined : "MQ",
        });
      }

      if (url.startsWith("/api/brain/paper-library/clusters?")) {
        const search = new URL(url, "http://localhost");
        const cursor = search.searchParams.get("cursor");
        return Response.json({
          ok: true,
          clusters: cursor
            ? [
                {
                  id: "cluster-2",
                  label: "Protein folding",
                  folderName: "protein-folding",
                  keywords: ["protein", "folding"],
                  memberCount: 3,
                  confidence: 0.67,
                  members: [],
                },
              ]
            : [
                {
                  id: "cluster-1",
                  label: "CRISPR design",
                  folderName: "crispr-design",
                  keywords: ["crispr", "guide"],
                  memberCount: 5,
                  confidence: 0.78,
                  members: [],
                },
              ],
          unclusteredCount: 2,
          model: {
            id: "local-hash",
            provider: "local_hash",
            dimensions: 256,
            chunking: "semantic-preview",
            status: "model_unavailable",
            cacheHits: 0,
            generatedCount: 0,
            reusedGbrainCount: 0,
            fallbackCount: 0,
          },
          warnings: ["No compatible embedding model is available for this project."],
          totalCount: 2,
          filteredCount: 2,
          nextCursor: cursor ? undefined : "MQ",
        });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<PaperLibraryCommandCenter projectSlug="demo-project" />);

    expect(await screen.findByText("Interesting Paper")).toBeInTheDocument();
    expect(await screen.findByText("Semantic Scholar paused for this scan.")).toBeInTheDocument();
    expect(await screen.findByText("model unavailable")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Load more nodes" }));
    fireEvent.click(screen.getByRole("button", { name: "Load more clusters" }));

    expect(await screen.findByText("Bridge Paper")).toBeInTheDocument();
    expect(await screen.findByText("Protein folding")).toBeInTheDocument();
    expect(screen.getByText(/Gap suggestions land here in the next phase/i)).toBeInTheDocument();
  });
});
