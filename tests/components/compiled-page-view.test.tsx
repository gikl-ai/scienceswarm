// @vitest-environment jsdom

import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CompiledPageView } from "@/components/research/compiled-page-view";

describe("CompiledPageView", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("renders compiled truth, timeline, typed backlinks, and contradiction badge", () => {
    const onNavigate = vi.fn();
    render(
      <CompiledPageView
        onNavigate={onNavigate}
        page={{
          path: "concepts/rlhf-alignment.md",
          title: "RLHF alignment",
          type: "concept",
          compiled_truth:
            "RLHF remains central, but new evidence contests reward-model optimization.",
          timeline: [
            {
              date: "2026-04-18",
              source: "papers/deceptive-rlhf",
              summary: "Compiled truth updated from Deceptive RLHF",
              detail: "1 contradiction surfaced.",
            },
          ],
          links: [
            {
              slug: "papers/deceptive-rlhf.md",
              kind: "contradicts",
              title: "Deceptive RLHF",
            },
          ],
          backlinks: [
            {
              slug: "papers/survey.md",
              kind: "cites",
              title: "Alignment Survey",
            },
          ],
        }}
      />,
    );

    const viewRoot = screen.getByText("RLHF alignment").closest("main")?.parentElement;
    expect(viewRoot).toHaveClass(
      "overflow-y-auto",
      "md:grid",
    );
    expect(screen.getByText("RLHF alignment")).toBeInTheDocument();
    expect(screen.getByText(/new evidence contests/)).toBeInTheDocument();
    expect(screen.getByText("1 contradiction")).toBeInTheDocument();
    expect(screen.getByText("Compiled truth updated from Deceptive RLHF")).toBeInTheDocument();
    expect(screen.getByText("contradicts")).toBeInTheDocument();
    expect(screen.getByText("cites")).toBeInTheDocument();

    fireEvent.click(within(screen.getByText("Deceptive RLHF").closest("button")!).getByText("Deceptive RLHF"));
    expect(onNavigate).toHaveBeenCalledWith("papers/deceptive-rlhf.md");
  });

  it("shows empty-state copy when a concept has no compiled truth or timeline", () => {
    render(
      <CompiledPageView
        page={{
          path: "concepts/new-topic.md",
          title: "New topic",
          type: "concept",
          compiled_truth: "",
          timeline: [],
          links: [],
          backlinks: [],
        }}
      />,
    );

    expect(screen.getByText("Not yet synthesized. Timeline below.")).toBeInTheDocument();
    expect(screen.getAllByText("Not yet observed")).toHaveLength(2);
    expect(screen.getAllByText("No typed links yet.")).toHaveLength(2);
  });

  it("collapses metadata when the resize handle is dragged to the right and restores it from the edge tab", () => {
    render(
      <CompiledPageView
        page={{
          path: "concepts/rlhf-alignment.md",
          title: "RLHF alignment",
          type: "concept",
          compiled_truth: "RLHF remains central.",
          timeline: [],
          links: [
            {
              slug: "papers/deceptive-rlhf.md",
              kind: "contradicts",
              title: "Deceptive RLHF",
            },
          ],
          backlinks: [
            {
              slug: "papers/survey.md",
              kind: "cites",
              title: "Alignment Survey",
            },
          ],
        }}
      />,
    );

    expect(screen.getByRole("heading", { name: "Links" })).toBeInTheDocument();

    const separator = screen.getByRole("separator", {
      name: "Resize links and backlinks metadata",
    });
    vi.spyOn(separator.parentElement!, "getBoundingClientRect").mockReturnValue({
      bottom: 640,
      height: 640,
      left: 0,
      right: 1000,
      top: 0,
      width: 1000,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);

    fireEvent.pointerDown(separator, { clientX: 720 });
    expect(document.body).toHaveClass("scienceswarm-resizing");
    fireEvent.pointerMove(document, { clientX: 980 });
    fireEvent.pointerUp(document);
    expect(document.body).not.toHaveClass("scienceswarm-resizing");

    expect(screen.queryByRole("heading", { name: "Links" })).not.toBeInTheDocument();

    const restoreButton = screen.getByRole("button", {
      name: "Show links and backlinks metadata",
    });
    expect(restoreButton).toHaveTextContent("2");

    fireEvent.click(restoreButton);
    expect(screen.getByRole("heading", { name: "Links" })).toBeInTheDocument();
  });
});
