// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DreamCycleCard } from "@/components/research/dream-cycle-card";

describe("DreamCycleCard", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders the overnight headline and can trigger a manual full run", async () => {
    const onCycleComplete = vi.fn();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/brain/dream" && method === "POST") {
        return Response.json({ pagesCompiled: 2 });
      }
      if (url === "/api/brain/dream") {
        return Response.json({
          lastRun: {
            timestamp: "2026-04-18T08:30:00.000Z",
            mode: "full",
            pages_compiled: 2,
            contradictions_found: 1,
            backlinks_added: 4,
            duration_ms: 1234,
            partial: false,
            headline: {
              generatedAt: "2026-04-18T08:30:00.000Z",
              headline:
                "While you slept: 3 new papers 1 contradiction with your current beliefs 1 stale work item 4 new cross-references.",
              newSignals: 5,
              newPapers: 3,
              topicsRecompiled: 2,
              contradictionsFound: 1,
              staleExperiments: 1,
              crossReferencesAdded: 4,
              compiledTopics: [
                {
                  slug: "concepts/rlhf-alignment",
                  title: "RLHF alignment",
                  compiledTruthPreview: "RLHF is now treated as contested.",
                },
                {
                  slug: "concepts/deception-evals",
                  title: "Deception evals",
                  compiledTruthPreview: "New eval evidence landed overnight.",
                },
                {
                  slug: "concepts/reward-model-drift",
                  title: "Reward model drift",
                  compiledTruthPreview: "Drift now has a contradiction to review.",
                },
              ],
              signals: [
                {
                  slug: "papers/new-rlhf-paper",
                  title: "New RLHF paper",
                  sourceKind: "paper",
                  observedAt: "2026-04-18T08:00:00.000Z",
                },
              ],
              staleExperimentDetails: [
                {
                  slug: "experiments/stale-assay",
                  title: "Stale assay",
                  lastObservedAt: "2026-03-01T00:00:00.000Z",
                  reason: "No experiment timeline update for 48 days.",
                },
              ],
            },
          },
        });
      }
      if (url === "/api/brain/dream-schedule") {
        return Response.json({
          enabled: true,
          schedule: "0 3 * * *",
          mode: "full",
          nextRun: "2026-04-19T03:00:00.000Z",
        });
      }
      return Response.json({});
    });
    vi.stubGlobal("fetch", fetchMock);
    const onNavigateBrainPage = vi.fn();

    render(
      <DreamCycleCard
        enabled
        projectBrief={{
          nextMove: { recommendation: "Review the new RLHF paper." },
          dueTasks: [{ path: "tasks/review.md", title: "Review notes", status: "open" }],
          frontier: [],
        }}
        onCycleComplete={onCycleComplete}
        onNavigateBrainPage={onNavigateBrainPage}
      />,
    );

    expect(await screen.findByText(/While you slept: 3 new papers/)).toBeInTheDocument();
    const compiledTruthColumn = screen.getByText("Compiled Truth").closest("div");
    expect(compiledTruthColumn).not.toBeNull();
    expect(compiledTruthColumn).toHaveClass("min-w-0");
    expect(within(compiledTruthColumn!).getByText("RLHF alignment")).toBeInTheDocument();
    expect(within(compiledTruthColumn!).getByText("Reward model drift")).toBeInTheDocument();
    expect(screen.getByText("Review the new RLHF paper.")).toBeInTheDocument();
    const rewardModelButton = screen.getByRole("button", { name: /Reward model drift/i });
    expect(rewardModelButton).toHaveClass("min-w-0");
    fireEvent.click(rewardModelButton);
    expect(onNavigateBrainPage).toHaveBeenCalledWith("concepts/reward-model-drift");
    fireEvent.click(screen.getByRole("button", { name: /New RLHF paper/i }));
    expect(onNavigateBrainPage).toHaveBeenCalledWith("papers/new-rlhf-paper");
    expect(screen.getByText("Review notes")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Review notes/i })).not.toBeInTheDocument();
    expect(onNavigateBrainPage).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("button", { name: /run now/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/brain/dream",
        expect.objectContaining({ method: "POST" }),
      );
      expect(onCycleComplete).toHaveBeenCalledTimes(1);
    });
  });

  it("only turns project brief brain paths into navigable links", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url === "/api/brain/dream") {
        return Response.json({
          lastRun: {
            timestamp: "2026-04-18T08:30:00.000Z",
            mode: "full",
            pages_compiled: 0,
            contradictions_found: 0,
            backlinks_added: 0,
            duration_ms: 50,
            partial: false,
          },
        });
      }
      if (url === "/api/brain/dream-schedule") {
        return Response.json({
          enabled: true,
          schedule: "0 3 * * *",
          mode: "full",
          nextRun: "2026-04-19T03:00:00.000Z",
        });
      }
      return Response.json({});
    });
    vi.stubGlobal("fetch", fetchMock);
    const onNavigateBrainPage = vi.fn();

    const { rerender } = render(
      <DreamCycleCard
        enabled
        projectBrief={{
          dueTasks: [{ path: "wiki/tasks/review.md", title: "Review notes", status: "open" }],
          frontier: [
            {
              path: "gbrain:frontier/capsule.mdx",
              title: "Frontier note",
              status: "open",
              whyItMatters: "Worth reading.",
            },
          ],
        }}
        onNavigateBrainPage={onNavigateBrainPage}
      />,
    );

    expect(await screen.findByText("Review notes")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Review notes/i })).not.toBeInTheDocument();
    expect(screen.getByText("Frontier note")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Frontier note/i })).not.toBeInTheDocument();

    rerender(
      <DreamCycleCard
        enabled
        projectBrief={{
          dueTasks: [{ path: "gbrain:/wiki/tasks/review.md", title: "Wiki review notes", status: "open" }],
          frontier: [
            {
              path: "gbrain:/wiki/frontier/capsule.mdx",
              title: "Brain frontier note",
              status: "open",
              whyItMatters: "Worth reading.",
            },
          ],
        }}
        onNavigateBrainPage={onNavigateBrainPage}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: /Wiki review notes/i }));
    expect(onNavigateBrainPage).toHaveBeenCalledWith("wiki/tasks/review");
    fireEvent.click(screen.getByRole("button", { name: /Brain frontier note/i }));
    expect(onNavigateBrainPage).toHaveBeenCalledWith("wiki/frontier/capsule");
  });

  it("shows recoverable failure guidance and keeps the retry path visible", async () => {
    const onCycleComplete = vi.fn();
    let postAttempts = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/brain/dream" && method === "POST") {
        postAttempts += 1;
        if (postAttempts === 1) {
          return Response.json(
            {
              error: "Dream Cycle could not complete.",
              code: "dream_cycle_local_model_unavailable",
              cause:
                "The configured local model service did not complete the synthesis request.",
              nextAction:
                "Start Ollama or restore the configured local model, then click Retry Dream Cycle. Existing research material is retained.",
            },
            { status: 503 },
          );
        }
        return Response.json({ pagesCompiled: 1 });
      }
      if (url === "/api/brain/dream") {
        return Response.json({
          lastRun: postAttempts >= 2
            ? {
                timestamp: "2026-04-18T08:30:00.000Z",
                mode: "full",
                pages_compiled: 1,
                contradictions_found: 0,
                backlinks_added: 2,
                duration_ms: 1234,
                partial: false,
                headline: {
                  generatedAt: "2026-04-18T08:30:00.000Z",
                  headline: "While you slept: recovered run complete.",
                  newSignals: 1,
                  newPapers: 0,
                  topicsRecompiled: 1,
                  contradictionsFound: 0,
                  staleExperiments: 0,
                  crossReferencesAdded: 2,
                  compiledTopics: [],
                  signals: [],
                  staleExperimentDetails: [],
                },
              }
            : null,
        });
      }
      if (url === "/api/brain/dream-schedule") {
        return Response.json({
          enabled: true,
          schedule: "0 3 * * *",
          mode: "full",
          nextRun: "2026-04-19T03:00:00.000Z",
        });
      }
      return Response.json({});
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <DreamCycleCard
        enabled
        projectBrief={null}
        onCycleComplete={onCycleComplete}
      />,
    );

    expect(await screen.findByText("No overnight run yet.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /run now/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Dream Cycle could not complete.",
    );
    expect(screen.getByText(/configured local model service/i)).toBeInTheDocument();
    expect(screen.getByText(/Existing research material is retained/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /retry dream cycle/i }));

    await waitFor(() => {
      expect(onCycleComplete).toHaveBeenCalledTimes(1);
      expect(postAttempts).toBe(2);
    });
    expect(await screen.findByText("While you slept: recovered run complete.")).toBeInTheDocument();
  });

  it("keeps the last failed run recoverable after the page reloads", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "/api/brain/dream") {
        return Response.json({
          lastRun: {
            timestamp: "2026-04-18T08:30:00.000Z",
            mode: "full",
            pages_compiled: 0,
            contradictions_found: 0,
            backlinks_added: 0,
            duration_ms: 321,
            partial: true,
            errors: ["The local brain store did not complete the synthesis request."],
            reason:
              "Close duplicate ScienceSwarm processes or restart ScienceSwarm to restore the local brain store, then click Retry Dream Cycle. Existing research material is retained.",
          },
        });
      }
      if (url === "/api/brain/dream-schedule") {
        return Response.json({
          enabled: true,
          schedule: "0 3 * * *",
          mode: "full",
          nextRun: "2026-04-19T03:00:00.000Z",
        });
      }
      return Response.json({});
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <DreamCycleCard
        enabled
        projectBrief={null}
      />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Dream Cycle could not complete.",
    );
    expect(screen.getAllByText(/local brain store/i).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /retry dream cycle/i })).toBeInTheDocument();
  });
});
