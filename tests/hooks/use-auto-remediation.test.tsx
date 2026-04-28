// @vitest-environment jsdom

import { render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useAutoRemediation, type AutoRemediationMessage } from "@/hooks/use-auto-remediation";

function Harness({ pushSystemMessage }: { pushSystemMessage: (message: AutoRemediationMessage) => void }) {
  useAutoRemediation(pushSystemMessage);
  return null;
}

describe("useAutoRemediation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("does not auto-start OpenClaw when local chat is selected", async () => {
    const pushSystemMessage = vi.fn();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url === "/api/health") {
        return Response.json({
          agent: { type: "openclaw", status: "disconnected" },
          openclaw: "disconnected",
          nanoclaw: "disconnected",
          ollama: "connected",
          ollamaModels: ["gemma4:e4b"],
          configuredLocalModel: "gemma4",
          llmProvider: "local",
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    render(<Harness pushSystemMessage={pushSystemMessage} />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    const calledUrls = fetchMock.mock.calls.map(([input]) =>
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
    );
    expect(calledUrls).toEqual(["/api/health"]);
    expect(pushSystemMessage).not.toHaveBeenCalled();
  });
});
