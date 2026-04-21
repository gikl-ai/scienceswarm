import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  fetchStructuredCritiqueByJobId,
  submitStructuredCritique,
  StructuredCritiqueServiceUnavailableError,
  StructuredCritiqueInvalidResponseError,
} from "@/lib/structured-critique-client";

// The shared client reads the config lazily on every call. Stub it per-test
// so we never hit a real env var.
vi.mock("@/lib/structured-critique-config", () => ({
  getStructuredCritiqueConfig: vi.fn(() => ({
    baseUrl: "http://test.invalid/api/v1",
    clientLabel: "scienceswarm-test",
    token: null,
    timeoutMs: 60_000,
    authMode: "user_session",
  })),
  StructuredCritiqueConfigError: class StructuredCritiqueConfigError extends Error {},
}));

function makeResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function makeJob(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-123",
    status: "COMPLETED",
    pdf_filename: "hubble-1929.pdf",
    style_profile: "professional",
    result: {
      findings: [],
      report_markdown: "# Result",
    },
    ...overrides,
  };
}

const LONG_TEXT =
  "This manuscript argues that a single intervention explains the full observed effect, but the evidence only establishes a correlation and leaves the main causal assumption undefended. ".repeat(
    2,
  );

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(makeResponse(makeJob())),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("submitStructuredCritique", () => {
  it("POSTs a file with the correct form fields and returns the payload", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        makeResponse(makeJob()),
      ),
    );

    const result = await submitStructuredCritique({
      file: {
        bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
        filename: "hubble-1929.pdf",
      },
      styleProfile: "professional",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe(200);
    expect(result.payload).toMatchObject(makeJob());

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://test.invalid/api/v1/structured-critique");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      "X-Structured-Critique-Client": "scienceswarm-test",
    });
    const form = init.body as FormData;
    expect(form.get("style_profile")).toBe("professional");
    expect(form.get("fallacy_profile")).toBeNull();
    expect(form.get("file")).toBeInstanceOf(File);
  });

  it("forwards an explicit fallacy profile when one is provided", async () => {
    const result = await submitStructuredCritique({
      text: LONG_TEXT,
      styleProfile: "professional",
      fallacyProfile: "general",
    });

    expect(result.ok).toBe(true);
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const [, init] = fetchMock.mock.calls[0];
    const form = init.body as FormData;
    expect(form.get("fallacy_profile")).toBe("general");
  });

  it("accepts a single-sentence text submission without a local minimum-length gate", async () => {
    const singleSentence =
      "Digital infrastructure expansion is essential for modern progress because it compounds later scientific and industrial improvements.";

    const result = await submitStructuredCritique({
      text: singleSentence,
      styleProfile: "professional",
    });

    expect(result.ok).toBe(true);
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const [, init] = fetchMock.mock.calls[0];
    const form = init.body as FormData;
    expect(form.get("text")).toBe(singleSentence);
  });

  it("rejects when neither file nor text is provided", async () => {
    const result = await submitStructuredCritique({});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
    expect(result.error).toContain("Either file bytes or a text body");
  });

  it("rejects when both file and text are provided", async () => {
    const result = await submitStructuredCritique({
      file: { bytes: new Uint8Array([1]), filename: "x.pdf" },
      text: "hello",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
    expect(result.error).toContain("not both");
  });

  it("rejects unknown style profiles", async () => {
    const result = await submitStructuredCritique({
      text: "hello",
      styleProfile: "harsh" as unknown as "professional",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
    expect(result.error).toContain("Invalid style_profile");
  });

  it("rejects oversized file bytes before submitting to Descartes", async () => {
    const result = await submitStructuredCritique({
      file: {
        bytes: new Uint8Array(25 * 1024 * 1024 + 1),
        filename: "large.pdf",
      },
      styleProfile: "professional",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(413);
    expect(result.error).toBe(
      "PDF upload exceeds the 25 MB structured critique limit",
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("maps a network failure to a 503 service-unreachable error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => {
        throw new Error("ECONNREFUSED");
      }),
    );
    const result = await submitStructuredCritique({
      text: LONG_TEXT,
      styleProfile: "professional",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(503);
    expect(result.error).toContain("temporarily unavailable");
  });

  it("surfaces an abort from the upstream as a 504 with the plain-language timeout message", async () => {
    const abortError = new Error("aborted");
    (abortError as { name?: string }).name = "AbortError";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(abortError),
    );
    const result = await submitStructuredCritique({
      text: LONG_TEXT,
      timeoutMs: 900_000,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(504);
    expect(result.error).toContain("did not respond after 900 seconds");
  });

  it("reports invalid JSON from the upstream as a 502", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("not-json", {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
      ),
    );
    const result = await submitStructuredCritique({
      text: LONG_TEXT,
      styleProfile: "professional",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(502);
    expect(result.error).toContain("invalid response");
  });

  it("reports successful upstream job payload schema failures as a 502", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        makeResponse({ status: "COMPLETED", result: { findings: [] } }),
      ),
    );
    const result = await submitStructuredCritique({
      text: LONG_TEXT,
      styleProfile: "professional",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(502);
    expect(result.error).toContain("invalid response");
  });

  it("maps polling aborts to 504 timeout responses", async () => {
    const abortError = new Error("aborted");
    abortError.name = "AbortError";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(abortError));

    const result = await fetchStructuredCritiqueByJobId("job-123", {
      timeoutMs: 45_000,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(504);
    expect(result.error).toContain("did not respond after 45 seconds");
  });

  it("surfaces upstream error payload detail on non-2xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        makeResponse(
          { detail: "file too large" },
          { status: 413 },
        ),
      ),
    );
    const result = await submitStructuredCritique({
      text: LONG_TEXT,
      styleProfile: "professional",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(413);
    expect(result.error).toBe("file too large");
  });

  it("formats FastAPI-style 422 validation arrays into readable messages", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        makeResponse(
          {
            detail: [
              {
                loc: ["body", "text"],
                msg: "Text must include at least 2 sentences",
                type: "value_error",
              },
            ],
          },
          { status: 422, statusText: "Unprocessable Entity" },
        ),
      ),
    );

    const result = await submitStructuredCritique({
      text: "This is one sentence only.",
      styleProfile: "professional",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(422);
    expect(result.error).toBe("text: Text must include at least 2 sentences");
  });

  it("does not expose nested non-422 upstream error.message payloads", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        makeResponse(
          {
            error: {
              message: "raw upstream stack trace",
            },
          },
          { status: 500, statusText: "Internal Server Error" },
        ),
      ),
    );

    const result = await submitStructuredCritique({
      text: LONG_TEXT,
      styleProfile: "professional",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(500);
    expect(result.error).toBe("Internal Server Error");
  });

  it("does not expose raw 5xx detail strings from the upstream", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        makeResponse(
          {
            detail: "Traceback: sensitive upstream failure details",
          },
          { status: 500, statusText: "Internal Server Error" },
        ),
      ),
    );

    const result = await submitStructuredCritique({
      text: LONG_TEXT,
      styleProfile: "professional",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(500);
    expect(result.error).toBe("Internal Server Error");
  });

  it("exports typed error classes that consumers can instanceof-check", () => {
    expect(
      new StructuredCritiqueServiceUnavailableError(),
    ).toBeInstanceOf(Error);
    expect(
      new StructuredCritiqueInvalidResponseError(),
    ).toBeInstanceOf(Error);
  });
});
