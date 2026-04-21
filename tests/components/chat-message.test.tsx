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
});
