// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

  it("shows program-match context and visible feedback acknowledgement", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/radar/briefing" && method === "GET") {
        return Response.json({
          id: "b1",
          generatedAt: "2026-04-10T08:00:00Z",
          nothingToday: false,
          matters: [
            {
              signalId: "s1",
              title: "MEK combination reverses EGFR resistance",
              url: "https://example.test/mek",
              whyItMatters: "Challenges the current single-agent EGFR plan.",
              relevanceScore: 0.92,
              matchedTopics: ["EGFR resistance program"],
              source: "semantic-scholar",
              actions: ["save-to-brain", "dismiss", "more-like-this"],
              programMatches: [
                {
                  area: "experiment",
                  reference:
                    "EGFR resistance program: Choosing whether to add a MEK arm",
                  whyThisMatters:
                    "Affects EGFR resistance because the source reports a rescue combination.",
                  recommendedAction:
                    "Compare the next planned experiment against this signal.",
                  evidence: ["matched topic: EGFR resistance program"],
                  confidence: "high",
                },
              ],
            },
          ],
          horizon: [],
          stats: { signalsFetched: 1, signalsRanked: 1, sourcesQueried: 1, sourcesFailed: [] },
        });
      }

      if (url === "/api/radar/feedback" && method === "POST") {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          briefingId: "b1",
          signalId: "s1",
          action: "save-to-brain",
        });
        return Response.json({
          ok: true,
          message:
            "Saved this frontier match to brain memory at wiki/entities/frontier/mek.md.",
          savedPath: "wiki/entities/frontier/mek.md",
        });
      }

      throw new Error(`Unhandled fetch: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<RadarBriefingView />);

    expect(
      await screen.findByText("Why this changes your program")
    ).toBeInTheDocument();
    expect(screen.getByText(/Choosing whether to add a MEK arm/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Save to brain/i }));

    expect(
      await screen.findByText(/Saved this frontier match to brain memory/i)
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Open saved brain note/i })).toHaveAttribute(
      "href",
      "/dashboard/gbrain?brain_slug=wiki%2Fentities%2Ffrontier%2Fmek"
    );
  });
});
