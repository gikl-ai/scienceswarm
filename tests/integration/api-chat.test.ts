import { describe, expect, it, vi } from "vitest";

/**
 * The /api/chat route internally calls fetch() to redirect to /api/chat/unified.
 * We mock global fetch to simulate that redirect and test the route handler.
 */

import { POST } from "@/app/api/chat/route";

describe("POST /api/chat", () => {
  it("redirects to unified endpoint and returns the proxied response", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      Response.json(
        { response: "Hello from unified", backend: "openclaw" },
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const request = new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "Summarize this paper" }],
        files: [],
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(200);

    // Verify the fetch was called with the unified endpoint
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.pathname).toBe("/api/chat/unified");
    expect(init.method).toBe("POST");

    const body = await response.json();
    expect(body.response).toBe("Hello from unified");
  });

  it("forwards the last user message to the unified endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      Response.json({ response: "ok", backend: "openclaw" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const request = new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          { role: "user", content: "First" },
          { role: "assistant", content: "Reply" },
          { role: "user", content: "Last message" },
        ],
        files: [],
      }),
    });

    await POST(request);

    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    const sentBody = JSON.parse(init.body as string);
    expect(sentBody.message).toBe("Last message");
  });

  it("propagates errors from the unified endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      Response.json(
        { error: "Both backends down", backend: "none" },
        { status: 503 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const request = new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [], files: [] }),
    });

    const response = await POST(request);
    expect(response.status).toBe(503);
  });
});
