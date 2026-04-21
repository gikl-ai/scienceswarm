// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ImportDialog } from "@/components/research/import-dialog";

describe("ImportDialog", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("starts a background import job for the user-selected preview bucket", async () => {
    vi.spyOn(window, "setInterval").mockImplementation((((callback: TimerHandler) => {
      if (typeof callback === "function") {
        void callback();
      }
      return 1;
    }) as typeof window.setInterval));
    vi.spyOn(window, "clearInterval").mockImplementation(() => {});
    const fetchMock = vi.fn(async (...args: [RequestInfo | URL, RequestInit?]) => {
      const [input] = args;
      const url = String(input);
      const method = args[1]?.method ?? "GET";

      if (url === "/api/import-project") {
        return Response.json({
          name: "Project Alpha Archive",
          basePath: "/tmp/project-alpha-archive",
          totalFiles: 2,
          files: [
            {
              path: "analysis/notebooks/explore_drought_gradients.ipynb",
              name: "explore_drought_gradients.ipynb",
              type: "ipynb",
              size: 128,
              content: "Notebook preview",
            },
            {
              path: "papers/draft/manuscript.md",
              name: "manuscript.md",
              type: "md",
              size: 96,
              content: "Draft preview",
            },
          ],
          preview: {
            analysis: "Local scan preview (local-scan)",
            backend: "local-scan",
            files: [
              {
                path: "analysis/notebooks/explore_drought_gradients.ipynb",
                type: "ipynb",
                size: 128,
                classification: "notebook",
                projectCandidates: ["project-alpha", "active-research"],
                warnings: [],
              },
              {
                path: "papers/draft/manuscript.md",
                type: "md",
                size: 96,
                classification: "draft",
                projectCandidates: ["writing-and-publication"],
                warnings: [],
              },
            ],
            projects: [
              {
                slug: "project-alpha",
                title: "Project Alpha Research Archive",
                confidence: "medium",
                reason: "Umbrella archive bucket",
                sourcePaths: ["analysis/notebooks/explore_drought_gradients.ipynb"],
              },
              {
                slug: "active-research",
                title: "Active Research",
                confidence: "medium",
                reason: "Analysis notebooks and experiment outputs",
                sourcePaths: ["analysis/notebooks/explore_drought_gradients.ipynb"],
              },
              {
                slug: "writing-and-publication",
                title: "Writing and Publication",
                confidence: "low",
                reason: "Drafts and paper assets",
                sourcePaths: ["papers/draft/manuscript.md"],
              },
            ],
            duplicateGroups: [],
            warnings: [],
          },
          duplicateGroups: [],
          warnings: [],
        });
      }

      if (url === "/api/brain/import-project-job" && method === "POST") {
        return Response.json({
          ok: true,
          job: {
            id: "job-active-research",
            project: "active-research",
            folderName: "project-alpha-archive",
            folderPath: "/tmp/project-alpha-archive",
            status: "queued",
            progress: {
              phase: "queued",
              detectedFiles: 0,
              detectedItems: 0,
              detectedBytes: 0,
              importedFiles: 0,
              skippedDuplicates: 0,
              duplicateGroups: 0,
              currentPath: null,
            },
            result: null,
            error: null,
          },
        });
      }

      if (url === "/api/brain/import-project-job?id=job-active-research") {
        return Response.json({
          id: "job-active-research",
          project: "active-research",
          folderName: "project-alpha-archive",
          folderPath: "/tmp/project-alpha-archive",
          status: "completed",
          progress: {
            phase: "finalizing",
            detectedFiles: 2,
            detectedItems: 2,
            detectedBytes: 224,
            importedFiles: 2,
            skippedDuplicates: 0,
            duplicateGroups: 0,
            currentPath: null,
          },
          result: {
            project: "active-research",
            title: "Active Research",
            importedFiles: 2,
            detectedItems: 2,
            detectedBytes: 224,
            duplicateGroups: 0,
            projectPagePath: "wiki/projects/active-research.md",
            sourcePageCount: 2,
            generatedAt: "2026-04-11T12:00:00.000Z",
          },
          error: null,
        });
      }

      throw new Error(`Unexpected fetch url: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    const onImport = vi.fn();
    const onClose = vi.fn();

    render(<ImportDialog open onClose={onClose} onImport={onImport} />);

    fireEvent.change(screen.getByPlaceholderText("/Users/your-username/code/your-project"), {
      target: { value: "/tmp/project-alpha-archive" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Import" }));

    expect(await screen.findByText("Project Alpha Research Archive")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Import full archive in background to project-alpha/i }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Active Research/i }));

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Import full archive in background to active-research/i }),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /Import full archive in background to active-research/i }));

    await waitFor(() => {
      expect(onImport).toHaveBeenCalledWith({
        projectSlug: "active-research",
        name: "Active Research",
        totalFiles: 2,
        detectedItems: 2,
        detectedBytes: 224,
        duplicateGroups: 0,
        source: "background-local-import",
      });
    });

    const commitCall = fetchMock.mock.calls[1];
    expect(commitCall?.[0]).toBe("/api/brain/import-project-job");
    expect(JSON.parse(String(commitCall?.[1]?.body))).toMatchObject({
      action: "start",
      path: "/tmp/project-alpha-archive",
      projectSlug: "active-research",
    });
  });

  it("passes completed import warnings back to the caller", async () => {
    vi.spyOn(window, "setInterval").mockImplementation((((callback: TimerHandler) => {
      if (typeof callback === "function") {
        void callback();
      }
      return 1;
    }) as typeof window.setInterval));
    vi.spyOn(window, "clearInterval").mockImplementation(() => {});
    const fetchMock = vi.fn(async (...args: [RequestInfo | URL, RequestInit?]) => {
      const [input] = args;
      const url = String(input);
      const method = args[1]?.method ?? "GET";

      if (url === "/api/import-project") {
        return Response.json({
          name: "Warning Archive",
          basePath: "/tmp/warning-archive",
          totalFiles: 1,
          files: [],
          preview: {
            analysis: "Local scan preview (local-scan)",
            backend: "local-scan",
            files: [],
            projects: [
              {
                slug: "warning-archive",
                title: "Warning Archive",
                confidence: "medium",
                reason: "Imported notes folder",
                sourcePaths: ["notes/summary.md"],
              },
            ],
            duplicateGroups: [],
            warnings: [],
          },
          duplicateGroups: [],
          warnings: [],
        });
      }

      if (url === "/api/brain/import-project-job" && method === "POST") {
        return Response.json({
          ok: true,
          job: {
            id: "job-warning-archive",
            project: "warning-archive",
            folderName: "Warning Archive",
            folderPath: "/tmp/warning-archive",
            status: "queued",
            progress: {
              phase: "queued",
              detectedFiles: 0,
              detectedItems: 0,
              detectedBytes: 0,
              importedFiles: 0,
              skippedDuplicates: 0,
              duplicateGroups: 0,
              currentPath: null,
            },
            result: null,
            error: null,
          },
        });
      }

      if (url === "/api/brain/import-project-job?id=job-warning-archive") {
        return Response.json({
          id: "job-warning-archive",
          project: "warning-archive",
          folderName: "Warning Archive",
          folderPath: "/tmp/warning-archive",
          status: "completed",
          progress: {
            phase: "finalizing",
            detectedFiles: 1,
            detectedItems: 1,
            detectedBytes: 42,
            importedFiles: 1,
            skippedDuplicates: 0,
            duplicateGroups: 0,
            currentPath: null,
          },
          result: {
            project: "warning-archive",
            title: "Warning Archive",
            importedFiles: 1,
            detectedItems: 1,
            detectedBytes: 42,
            duplicateGroups: 0,
            projectPagePath: "wiki/projects/warning-archive.md",
            sourcePageCount: 1,
            generatedAt: "2026-04-11T12:00:00.000Z",
            warnings: [
              {
                code: "indexing-failed",
                message: "Imported files were written to disk but brain indexing failed: Indexing failed hard",
              },
            ],
          },
          error: null,
        });
      }

      throw new Error(`Unexpected fetch url: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    const onImport = vi.fn();

    render(<ImportDialog open onClose={vi.fn()} onImport={onImport} />);

    fireEvent.change(screen.getByPlaceholderText("/Users/your-username/code/your-project"), {
      target: { value: "/tmp/warning-archive" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    expect(
      await screen.findByRole("button", { name: /Import full archive in background to warning-archive/i }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Import full archive in background to warning-archive/i }));

    await waitFor(() => {
      expect(onImport).toHaveBeenCalledWith({
        projectSlug: "warning-archive",
        name: "Warning Archive",
        totalFiles: 1,
        detectedItems: 1,
        detectedBytes: 42,
        duplicateGroups: 0,
        source: "background-local-import",
        warnings: [
          {
            code: "indexing-failed",
            message: "Imported files were written to disk but brain indexing failed: Indexing failed hard",
          },
        ],
      });
    });
  });

  it("delivers a completed background import only once across rerenders", async () => {
    vi.spyOn(window, "setInterval").mockImplementation(((() => 1) as unknown as typeof window.setInterval));
    vi.spyOn(window, "clearInterval").mockImplementation(() => {});

    let resolveStatus!: (value: Response) => void;
    const statusPromise = new Promise<Response>((resolve) => {
      resolveStatus = resolve;
    });

    const fetchMock = vi.fn(async (...args: [RequestInfo | URL, RequestInit?]) => {
      const [input] = args;
      const url = String(input);
      const method = args[1]?.method ?? "GET";

      if (url === "/api/import-project") {
        return Response.json({
          name: "Project Alpha Archive",
          basePath: "/tmp/project-alpha-archive",
          totalFiles: 1,
          files: [],
          preview: {
            analysis: "Local scan preview (local-scan)",
            backend: "local-scan",
            files: [],
            projects: [
              {
                slug: "active-research",
                title: "Active Research",
                confidence: "medium",
                reason: "Analysis notebooks and experiment outputs",
                sourcePaths: ["analysis/explore.ipynb"],
              },
            ],
            duplicateGroups: [],
            warnings: [],
          },
          duplicateGroups: [],
          warnings: [],
        });
      }

      if (url === "/api/brain/import-project-job" && method === "POST") {
        return Response.json({
          ok: true,
          job: {
            id: "job-active-research",
            project: "active-research",
            folderName: "project-alpha-archive",
            folderPath: "/tmp/project-alpha-archive",
            status: "queued",
            progress: {
              phase: "queued",
              detectedFiles: 0,
              detectedItems: 0,
              detectedBytes: 0,
              importedFiles: 0,
              skippedDuplicates: 0,
              duplicateGroups: 0,
              currentPath: null,
            },
            result: null,
            error: null,
          },
        });
      }

      if (url === "/api/brain/import-project-job?id=job-active-research") {
        return statusPromise;
      }

      throw new Error(`Unexpected fetch url: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    const firstOnImport = vi.fn();
    const secondOnImport = vi.fn();
    const onClose = vi.fn();

    const { rerender } = render(<ImportDialog open onClose={onClose} onImport={firstOnImport} />);

    fireEvent.change(screen.getByPlaceholderText("/Users/your-username/code/your-project"), {
      target: { value: "/tmp/project-alpha-archive" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    expect(await screen.findByText("Active Research")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Import full archive in background to active-research/i }));

    rerender(<ImportDialog open onClose={onClose} onImport={secondOnImport} />);

    await act(async () => {
      resolveStatus(Response.json({
        id: "job-active-research",
        project: "active-research",
        folderName: "project-alpha-archive",
        folderPath: "/tmp/project-alpha-archive",
        status: "completed",
        progress: {
          phase: "finalizing",
          detectedFiles: 1,
          detectedItems: 1,
          detectedBytes: 24,
          importedFiles: 1,
          skippedDuplicates: 0,
          duplicateGroups: 0,
          currentPath: null,
        },
        result: {
          project: "active-research",
          title: "Active Research",
          importedFiles: 1,
          detectedItems: 1,
          detectedBytes: 24,
          duplicateGroups: 0,
          projectPagePath: "wiki/projects/active-research.md",
          sourcePageCount: 1,
          generatedAt: "2026-04-12T12:00:00.000Z",
        },
        error: null,
      }));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(secondOnImport).toHaveBeenCalledTimes(1);
    });

    expect(firstOnImport).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not call onClose twice when the user closes the dialog before the background import completes", async () => {
    let pollTick: (() => void) | null = null;
    vi.spyOn(window, "setInterval").mockImplementation((((callback: TimerHandler) => {
      if (typeof callback === "function") {
        pollTick = callback as () => void;
      }
      return 1;
    }) as typeof window.setInterval));
    vi.spyOn(window, "clearInterval").mockImplementation(() => {});

    let resolveStatus!: (value: Response) => void;
    const statusPromise = new Promise<Response>((resolve) => {
      resolveStatus = resolve;
    });

    const fetchMock = vi.fn(async (...args: [RequestInfo | URL, RequestInit?]) => {
      const [input] = args;
      const url = String(input);
      const method = args[1]?.method ?? "GET";

      if (url === "/api/import-project") {
        return Response.json({
          name: "Project Alpha Archive",
          basePath: "/tmp/project-alpha-archive",
          totalFiles: 1,
          files: [],
          preview: {
            analysis: "Local scan preview (local-scan)",
            backend: "local-scan",
            files: [],
            projects: [
              {
                slug: "active-research",
                title: "Active Research",
                confidence: "medium",
                reason: "Analysis notebooks and experiment outputs",
                sourcePaths: ["analysis/explore.ipynb"],
              },
            ],
            duplicateGroups: [],
            warnings: [],
          },
          duplicateGroups: [],
          warnings: [],
        });
      }

      if (url === "/api/brain/import-project-job" && method === "POST") {
        return Response.json({
          ok: true,
          job: {
            id: "job-active-research",
            project: "active-research",
            folderName: "project-alpha-archive",
            folderPath: "/tmp/project-alpha-archive",
            status: "queued",
            progress: {
              phase: "queued",
              detectedFiles: 0,
              detectedItems: 0,
              detectedBytes: 0,
              importedFiles: 0,
              skippedDuplicates: 0,
              duplicateGroups: 0,
              currentPath: null,
            },
            result: null,
            error: null,
          },
        });
      }

      if (url === "/api/brain/import-project-job?id=job-active-research") {
        return statusPromise;
      }

      throw new Error(`Unexpected fetch url: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    const onImport = vi.fn();
    const onClose = vi.fn();
    const { rerender } = render(<ImportDialog open onClose={onClose} onImport={onImport} />);

    fireEvent.change(screen.getByPlaceholderText("/Users/your-username/code/your-project"), {
      target: { value: "/tmp/project-alpha-archive" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    expect(await screen.findByText("Active Research")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Import full archive in background to active-research/i }));
    await waitFor(() => {
      expect(pollTick).not.toBeNull();
    });
    await act(async () => {
      pollTick?.();
    });
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([input]) => String(input) === "/api/brain/import-project-job?id=job-active-research"),
      ).toBe(true);
    });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    rerender(<ImportDialog open={false} onClose={onClose} onImport={onImport} />);

    await act(async () => {
      resolveStatus(Response.json({
        id: "job-active-research",
        project: "active-research",
        folderName: "project-alpha-archive",
        folderPath: "/tmp/project-alpha-archive",
        status: "completed",
        progress: {
          phase: "finalizing",
          detectedFiles: 1,
          detectedItems: 1,
          detectedBytes: 24,
          importedFiles: 1,
          skippedDuplicates: 0,
          duplicateGroups: 0,
          currentPath: null,
        },
        result: {
          project: "active-research",
          title: "Active Research",
          importedFiles: 1,
          detectedItems: 1,
          detectedBytes: 24,
          duplicateGroups: 0,
          projectPagePath: "wiki/projects/active-research.md",
          sourcePageCount: 1,
          generatedAt: "2026-04-12T12:00:00.000Z",
        },
        error: null,
      }));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(onImport).toHaveBeenCalledTimes(1);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("resumes a background import after reopening and shows truthful progress wording", async () => {
    window.localStorage.setItem("scienceswarm.importDialog.activeJob", JSON.stringify({
      id: "job-large-archive",
      project: "large-archive",
      projectTitle: "Large Archive",
      folderName: "large-archive",
      folderPath: "/tmp/large-archive",
      preparedFiles: 500,
      detectedItems: 1024,
      detectedBytes: 1789300000,
      handledCompletion: false,
      savedAt: "2026-04-12T12:00:00.000Z",
    }));

    vi.spyOn(window, "setInterval").mockImplementation(((() => 1) as unknown as typeof window.setInterval));
    vi.spyOn(window, "clearInterval").mockImplementation(() => {});

    const fetchMock = vi.fn(async (...args: [RequestInfo | URL, RequestInit?]) => {
      const [input] = args;
      const url = String(input);

      if (url === "/api/brain/import-project-job?id=job-large-archive") {
        return Response.json({
          id: "job-large-archive",
          project: "large-archive",
          folderName: "large-archive",
          folderPath: "/tmp/large-archive",
          status: "running",
          progress: {
            phase: "importing",
            detectedFiles: 400,
            detectedItems: 512,
            detectedBytes: 894650000,
            importedFiles: 120,
            skippedDuplicates: 30,
            duplicateGroups: 12,
            currentPath: "notes/chapter-3.md",
          },
          result: null,
          error: null,
        });
      }

      throw new Error(`Unexpected fetch url: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<ImportDialog open onClose={vi.fn()} onImport={vi.fn()} />);

    expect(await screen.findByText("Resumed background import tracking for large-archive.")).toBeInTheDocument();
    expect(screen.getByText("50% of the initial local scan")).toBeInTheDocument();
    expect(screen.getByText("512 of 1,024 items scanned.")).toBeInTheDocument();
    expect(screen.getByText("853.2 MB of 1.67 GB read from the initial local scan.")).toBeInTheDocument();
    expect(screen.getByText("Imported 120 unique files so far. Skipped 30 duplicate files across 12 duplicate groups.")).toBeInTheDocument();
    expect(screen.getByText("Large Archive")).toBeInTheDocument();
    expect(screen.getByText("Current: notes/chapter-3.md")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("/Users/your-username/code/your-project")).toHaveValue("/tmp/large-archive");
  });

  it("clears a resumed import and shows a retryable error when the worker disappears", async () => {
    window.localStorage.setItem("scienceswarm.importDialog.activeJob", JSON.stringify({
      id: "job-stale-archive",
      project: "project-alpha",
      projectTitle: "Project Alpha",
      folderName: "stale-archive",
      folderPath: "/tmp/stale-archive",
      preparedFiles: 12,
      detectedItems: 24,
      detectedBytes: 2048,
      handledCompletion: false,
      savedAt: "2026-04-12T12:00:00.000Z",
    }));

    vi.spyOn(window, "setInterval").mockImplementation(((() => 1) as unknown as typeof window.setInterval));
    vi.spyOn(window, "clearInterval").mockImplementation(() => {});

    const fetchMock = vi.fn(async (...args: [RequestInfo | URL, RequestInit?]) => {
      const [input] = args;
      const url = String(input);

      if (url === "/api/brain/import-project-job?id=job-stale-archive") {
        return Response.json({
          id: "job-stale-archive",
          project: "project-alpha",
          folderName: "stale-archive",
          folderPath: "/tmp/stale-archive",
          status: "failed",
          progress: {
            phase: "importing",
            detectedFiles: 8,
            detectedItems: 12,
            detectedBytes: 1024,
            importedFiles: 4,
            skippedDuplicates: 2,
            duplicateGroups: 1,
            currentPath: null,
          },
          result: null,
          error: "Background import worker stopped before completion after 12 items scanned, 4 unique files imported, 2 duplicate files skipped. Re-scan the local folder to restart it.",
        });
      }

      throw new Error(`Unexpected fetch url: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<ImportDialog open onClose={vi.fn()} onImport={vi.fn()} />);

    expect(await screen.findByText("Background import worker stopped before completion after 12 items scanned, 4 unique files imported, 2 duplicate files skipped. Re-scan the local folder to restart it.")).toBeInTheDocument();
    expect(screen.getByText("Last progress: 12 of 24 items scanned.")).toBeInTheDocument();
    expect(screen.getByText("1.0 KB of 2.0 KB read before the worker stopped.")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("/Users/your-username/code/your-project")).toHaveValue("/tmp/stale-archive");
    await waitFor(() => {
      expect(window.localStorage.getItem("scienceswarm.importDialog.activeJob")).toBeNull();
    });
  });

  it("hides demo shortcuts and remembers only the latest successful import path", async () => {
    const fetchMock = vi.fn(async (...args: [RequestInfo | URL, RequestInit?]) => {
      const [input] = args;
      const url = String(input);

      if (url === "/api/import-project") {
        return Response.json({
          name: "Project Alpha Archive",
          basePath: "/tmp/project-alpha-archive",
          totalFiles: 1,
          files: [
            {
              path: "notes/summary.md",
              name: "summary.md",
              type: "md",
              size: 24,
              content: "Summary preview",
            },
          ],
          preview: {
            analysis: "Local scan preview (local-scan)",
            backend: "local-scan",
            files: [
              {
                path: "notes/summary.md",
                type: "md",
                size: 24,
                classification: "note",
                projectCandidates: ["demo-project"],
                warnings: [],
              },
            ],
            projects: [
              {
                slug: "demo-project",
                title: "Demo Project",
                confidence: "medium",
                reason: "Imported notes folder",
                sourcePaths: ["notes/summary.md"],
              },
            ],
            duplicateGroups: [],
            warnings: [],
          },
          duplicateGroups: [],
          warnings: [],
        });
      }

      throw new Error(`Unexpected fetch url: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    const onImport = vi.fn();
    const onClose = vi.fn();

    window.localStorage.setItem("scienceswarm.importDialog.recentPaths", JSON.stringify([
      "~/.scienceswarm/demo-data/project-alpha-archive",
      "/tmp/older-archive",
      "/tmp/oldest-archive",
    ]));

    const { rerender } = render(<ImportDialog open onClose={onClose} onImport={onImport} />);

    expect(screen.queryByRole("button", { name: "Demo archive" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Recent: /tmp/older-archive" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Recent: /tmp/oldest-archive" })).not.toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("/Users/your-username/code/your-project"), {
      target: { value: "/tmp/project-alpha-archive" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Import" }));

    expect(await screen.findByText("Demo Project")).toBeInTheDocument();
    expect(JSON.parse(window.localStorage.getItem("scienceswarm.importDialog.recentPaths") ?? "[]")).toEqual([
      "/tmp/project-alpha-archive",
    ]);

    rerender(<ImportDialog open={false} onClose={onClose} onImport={onImport} />);
    rerender(<ImportDialog open onClose={onClose} onImport={onImport} />);

    expect(
      await screen.findByRole("button", { name: "Recent: /tmp/project-alpha-archive" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Recent: /tmp/older-archive" })).not.toBeInTheDocument();
  });

  it("keeps a successful scan usable when localStorage writes fail", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage disabled");
    });

    const fetchMock = vi.fn(async (...args: [RequestInfo | URL, RequestInit?]) => {
      const [input] = args;
      const url = String(input);

      if (url === "/api/import-project") {
        return Response.json({
          name: "Project Alpha Archive",
          basePath: "/tmp/project-alpha-archive",
          totalFiles: 1,
          files: [
            {
              path: "notes/summary.md",
              name: "summary.md",
              type: "md",
              size: 24,
              content: "Summary preview",
            },
          ],
          preview: {
            analysis: "Local scan preview (local-scan)",
            backend: "local-scan",
            files: [
              {
                path: "notes/summary.md",
                type: "md",
                size: 24,
                classification: "note",
                projectCandidates: ["demo-project"],
                warnings: [],
              },
            ],
            projects: [
              {
                slug: "demo-project",
                title: "Demo Project",
                confidence: "medium",
                reason: "Imported notes folder",
                sourcePaths: ["notes/summary.md"],
              },
            ],
            duplicateGroups: [],
            warnings: [],
          },
          duplicateGroups: [],
          warnings: [],
        });
      }

      throw new Error(`Unexpected fetch url: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<ImportDialog open onClose={vi.fn()} onImport={vi.fn()} />);

    fireEvent.change(screen.getByPlaceholderText("/Users/your-username/code/your-project"), {
      target: { value: "/tmp/project-alpha-archive" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Import" }));

    expect(await screen.findByText("Demo Project")).toBeInTheDocument();
    expect(screen.queryByText("storage disabled")).not.toBeInTheDocument();
  });

  it("prefills the path when the dashboard opens the dialog with a suggested archive", () => {
    render(
      <ImportDialog
        open
        onClose={vi.fn()}
        onImport={vi.fn()}
        initialPath="~/.scienceswarm/demo-data/project-alpha-archive"
      />,
    );

    expect(screen.getByPlaceholderText("/Users/your-username/code/your-project")).toHaveValue(
      "~/.scienceswarm/demo-data/project-alpha-archive",
    );
  });

  it("chooses a folder through the local picker without browser upload prompts", async () => {
    vi.spyOn(window, "setInterval").mockImplementation((((callback: TimerHandler) => {
      if (typeof callback === "function") {
        void callback();
      }
      return 1;
    }) as typeof window.setInterval));
    vi.spyOn(window, "clearInterval").mockImplementation(() => {});
    const fetchMock = vi.fn(async (...args: [RequestInfo | URL, RequestInit?]) => {
      const [input] = args;
      const url = String(input);
      const method = args[1]?.method ?? "GET";

      if (url === "/api/local-folder-picker") {
        return Response.json({
          path: "/tmp/picked-archive",
        });
      }

      if (url === "/api/import-project") {
        return Response.json({
          name: "picked-archive",
          basePath: "/tmp/picked-archive",
          totalFiles: 2,
          files: [
            {
              path: "analysis/explore.ipynb",
              name: "explore.ipynb",
              type: "ipynb",
              size: 128,
              content: "Notebook preview",
            },
            {
              path: "notes/summary.md",
              name: "summary.md",
              type: "md",
              size: 48,
              content: "Summary preview",
            },
          ],
          preview: {
            analysis: "Local scan preview (local-scan)",
            backend: "local-scan",
            files: [
              {
                path: "analysis/explore.ipynb",
                type: "ipynb",
                size: 128,
                classification: "notebook",
                projectCandidates: ["picked-project"],
                warnings: [],
              },
              {
                path: "notes/summary.md",
                type: "md",
                size: 48,
                classification: "note",
                projectCandidates: ["picked-project"],
                warnings: [],
              },
            ],
            projects: [
              {
                slug: "picked-project",
                title: "Picked Project",
                confidence: "medium",
                reason: "Notebook and notes align to a single project.",
                sourcePaths: ["analysis/explore.ipynb", "notes/summary.md"],
              },
            ],
            duplicateGroups: [],
            warnings: [],
          },
          projects: [
            {
              slug: "picked-project",
              title: "Picked Project",
              confidence: "medium",
              reason: "Notebook and notes align to a single project.",
              sourcePaths: ["analysis/explore.ipynb", "notes/summary.md"],
            },
          ],
          duplicateGroups: [],
          warnings: [],
        });
      }

      if (url === "/api/brain/import-project-job" && method === "POST") {
        return Response.json({
          ok: true,
          job: {
            id: "job-picked-project",
            project: "picked-project",
            folderName: "picked-archive",
            folderPath: "/tmp/picked-archive",
            status: "queued",
            progress: {
              phase: "queued",
              detectedFiles: 0,
              detectedItems: 0,
              detectedBytes: 0,
              importedFiles: 0,
              skippedDuplicates: 0,
              duplicateGroups: 0,
              currentPath: null,
            },
            result: null,
            error: null,
          },
        });
      }

      if (url === "/api/brain/import-project-job?id=job-picked-project") {
        return Response.json({
          id: "job-picked-project",
          project: "picked-project",
          folderName: "picked-archive",
          folderPath: "/tmp/picked-archive",
          status: "completed",
          progress: {
            phase: "finalizing",
            detectedFiles: 2,
            detectedItems: 2,
            detectedBytes: 176,
            importedFiles: 2,
            skippedDuplicates: 0,
            duplicateGroups: 0,
            currentPath: null,
          },
          result: {
            project: "picked-project",
            title: "Picked Project",
            importedFiles: 2,
            detectedItems: 2,
            detectedBytes: 176,
            duplicateGroups: 0,
            projectPagePath: "wiki/projects/picked-project.md",
            sourcePageCount: 2,
            generatedAt: "2026-04-11T12:00:00.000Z",
          },
          error: null,
        });
      }

      throw new Error(`Unexpected fetch url: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<ImportDialog open onClose={vi.fn()} onImport={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Pick Local Folder" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/local-folder-picker",
        expect.objectContaining({ method: "POST" }),
      );
    });
    expect(await screen.findByText("Picked Project")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("/Users/your-username/code/your-project")).toHaveValue("/tmp/picked-archive");

    fireEvent.click(screen.getByRole("button", { name: /Import full archive in background to picked-project/i }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([url]) => url === "/api/brain/import-project-job?id=job-picked-project"),
      ).toBe(true);
    });

    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/import-project");
    expect(fetchMock.mock.calls[2]?.[0]).toBe("/api/brain/import-project-job");
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toMatchObject({
      action: "start",
      path: "/tmp/picked-archive",
      projectSlug: "picked-project",
    });
  });

  it("explains scan caps and duplicate handling in the warning panel", async () => {
    const fetchMock = vi.fn(async (...args: [RequestInfo | URL, RequestInit?]) => {
      const [input] = args;
      const url = String(input);

      if (url === "/api/import-project") {
        return Response.json({
          name: "Large Archive",
          basePath: "/tmp/large-archive",
          totalFiles: 500,
          detectedItems: 5048,
          detectedBytes: 1789300000,
          files: [],
          preview: {
            analysis: "Local scan preview (local-scan)",
            backend: "local-scan",
            files: Array.from({ length: 100 }, (_, index) => ({
              path: `notes/file-${index}.md`,
              type: "md",
              size: 24,
              classification: "note",
              projectCandidates: ["large-archive"],
              warnings: [],
            })),
            projects: [
              {
                slug: "large-archive",
                title: "Large Archive",
                confidence: "medium",
                reason: "Imported notes folder",
                sourcePaths: ["notes/file-0.md"],
              },
            ],
            duplicateGroups: Array.from({ length: 12 }, (_, index) => ({
              id: `dup-${index + 1}`,
              paths: [`notes/original-${index}.md`, `notes/copy-${index}.md`],
              reason: "Identical content hash abcdef123456",
            })),
            warnings: [
              {
                code: "scan-limit",
                message: "Local scan found 5,048 items (1789.3 MB on disk). Prepared 500 files for import in this pass because of the 500-file cap.",
              },
              {
                code: "file-limit",
                message: "Preview shows only the first 100 prepared files out of 500 local files scanned.",
              },
              {
                code: "duplicates",
                message: "12 duplicate group(s) detected in the local scan.",
              },
            ],
          },
          duplicateGroups: [],
          warnings: [],
        });
      }

      throw new Error(`Unexpected fetch url: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<ImportDialog open onClose={vi.fn()} onImport={vi.fn()} />);

    fireEvent.change(screen.getByPlaceholderText("/Users/your-username/code/your-project"), {
      target: { value: "/tmp/large-archive" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Import" }));

    expect(await screen.findByText("This preview is capped at 500 files, but the server-side import can continue from the full local folder in the background.")).toBeInTheDocument();
    expect(screen.getByText("The preview list below is only a sample of the local scan. It shows the first 100 files from the capped preview set.")).toBeInTheDocument();
    expect(screen.getByText("ScienceSwarm keeps the first file in each duplicate group and skips the rest during import.")).toBeInTheDocument();
  });

  it("locks the import target to the current project when projectSlug is supplied", async () => {
    const fetchMock = vi.fn(async (...args: [RequestInfo | URL, RequestInit?]) => {
      const [input] = args;
      const url = String(input);
      const method = args[1]?.method ?? "GET";

      if (url === "/api/import-project") {
        return Response.json({
          name: "Alpha Archive",
          basePath: "/tmp/alpha-archive",
          totalFiles: 1,
          files: [],
          preview: {
            analysis: "Local scan preview (local-scan)",
            backend: "local-scan",
            files: [],
            projects: [
              {
                slug: "preview-bucket",
                title: "Preview Bucket",
                confidence: "medium",
                reason: "Preview grouping",
                sourcePaths: ["notes/summary.md"],
              },
            ],
            duplicateGroups: [],
            warnings: [],
          },
          duplicateGroups: [],
          warnings: [],
        });
      }

      if (url === "/api/brain/import-project-job" && method === "POST") {
        return Response.json({
          ok: true,
          job: {
            id: "job-project-alpha",
            project: "project-alpha",
            folderName: "Alpha Archive",
            folderPath: "/tmp/alpha-archive",
            status: "queued",
            progress: {
              phase: "queued",
              detectedFiles: 0,
              detectedItems: 0,
              detectedBytes: 0,
              importedFiles: 0,
              skippedDuplicates: 0,
              duplicateGroups: 0,
              currentPath: null,
            },
            result: null,
            error: null,
          },
        });
      }

      if (url === "/api/brain/import-project-job?id=job-project-alpha") {
        return Response.json({
          id: "job-project-alpha",
          project: "project-alpha",
          folderName: "Alpha Archive",
          folderPath: "/tmp/alpha-archive",
          status: "completed",
          progress: {
            phase: "finalizing",
            detectedFiles: 1,
            detectedItems: 1,
            detectedBytes: 42,
            importedFiles: 1,
            skippedDuplicates: 0,
            duplicateGroups: 0,
            currentPath: null,
          },
          result: {
            project: "project-alpha",
            title: "Project Alpha",
            importedFiles: 1,
            detectedItems: 1,
            detectedBytes: 42,
            duplicateGroups: 0,
            projectPagePath: "wiki/projects/project-alpha.md",
            sourcePageCount: 1,
            generatedAt: "2026-04-11T12:00:00.000Z",
          },
          error: null,
        });
      }

      throw new Error(`Unexpected fetch url: ${url}`);
    });

    vi.spyOn(window, "setInterval").mockImplementation((((callback: TimerHandler) => {
      if (typeof callback === "function") {
        void callback();
      }
      return 1;
    }) as typeof window.setInterval));
    vi.spyOn(window, "clearInterval").mockImplementation(() => {});
    vi.stubGlobal("fetch", fetchMock);

    render(<ImportDialog open onClose={vi.fn()} onImport={vi.fn()} projectSlug="project-alpha" />);

    fireEvent.change(screen.getByPlaceholderText("/Users/your-username/code/your-project"), {
      target: { value: "/tmp/alpha-archive" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Import" }));

    expect(await screen.findByText(/Import full archive in background to project-alpha/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Preview Bucket/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Import full archive in background to project-alpha/i }));

    const commitCall = fetchMock.mock.calls[1];
    expect(JSON.parse(String(commitCall?.[1]?.body))).toMatchObject({
      action: "start",
      path: "/tmp/alpha-archive",
      projectSlug: "project-alpha",
    });
  });
});
