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

  it("renders assistant progress as a single inline transcript", () => {
    render(
      <ChatMessage
        role="assistant"
        content=""
        progressLog={[
          { kind: "thinking", text: "Checking the imported files..." },
          { kind: "activity", text: "Read docs/results_table.csv" },
          { kind: "activity", text: "Search activityLog in use-unified-chat.ts" },
        ]}
        timestamp={new Date("2026-04-20T10:00:00.000Z")}
        isStreaming
      />,
    );

    const progressLog = screen.getByRole("log");
    expect(screen.getByText("• Explored")).toBeInTheDocument();
    expect(progressLog).toHaveTextContent("• Checking the imported files...");
    expect(screen.getByText(/└ Read docs\/results_table\.csv/)).toBeInTheDocument();
    expect(screen.getByText(/Search activityLog in use-unified-chat\.ts/)).toBeInTheDocument();
    expect(progressLog).toHaveTextContent(/• Working \(\d+s • esc to interrupt\)/);
    expect(screen.queryByText("Thinking Trace")).not.toBeInTheDocument();
    expect(screen.queryByText("OpenClaw Activity")).not.toBeInTheDocument();
    expect(screen.queryByText("Recent activity")).not.toBeInTheDocument();
  });

  it("renders markdown bold inside progress transcript rows", () => {
    render(
      <ChatMessage
        role="assistant"
        content=""
        progressLog={[
          { kind: "thinking", text: "**Moving forward with embedding**" },
          { kind: "thinking", text: "I think I'll finalize by saying \"Made it\"." },
        ]}
        timestamp={new Date("2026-04-21T10:00:00.000Z")}
        isStreaming
      />,
    );

    expect(
      screen.getByText("Moving forward with embedding", { selector: "strong" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/\*\*Moving forward with embedding\*\*/)).not.toBeInTheDocument();
    expect(screen.getByText(/I think I'll finalize by saying "Made it"\./)).toBeInTheDocument();
  });

  it("normalizes legacy raw tool JSON lines in the visible transcript", () => {
    render(
      <ChatMessage
        role="assistant"
        content=""
        progressLog={[
          {
            kind: "activity",
            text:
              "Use write: {\"path\":\"/Users/vajdap/.scienceswarm/projects/project-alpha/scripts/generate_mouse_chasing_cat_gif.py\",\"content\":\"#!/usr/bin/env python3\"}",
          },
          { kind: "activity", text: "Use write complete" },
        ]}
        timestamp={new Date("2026-04-21T10:01:00.000Z")}
        isStreaming
      />,
    );

    const progressLog = screen.getByRole("log");
    expect(progressLog).toHaveTextContent("Write scripts/generate_mouse_chasing_cat_gif.py");
    expect(progressLog).not.toHaveTextContent("\"content\":\"#!/usr/bin/env python3\"");
    expect(progressLog).not.toHaveTextContent("Use write complete");
  });

  it("normalizes legacy command rows in the visible transcript", () => {
    render(
      <ChatMessage
        role="assistant"
        content=""
        progressLog={[
          {
            kind: "activity",
            text:
              "Run /usr/local/Caskroom/miniforge/base/bin/python3 /Users/vajdap/.scienceswarm/projects/project-alpha/scripts/generate_mouse_chasing_cat_gif.py",
          },
          { kind: "activity", text: "Run command complete" },
        ]}
        timestamp={new Date("2026-04-21T10:01:30.000Z")}
        isStreaming
      />,
    );

    const progressLog = screen.getByRole("log");
    expect(progressLog).toHaveTextContent("Run python3 scripts/generate_mouse_chasing_cat_gif.py");
    expect(progressLog).not.toHaveTextContent("/usr/local/Caskroom/miniforge/base/bin/python3");
    expect(progressLog).not.toHaveTextContent("Run command complete");
  });

  it("falls back to legacy thinking and activity fields when progressLog is absent", () => {
    render(
      <ChatMessage
        role="assistant"
        content="Final answer"
        thinking="Planning how to inspect the chart files."
        activityLog={[
          "Turn started",
          "Tool read_file: {\"path\":\"docs/results_table.csv\"}",
          "Tool read_file result: Loaded 42 rows",
        ]}
        timestamp={new Date("2026-04-20T10:02:00.000Z")}
        isStreaming
      />,
    );

    const progressLog = screen.getByRole("log");
    expect(progressLog).toHaveTextContent("• Planning how to inspect the chart files.");
    expect(progressLog).toHaveTextContent("Read docs/results_table.csv");
    expect(progressLog).not.toHaveTextContent("Turn started");
    expect(progressLog).not.toHaveTextContent("Tool read_file:");
    expect(progressLog).not.toHaveTextContent("Tool read_file result:");
    expect(progressLog).toHaveTextContent(/• Working \(\d+s • esc to interrupt\)/);
    expect(screen.queryByText("Thinking Trace")).not.toBeInTheDocument();
  });

  it("renders workspace media hints as chat media", () => {
    render(
      <ChatMessage
        role="assistant"
        content={"Done.\n\nMEDIA:docs/results_chart.png"}
        projectId="project-alpha"
        timestamp={new Date("2026-04-21T10:00:00.000Z")}
      />,
    );

    expect(screen.getByAltText("docs/results_chart.png")).toHaveAttribute(
      "src",
      "/api/workspace?action=raw&file=docs%2Fresults_chart.png&projectId=project-alpha",
    );
  });

  it("maps absolute OpenClaw media paths to managed raw previews", () => {
    render(
      <ChatMessage
        role="assistant"
        content={
          "MEDIA:/Users/vajdap/.scienceswarm/openclaw/media/tool-image-generation/cat-image---1234.png"
        }
        projectId="project-alpha"
        timestamp={new Date("2026-04-21T10:00:30.000Z")}
      />,
    );

    expect(
      screen.getByAltText("/Users/vajdap/.scienceswarm/openclaw/media/tool-image-generation/cat-image---1234.png"),
    ).toHaveAttribute(
      "src",
      "/api/workspace?action=raw&file=__openclaw__%2Fmedia%2Ftool-image-generation%2Fcat-image---1234.png&projectId=project-alpha",
    );
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

  it("preserves explicit canvas document paths inside the project workspace", () => {
    render(
      <ChatMessage
        role="assistant"
        content={
          "[embed url=\"/__openclaw__/canvas/documents/cat-svg-preview/index.html\" title=\"Cat SVG\" height=\"420\" /]"
        }
        projectId="project-alpha"
        timestamp={new Date("2026-04-20T10:12:00.000Z")}
      />,
    );

    expect(screen.getByTitle("Cat SVG")).toHaveAttribute(
      "src",
      "/api/workspace?action=raw&file=__openclaw__%2Fcanvas%2Fdocuments%2Fcat-svg-preview%2Findex.html&projectId=project-alpha",
    );
    expect(screen.queryByText(/\[embed url=.*Cat SVG.*\]/)).not.toBeInTheDocument();
  });

  it("reuses the latest saved html filename across intervening text", () => {
    render(
      <ChatMessage
        role="assistant"
        content={
          "Saved `alpha.html`\n[embed url=\"__openclaw__/canvas\" title=\"Alpha\"]\n" +
          "Use the chart above as context before opening the follow-up embed.\n" +
          "[embed url=\"__openclaw__/canvas\" title=\"Alpha Again\"]"
        }
        projectId="project-alpha"
        timestamp={new Date("2026-04-20T10:15:00.000Z")}
      />,
    );

    expect(screen.getByTitle("Alpha Again")).toHaveAttribute(
      "src",
      "/api/workspace?action=raw&file=alpha.html&projectId=project-alpha",
    );
  });

  it("suppresses the generic spinner when a live activity log is present", () => {
    render(
      <ChatMessage
        role="assistant"
        content=""
        activityLog={["Turn started"]}
        timestamp={new Date("2026-04-20T10:16:00.000Z")}
        isStreaming
      />,
    );

    expect(screen.queryByTestId("chat-streaming-spinner")).not.toBeInTheDocument();
  });
});
