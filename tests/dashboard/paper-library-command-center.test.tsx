// @vitest-environment jsdom

import type { AnchorHTMLAttributes, ReactNode } from "react";
import { act } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
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
    vi.useRealTimers();
  });

  it("starts a scan and routes into the review queue", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (url === "/api/brain/paper-library/scan?project=demo-project&latest=1") {
        return Response.json(
          { error: { message: "Paper library scan not found." } },
          { status: 404 },
        );
      }

      if (url === "/api/local-folder-picker" && method === "POST") {
        return Response.json({ path: "/tmp/library" });
      }

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

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([request]) => String(request) === "/api/brain/paper-library/scan?project=demo-project&latest=1"),
      ).toBe(true);
    });

    fireEvent.click(screen.getByRole("button", { name: "Import PDF Folder" }));

    expect(await screen.findByText("ready for review")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open review queue" }));
    expect(await screen.findByText("2024 - Smith - Interesting Paper.pdf")).toBeInTheDocument();
  });

  it("hydrates the latest persisted scan when local storage is empty", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (url === "/api/brain/paper-library/scan?project=demo-project&latest=1") {
        return Response.json({
          ok: true,
          scan: baseScan({
            counters: {
              detectedFiles: 4,
              identified: 4,
              needsReview: 1,
              readyForApply: 3,
              failed: 0,
            },
          }),
        });
      }

      if (url === "/api/brain/paper-library/scan?project=demo-project&id=scan-1") {
        return Response.json({
          ok: true,
          scan: baseScan({
            counters: {
              detectedFiles: 4,
              identified: 4,
              needsReview: 1,
              readyForApply: 3,
              failed: 0,
            },
          }),
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

    expect(await screen.findByText("2024 - Smith - Interesting Paper.pdf")).toBeInTheDocument();
    expect(window.localStorage.getItem("scienceswarm.paperLibrary.session.demo-project")).toContain("\"rootPath\":\"/tmp/library\"");
    expect(window.localStorage.getItem("scienceswarm.paperLibrary.session.demo-project")).toContain("\"scanId\":\"scan-1\"");
  });

  it("hydrates SSR markup before restoring a browser session", async () => {
    let serverHtml = "";
    const originalWindow = window;
    vi.stubGlobal("window", undefined);
    try {
      serverHtml = renderToString(<PaperLibraryCommandCenter projectSlug="demo-project" />);
    } finally {
      vi.stubGlobal("window", originalWindow);
    }

    window.localStorage.setItem(
      "scienceswarm.paperLibrary.session.demo-project",
      JSON.stringify({
        step: "history",
        rootPath: "/tmp/library",
        templateFormat: "papers/{year}/{title}.pdf",
        scanId: "scan-1",
        applyPlanId: "plan-1",
        manifestId: "manifest-1",
      }),
    );

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url === "/api/brain/paper-library/scan?project=demo-project&id=scan-1") {
        return Response.json({
          ok: true,
          scan: baseScan({
            status: "ready_for_apply",
            counters: {
              detectedFiles: 4,
              identified: 4,
              needsReview: 0,
              readyForApply: 1,
              failed: 0,
            },
            applyPlanId: "plan-1",
          }),
        });
      }

      if (url.startsWith("/api/brain/paper-library/apply-plan?")) {
        return Response.json({
          ok: true,
          plan: {
            version: 1,
            id: "plan-1",
            scanId: "scan-1",
            project: "demo-project",
            status: "applied",
            rootPath: "/tmp/library",
            rootRealpath: "/tmp/library",
            templateFormat: "papers/{year}/{title}.pdf",
            operationCount: 1,
            conflictCount: 0,
            operationShardIds: ["0001"],
            planDigest: "digest",
            manifestId: "manifest-1",
            createdAt: "2026-04-23T12:20:00.000Z",
            updatedAt: "2026-04-23T12:20:00.000Z",
          },
          operations: [
            {
              id: "operation-1",
              paperId: "paper-1",
              kind: "rename",
              source: baseReviewItem().source,
              destinationRelativePath: "papers/2024/Interesting Paper.pdf",
              reason: "Paper library template proposal",
              confidence: 0.82,
              conflictCodes: [],
            },
          ],
          totalCount: 1,
          filteredCount: 1,
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
            status: "applied",
            rootRealpath: "/tmp/library",
            planDigest: "digest",
            operationCount: 1,
            appliedCount: 1,
            failedCount: 0,
            undoneCount: 0,
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
              destinationRelativePath: "papers/2024/Interesting Paper.pdf",
              status: "applied",
              appliedAt: "2026-04-23T12:31:00.000Z",
            },
          ],
          totalCount: 1,
          filteredCount: 1,
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    const consoleErrorSpy = vi.spyOn(console, "error");
    const container = document.createElement("div");
    container.innerHTML = serverHtml;
    document.body.appendChild(container);
    let root: ReturnType<typeof hydrateRoot> | null = null;

    await act(async () => {
      root = hydrateRoot(container, <PaperLibraryCommandCenter projectSlug="demo-project" />);
      await Promise.resolve();
    });

    expect(await screen.findByText("Manifest and undo")).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([request]) => String(request).includes("latest=1"))).toBe(false);
    expect(
      consoleErrorSpy.mock.calls.filter(([message]) => String(message).includes("Hydration failed")),
    ).toHaveLength(0);

    await act(async () => {
      root?.unmount();
    });
    container.remove();
  });

  it("does not open the folder picker while latest-scan restore is in flight", async () => {
    let resolveLatestScan: ((response: Response) => void) | undefined;
    const latestScanResponse = new Promise<Response>((resolve) => {
      resolveLatestScan = resolve;
    });

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (url === "/api/brain/paper-library/scan?project=demo-project&latest=1") {
        return latestScanResponse;
      }

      if (url === "/api/local-folder-picker" && method === "POST") {
        throw new Error("Folder picker should not open while restore is loading.");
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<PaperLibraryCommandCenter projectSlug="demo-project" />);

    expect(screen.getByRole("button", { name: "Import PDF Folder" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Import PDF Folder" }));

    resolveLatestScan?.(Response.json({
      ok: true,
      scan: baseScan({
        rootPath: "/tmp/latest-library",
        rootRealpath: "/tmp/latest-library",
        status: "scanning",
      }),
    }));

    await waitFor(() => {
      expect(screen.getByText("/tmp/latest-library")).toBeInTheDocument();
    });

    expect(
      fetchMock.mock.calls.some(([request]) => String(request) === "/api/local-folder-picker"),
    ).toBe(false);
  });

  it("does not start a scan when the folder picker is cancelled", async () => {
    window.localStorage.setItem(
      "scienceswarm.paperLibrary.session.demo-project",
      JSON.stringify({
        step: "scan",
        rootPath: "",
        templateFormat: "{year} - {title}.pdf",
      }),
    );

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (url === "/api/brain/paper-library/scan?project=demo-project&latest=1") {
        return Response.json(
          { error: { message: "Paper library scan not found." } },
          { status: 404 },
        );
      }

      if (url === "/api/local-folder-picker" && method === "POST") {
        return Response.json({ cancelled: true });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<PaperLibraryCommandCenter projectSlug="demo-project" />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Import PDF Folder" })).toBeEnabled();
    });

    fireEvent.click(screen.getByRole("button", { name: "Import PDF Folder" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/local-folder-picker", { method: "POST" });
    });

    expect(
      fetchMock.mock.calls.some(([request]) => String(request) === "/api/brain/paper-library/scan"),
    ).toBe(false);
  });

  it("disables folder import while a scan is already running", async () => {
    window.localStorage.setItem(
      "scienceswarm.paperLibrary.session.demo-project",
      JSON.stringify({
        step: "scan",
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
          scan: baseScan({ status: "scanning" }),
        });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<PaperLibraryCommandCenter projectSlug="demo-project" />);

    expect(await screen.findByText("scanning")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Import PDF Folder" })).toBeDisabled();
    expect(fetchMock).not.toHaveBeenCalledWith("/api/brain/paper-library/scan?project=demo-project&latest=1");
  });

  it("ignores malformed latest-scan payloads without breaking the scan view", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (url === "/api/brain/paper-library/scan?project=demo-project&latest=1") {
        return Response.json({ ok: true });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<PaperLibraryCommandCenter projectSlug="demo-project" />);

    expect(await screen.findByRole("heading", { name: "Import a local PDF folder without mutating disk" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Import PDF Folder" })).toBeInTheDocument();
  });

  it("restores manifest history from the latest persisted scan", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (url === "/api/brain/paper-library/scan?project=demo-project&latest=1") {
        return Response.json({
          ok: true,
          scan: baseScan({
            status: "ready_for_apply",
            counters: {
              detectedFiles: 4,
              identified: 4,
              needsReview: 0,
              readyForApply: 3,
              failed: 0,
            },
            applyPlanId: "plan-1",
          }),
        });
      }

      if (url === "/api/brain/paper-library/scan?project=demo-project&id=scan-1") {
        return Response.json({
          ok: true,
          scan: baseScan({
            status: "ready_for_apply",
            counters: {
              detectedFiles: 4,
              identified: 4,
              needsReview: 0,
              readyForApply: 3,
              failed: 0,
            },
            applyPlanId: "plan-1",
          }),
        });
      }

      if (url.startsWith("/api/brain/paper-library/apply-plan?")) {
        return Response.json({
          ok: true,
          plan: {
            version: 1,
            id: "plan-1",
            scanId: "scan-1",
            project: "demo-project",
            status: "applied",
            rootPath: "/tmp/library",
            rootRealpath: "/tmp/library",
            templateFormat: "papers/{year}/{title}.pdf",
            operationCount: 1,
            conflictCount: 0,
            operationShardIds: ["0001"],
            planDigest: "digest",
            manifestId: "manifest-1",
            createdAt: "2026-04-23T12:20:00.000Z",
            updatedAt: "2026-04-23T12:20:00.000Z",
          },
          operations: [
            {
              id: "operation-1",
              paperId: "paper-1",
              kind: "rename",
              source: baseReviewItem().source,
              destinationRelativePath: "papers/2024/Interesting Paper.pdf",
              reason: "Paper library template proposal",
              confidence: 0.82,
              conflictCodes: [],
            },
          ],
          totalCount: 1,
          filteredCount: 1,
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
            status: "undone",
            rootRealpath: "/tmp/library",
            planDigest: "digest",
            operationCount: 1,
            appliedCount: 1,
            failedCount: 0,
            undoneCount: 1,
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
              destinationRelativePath: "papers/2024/Interesting Paper.pdf",
              status: "undone",
              appliedAt: "2026-04-23T12:31:00.000Z",
              undoneAt: "2026-04-23T12:35:00.000Z",
            },
          ],
          totalCount: 1,
          filteredCount: 1,
        });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<PaperLibraryCommandCenter projectSlug="demo-project" />);

    expect(await screen.findByText("Manifest and undo")).toBeInTheDocument();
    await waitFor(() => {
      expect(window.localStorage.getItem("scienceswarm.paperLibrary.session.demo-project")).toContain("\"step\":\"history\"");
      expect(window.localStorage.getItem("scienceswarm.paperLibrary.session.demo-project")).toContain("\"manifestId\":\"manifest-1\"");
      expect(window.localStorage.getItem("scienceswarm.paperLibrary.session.demo-project")).toContain("\"templateFormat\":\"papers/{year}/{title}.pdf\"");
    });
  });

  it("promotes a newer latest scan over a stale terminal browser session", async () => {
    window.localStorage.setItem(
      "scienceswarm.paperLibrary.session.demo-project",
      JSON.stringify({
        step: "scan",
        rootPath: "/tmp/old-library",
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
              detectedFiles: 4,
              identified: 4,
              needsReview: 0,
              readyForApply: 3,
              failed: 0,
            },
          }),
        });
      }

      if (url === "/api/brain/paper-library/scan?project=demo-project&latest=1") {
        return Response.json({
          ok: true,
          scan: baseScan({
            id: "scan-2",
            rootPath: "/tmp/latest-library",
            rootRealpath: "/tmp/latest-library",
            status: "scanning",
            createdAt: "2026-04-23T12:09:00.000Z",
            updatedAt: "2026-04-23T12:10:00.000Z",
          }),
        });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<PaperLibraryCommandCenter projectSlug="demo-project" />);

    await waitFor(() => {
      expect(screen.getByText("/tmp/latest-library")).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(window.localStorage.getItem("scienceswarm.paperLibrary.session.demo-project")).toContain("\"scanId\":\"scan-2\"");
    });
  });

  it("supports accept, plan, apply, and undo through the command center", async () => {
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
          expiresAt: "3026-04-23T13:00:00.000Z",
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

    expect(await screen.findByText("2024 - Smith - Interesting Paper.pdf")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Save metadata/i }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Apply1" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Apply1" }));
    fireEvent.click(await screen.findByRole("button", { name: /preview/i }));
    expect(await screen.findByText("1 operations")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Apply 1 change" }));
    expect(await screen.findByText("Manifest and undo")).toBeInTheDocument();
    expect(await screen.findByText("1 applied")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Undo changes" }));
    expect(await screen.findAllByText("undone")).toHaveLength(3);
  });

  it("accepts unchanged author suggestions that contain commas", async () => {
    window.localStorage.setItem(
      "scienceswarm.paperLibrary.session.demo-project",
      JSON.stringify({
        step: "review",
        rootPath: "/tmp/library",
        templateFormat: "{year} - {title}.pdf",
        scanId: "scan-1",
      }),
    );

    const commaAuthorItem = {
      ...baseReviewItem(),
      candidates: [
        {
          ...baseReviewItem().candidates[0],
          authors: ["Smith, Jr.", "Jones"],
        },
      ],
    };
    let reviewBody: Record<string, unknown> | undefined;

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (url === "/api/brain/paper-library/scan?project=demo-project&id=scan-1") {
        return Response.json({
          ok: true,
          scan: baseScan(),
        });
      }

      if (url.startsWith("/api/brain/paper-library/review?")) {
        return Response.json({
          ok: true,
          items: [commaAuthorItem],
          totalCount: 1,
          filteredCount: 1,
        });
      }

      if (url === "/api/brain/paper-library/review" && method === "POST") {
        reviewBody = JSON.parse(String(init?.body));
        return Response.json({ ok: true, remainingCount: 0 });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<PaperLibraryCommandCenter projectSlug="demo-project" />);

    expect(await screen.findByDisplayValue("Smith, Jr., Jones")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Save metadata/i }));

    await waitFor(() => {
      expect(reviewBody).toMatchObject({ action: "accept" });
    });
    expect(reviewBody?.correction).toBeUndefined();
  });

  it("repairs a manifest that still needs gbrain writeback", async () => {
    window.localStorage.setItem(
      "scienceswarm.paperLibrary.session.demo-project",
      JSON.stringify({
        step: "history",
        rootPath: "/tmp/library",
        templateFormat: "{year} - {title}.pdf",
        scanId: "scan-1",
        applyPlanId: "plan-1",
        manifestId: "manifest-1",
      }),
    );

    let repaired = false;

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (url === "/api/brain/paper-library/scan?project=demo-project&id=scan-1") {
        return Response.json({
          ok: true,
          scan: baseScan({
            status: "ready_for_apply",
            counters: {
              detectedFiles: 4,
              identified: 4,
              needsReview: 0,
              readyForApply: 1,
              failed: 0,
            },
            applyPlanId: "plan-1",
          }),
        });
      }

      if (url.startsWith("/api/brain/paper-library/apply-plan?")) {
        return Response.json({
          ok: true,
          plan: {
            version: 1,
            id: "plan-1",
            scanId: "scan-1",
            project: "demo-project",
            status: repaired ? "applied" : "applied_with_repair_required",
            rootPath: "/tmp/library",
            rootRealpath: "/tmp/library",
            templateFormat: "{year} - {title}.pdf",
            operationCount: 1,
            conflictCount: 0,
            operationShardIds: ["0001"],
            planDigest: "digest",
            manifestId: "manifest-1",
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

      if (url.startsWith("/api/brain/paper-library/manifest?")) {
        return Response.json({
          ok: true,
          manifest: {
            version: 1,
            id: "manifest-1",
            project: "demo-project",
            applyPlanId: "plan-1",
            status: repaired ? "applied" : "applied_with_repair_required",
            rootRealpath: "/tmp/library",
            planDigest: "digest",
            operationCount: 1,
            appliedCount: 1,
            failedCount: 0,
            undoneCount: 0,
            operationShardIds: ["0001"],
            warnings: repaired ? [] : ["gbrain writer offline"],
            createdAt: "2026-04-23T12:31:00.000Z",
            updatedAt: "2026-04-23T12:31:00.000Z",
          },
          operations: [
            {
              operationId: "operation-1",
              paperId: "paper-1",
              sourceRelativePath: "2024 - Smith - Interesting Paper.pdf",
              destinationRelativePath: "2024 - Interesting Paper.pdf",
              status: "verified",
              appliedAt: "2026-04-23T12:31:00.000Z",
            },
          ],
          totalCount: 1,
          filteredCount: 1,
        });
      }

      if (url === "/api/brain/paper-library/repair" && method === "POST") {
        repaired = true;
        return Response.json({
          ok: true,
          repaired: true,
          status: "applied",
          manifest: {
            id: "manifest-1",
            status: "applied",
            warnings: [],
          },
        });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<PaperLibraryCommandCenter projectSlug="demo-project" />);

    expect(await screen.findByText("applied with repair required")).toBeInTheDocument();
    expect(screen.getByText("gbrain writer offline")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry gbrain repair" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Retry gbrain repair" }));

    await waitFor(() => {
      expect(screen.getByText("applied")).toBeInTheDocument();
    });
    expect(screen.queryByText("gbrain writer offline")).not.toBeInTheDocument();
  });

  it("resets the review filter when starting a new scan", async () => {
    window.localStorage.setItem(
      "scienceswarm.paperLibrary.session.demo-project",
      JSON.stringify({
        step: "review",
        rootPath: "/tmp/library",
        templateFormat: "{year} - {title}.pdf",
        scanId: "scan-1",
      }),
    );

    let activeScanId = "scan-1";
    const secondReviewItem = {
      ...baseReviewItem(),
      id: "review-2",
      paperId: "paper-2",
      candidates: [
        {
          ...baseReviewItem().candidates[0],
          id: "candidate-2",
          title: "Fresh Library Scan",
          year: 2025,
        },
      ],
      selectedCandidateId: "candidate-2",
    };

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (url === "/api/local-folder-picker" && method === "POST") {
        return Response.json({ path: "/tmp/library-2" });
      }

      if (url === "/api/brain/paper-library/scan" && method === "POST") {
        activeScanId = "scan-2";
        return Response.json({ ok: true, scanId: "scan-2" });
      }

      if (url.startsWith("/api/brain/paper-library/scan?project=demo-project&id=")) {
        return Response.json({
          ok: true,
          scan: baseScan({ id: activeScanId }),
        });
      }

      if (url.startsWith("/api/brain/paper-library/review?")) {
        const search = new URL(url, "http://localhost");
        const scanId = search.searchParams.get("scanId");
        const filter = search.searchParams.get("filter");
        const items = filter === "needs_review"
          ? (scanId === "scan-2" ? [secondReviewItem] : [baseReviewItem()])
          : [];

        return Response.json({
          ok: true,
          items,
          totalCount: items.length,
          filteredCount: items.length,
        });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<PaperLibraryCommandCenter projectSlug="demo-project" />);

    expect(await screen.findByText("2024 - Smith - Interesting Paper.pdf")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "accepted" }));
    expect(await screen.findByText("Nothing in this review slice")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Scan/ }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Import PDF Folder" })).toBeEnabled();
    });
    fireEvent.click(screen.getByRole("button", { name: "Import PDF Folder" }));

    await waitFor(() => {
      expect(window.localStorage.getItem("scienceswarm.paperLibrary.session.demo-project")).toContain("\"scanId\":\"scan-2\"");
    });
    fireEvent.click(screen.getByRole("button", { name: /Scan/ }));
    expect(await screen.findByText("ready for review")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Open review queue" }));
    expect(await screen.findByDisplayValue("Fresh Library Scan")).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(([request]) => {
        const url = String(request);
        return url.includes("scanId=scan-2") && url.includes("filter=needs_review");
      }),
    ).toBe(true);
  });

  it("disables applying when the approval token is already expired", async () => {
    window.localStorage.setItem(
      "scienceswarm.paperLibrary.session.demo-project",
      JSON.stringify({
        step: "apply",
        rootPath: "/tmp/library",
        templateFormat: "{year} - {title}.pdf",
        scanId: "scan-1",
        applyPlanId: "plan-1",
      }),
    );

    let approved = false;

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (url === "/api/brain/paper-library/scan?project=demo-project&id=scan-1") {
        return Response.json({
          ok: true,
          scan: baseScan({
            status: "ready_for_apply",
            counters: {
              detectedFiles: 4,
              identified: 4,
              needsReview: 0,
              readyForApply: 1,
              failed: 0,
            },
            applyPlanId: "plan-1",
          }),
        });
      }

      if (url.startsWith("/api/brain/paper-library/apply-plan?")) {
        return Response.json({
          ok: true,
          plan: {
            version: 1,
            id: "plan-1",
            scanId: "scan-1",
            project: "demo-project",
            status: approved ? "approved" : "validated",
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
          expiresAt: "2000-04-23T13:00:00.000Z",
        });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<PaperLibraryCommandCenter projectSlug="demo-project" />);

    expect(await screen.findByText("1 operations")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Apply 1 change" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/Approval expired at/i);
    expect(screen.getByRole("alert")).toHaveTextContent(/Applying will refresh approval first/i);
    expect(screen.queryByText(/Refresh approval to continue/i)).not.toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(([request]) => String(request) === "/api/brain/paper-library/apply"),
    ).toBe(false);
  });

  it("regenerates an existing rename preview with the newly selected template", async () => {
    window.localStorage.setItem(
      "scienceswarm.paperLibrary.session.demo-project",
      JSON.stringify({
        step: "apply",
        rootPath: "/tmp/library",
        templateFormat: "{year} - {title}.pdf",
        scanId: "scan-1",
        applyPlanId: "plan-1",
      }),
    );

    let generatedPlanFormat = "{year} - {title}.pdf";

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (url === "/api/brain/paper-library/scan?project=demo-project&id=scan-1") {
        return Response.json({
          ok: true,
          scan: baseScan({
            status: "ready_for_apply",
            counters: {
              detectedFiles: 4,
              identified: 4,
              needsReview: 0,
              readyForApply: 1,
              failed: 0,
            },
            applyPlanId: "plan-1",
          }),
        });
      }

      if (url.startsWith("/api/brain/paper-library/apply-plan?")) {
        const search = new URL(url, "http://localhost");
        const planId = search.searchParams.get("id");
        const templateFormat = planId === "plan-2" ? generatedPlanFormat : "{year} - {title}.pdf";
        return Response.json({
          ok: true,
          plan: {
            version: 1,
            id: planId ?? "plan-1",
            scanId: "scan-1",
            project: "demo-project",
            status: "validated",
            rootPath: "/tmp/library",
            rootRealpath: "/tmp/library",
            templateFormat,
            operationCount: 1,
            conflictCount: 0,
            operationShardIds: ["0001"],
            planDigest: "digest",
            createdAt: "2026-04-23T12:20:00.000Z",
            updatedAt: "2026-04-23T12:20:00.000Z",
          },
          operations: [
            {
              id: "operation-1",
              paperId: "paper-1",
              kind: "rename",
              source: baseReviewItem().source,
              destinationRelativePath: templateFormat.startsWith("{first_author}")
                ? "Smith 2024 - Interesting Paper.pdf"
                : "2024 - Interesting Paper.pdf",
              reason: "Paper library template proposal",
              confidence: 0.82,
              conflictCodes: [],
            },
          ],
          totalCount: 1,
          filteredCount: 1,
        });
      }

      if (url === "/api/brain/paper-library/apply-plan" && method === "POST") {
        const body = JSON.parse(String(init?.body)) as { templateFormat: string };
        generatedPlanFormat = body.templateFormat;
        return Response.json({ ok: true, applyPlanId: "plan-2" });
      }

      if (url === "/api/brain/paper-library/apply-plan/approve" && method === "POST") {
        return Response.json({
          ok: true,
          approvalToken: "approval-token",
          expiresAt: "3026-04-23T13:00:00.000Z",
        });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<PaperLibraryCommandCenter projectSlug="demo-project" />);

    expect(await screen.findByText(/2024 - Interesting Paper\.pdf/)).toBeInTheDocument();
    const initialPlanLoads = fetchMock.mock.calls.filter(([request]) => String(request).startsWith("/api/brain/paper-library/apply-plan?")).length;

    fireEvent.click(screen.getByRole("button", { name: /Author Year - Title/ }));

    await waitFor(() => {
      expect(fetchMock.mock.calls.filter(([request]) => String(request).startsWith("/api/brain/paper-library/apply-plan?")).length).toBeGreaterThan(initialPlanLoads);
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      "This preview uses {year} - {title}.pdf. Regenerate rename preview to inspect {first_author} {year} - {title}.pdf.",
    );
    expect(screen.getByRole("button", { name: "Apply 1 change" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Regenerate rename preview" }));

    await waitFor(() => {
      const request = fetchMock.mock.calls.find(([input, init]) => (
        String(input) === "/api/brain/paper-library/apply-plan" && init?.method === "POST"
      ));
      expect(JSON.parse(String(request?.[1]?.body))).toMatchObject({
        templateFormat: "{first_author} {year} - {title}.pdf",
      });
    });

    expect(await screen.findByText(/Smith 2024 - Interesting Paper\.pdf/)).toBeInTheDocument();
  });

  it("refreshes approval for a restored approved plan when the browser token is missing", async () => {
    window.localStorage.setItem(
      "scienceswarm.paperLibrary.session.demo-project",
      JSON.stringify({
        step: "apply",
        rootPath: "/tmp/library",
        templateFormat: "{year} - {title}.pdf",
        scanId: "scan-1",
        applyPlanId: "plan-1",
      }),
    );

    let refreshed = false;
    let applied = false;

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (url === "/api/brain/paper-library/scan?project=demo-project&id=scan-1") {
        return Response.json({
          ok: true,
          scan: baseScan({
            status: applied ? "applied" : "ready_for_apply",
            counters: {
              detectedFiles: 4,
              identified: 4,
              needsReview: 0,
              readyForApply: 1,
              failed: 0,
            },
            applyPlanId: "plan-1",
          }),
        });
      }

      if (url.startsWith("/api/brain/paper-library/apply-plan?")) {
        return Response.json({
          ok: true,
          plan: {
            version: 1,
            id: "plan-1",
            scanId: "scan-1",
            project: "demo-project",
            status: applied ? "applied" : "approved",
            rootPath: "/tmp/library",
            rootRealpath: "/tmp/library",
            templateFormat: "{year} - {title}.pdf",
            operationCount: 1,
            conflictCount: 0,
            operationShardIds: ["0001"],
            planDigest: "digest",
            approvalTokenHash: "token-hash",
            approvalExpiresAt: refreshed ? "3026-04-23T13:00:00.000Z" : "3026-04-23T12:30:00.000Z",
            approvedAt: "2026-04-23T12:20:00.000Z",
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
        refreshed = true;
        return Response.json({
          ok: true,
          approvalToken: "approval-token-refreshed",
          expiresAt: "3026-04-23T13:00:00.000Z",
        });
      }

      if (url === "/api/brain/paper-library/apply" && method === "POST") {
        applied = true;
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
            status: "applied",
            rootRealpath: "/tmp/library",
            planDigest: "digest",
            operationCount: 1,
            appliedCount: 1,
            failedCount: 0,
            undoneCount: 0,
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
              status: "verified",
              appliedAt: "2026-04-23T12:31:00.000Z",
            },
          ],
          totalCount: 1,
          filteredCount: 1,
        });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<PaperLibraryCommandCenter projectSlug="demo-project" />);

    expect(await screen.findByText("1 operations")).toBeInTheDocument();
    expect(screen.getByText(/Applying will refresh the browser token first/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Apply 1 change" }));
    expect(await screen.findByText("Manifest and undo")).toBeInTheDocument();
    expect(await screen.findByText("1 applied")).toBeInTheDocument();
  });

  it("shows command errors outside the scan step", async () => {
    window.localStorage.setItem(
      "scienceswarm.paperLibrary.session.demo-project",
      JSON.stringify({
        step: "apply",
        rootPath: "/tmp/library",
        templateFormat: "{year} - {title}.pdf",
        scanId: "scan-1",
        applyPlanId: "plan-1",
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
              detectedFiles: 4,
              identified: 4,
              needsReview: 0,
              readyForApply: 1,
              failed: 0,
            },
            applyPlanId: "plan-1",
          }),
        });
      }

      if (url.startsWith("/api/brain/paper-library/apply-plan?")) {
        return Response.json({
          ok: true,
          plan: {
            version: 1,
            id: "plan-1",
            scanId: "scan-1",
            project: "demo-project",
            status: "validated",
            rootPath: "/tmp/library",
            rootRealpath: "/tmp/library",
            templateFormat: "{year} - {title}.pdf",
            operationCount: 1,
            conflictCount: 0,
            operationShardIds: ["0001"],
            planDigest: "digest",
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
        return Response.json(
          { error: { message: "Approval failed." } },
          { status: 500 },
        );
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<PaperLibraryCommandCenter projectSlug="demo-project" />);

    expect(await screen.findByText("1 operations")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Apply 1 change" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Approval failed.");
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
        const wantsAll = search.searchParams.get("all") === "1";
        if (wantsAll) {
          return Response.json({
            ok: true,
            nodes: [
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
            ],
            edges: [
              {
                id: "edge-1",
                sourceNodeId: "node-1",
                targetNodeId: "node-2",
                kind: "references",
                source: "semantic_scholar",
                evidence: [],
              },
            ],
            loadedNodeCount: 2,
            totalEdgeCount: 1,
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
          });
        }
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
              ],
          edges: [
            {
              id: "edge-1",
              sourceNodeId: "node-1",
              targetNodeId: "node-2",
              kind: "references",
              source: "semantic_scholar",
              evidence: [],
            },
          ],
          loadedNodeCount: 1,
          totalEdgeCount: 1,
          sourceRuns: cursor ? [] : [
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
          warnings: cursor ? [] : ["Semantic Scholar paused for this scan."],
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

      if (url.startsWith("/api/brain/paper-library/gaps?")) {
        const search = new URL(url, "http://localhost");
        const cursor = search.searchParams.get("cursor");
        return Response.json({
          ok: true,
          suggestions: cursor
            ? [
                {
                  id: "gap-2",
                  scanId: "scan-1",
                  nodeId: "node-gap-2",
                  title: "Cluster Bridge Candidate",
                  authors: ["Lee"],
                  year: 2022,
                  venue: "Bridge Journal",
                  identifiers: { doi: "10.2000/bridge" },
                  sources: ["semantic_scholar"],
                  state: "watching",
                  reasonCodes: ["bridge_position"],
                  score: {
                    overall: 0.61,
                    citationFrequency: 0.25,
                    bridgePosition: 0.5,
                    clusterGap: 0.2,
                    recentConnected: 0.1,
                    disagreementPenalty: 0,
                  },
                  localConnectionCount: 2,
                  evidencePaperIds: ["paper-1"],
                  evidenceClusterIds: ["cluster-2"],
                  evidenceNodeIds: ["node-2"],
                  createdAt: "2026-04-23T12:00:00.000Z",
                  updatedAt: "2026-04-23T12:00:00.000Z",
                },
              ]
            : [
                {
                  id: "gap-1",
                  scanId: "scan-1",
                  nodeId: "node-gap-1",
                  title: "Missing Seminal Paper",
                  authors: ["Smith"],
                  year: 2025,
                  venue: "Nature",
                  identifiers: { doi: "10.1000/missing" },
                  sources: ["semantic_scholar"],
                  state: "open",
                  reasonCodes: ["citation_frequency", "cluster_gap"],
                  score: {
                    overall: 0.88,
                    citationFrequency: 0.75,
                    bridgePosition: 0.25,
                    clusterGap: 0.5,
                    recentConnected: 1,
                    disagreementPenalty: 0,
                  },
                  localConnectionCount: 3,
                  evidencePaperIds: ["paper-1"],
                  evidenceClusterIds: ["cluster-1"],
                  evidenceNodeIds: ["node-1"],
                  createdAt: "2026-04-23T12:00:00.000Z",
                  updatedAt: "2026-04-23T12:00:00.000Z",
                },
              ],
          stateCounts: {
            open: 1,
            watching: 1,
            ignored: 0,
            saved: 0,
            imported: 0,
          },
          warnings: ["Gap suggestions are still suggestions until you save or import them."],
          totalCount: 2,
          filteredCount: 2,
          nextCursor: cursor ? undefined : "MQ",
        });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<PaperLibraryCommandCenter projectSlug="demo-project" />);

    expect(await screen.findByText("Citation graph overview")).toBeInTheDocument();
    expect((await screen.findAllByText("Interesting Paper")).length).toBeGreaterThan(0);
    expect(await screen.findByText("Semantic Scholar paused for this scan.")).toBeInTheDocument();
    expect(await screen.findByText("2 of 2 papers loaded")).toBeInTheDocument();
    expect(await screen.findByText("model unavailable")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Load more nodes" }));
    fireEvent.click(screen.getByRole("button", { name: "Load more clusters" }));

    expect((await screen.findAllByText("Bridge Paper")).length).toBeGreaterThan(0);
    expect(screen.getByText("2 visible nodes")).toBeInTheDocument();
    expect(screen.getByText("Semantic Scholar paused for this scan.")).toBeInTheDocument();
    expect(await screen.findByText("Protein folding")).toBeInTheDocument();
    expect(screen.getByText("Gap suggestions")).toBeInTheDocument();
    expect(screen.getByText("Missing Seminal Paper (2025)")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Load more suggestions" }));
    expect(await screen.findByText("Cluster Bridge Candidate (2022)")).toBeInTheDocument();
  });
});
