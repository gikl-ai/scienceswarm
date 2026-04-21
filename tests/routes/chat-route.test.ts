import { describe, expect, it, vi } from "vitest";

/**
 * The /api/chat route now redirects to /api/chat/unified via fetch().
 * We mock global fetch to test the proxying behaviour.
 */

import { POST } from "@/app/api/chat/route";

describe("POST /api/chat", () => {
  it("proxies the last user message to the unified endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      Response.json(
        { response: "hello", backend: "openclaw" },
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const requestBody = {
      messages: [{ role: "user", content: "Summarize this paper" }],
      files: [{ name: "paper.pdf", size: "2 MB" }],
    };
    const request = new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });

    const response = await POST(request);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.pathname).toBe("/api/chat/unified");
    expect(init.method).toBe("POST");

    const sentBody = JSON.parse(init.body as string);
    expect(sentBody.message).toBe("Summarize this paper");
    expect(sentBody.files).toEqual(requestBody.files);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.response).toBe("hello");
  });

  it("propagates error status from the unified endpoint", async () => {
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
