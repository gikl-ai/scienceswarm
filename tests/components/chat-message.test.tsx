// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ChatMessage } from "@/components/research/chat-message";

describe("ChatMessage", () => {
  it("renders assistant task phases inside the message bubble", () => {
    render(
      <ChatMessage
        role="assistant"
        content="Saved chart to results/summary-chart.svg"
        timestamp={new Date("2026-04-15T07:00:05.000Z")}
        taskPhases={[
          { id: "reading-file", label: "Reading file", status: "completed" },
          { id: "extracting-table", label: "Extracting table", status: "completed" },
          { id: "generating-chart", label: "Generating chart", status: "completed" },
          { id: "importing-result", label: "Importing result", status: "completed" },
          { id: "done", label: "Done", status: "completed" },
        ]}
      />,
    );

    expect(screen.getByLabelText("Reading file (completed)")).toBeInTheDocument();
    expect(screen.getByLabelText("Extracting table (completed)")).toBeInTheDocument();
    expect(screen.getByLabelText("Generating chart (completed)")).toBeInTheDocument();
    expect(screen.getByLabelText("Importing result (completed)")).toBeInTheDocument();
    expect(screen.getByLabelText("Done (completed)")).toBeInTheDocument();
  });

  it("renders assistant thinking traces in an expandable panel", () => {
    render(
      <ChatMessage
        role="assistant"
        content=""
        thinking={"Checking the imported files...\nCounting PDFs by manifest entry."}
        timestamp={new Date("2026-04-20T10:00:00.000Z")}
        isStreaming
      />,
    );

    expect(screen.getByText("Thinking Trace")).toBeInTheDocument();
    expect(screen.getByText(/Checking the imported files/)).toBeInTheDocument();
    expect(screen.getByText("Thinking Trace").closest("details")).toHaveAttribute("open");
  });

  it("adds explicit MIME hints for rendered media sources", () => {
    const { container } = render(
      <ChatMessage
        role="assistant"
        content={"MEDIA:clips/demo.m4v\nMEDIA:audio/demo.m4a"}
        projectId="project-alpha"
        timestamp={new Date("2026-04-20T10:05:00.000Z")}
      />,
    );

    expect(container.querySelector("video source")).toHaveAttribute("type", "video/mp4");
    expect(container.querySelector("audio source")).toHaveAttribute("type", "audio/mp4");
  });

  it("keeps saved html filename hints scoped to each embed", () => {
    render(
      <ChatMessage
        role="assistant"
        content={
          "Saved `alpha.html`\n[embed url=\"__openclaw__/canvas\" title=\"Alpha\"]\n" +
          "Saved `beta.html`\n[embed url=\"__openclaw__/canvas\" title=\"Beta\"]"
        }
        projectId="project-alpha"
        timestamp={new Date("2026-04-20T10:10:00.000Z")}
      />,
    );

    expect(screen.getByTitle("Alpha")).toHaveAttribute(
      "src",
      "/api/workspace?action=raw&file=alpha.html&projectId=project-alpha",
    );
    expect(screen.getByTitle("Beta")).toHaveAttribute(
      "src",
      "/api/workspace?action=raw&file=beta.html&projectId=project-alpha",
    );
  });
});
