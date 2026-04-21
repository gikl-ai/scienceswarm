// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RadarBriefingView } from "@/components/radar/radar-briefing-view";

describe("RadarBriefingView", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/radar/briefing" && method === "GET") {
        return Response.json(null);
      }

      throw new Error(`Unhandled fetch: ${method} ${url}`);
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows the empty state when the API returns 200 null", async () => {
    render(<RadarBriefingView />);

    await waitFor(() => {
      expect(screen.queryByText("Loading briefing...")).not.toBeInTheDocument();
    });

    expect(
      screen.getByText(/No briefing yet\. Hit "Generate now" to create your first radar briefing\./i),
    ).toBeInTheDocument();
  });
});
