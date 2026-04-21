// @vitest-environment jsdom

/**
 * Tests for `src/components/progress/brain-progress.tsx`.
 *
 * The component consumes a POST-SSE response, so every test has to
 * hand-assemble a fake `Response` whose body is a `ReadableStream`
 * that emits the SSE blocks the test cares about. A small helper
 * (`makeSseResponse`) builds one from a canned list of events.
 *
 * We intentionally do NOT use MSW or a real network here — the
 * streaming protocol is simple enough that a hand-rolled stub keeps
 * the tests fast and deterministic.
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BrainProgress,
  formatDuration,
  type BrainProgressResult,
} from "@/components/progress/brain-progress";

// ── Helpers ─────────────────────────────────────────────────────

interface SseEvent {
  event: string;
  data: unknown;
}

/**
 * Build a fake Response whose body is a ReadableStream that emits
 * each event as a proper SSE block (`event: foo\ndata: json\n\n`).
 * `delayMs` pauses between blocks so the component can observe
 * intermediate states — useful for testing progress updates.
 */
function makeSseResponse(
  events: SseEvent[],
  delayMs = 0,
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const ev of events) {
        const block = `event: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`;
        controller.enqueue(encoder.encode(block));
        if (delayMs > 0) {
          await new Promise((r) => setTimeout(r, delayMs));
        }
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

/**
 * Build a fake response that never closes and records the abort
 * signal the component threads through. Used to verify the
 * AbortController path on unmount.
 */
function makeHangingResponse(): {
  response: Response;
  cancelled: () => boolean;
} {
  let cancelCalled = false;
  const stream = new ReadableStream<Uint8Array>({
    // Intentionally never enqueue — the reader blocks on `.read()`.
    start() {
      /* no-op */
    },
    cancel() {
      cancelCalled = true;
    },
  });
  return {
    response: new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }),
    cancelled: () => cancelCalled,
  };
}

// ── Suite ───────────────────────────────────────────────────────

describe("BrainProgress", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    // Keep a stable clock baseline; tests that need it call
    // vi.useFakeTimers() explicitly.
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("renders the idle header and description with autoStart=false", () => {
    // Mock fetch so the auto-effect wouldn't run anyway. Passing
    // autoStart={false} keeps the component firmly in the idle state
    // until the user clicks the button.
    globalThis.fetch = vi.fn();
    render(
      <BrainProgress
        streamUrl="/api/brain/coldstart-stream"
        title="Importing your corpus"
        description="Scientist corpus warm-start"
        autoStart={false}
      />,
    );

    expect(screen.getByText("Importing your corpus")).toBeInTheDocument();
    expect(screen.getByText("Scientist corpus warm-start")).toBeInTheDocument();
    expect(screen.getByText(/Waiting to start/i)).toBeInTheDocument();
    expect(
      screen.getByTestId("brain-progress-run-button"),
    ).toBeInTheDocument();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("updates state as progress and complete events land", async () => {
    const response = makeSseResponse([
      { event: "start", data: { total: 3 } },
      {
        event: "progress",
        data: {
          phase: "importing",
          current: 1,
          total: 3,
          currentFile: "alpha.pdf",
          message: "Importing alpha.pdf (1/3)",
        },
      },
      {
        event: "progress",
        data: {
          phase: "importing",
          current: 2,
          total: 3,
          currentFile: "beta.pdf",
          message: "Importing beta.pdf (2/3)",
        },
      },
      {
        event: "progress",
        data: {
          phase: "importing",
          current: 3,
          total: 3,
          currentFile: "gamma.pdf",
          message: "Importing gamma.pdf (3/3)",
        },
      },
      {
        event: "complete",
        data: {
          imported: 3,
          skipped: 0,
          errors: [],
          pagesCreated: 3,
          durationMs: 1234,
        },
      },
    ]);
    globalThis.fetch = vi.fn().mockResolvedValue(response);

    const onComplete = vi.fn<(result: BrainProgressResult) => void>();

    render(
      <BrainProgress
        streamUrl="/api/brain/coldstart-stream"
        title="Importing your corpus"
        onComplete={onComplete}
      />,
    );

    // Wait for the success banner — proves the component parsed the
    // complete event and called onComplete at least once.
    await waitFor(() =>
      expect(
        screen.getByTestId("brain-progress-success-banner"),
      ).toBeInTheDocument(),
    );

    expect(onComplete).toHaveBeenCalledTimes(1);
    const result = onComplete.mock.calls[0][0];
    expect(result.imported).toBe(3);
    expect(result.skipped).toBe(0);
    expect(result.errors).toEqual([]);

    // The final "Imported 3 files" banner uses the success variant.
    expect(screen.getByRole("status").textContent).toMatch(/Imported 3 file/);
  });

  it("shows the error list when error events arrive", async () => {
    const response = makeSseResponse([
      { event: "start", data: { total: 2 } },
      {
        event: "progress",
        data: {
          phase: "importing",
          current: 1,
          total: 2,
          currentFile: "ok.pdf",
          message: "Importing ok.pdf (1/2)",
        },
      },
      { event: "error", data: { path: "broken.pdf", error: "Parse failed" } },
      {
        event: "progress",
        data: {
          phase: "importing",
          current: 2,
          total: 2,
          currentFile: "broken.pdf",
          message: "Importing broken.pdf (2/2)",
        },
      },
      {
        event: "complete",
        data: {
          imported: 1,
          skipped: 0,
          errors: [{ path: "broken.pdf", error: "Parse failed" }],
          pagesCreated: 1,
          durationMs: 500,
        },
      },
    ]);
    globalThis.fetch = vi.fn().mockResolvedValue(response);

    render(
      <BrainProgress
        streamUrl="/api/brain/coldstart-stream"
        title="Importing your corpus"
      />,
    );

    await waitFor(() =>
      expect(screen.getByTestId("brain-progress-error-list")).toBeInTheDocument(),
    );

    const toggle = screen.getByTestId("brain-progress-error-toggle");
    expect(toggle.textContent).toMatch(/1 file had errors/);

    // Collapsed by default — expand and confirm the detail lands.
    fireEvent.click(toggle);
    expect(screen.getByText(/Parse failed/)).toBeInTheDocument();
    // "broken.pdf" appears in both the current-file indicator and
    // the error list after expansion, so `getByText` would match
    // twice. Scope the assertion to the error list container.
    const errorList = screen.getByTestId("brain-progress-error-list");
    expect(errorList.textContent).toContain("broken.pdf");
  });

  it("surfaces a fatal error when the fetch rejects", async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error("network went boom"));

    const onError = vi.fn<(err: Error) => void>();

    render(
      <BrainProgress
        streamUrl="/api/brain/coldstart-stream"
        title="Importing your corpus"
        onError={onError}
      />,
    );

    await waitFor(() =>
      expect(screen.getByTestId("brain-progress-error-banner")).toBeInTheDocument(),
    );
    expect(screen.getByText(/network went boom/)).toBeInTheDocument();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);
  });

  it("aborts the in-flight fetch on unmount", async () => {
    const { response, cancelled } = makeHangingResponse();
    // Capture the signal the component passed so we can assert it
    // got aborted.
    let capturedSignal: AbortSignal | undefined;
    globalThis.fetch = vi.fn().mockImplementation(
      async (_url: string, init?: RequestInit) => {
        capturedSignal = init?.signal ?? undefined;
        return response;
      },
    );

    const { unmount } = render(
      <BrainProgress
        streamUrl="/api/brain/coldstart-stream"
        title="Importing your corpus"
      />,
    );

    // Wait until the fetch has been issued so the reader loop is
    // definitely active. `act` flushes the effect that auto-starts.
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1));
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal!.aborted).toBe(false);

    // Unmount should fire the cleanup effect, which aborts the
    // controller. Greptile caught this leak in PR #242 — we assert
    // the fixed pattern here.
    await act(async () => {
      unmount();
    });

    expect(capturedSignal!.aborted).toBe(true);
    // The reader's `cancel()` is called by the loop after the abort
    // lands. Either the reader cancel OR the abort signal is enough
    // to prove the leak is fixed — check at least one landed.
    await waitFor(() => {
      expect(capturedSignal!.aborted || cancelled()).toBe(true);
    });
  });
});

describe("formatDuration", () => {
  it("formats sub-minute durations as seconds", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(999)).toBe("0s");
    expect(formatDuration(1000)).toBe("1s");
    expect(formatDuration(59_000)).toBe("59s");
  });

  it("formats sub-hour durations as minutes+seconds", () => {
    expect(formatDuration(60_000)).toBe("1m");
    expect(formatDuration(65_000)).toBe("1m 5s");
    expect(formatDuration(59 * 60 * 1000)).toBe("59m");
  });

  it("formats multi-hour durations as hours+minutes", () => {
    expect(formatDuration(60 * 60 * 1000)).toBe("1h");
    expect(formatDuration(60 * 60 * 1000 + 30 * 60 * 1000)).toBe("1h 30m");
  });

  it("returns 0s for negative or NaN input", () => {
    expect(formatDuration(-1)).toBe("0s");
    expect(formatDuration(Number.NaN)).toBe("0s");
  });
});
