/**
 * Contract test for `POST /api/brain/coldstart-stream`.
 *
 * Pins the SSE event shape emitted by the warm-start endpoint so
 * Phase C Lane 4's `BrainProgress` UI component can rely on a stable
 * wire format. The route internally delegates to
 * `approveAndImportWithProgress`; we mock that module so the test is
 * deterministic and does not depend on having a real brain on disk.
 *
 * The test verifies:
 *   1. The new `start` event fires once before any `progress` event,
 *      and carries a `total` that agrees with the preview minus
 *      pre-skipped duplicates.
 *   2. `progress`, `file-done`, `error`, `complete` events are
 *      forwarded with the expected payload shapes.
 *   3. The response has the correct SSE content-type headers.
 *   4. A malformed body is rejected with a 400 before the stream
 *      opens.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the _shared helper BEFORE importing the route so the route
// picks up the mocked getBrainConfig / getLLMClient. We return a
// trivial non-Response BrainConfig stub; the route only passes it
// through to the mocked coldstart function, which we also stub.
vi.mock("@/app/api/brain/_shared", () => ({
  getBrainConfig: vi.fn(() => ({
    root: "/tmp/fake-brain",
    extractionModel: "test",
    synthesisModel: "test",
    rippleCap: 5,
    paperWatchBudget: 10,
    serendipityRate: 0,
  })),
  getLLMClient: vi.fn(() => ({
    async complete() {
      return { content: "", cost: null };
    },
  })),
  isErrorResponse: (result: unknown): result is Response =>
    result instanceof Response,
}));

vi.mock("@/brain/coldstart", () => ({
  approveAndImportWithProgress: vi.fn(),
}));

import { POST } from "@/app/api/brain/coldstart-stream/route";
import { approveAndImportWithProgress } from "@/brain/coldstart";

interface ParsedSseBlock {
  event: string;
  data: Record<string, unknown>;
}

async function drainSse(response: Response): Promise<ParsedSseBlock[]> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("response had no body");
  const decoder = new TextDecoder();
  let buffer = "";
  const blocks: ParsedSseBlock[] = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const raw = buffer.split("\n\n");
    buffer = raw.pop() ?? "";
    for (const block of raw) {
      let event = "message";
      let dataJson: string | null = null;
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice("event:".length).trim();
        else if (line.startsWith("data:")) dataJson = line.slice("data:".length).trim();
      }
      if (dataJson == null) continue;
      blocks.push({ event, data: JSON.parse(dataJson) as Record<string, unknown> });
    }
  }
  return blocks;
}

function makePreview(
  fileCount: number,
  duplicateGroups: Array<{ paths: string[] }> = [],
) {
  const files = Array.from({ length: fileCount }, (_, i) => ({
    path: `/tmp/fake/file-${i}.pdf`,
    type: "paper",
    size: 1024,
    hash: `hash-${i}`,
    classification: { home: "papers", confidence: 0.9, reason: "test" },
    projectCandidates: [],
    warnings: [],
  }));
  return {
    analysis: `Found ${fileCount} files`,
    backend: "coldstart-scan",
    files,
    projects: [],
    duplicateGroups,
    warnings: [],
  };
}

describe("POST /api/brain/coldstart-stream — SSE event contract", () => {
  const mocked = vi.mocked(approveAndImportWithProgress);

  beforeEach(() => {
    mocked.mockReset();
    vi.stubEnv("SCIENCESWARM_USER_HANDLE", "@test-researcher");
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("rejects a missing preview with a 400 before opening the stream", async () => {
    const request = new Request("http://localhost/api/brain/coldstart-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    const response = await POST(request);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toMatch(/preview/i);
  });

  it("emits start, progress, file-done, error, and complete events in order", async () => {
    mocked.mockImplementation(async (_config, _llm, _preview, _options, cb) => {
      cb.onProgress?.({
        phase: "importing",
        current: 1,
        total: 2,
        currentFile: "/tmp/fake/file-0.pdf",
        message: "Importing file-0.pdf (1/2)",
      });
      cb.onFileDone?.({
        path: "/tmp/fake/file-0.pdf",
        type: "paper",
        wikiPath: "wiki/papers/file-0.md",
      });
      cb.onError?.({
        path: "/tmp/fake/file-1.pdf",
        error: "fake parse failure",
      });
      cb.onProgress?.({
        phase: "importing",
        current: 2,
        total: 2,
        currentFile: "/tmp/fake/file-1.pdf",
        message: "Importing file-1.pdf (2/2)",
      });
      return {
        imported: 1,
        skipped: 0,
        errors: [{ path: "/tmp/fake/file-1.pdf", error: "fake parse failure" }],
        projectsCreated: [],
        pagesCreated: 1,
        firstBriefing: {
          generatedAt: new Date().toISOString(),
          activeThreads: [],
          stalledThreads: [],
          centralPapers: [],
          suggestedQuestions: [],
          stats: {
            papers: 0,
            notes: 0,
            experiments: 0,
            projects: 0,
            totalPages: 0,
          },
        },
        durationMs: 42,
      };
    });

    const request = new Request("http://localhost/api/brain/coldstart-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ preview: makePreview(2) }),
    });

    const response = await POST(request);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");

    const blocks = await drainSse(response);
    const eventNames = blocks.map((b) => b.event);
    expect(eventNames).toEqual([
      "start",
      "progress",
      "file-done",
      "error",
      "progress",
      "complete",
    ]);

    const startBlock = blocks[0];
    expect(startBlock.data).toEqual({ total: 2 });

    const firstProgress = blocks[1];
    expect(firstProgress.data).toMatchObject({
      current: 1,
      total: 2,
      currentFile: "/tmp/fake/file-0.pdf",
    });

    const errorBlock = blocks[3];
    expect(errorBlock.data).toMatchObject({
      path: "/tmp/fake/file-1.pdf",
      error: "fake parse failure",
    });

    const completeBlock = blocks[blocks.length - 1];
    expect(completeBlock.data).toMatchObject({
      imported: 1,
      skipped: 0,
    });
  });

  it("subtracts pre-skipped duplicates from the start total when skipDuplicates is set", async () => {
    mocked.mockImplementation(async () => ({
      imported: 0,
      skipped: 0,
      errors: [],
      projectsCreated: [],
      pagesCreated: 0,
      firstBriefing: {
        generatedAt: new Date().toISOString(),
        activeThreads: [],
        stalledThreads: [],
        centralPapers: [],
        suggestedQuestions: [],
        stats: {
          papers: 0,
          notes: 0,
          experiments: 0,
          projects: 0,
          totalPages: 0,
        },
      },
      durationMs: 0,
    }));

    // 4 files, one duplicate group of [a, b, c] means b and c are
    // pre-skipped ⇒ total = 4 - 2 = 2.
    const preview = makePreview(4, [
      { paths: ["/tmp/fake/file-0.pdf", "/tmp/fake/file-1.pdf", "/tmp/fake/file-2.pdf"] },
    ]);

    const request = new Request("http://localhost/api/brain/coldstart-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        preview,
        options: { skipDuplicates: true },
      }),
    });

    const response = await POST(request);
    const blocks = await drainSse(response);
    expect(blocks[0].event).toBe("start");
    expect(blocks[0].data).toEqual({ total: 2 });
  });

  it("passes the requested project slug through to the import worker", async () => {
    mocked.mockResolvedValue({
      imported: 0,
      skipped: 0,
      errors: [],
      projectsCreated: [],
      pagesCreated: 0,
      firstBriefing: {
        generatedAt: new Date().toISOString(),
        activeThreads: [],
        stalledThreads: [],
        centralPapers: [],
        suggestedQuestions: [],
        stats: {
          papers: 0,
          notes: 0,
          experiments: 0,
          projects: 0,
          totalPages: 0,
        },
      },
      durationMs: 0,
    });

    const request = new Request("http://localhost/api/brain/coldstart-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        preview: makePreview(1),
        options: { projectSlug: "project-alpha" },
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(200);
    expect(mocked).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ projectSlug: "project-alpha" }),
      expect.anything(),
    );
  });

  it("emits a synthetic error event if the inner import throws", async () => {
    mocked.mockRejectedValueOnce(new Error("boom"));

    const request = new Request("http://localhost/api/brain/coldstart-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ preview: makePreview(1) }),
    });

    const response = await POST(request);
    const blocks = await drainSse(response);
    const errorBlock = blocks.find((b) => b.event === "error");
    expect(errorBlock).toBeDefined();
    expect(errorBlock!.data).toMatchObject({ error: "boom" });
  });

  it("emits a terminal complete event after a fatal throw so the client leaves the running state", async () => {
    // Regression for Greptile P1 on PR #248: without a terminal
    // `complete` event, BrainProgress would observe the stream close
    // with no state transition and stay stuck in "running".
    mocked.mockRejectedValueOnce(new Error("kaboom"));

    const request = new Request("http://localhost/api/brain/coldstart-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ preview: makePreview(3) }),
    });

    const response = await POST(request);
    const blocks = await drainSse(response);
    const eventOrder = blocks.map((b) => b.event);
    expect(eventOrder[0]).toBe("start");
    expect(eventOrder).toContain("error");
    expect(eventOrder[eventOrder.length - 1]).toBe("complete");

    const completeBlock = blocks[blocks.length - 1];
    expect(completeBlock.data).toMatchObject({
      imported: 0,
      skipped: 0,
    });
    const errors = (completeBlock.data as { errors?: unknown }).errors;
    expect(Array.isArray(errors)).toBe(true);
    expect((errors as Array<{ error: string }>)[0]?.error).toBe("kaboom");
  });
});
