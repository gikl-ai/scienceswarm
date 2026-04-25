import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GET,
  POST,
} from "@/app/api/structured-critique/route";

function stubCritiqueEnv() {
  vi.stubEnv("STRUCTURED_CRITIQUE_SERVICE_URL", "https://critique.example/api/v1/");
  vi.stubEnv("STRUCTURED_CRITIQUE_SERVICE_TOKEN", "shared-token");
  vi.stubEnv("STRUCTURED_CRITIQUE_SERVICE_CLIENT", "scienceswarm-web");
  vi.stubEnv("STRUCTURED_CRITIQUE_TIMEOUT_MS", "45000");
}

const LONG_TEXT =
  "This manuscript argues that a single intervention explains the full observed effect, but the evidence only establishes a correlation and leaves the main causal assumption undefended. ".repeat(
    2,
  );

function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

describe("/api/structured-critique", () => {
  beforeEach(() => {
    stubCritiqueEnv();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("blocks hosted critique submission in strict local-only mode before upstream fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("SCIENCESWARM_STRICT_LOCAL_ONLY", "1");

    const formData = new FormData();
    formData.append("text", "A sufficiently long text payload for reasoning audit submission.");

    const request = new Request("http://localhost/api/structured-critique", {
      method: "POST",
      body: formData,
      headers: { Authorization: "Bearer user-session-token" },
    });

    const response = await POST(request);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("Strict local-only mode blocks Cloud structured critique"),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks hosted critique polling in strict local-only mode before upstream fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("SCIENCESWARM_STRICT_LOCAL_ONLY", "1");

    const response = await GET(
      new Request("http://localhost/api/structured-critique?job_id=job-123"),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("Strict local-only mode blocks Cloud structured critique polling"),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects requests without a file or text", async () => {
    const request = new Request("http://localhost/api/structured-critique", {
      method: "POST",
      body: new FormData(),
    });

    const response = await POST(request);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Either a file upload or a text field is required",
    });
  });

  it("proxies a validated PDF upload to the remote critique service", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      Response.json(
        { id: "job-123", status: "PENDING", pdf_filename: "paper.pdf" },
        { status: 202 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const formData = new FormData();
    formData.append("file", new File(["pdf bytes"], "paper.pdf", { type: "application/pdf" }));
    formData.append("style_profile", "referee");

    const request = new Request("http://localhost/api/structured-critique", {
      method: "POST",
      body: formData,
      headers: { Authorization: "Bearer user-session-token" },
    });

    const response = await POST(request);

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      id: "job-123",
      status: "PENDING",
      pdf_filename: "paper.pdf",
      style_profile: "professional",
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://critique.example/api/v1/structured-critique");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      Authorization: "Bearer shared-token",
      "X-Structured-Critique-Client": "scienceswarm-web",
    });

    const upstreamBody = init.body as FormData;
    expect(upstreamBody.get("style_profile")).toBe("referee");
    expect(upstreamBody.get("fallacy_profile")).toBeNull();
    expect((upstreamBody.get("file") as File).name).toBe("paper.pdf");
  });

  it("rejects polling requests without a job id", async () => {
    const request = new Request("http://localhost/api/structured-critique");

    const response = await GET(request);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "job_id is required",
    });
  });

  it("polls the remote critique service with an encoded job id", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      Response.json(
        {
          id: "job 123",
          status: "RUNNING",
          pdf_filename: "paper.pdf",
        },
        { status: 202 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET(new Request(
      "http://localhost/api/structured-critique?job_id=job 123",
      {
        headers: { Authorization: "Bearer user-session-token" },
      },
    ));

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      id: "job 123",
      status: "RUNNING",
      pdf_filename: "paper.pdf",
      style_profile: "professional",
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://critique.example/api/v1/structured-critique/job%20123");
    expect(init.method).toBe("GET");
    expect(init.headers).toEqual({
      Authorization: "Bearer shared-token",
      "X-Structured-Critique-Client": "scienceswarm-web",
    });
  });

  it("lists hosted critique history when requested", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      Response.json(
        {
          jobs: [
            {
              id: "job-history-1",
              status: "RUNNING",
              pdf_filename: "paper.pdf",
            },
          ],
        },
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET(
      new Request(
        "http://localhost/api/structured-critique?history=1&limit=5",
        {
          headers: { Authorization: "Bearer user-session-token" },
        },
      ),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      jobs: [
        {
          id: "job-history-1",
          status: "RUNNING",
          pdf_filename: "paper.pdf",
          style_profile: "professional",
        },
      ],
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://critique.example/api/v1/structured-critique?limit=5");
    expect(init.method).toBe("GET");
    expect(init.headers).toEqual({
      Authorization: "Bearer shared-token",
      "X-Structured-Critique-Client": "scienceswarm-web",
    });
  });

  it("rejects non-integer history limits", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET(
      new Request(
        "http://localhost/api/structured-critique?history=1&limit=5abc",
        {
          headers: { Authorization: "Bearer user-session-token" },
        },
      ),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "limit must be an integer between 1 and 100",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("proxies a text input to the remote critique service", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      Response.json(
        { id: "job-text-1", status: "PENDING", pdf_filename: "" },
        { status: 202 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const formData = new FormData();
    formData.append("text", LONG_TEXT);

    const request = new Request("http://localhost/api/structured-critique", {
      method: "POST",
      body: formData,
      headers: { Authorization: "Bearer user-session-token" },
    });

    const response = await POST(request);

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      id: "job-text-1",
      status: "PENDING",
      pdf_filename: "",
      style_profile: "professional",
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const upstreamBody = init.body as FormData;
    expect(upstreamBody.get("text")).toBe(LONG_TEXT.trim());
    expect(upstreamBody.get("file")).toBeNull();
  });

  it("accepts a single-sentence text submission and proxies it upstream", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      Response.json(
        { id: "job-text-short", status: "PENDING", pdf_filename: "" },
        { status: 202 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const singleSentence =
      "Digital infrastructure expansion is essential for modern progress because it compounds later scientific and industrial improvements.";
    const formData = new FormData();
    formData.append("text", singleSentence);

    const response = await POST(
      new Request("http://localhost/api/structured-critique", {
        method: "POST",
        body: formData,
        headers: { Authorization: "Bearer user-session-token" },
      }),
    );

    expect(response.status).toBe(202);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const upstreamBody = init.body as FormData;
    expect(upstreamBody.get("text")).toBe(singleSentence);
  });

  it("returns a sign-in message when the hosted service rejects an unauthenticated browser request", async () => {
    vi.stubEnv("STRUCTURED_CRITIQUE_SERVICE_URL", "");
    vi.stubEnv("STRUCTURED_CRITIQUE_SERVICE_TOKEN", "");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json(
          {
            detail:
              "Authentication required",
          },
          { status: 401 },
        ),
      ),
    );

    const formData = new FormData();
    formData.append("text", LONG_TEXT);

    const response = await POST(
      new Request("http://localhost/api/structured-critique", {
        method: "POST",
        body: formData,
      }),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error:
        "Create a free account at scienceswarm.ai and sign in to use the Cloud Reasoning API.",
    });
  });

  it("rejects requests with both file and text", async () => {
    const formData = new FormData();
    formData.append("file", new File(["pdf bytes"], "paper.pdf", { type: "application/pdf" }));
    formData.append("text", "some text");

    const request = new Request("http://localhost/api/structured-critique", {
      method: "POST",
      body: formData,
    });

    const response = await POST(request);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Provide either file or text, not both",
    });
  });

  it("rejects empty text with 400", async () => {
    const formData = new FormData();
    formData.append("text", "   ");

    const request = new Request("http://localhost/api/structured-critique", {
      method: "POST",
      body: formData,
    });

    const response = await POST(request);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Either a file upload or a text field is required",
    });
  });

  it("forwards fallacy_profile to the upstream service", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      Response.json(
        { id: "job-fp-1", status: "PENDING", pdf_filename: "paper.pdf" },
        { status: 202 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const formData = new FormData();
    formData.append("file", new File(["pdf bytes"], "paper.pdf", { type: "application/pdf" }));
    formData.append("fallacy_profile", "scientific_reasoning");

    const request = new Request("http://localhost/api/structured-critique", {
      method: "POST",
      body: formData,
    });

    const response = await POST(request);

    expect(response.status).toBe(202);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const upstreamBody = init.body as FormData;
    expect(upstreamBody.get("fallacy_profile")).toBe("scientific_reasoning");
  });

  it("still proxies PDF uploads correctly (regression)", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      Response.json(
        { id: "job-reg-1", status: "PENDING", pdf_filename: "results.pdf" },
        { status: 202 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const formData = new FormData();
    formData.append("file", new File(["pdf content"], "results.pdf", { type: "application/pdf" }));

    const request = new Request("http://localhost/api/structured-critique", {
      method: "POST",
      body: formData,
    });

    const response = await POST(request);

    expect(response.status).toBe(202);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://critique.example/api/v1/structured-critique");
    expect(init.method).toBe("POST");

    const upstreamBody = init.body as FormData;
    const upstreamFile = upstreamBody.get("file") as File;
    expect(upstreamFile).toBeInstanceOf(File);
    expect(upstreamFile.name).toBe("results.pdf");
    expect(upstreamBody.get("style_profile")).toBe("professional");
    expect(upstreamBody.get("fallacy_profile")).toBeNull();
  });

  it("returns 503 when the critique service is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new TypeError("fetch failed")));

    const formData = new FormData();
    formData.append("text", LONG_TEXT);

    const request = new Request("http://localhost/api/structured-critique", {
      method: "POST",
      body: formData,
    });

    const response = await POST(request);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Analysis service is temporarily unavailable. Try again in a few minutes.",
    });
  });

  it("uses the built-in ScienceSwarm endpoint when no override URL is set", async () => {
    vi.stubEnv("STRUCTURED_CRITIQUE_SERVICE_URL", "");
    vi.stubEnv("STRUCTURED_CRITIQUE_SERVICE_TOKEN", "");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          { id: "job-built-in", status: "PENDING", pdf_filename: "" },
          { status: 202 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const formData = new FormData();
    formData.append("text", LONG_TEXT);

    const request = new Request("http://localhost/api/structured-critique", {
      method: "POST",
      body: formData,
      headers: { Authorization: "Bearer user-session-token" },
    });

    const response = await POST(request);

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      id: "job-built-in",
      status: "PENDING",
      pdf_filename: "",
      style_profile: "professional",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://scienceswarm.ai/api/v1/structured-critique",
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: {
        Authorization: "Bearer user-session-token",
        "X-Structured-Critique-Client": "scienceswarm-web",
      },
      method: "POST",
    });
  });

  it("returns 503 when the critique URL override is invalid", async () => {
    vi.stubEnv("STRUCTURED_CRITIQUE_SERVICE_URL", "not-a-url");

    const formData = new FormData();
    formData.append("text", LONG_TEXT);

    const request = new Request("http://localhost/api/structured-critique", {
      method: "POST",
      body: formData,
    });

    const response = await POST(request);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error:
        "Reasoning Audit live analysis override is invalid. `STRUCTURED_CRITIQUE_SERVICE_URL` must be a valid Cloud critique URL ending in `/v1`.",
    });
  });

  it("returns 503 when an external override omits the service token", async () => {
    vi.stubEnv("STRUCTURED_CRITIQUE_SERVICE_URL", "https://critique.example/api/v1/");
    vi.stubEnv("STRUCTURED_CRITIQUE_SERVICE_TOKEN", "");

    const formData = new FormData();
    formData.append("text", LONG_TEXT);

    const response = await POST(
      new Request("http://localhost/api/structured-critique", {
        method: "POST",
        body: formData,
      }),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error:
        "Reasoning Audit external override is incomplete. Non-ScienceSwarm critique URLs require `STRUCTURED_CRITIQUE_SERVICE_TOKEN`.",
    });
  });

  it("returns 502 when a successful critique submit response contains invalid JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response("not-json", {
          status: 202,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    const formData = new FormData();
    formData.append("text", LONG_TEXT);

    const request = new Request("http://localhost/api/structured-critique", {
      method: "POST",
      body: formData,
    });

    const response = await POST(request);

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: "Analysis service returned an invalid response. Try again in a few minutes.",
    });
  });

  it("returns 503 when critique polling cannot reach the upstream service", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new TypeError("fetch failed")));

    const response = await GET(
      new Request("http://localhost/api/structured-critique?job_id=job-123"),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Analysis service is temporarily unavailable. Try again in a few minutes.",
    });
  });

  it("returns 502 when a successful critique polling response contains invalid JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response("not-json", {
          status: 202,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    const response = await GET(
      new Request("http://localhost/api/structured-critique?job_id=job-123"),
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: "Analysis service returned an invalid response. Try again in a few minutes.",
    });
  });

  it("returns 504 when critique submission times out", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(abortError()));

    const formData = new FormData();
    formData.append("text", LONG_TEXT);

    const response = await POST(
      new Request("http://localhost/api/structured-critique", {
        method: "POST",
        body: formData,
      }),
    );

    expect(response.status).toBe(504);
    await expect(response.json()).resolves.toEqual({
      error:
        "the critique service did not respond after 45 seconds. Try again or check the service status.",
    });
  });

  it("returns 504 when critique polling times out", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(abortError()));

    const response = await GET(
      new Request("http://localhost/api/structured-critique?job_id=job-123"),
    );

    expect(response.status).toBe(504);
    await expect(response.json()).resolves.toEqual({
      error:
        "the critique service did not respond after 45 seconds. Try again or check the service status.",
    });
  });

  it("returns 502 when a successful upstream job payload fails local validation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        Response.json({ status: "PENDING" }, { status: 202 }),
      ),
    );

    const formData = new FormData();
    formData.append("text", LONG_TEXT);

    const response = await POST(
      new Request("http://localhost/api/structured-critique", {
        method: "POST",
        body: formData,
      }),
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: "Analysis service returned an invalid response. Try again in a few minutes.",
    });
  });

  it("accepts failed job envelopes with nested user-facing error messages", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        Response.json(
          {
            id: "job-failed",
            status: "FAILED",
            trace_id: "trace-123",
            error: {
              user_facing_message:
                "The critique pipeline failed before producing findings.",
            },
          },
          { status: 200 },
        ),
      ),
    );

    const response = await GET(
      new Request("http://localhost/api/structured-critique?job_id=job-failed"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: "job-failed",
      status: "FAILED",
      trace_id: "trace-123",
      error: {
        user_facing_message:
          "The critique pipeline failed before producing findings.",
      },
    });
  });

  it("accepts cancelled job envelopes with user-facing error messages", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        Response.json(
          {
            id: "job-cancelled",
            status: "CANCELLED",
            trace_id: "trace-456",
            error_message:
              "This queued critique was cancelled after you reached the hosted output limit.",
          },
          { status: 200 },
        ),
      ),
    );

    const response = await GET(
      new Request("http://localhost/api/structured-critique?job_id=job-cancelled"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: "job-cancelled",
      status: "CANCELLED",
      trace_id: "trace-456",
      error_message:
        "This queued critique was cancelled after you reached the hosted output limit.",
    });
  });

  it("rejects PDFs above the hosted Descartes upload limit before proxying", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const formData = new FormData();
    const oversized = new File([new Uint8Array(25 * 1024 * 1024 + 1)], "paper.pdf", {
      type: "application/pdf",
    });
    formData.append("file", oversized);

    const response = await POST(
      new Request("http://localhost/api/structured-critique", {
        method: "POST",
        body: formData,
      }),
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: "PDF upload exceeds the 25 MB structured critique limit",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("redacts bearer tokens from upstream error messages", async () => {
    vi.stubEnv("STRUCTURED_CRITIQUE_SERVICE_TOKEN", "shared-token");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        Response.json(
          { detail: "Bearer shared-token cannot submit this request" },
          { status: 403 },
        ),
      ),
    );

    const formData = new FormData();
    formData.append("text", LONG_TEXT);

    const response = await POST(
      new Request("http://localhost/api/structured-critique", {
        method: "POST",
        body: formData,
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Bearer [redacted] cannot submit this request",
    });
  });

  it("surfaces structured upstream 422 validation arrays instead of falling back to status text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        Response.json(
          {
            detail: [
              {
                loc: ["body", "text"],
                msg: "Text must include at least 2 sentences",
                type: "value_error",
              },
            ],
          },
          { status: 422 },
        ),
      ),
    );

    const formData = new FormData();
    formData.append("text", "This is one sentence only.");

    const response = await POST(
      new Request("http://localhost/api/structured-critique", {
        method: "POST",
        body: formData,
      }),
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error: "text: Text must include at least 2 sentences",
    });
  });

  it("does not expose nested non-422 upstream error.message payloads", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        Response.json(
          {
            error: {
              message: "raw upstream stack trace",
            },
          },
          { status: 500, statusText: "Internal Server Error" },
        ),
      ),
    );

    const formData = new FormData();
    formData.append("text", LONG_TEXT);

    const response = await POST(
      new Request("http://localhost/api/structured-critique", {
        method: "POST",
        body: formData,
      }),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "Internal Server Error",
    });
  });

  it("does not expose raw 5xx detail strings from the upstream", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        Response.json(
          {
            detail: "Traceback: sensitive upstream failure details",
          },
          { status: 500, statusText: "Internal Server Error" },
        ),
      ),
    );

    const formData = new FormData();
    formData.append("text", LONG_TEXT);

    const response = await POST(
      new Request("http://localhost/api/structured-critique", {
        method: "POST",
        body: formData,
      }),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "Internal Server Error",
    });
  });

  it("caps distinct submission rate-limit buckets to bound spoofed-client memory growth", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() =>
        Response.json(
          { id: crypto.randomUUID(), status: "PENDING" },
          { status: 202 },
        ),
      ),
    );

    let response: Response | null = null;
    for (let i = 0; i < 4100; i += 1) {
      const formData = new FormData();
      formData.append("text", LONG_TEXT);
      response = await POST(
        new Request("http://localhost/api/structured-critique", {
          method: "POST",
          body: formData,
          headers: { "x-forwarded-for": `client-${i}` },
        }),
      );
      if (response.status === 429) break;
    }

    expect(response?.status).toBe(429);
    expect(response).not.toBeNull();
    await expect(response!.json()).resolves.toEqual({
      error:
        "Structured critique submission capacity is temporarily exhausted. Try again in a few minutes.",
    });
  });
});
