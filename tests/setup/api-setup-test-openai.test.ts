import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/setup/test-openai tests. We mock `globalThis.fetch`
 * directly because the handler calls the global `fetch`, not a
 * module-scoped alias. Restoring the spy after each test prevents
 * cross-test leakage.
 */

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/api/setup/test-openai", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function okResponse(status = 200): Response {
  return new Response(JSON.stringify({ data: [] }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("POST /api/setup/test-openai", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn> | null = null;

  beforeEach(() => {
    fetchSpy = null;
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
    fetchSpy = null;
    vi.unstubAllEnvs();
  });

  it("returns 400 with reason:missing when body is empty object", async () => {
    const { POST } = await import("@/app/api/setup/test-openai/route");
    const res = await POST(jsonRequest({}));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; reason: string };
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("missing");
  });

  it("returns 400 with reason:missing when key is empty string", async () => {
    const { POST } = await import("@/app/api/setup/test-openai/route");
    const res = await POST(jsonRequest({ key: "" }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; reason: string };
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("missing");
  });

  it("returns 400 with reason:missing when key is whitespace only", async () => {
    const { POST } = await import("@/app/api/setup/test-openai/route");
    const res = await POST(jsonRequest({ key: "   " }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; reason: string };
    expect(body.reason).toBe("missing");
  });

  it("returns 400 with reason:missing when JSON is malformed", async () => {
    const { POST } = await import("@/app/api/setup/test-openai/route");
    const res = await POST(
      new Request("http://localhost/api/setup/test-openai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not-json",
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; reason: string };
    expect(body.reason).toBe("missing");
  });

  it("returns 200 ok:true on upstream 200", async () => {
    fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(okResponse(200));

    const { POST } = await import("@/app/api/setup/test-openai/route");
    const res = await POST(jsonRequest({ key: "sk-test-abc" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; reason?: string };
    expect(body.ok).toBe(true);
    expect(body.reason).toBeUndefined();
  });

  it("blocks the hosted key probe in strict local-only mode before fetch", async () => {
    vi.stubEnv("SCIENCESWARM_STRICT_LOCAL_ONLY", "1");
    fetchSpy = vi.spyOn(globalThis, "fetch");

    const { POST } = await import("@/app/api/setup/test-openai/route");
    const res = await POST(jsonRequest({ key: "sk-test-abc" }));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { ok: boolean; reason: string };
    expect(body).toEqual({ ok: false, reason: "strict-local" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns 200 ok:false reason:unauthorized on upstream 401", async () => {
    fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("", { status: 401 }));

    const { POST } = await import("@/app/api/setup/test-openai/route");
    const res = await POST(jsonRequest({ key: "sk-bad" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; reason: string };
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("unauthorized");
  });

  it("returns 200 ok:false reason:unauthorized on upstream 403", async () => {
    fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("", { status: 403 }));

    const { POST } = await import("@/app/api/setup/test-openai/route");
    const res = await POST(jsonRequest({ key: "sk-bad" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; reason: string };
    expect(body.reason).toBe("unauthorized");
  });

  it("returns 200 ok:false reason:rate-limited on upstream 429", async () => {
    fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("", { status: 429 }));

    const { POST } = await import("@/app/api/setup/test-openai/route");
    const res = await POST(jsonRequest({ key: "sk-test" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; reason: string };
    expect(body.reason).toBe("rate-limited");
  });

  it("returns 200 ok:false reason:unknown on other upstream errors", async () => {
    fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("", { status: 500 }));

    const { POST } = await import("@/app/api/setup/test-openai/route");
    const res = await POST(jsonRequest({ key: "sk-test" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; reason: string };
    expect(body.reason).toBe("unknown");
  });

  it("returns 200 ok:false reason:network on fetch rejection", async () => {
    fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("ECONNRESET"));

    const { POST } = await import("@/app/api/setup/test-openai/route");
    const res = await POST(jsonRequest({ key: "sk-test" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; reason: string };
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("network");
  });

  it("collapses AbortController timeout to reason:network", async () => {
    // Simulate the shape fetch throws when aborted: an AbortError.
    // The handler catches any thrown error in the fetch call site
    // and maps it to reason:network regardless of the specific
    // error class.
    fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(async (_input, init) => {
        const signal = init?.signal as AbortSignal | undefined;
        if (signal?.aborted) {
          const err = new Error("aborted");
          err.name = "AbortError";
          throw err;
        }
        // Simulate the signal firing mid-flight.
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        });
      });

    // Replace setTimeout briefly so the abort triggers immediately
    // instead of after 10 s.
    const timeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementationOnce((cb) => {
        // Fire synchronously so the mocked fetch rejects right away.
        (cb as () => void)();
        return 0 as unknown as ReturnType<typeof setTimeout>;
      });

    const { POST } = await import("@/app/api/setup/test-openai/route");
    const res = await POST(jsonRequest({ key: "sk-test" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; reason: string };
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("network");

    timeoutSpy.mockRestore();
  });

  it("trims whitespace from the key before sending to OpenAI", async () => {
    let seenAuth: string | null = null;
    fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(async (_input, init) => {
        const headers = new Headers(init?.headers);
        seenAuth = headers.get("Authorization");
        return okResponse(200);
      });

    const { POST } = await import("@/app/api/setup/test-openai/route");
    const res = await POST(jsonRequest({ key: "  sk-padded  " }));
    expect(res.status).toBe(200);
    expect(seenAuth).toBe("Bearer sk-padded");
  });

  it("sends the key via Authorization header only, not in URL", async () => {
    let seenUrl: string | null = null;
    fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(async (input) => {
        seenUrl = typeof input === "string" ? input : (input as URL | Request).toString();
        return okResponse(200);
      });

    const { POST } = await import("@/app/api/setup/test-openai/route");
    await POST(jsonRequest({ key: "sk-never-leak-me" }));
    expect(seenUrl).not.toBeNull();
    expect(seenUrl).not.toContain("sk-never-leak-me");
  });
});
