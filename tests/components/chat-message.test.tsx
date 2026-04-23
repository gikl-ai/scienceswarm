// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatMessage } from "@/components/research/chat-message";

describe("ChatMessage", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders a full date and time footer for message bubbles", () => {
    const timestamp = new Date(2026, 3, 22, 16, 45, 0);
    const expectedFooter = `${timestamp.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    })} · ${timestamp.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    })}`;

    render(
      <ChatMessage
        role="assistant"
        content="Final answer"
        timestamp={timestamp}
      />,
    );

    expect(screen.getByText(expectedFooter)).toBeInTheDocument();
  });

  it("copies rendered message text instead of raw bubble directives", async () => {
    const writeText = vi.fn<(value: string) => Promise<void>>(async (_value) => {});
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    render(
      <ChatMessage
        role="assistant"
        content={"**Line one**\nMEDIA:docs/results_chart.png"}
        projectId="project-alpha"
        timestamp={new Date("2026-04-22T16:45:00.000Z")}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy message" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const copiedText = writeText.mock.calls[0]?.[0] ?? "";
    expect(copiedText).toContain("Line one");
    expect(copiedText).toContain("docs/results_chart.png");
    expect(copiedText).not.toContain("**");
    expect(copiedText).not.toContain("MEDIA:");
    expect(await screen.findByRole("button", { name: "Copied message" })).toBeInTheDocument();
  });

  it("surfaces copy failures inline when the clipboard write rejects", async () => {
    const writeText = vi.fn<(value: string) => Promise<void>>(async (_value) => {
      throw new Error("denied");
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    render(
      <ChatMessage
        role="assistant"
        content="Final answer"
        timestamp={new Date("2026-04-22T16:45:00.000Z")}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy message" }));

    expect(await screen.findByRole("button", { name: "Copy failed" })).toBeInTheDocument();
  });

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
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-20T10:00:05.000Z"));

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
    expect(progressLog).toHaveTextContent("Checking the imported files...");
    expect(progressLog).toHaveTextContent("└ Read docs/results_table.csv");
    expect(progressLog).toHaveTextContent("Search activityLog in use-unified-chat.ts");
    expect(progressLog).toHaveTextContent(/• Working \(\d+s • esc to interrupt\)/);
    expect(screen.queryByText("Thinking Trace")).not.toBeInTheDocument();
    expect(screen.queryByText("OpenClaw Activity")).not.toBeInTheDocument();
    expect(screen.queryByText("Recent activity")).not.toBeInTheDocument();
  });

  it("increments the live Working elapsed row every second under fake timers", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-20T10:00:05.000Z"));

    render(
      <ChatMessage
        role="assistant"
        content=""
        progressLog={[
          { kind: "activity", text: "Read docs/results_table.csv" },
        ]}
        timestamp={new Date("2026-04-20T10:00:00.000Z")}
        isStreaming
      />,
    );

    expect(screen.getByRole("log")).toHaveTextContent(
      "Working (5s • esc to interrupt)",
    );

    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(screen.getByRole("log")).toHaveTextContent(
      "Working (6s • esc to interrupt)",
    );
  });

  it("ticks the live Working row on the next wall-clock second boundary", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-20T10:00:05.900Z"));

    render(
      <ChatMessage
        role="assistant"
        content=""
        progressLog={[
          { kind: "activity", text: "Read docs/results_table.csv" },
        ]}
        timestamp={new Date("2026-04-20T10:00:00.000Z")}
        isStreaming
      />,
    );

    expect(screen.getByRole("log")).toHaveTextContent(
      "Working (5s • esc to interrupt)",
    );

    act(() => {
      vi.advanceTimersByTime(100);
    });

    expect(screen.getByRole("log")).toHaveTextContent(
      "Working (6s • esc to interrupt)",
    );

    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(screen.getByRole("log")).toHaveTextContent(
      "Working (7s • esc to interrupt)",
    );
  });

  it("renders streaming thinking rows as markdown in the assistant transcript", () => {
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

    const progressLog = screen.getByRole("log");
    expect(progressLog).toHaveTextContent("Moving forward with embedding");
    expect(progressLog).toHaveTextContent("I think I'll finalize by saying \"Made it\".");
    expect(progressLog).not.toHaveTextContent("**Moving forward with embedding**");
    expect(
      screen.getByText("Moving forward with embedding", { selector: "strong" }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("chat-streaming-spinner")).not.toBeInTheDocument();
  });

  it("renders inline code inside visible explored transcript rows", () => {
    render(
      <ChatMessage
        role="assistant"
        content=""
        progressLog={[
          { kind: "thinking", text: "Saving output to `docs/results_chart.png`." },
          { kind: "activity", text: "Read `docs/results_table.csv`" },
        ]}
        timestamp={new Date("2026-04-21T10:00:00.000Z")}
        isStreaming
      />,
    );

    expect(
      screen.getByText("docs/results_table.csv", { selector: "code" }),
    ).toBeInTheDocument();
    expect(screen.getByText("docs/results_chart.png", { selector: "code" })).toBeInTheDocument();
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
              "Use write: {\"path\":\"/Users/example/.scienceswarm/projects/project-alpha/scripts/generate_mouse_chasing_cat_gif.py\",\"content\":\"#!/usr/bin/env python3\"}",
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

  it("maps legacy read rows in the visible transcript to project-facing canvas paths", () => {
    render(
      <ChatMessage
        role="assistant"
        content=""
        progressLog={[
          {
            kind: "activity",
            text:
              "Use read: {\"path\":\"/Users/example/.scienceswarm/openclaw/canvas/documents/cat-svg-preview/index.html\"}",
          },
        ]}
        timestamp={new Date("2026-04-21T10:01:10.000Z")}
        isStreaming
      />,
    );

    const progressLog = screen.getByRole("log");
    expect(progressLog).toHaveTextContent("Read figures/cat-svg-preview/index.html");
    expect(progressLog).not.toHaveTextContent(".scienceswarm/openclaw/canvas/documents");
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
              "Run /usr/bin/python3 /Users/example/.scienceswarm/projects/project-alpha/scripts/generate_mouse_chasing_cat_gif.py",
          },
          { kind: "activity", text: "Run command complete" },
        ]}
        timestamp={new Date("2026-04-21T10:01:30.000Z")}
        isStreaming
      />,
    );

    const progressLog = screen.getByRole("log");
    expect(progressLog).toHaveTextContent("Run python3 scripts/generate_mouse_chasing_cat_gif.py");
    expect(progressLog).not.toHaveTextContent("/usr/bin/python3");
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
    expect(progressLog).toHaveTextContent("Planning how to inspect the chart files.");
    expect(progressLog).toHaveTextContent("Read docs/results_table.csv");
    expect(progressLog).not.toHaveTextContent("Turn started");
    expect(progressLog).not.toHaveTextContent("Tool read_file:");
    expect(progressLog).not.toHaveTextContent("Tool read_file result:");
    expect(progressLog).toHaveTextContent(/• Working \(\d+s • esc to interrupt\)/);
    expect(screen.queryByText("Thinking Trace")).not.toBeInTheDocument();
  });

  it("renders restored legacy thinking and activity after a completed assistant turn", () => {
    render(
      <ChatMessage
        role="assistant"
        content="Final answer"
        thinking="Internal **planning** that should stay visible."
        activityLog={[
          "Tool read_file: {\"path\":\"docs/results_table.csv\"}",
        ]}
        timestamp={new Date("2026-04-20T10:03:00.000Z")}
        isStreaming={false}
      />,
    );

    expect(screen.getByText("Final answer")).toBeInTheDocument();
    const progressLog = screen.getByRole("log");
    expect(progressLog).toHaveTextContent("Internal planning that should stay visible.");
    expect(progressLog).toHaveTextContent("Read docs/results_table.csv");
    expect(
      screen.getByText("planning", { selector: "strong" }),
    ).toBeInTheDocument();
  });

  it("renders a stored progress transcript after a completed assistant turn", () => {
    render(
      <ChatMessage
        role="assistant"
        content="Final answer"
        progressLog={[
          { kind: "thinking", text: "Planning how to inspect the chart files." },
          { kind: "activity", text: "Read docs/results_table.csv" },
        ]}
        timestamp={new Date("2026-04-20T10:04:00.000Z")}
        isStreaming={false}
      />,
    );

    expect(screen.getByText("Final answer")).toBeInTheDocument();
    const progressLog = screen.getByRole("log");
    expect(progressLog).toHaveTextContent("Planning how to inspect the chart files.");
    expect(progressLog).toHaveTextContent("Read docs/results_table.csv");
    expect(progressLog).not.toHaveTextContent("Working (");
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

  it("renders AVIF MEDIA references as inline image", () => {
    render(
      <ChatMessage
        role="assistant"
        content={"MEDIA:figures/diagram.avif"}
        projectId="project-alpha"
        timestamp={new Date("2026-04-21T10:00:15.000Z")}
      />,
    );

    const image = screen.getByAltText("figures/diagram.avif");
    expect(image.tagName).toBe("IMG");
    expect(image.getAttribute("src")).toContain("file=figures%2Fdiagram.avif");
  });

  it("maps absolute OpenClaw media paths to managed raw previews", () => {
    render(
      <ChatMessage
        role="assistant"
        content={
          "MEDIA:/Users/example/.scienceswarm/openclaw/media/tool-image-generation/cat-image---1234.png"
        }
        projectId="project-alpha"
        timestamp={new Date("2026-04-21T10:00:30.000Z")}
      />,
    );

    expect(
      screen.getByAltText("/Users/example/.scienceswarm/openclaw/media/tool-image-generation/cat-image---1234.png"),
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

  it("renders PDF MEDIA references as inline iframe", () => {
    const { container } = render(
      <ChatMessage
        role="assistant"
        content={"MEDIA:reports/paper.pdf"}
        projectId="project-alpha"
        timestamp={new Date("2026-04-20T10:06:00.000Z")}
      />,
    );

    const iframe = container.querySelector("iframe");
    expect(iframe).not.toBeNull();
    expect(iframe?.getAttribute("src")).toContain("file=reports%2Fpaper.pdf");
    expect(iframe?.getAttribute("sandbox")).toBe("allow-same-origin allow-downloads");
  });

  it("renders FLAC/OPUS/AAC MEDIA references as inline audio", () => {
    const { container } = render(
      <ChatMessage
        role="assistant"
        content={"MEDIA:audio/song.flac\nMEDIA:audio/clip.opus\nMEDIA:audio/voice.aac"}
        projectId="project-alpha"
        timestamp={new Date("2026-04-20T10:07:00.000Z")}
      />,
    );

    const audioElements = container.querySelectorAll("audio");
    expect(audioElements).toHaveLength(3);

    const sources = container.querySelectorAll("audio source");
    expect(sources[0]).toHaveAttribute("type", "audio/flac");
    expect(sources[1]).toHaveAttribute("type", "audio/ogg; codecs=opus");
    expect(sources[2]).toHaveAttribute("type", "audio/aac");
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

  it("routes project-local html embeds through the raw workspace preview", () => {
    render(
      <ChatMessage
        role="assistant"
        content={"[embed url=\"figures/snake-game/index.html\" title=\"Snake\" height=\"420\" /]"}
        projectId="project-alpha"
        timestamp={new Date("2026-04-20T10:12:30.000Z")}
      />,
    );

    expect(screen.getByTitle("Snake")).toHaveAttribute(
      "src",
      "/api/workspace?action=raw&file=figures%2Fsnake-game%2Findex.html&projectId=project-alpha",
    );
  });

  it("blocks markdown image urls that walk upward from the page path", () => {
    render(
      <ChatMessage
        role="assistant"
        content={"![img](../../api/chat/unified)"}
        projectId="project-alpha"
        timestamp={new Date("2026-04-20T10:12:40.000Z")}
      />,
    );

    expect(screen.queryByAltText("img")).not.toBeInTheDocument();
    expect(screen.getByText("[image: img]")).toBeInTheDocument();
  });

  it("blocks invalid embed traversal paths instead of proxying them through the workspace api", () => {
    render(
      <ChatMessage
        role="assistant"
        content={"[embed url=\"/__openclaw__/canvas/documents/snake-game/..\" title=\"Snake\" /]"}
        projectId="project-alpha"
        timestamp={new Date("2026-04-20T10:12:45.000Z")}
      />,
    );

    expect(screen.queryByTitle("Snake")).not.toBeInTheDocument();
    expect(screen.getByText("[embed blocked: invalid path]")).toBeInTheDocument();
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
});
