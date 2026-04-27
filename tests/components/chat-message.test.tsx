// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

  it("renders assistant turns without the legacy card bubble chrome", () => {
    render(
      <ChatMessage
        role="assistant"
        content="Final answer"
        timestamp={new Date("2026-04-22T16:45:00.000Z")}
      />,
    );

    expect(screen.getByTestId("chat-bubble")).not.toHaveClass("rounded-xl");
    expect(screen.getByTestId("chat-bubble")).not.toHaveClass("border-2");
    expect(screen.getByTestId("chat-bubble")).not.toHaveClass("bg-white");
  });

  it("centers assistant turns on the narrower reading lane", () => {
    render(
      <ChatMessage
        role="assistant"
        content="Final answer"
        timestamp={new Date("2026-04-22T16:45:00.000Z")}
      />,
    );

    expect(screen.getByTestId("chat-bubble").parentElement).toHaveClass("justify-center");
    expect(screen.getByTestId("chat-bubble")).toHaveClass("max-w-[min(90vw,56rem)]");
    expect(screen.getByTestId("assistant-reply-surface")).toHaveClass("max-w-[48rem]");
  });

  it("renders assistant copy on a document-width inner surface", () => {
    render(
      <ChatMessage
        role="assistant"
        content="Final answer"
        timestamp={new Date("2026-04-22T16:45:00.000Z")}
      />,
    );

    expect(screen.getByTestId("assistant-reply-surface")).toHaveClass("mx-auto");
    expect(screen.getByTestId("assistant-reply-content")).toHaveClass("text-strong");
  });

  it("renders assistant markdown headings and lists with stronger transcript hierarchy", () => {
    render(
      <ChatMessage
        role="assistant"
        content={"# Research update\n\n## Next steps\n\n- Validate the chart\n- Publish the summary"}
        timestamp={new Date("2026-04-22T16:45:00.000Z")}
      />,
    );

    expect(screen.getByRole("heading", { level: 1, name: "Research update" })).toHaveClass("text-[2.25rem]");
    expect(screen.getByRole("heading", { level: 1, name: "Research update" })).toHaveClass("mb-6");
    expect(screen.getByRole("heading", { level: 2, name: "Next steps" })).toHaveClass("mt-10");
    expect(screen.getByRole("heading", { level: 2, name: "Next steps" })).toHaveClass("text-[1.7rem]");
    expect(screen.getByRole("list")).toHaveClass("list-disc");
    expect(screen.getByRole("list")).toHaveClass("pl-6");
    expect(screen.getByRole("list")).toHaveClass("space-y-2.5");
    expect(screen.getByText("Validate the chart").closest("li")).toHaveClass("pl-2");
  });

  it("renders assistant markdown tables on a styled reading surface", () => {
    render(
      <ChatMessage
        role="assistant"
        content={
          "| Metric | Value |\n" +
          "| --- | --- |\n" +
          "| First chunk | 58 ms |\n" +
          "| Total | 6677 ms |"
        }
        timestamp={new Date("2026-04-22T16:45:00.000Z")}
      />,
    );

    const table = screen.getByRole("table");
    expect(table.parentElement).toHaveClass("rounded-[1.35rem]");
    expect(table.parentElement).toHaveClass("border-rule");
    expect(table).toHaveClass("min-w-full");
    expect(screen.getByRole("columnheader", { name: "Metric" })).toHaveClass("uppercase");
    expect(screen.getByRole("columnheader", { name: "Metric" })).toHaveClass("px-4");
    expect(screen.getByRole("cell", { name: "58 ms" })).toHaveClass("px-4");
    expect(screen.getByRole("cell", { name: "6677 ms" }).closest("tr")).toHaveClass("even:bg-sunk/35");
  });

  it("preserves GFM table alignment and header scope attributes", () => {
    render(
      <ChatMessage
        role="assistant"
        content={
          "| Left | Right |\n" +
          "| :-- | --: |\n" +
          "| A | 42 |\n"
        }
        timestamp={new Date("2026-04-22T16:45:00.000Z")}
      />,
    );

    expect(screen.getByRole("columnheader", { name: "Left" })).toHaveAttribute("scope", "col");
    expect(screen.getByRole("columnheader", { name: "Left" })).toHaveStyle({ textAlign: "left" });
    expect(screen.getByRole("columnheader", { name: "Right" })).toHaveStyle({ textAlign: "right" });
    expect(screen.getByRole("cell", { name: "42" })).toHaveStyle({ textAlign: "right" });
  });

  it("renders assistant markdown task lists with styled checkboxes", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { container } = render(
        <ChatMessage
          role="assistant"
          content={"- [x] Validate the chart\n- [ ] Publish the summary"}
          timestamp={new Date("2026-04-22T16:45:00.000Z")}
        />,
      );

      const checkboxes = Array.from(
        container.querySelectorAll('[data-testid="assistant-reply-content"] input[type="checkbox"]'),
      );
      expect(checkboxes).toHaveLength(2);
      expect(checkboxes[0]).toBeChecked();
      expect(checkboxes[0]).toHaveClass("h-4");
      expect(checkboxes[0]).toHaveClass("accent-accent");
      expect(checkboxes[0].closest("li")).toHaveClass("task-list-item");
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("uses softer caption and metadata typography for assistant media and footer", () => {
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
        content={"MEDIA:docs/results_chart.png"}
        projectId="project-alpha"
        timestamp={timestamp}
      />,
    );

    expect(screen.getByAltText("docs/results_chart.png")).toHaveClass("rounded-[1rem]");
    expect(screen.getByAltText("docs/results_chart.png").closest("figure")).toHaveClass(
      "shadow-[0_16px_36px_-24px_rgba(15,23,42,0.4)]",
    );
    expect(screen.getByText("docs/results_chart.png")).toHaveClass("text-[11px]");
    expect(screen.getByText(expectedFooter)).toHaveClass("text-[9px]");
    expect(screen.getByText(expectedFooter)).toHaveClass("border-rule/60");
    expect(screen.getByTestId("assistant-reply-surface")).toHaveClass("group/assistant");
    expect(screen.getByTestId("assistant-metadata-bar")).toHaveClass("border-rule/70");
    expect(screen.getByRole("button", { name: "Copy message" })).toHaveClass("h-6");
    expect(screen.getByRole("button", { name: "Copy message" })).not.toHaveClass("opacity-0");
  });

  it("keeps system-message copy actions visible without assistant hover chrome", () => {
    render(
      <ChatMessage
        role="system"
        content="System note"
        timestamp={new Date("2026-04-22T16:45:00.000Z")}
      />,
    );

    const copyButton = screen.getByRole("button", { name: "Copy message" });
    expect(copyButton).not.toHaveClass("opacity-0");
    expect(copyButton).toHaveClass("text-muted/65");
  });

  it("adds section spacing and stronger code block separation in assistant markdown", () => {
    render(
      <ChatMessage
        role="assistant"
        content={
          "Paragraph lead.\n\n" +
          "#### Detailed checklist\n\n" +
          "1. Outline the experiment\n   - Collect the baseline samples\n\n" +
          "> Keep the calibration notebook nearby.\n\n" +
          "```ts\nconst total = 2;\n```"
        }
        timestamp={new Date("2026-04-22T16:45:00.000Z")}
      />,
    );

    expect(screen.getByText("Paragraph lead.")).toHaveClass("mb-5");
    expect(screen.getByRole("heading", { level: 4, name: "Detailed checklist" })).toHaveClass("mt-6");
    expect(screen.getByRole("heading", { level: 4, name: "Detailed checklist" })).toHaveClass("text-[1rem]");
    expect(screen.getAllByRole("list")).toHaveLength(2);
    expect(screen.getAllByRole("list")[0]).toHaveClass("pl-6");
    expect(screen.getAllByRole("list")[0]).toHaveClass("space-y-2.5");
    expect(screen.getByText("Keep the calibration notebook nearby.").closest("blockquote")).toHaveClass("my-6");
    expect(screen.getByText("const total = 2;").closest("pre")).toHaveClass("my-6");
    expect(screen.getByText("const total = 2;").closest("pre")).toHaveClass("rounded-3xl");
    expect(screen.getByText("const total = 2;").closest("pre")).toHaveClass("px-5");
  });

  it("renders markdown section dividers with the assistant reading rhythm", () => {
    const { container } = render(
      <ChatMessage
        role="assistant"
        content={"## Findings\n\n- First result\n\n---\n\n## Next step\n\nFollow up on the benchmark."}
        timestamp={new Date("2026-04-22T16:45:00.000Z")}
      />,
    );

    const divider = container.querySelector("hr");
    expect(divider).toBeTruthy();
    expect(divider).toHaveClass("my-8");
    expect(divider).toHaveClass("border-t");
    expect(screen.getByRole("heading", { level: 2, name: "Next step" })).toHaveClass("mt-10");
  });

  it("keeps language-less fenced code blocks on the block-code surface", () => {
    render(
      <ChatMessage
        role="assistant"
        content={"```\nready()\n```"}
        timestamp={new Date("2026-04-22T16:45:00.000Z")}
      />,
    );

    expect(screen.getByText("ready()").closest("pre")).toHaveClass("bg-ink");
    expect(screen.getByText("ready()").closest("pre")).toHaveClass("py-4");
  });

  it("renders safe markdown links and suppresses unsafe html and relative links", () => {
    render(
      <ChatMessage
        role="assistant"
        content={
          "[Guide](https://example.com/guide)\n\n" +
          "[Protocol Relative](//attacker.com)\n\n" +
          "[Unsafe](../api/chat/unified)\n\n" +
          "<button>Do not render</button>"
        }
        timestamp={new Date("2026-04-22T16:45:00.000Z")}
      />,
    );

    expect(screen.getByRole("link", { name: "Guide" })).toHaveAttribute("href", "https://example.com/guide");
    expect(screen.getByRole("link", { name: "Guide" })).toHaveAttribute("target", "_blank");
    expect(screen.queryByRole("link", { name: "Protocol Relative" })).not.toBeInTheDocument();
    expect(screen.getByText("Protocol Relative")).toHaveClass("text-quiet");
    expect(screen.queryByRole("link", { name: "Unsafe" })).not.toBeInTheDocument();
    expect(screen.getByText("Unsafe")).toHaveClass("text-quiet");
    expect(screen.queryByRole("button", { name: "Do not render" })).not.toBeInTheDocument();
  });

  it("applies restrained semantic colors to headings, links, callouts, and code surfaces", () => {
    render(
      <ChatMessage
        role="assistant"
        content={
          "## Findings\n\n" +
          "### Risks\n\n" +
          "> Watch the local gateway logs.\n\n" +
          "[Docs](https://example.com/docs)\n\n" +
          "```ts\nconst ready = true;\n```"
        }
        timestamp={new Date("2026-04-22T16:45:00.000Z")}
      />,
    );

    expect(screen.getByRole("heading", { level: 2, name: "Findings" })).toHaveClass("text-strong");
    expect(screen.getByRole("heading", { level: 3, name: "Risks" })).toHaveClass("text-strong");
    expect(screen.getByRole("link", { name: "Docs" })).toHaveClass("text-accent");
    expect(screen.getByText("Watch the local gateway logs.").closest("blockquote")).toHaveClass("bg-sunk/75");
    expect(screen.getByText("const ready = true;").closest("pre")).toHaveClass("border-rule");
  });

  it("adds calmer section rhythm between assistant headings, lists, and galleries", () => {
    render(
      <ChatMessage
        role="assistant"
        content={
          "# Experiment summary\n\n" +
          "Intro paragraph.\n\n" +
          "## Follow-up\n\n" +
          "- Review the run log\n\n" +
          "MEDIA:docs/chart-a.png\n" +
          "MEDIA:docs/chart-b.png"
        }
        projectId="project-alpha"
        timestamp={new Date("2026-04-22T16:45:00.000Z")}
      />,
    );

    expect(screen.getByRole("heading", { level: 1, name: "Experiment summary" })).toHaveClass("mb-6");
    expect(screen.getByRole("heading", { level: 2, name: "Follow-up" })).toHaveClass("mt-10");
    expect(screen.getByRole("heading", { level: 2, name: "Follow-up" })).toHaveClass("first:mt-0");
    expect(screen.getByRole("list")).toHaveClass("mb-5");
    expect(screen.getByTestId("assistant-media-gallery")).toHaveClass("my-6");
  });

  it("renders user turns as a subtle accent-tinted bubble", () => {
    render(
      <ChatMessage
        role="user"
        content="Hi"
        timestamp={new Date("2026-04-22T16:45:00.000Z")}
      />,
    );

    const bubble = screen.getByTestId("chat-bubble");
    expect(bubble).toHaveClass("rounded-xl");
    expect(bubble).toHaveClass("bg-accent/10");
    expect(bubble).toHaveClass("text-accent");
    expect(bubble).toHaveClass("border-accent/30");
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

  it("hides separate phase and step chrome when an assistant transcript is already visible", () => {
    render(
      <ChatMessage
        role="assistant"
        content=""
        progressLog={[
          { kind: "thinking", text: "Planning the next change" },
          { kind: "activity", text: "Read src/components/research/chat-message.tsx" },
        ]}
        taskPhases={[
          { id: "read", label: "Reading file", status: "completed" },
          { id: "write", label: "Writing patch", status: "active" },
        ]}
        steps={[
          { id: "step-read", verb: "reading", target: "chat-message.tsx", status: "done" },
          { id: "step-write", verb: "drafting", target: "compact transcript", status: "running" },
        ]}
        timestamp={new Date("2026-04-15T07:00:05.000Z")}
        isStreaming
      />,
    );

    expect(screen.getByRole("log")).toHaveTextContent("Planning the next change");
    expect(screen.queryByLabelText("Task phases")).not.toBeInTheDocument();
    expect(screen.queryByTestId("step-cards")).not.toBeInTheDocument();
  });

  it("keeps phase and step chrome when progress entries normalize away", () => {
    render(
      <ChatMessage
        role="assistant"
        content=""
        progressLog={[
          { kind: "activity", text: "Turn started" },
          { kind: "activity", text: "Run command complete" },
        ]}
        taskPhases={[
          { id: "read", label: "Reading file", status: "completed" },
          { id: "write", label: "Writing patch", status: "active" },
        ]}
        steps={[
          { id: "step-read", verb: "reading", target: "chat-message.tsx", status: "done" },
        ]}
        timestamp={new Date("2026-04-15T07:00:05.000Z")}
        isStreaming
      />,
    );

    expect(screen.queryByLabelText("Task phases")).not.toBeInTheDocument();
    expect(screen.queryByTestId("step-cards")).not.toBeInTheDocument();
    expect(screen.getByRole("log")).toHaveTextContent("Phase: Writing patch");
    expect(screen.getByRole("log")).toHaveTextContent("1 step complete");
  });

  it("collapses live task phases and step cards into compact summary chips", () => {
    render(
      <ChatMessage
        role="assistant"
        content=""
        progressLog={[
          { kind: "activity", text: "Read docs/results_table.csv" },
        ]}
        taskPhases={[
          { id: "read", label: "Reading file", status: "completed" },
          { id: "summarize", label: "Summarizing findings", status: "active" },
        ]}
        steps={[
          { id: "s1", verb: "reading", target: "docs/results_table.csv", status: "done" },
          { id: "s2", verb: "drafting", target: "summary note", status: "running" },
        ]}
        timestamp={new Date("2026-04-20T10:04:30.000Z")}
        isStreaming
      />,
    );

    expect(screen.queryByLabelText("Task phases")).not.toBeInTheDocument();
    expect(screen.queryByTestId("step-cards")).not.toBeInTheDocument();
    expect(screen.getByRole("log")).toHaveTextContent("Phase: Summarizing findings");
    expect(screen.getByRole("log")).toHaveTextContent("Drafting summary note");
    expect(screen.getByRole("log")).toHaveTextContent("Read docs/results_table.csv");
  });

  it("renders a dedicated run-state surface before transcript progress arrives", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-20T10:00:05.000Z"));

    render(
      <ChatMessage
        role="assistant"
        content=""
        timestamp={new Date("2026-04-20T10:00:00.000Z")}
        isStreaming
      />,
    );

    expect(screen.getByTestId("assistant-run-state")).toHaveTextContent(
      "Working (5s • esc to interrupt)",
    );
    expect(screen.getByTestId("chat-streaming-spinner")).toBeInTheDocument();
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
    expect(progressLog).toHaveTextContent(/Working \(\d+s • esc to interrupt\)/);
    expect(progressLog).toHaveTextContent("• Explored");
    expect(progressLog).toHaveTextContent("Checking the imported files...");
    expect(progressLog).toHaveTextContent("└ Read docs/results_table.csv");
    expect(progressLog).toHaveTextContent("Search activityLog in use-unified-chat.ts");
    expect(screen.getByTestId("assistant-explored-count-1")).toHaveTextContent("2 actions");
    expect(progressLog).toHaveTextContent("Thinking");
    expect(progressLog).toHaveTextContent("Activity");
    expect(screen.queryByText("Thinking Trace")).not.toBeInTheDocument();
    expect(screen.queryByText("OpenClaw Activity")).not.toBeInTheDocument();
    expect(screen.queryByText("Recent activity")).not.toBeInTheDocument();
  });

  it("surfaces the latest compact progress detail under the live run-state header", () => {
    render(
      <ChatMessage
        role="assistant"
        content=""
        progressLog={[
          { kind: "activity", text: "Read docs/results_table.csv" },
          { kind: "thinking", text: "Plan: compare the timing artifact" },
        ]}
        timestamp={new Date("2026-04-20T10:00:00.000Z")}
        isStreaming
      />,
    );

    expect(screen.getByTestId("assistant-run-state")).toHaveTextContent("Thinking");
    expect(screen.getByTestId("assistant-run-state")).toHaveTextContent(
      "Plan: compare the timing artifact",
    );
  });

  it("summarizes dense explored activity in the live run-state detail", () => {
    render(
      <ChatMessage
        role="assistant"
        content=""
        progressLog={[
          { kind: "activity", text: "Read docs/results_table.csv" },
          { kind: "activity", text: "Write docs/results_summary.md" },
          { kind: "activity", text: "Search docs/ for timing notes" },
        ]}
        timestamp={new Date("2026-04-20T10:00:00.000Z")}
        isStreaming
      />,
    );

    expect(screen.getByTestId("assistant-run-state")).toHaveTextContent(
      "Explored",
    );
    expect(screen.getByTestId("assistant-run-state")).toHaveTextContent(
      "Explored 3 actions",
    );
    expect(screen.getByTestId("assistant-run-state")).not.toHaveTextContent(
      "Search docs/ for timing notes",
    );
  });

  it("counts raw explored activity entries even when the transcript coalesces them", () => {
    render(
      <ChatMessage
        role="assistant"
        content=""
        progressLog={[
          { kind: "activity", text: "Read docs/a.md" },
          { kind: "activity", text: "Read docs/b.md" },
          { kind: "activity", text: "Read docs/c.md" },
          { kind: "activity", text: "Write docs/summary.md" },
        ]}
        timestamp={new Date("2026-04-20T10:00:00.000Z")}
        isStreaming
      />,
    );

    expect(screen.getByTestId("assistant-run-state")).toHaveTextContent(
      "Explored 4 actions",
    );
    expect(screen.getByRole("log")).toHaveTextContent(
      "Read docs/a.md · docs/b.md · docs/c.md",
    );
    expect(screen.getByTestId("assistant-explored-count-0")).toHaveTextContent("4 actions");
  });

  it("keeps the compact live run-state wrapper on a single spacing system", () => {
    render(
      <ChatMessage
        role="assistant"
        content=""
        progressLog={[
          { kind: "activity", text: "Read docs/results_table.csv" },
          { kind: "thinking", text: "Plan: compare the timing artifact" },
        ]}
        timestamp={new Date("2026-04-20T10:00:00.000Z")}
        isStreaming
      />,
    );

    expect(screen.getByRole("log")).toHaveClass("space-y-0");
  });

  it("falls back to the previous non-empty compact detail when the latest narrative is blank", () => {
    render(
      <ChatMessage
        role="assistant"
        content=""
        progressLog={[
          { kind: "activity", text: "Read docs/results_table.csv" },
          { kind: "thinking", text: "   " },
        ]}
        timestamp={new Date("2026-04-20T10:00:00.000Z")}
        isStreaming
      />,
    );

    expect(screen.getByTestId("assistant-run-state")).toHaveTextContent(
      "Read docs/results_table.csv",
    );
  });

  it("updates the labeled run-state detail when the latest compact detail changes", () => {
    const timestamp = new Date("2026-04-20T10:00:00.000Z");
    const { rerender } = render(
      <ChatMessage
        role="assistant"
        content=""
        progressLog={[
          { kind: "thinking", text: "Plan: inspect the saved chart." },
        ]}
        timestamp={timestamp}
        isStreaming
      />,
    );

    const runState = screen.getByTestId("assistant-run-state");
    expect(runState).toHaveTextContent("Thinking");
    expect(runState).toHaveTextContent("Plan: inspect the saved chart.");

    rerender(
      <ChatMessage
        role="assistant"
        content=""
        progressLog={[
          { kind: "thinking", text: "Plan: inspect the saved chart." },
          { kind: "activity", text: "Read docs/results_table.csv" },
        ]}
        timestamp={timestamp}
        isStreaming
      />,
    );

    expect(runState).toHaveTextContent("Read");
    expect(runState).toHaveTextContent("Read docs/results_table.csv");
    expect(runState).not.toHaveTextContent("Plan: inspect the saved chart.");
  });

  it("prefers explicit progress metadata labels in the live run-state detail", () => {
    render(
      <ChatMessage
        role="assistant"
        content=""
        progressLog={[
          {
            kind: "activity",
            text: "Waiting for OpenClaw to respond",
            source: "server",
            phase: "waiting",
            status: "running",
            label: "Wait",
          },
        ]}
        timestamp={new Date("2026-04-20T10:00:00.000Z")}
        isStreaming
      />,
    );

    const runState = screen.getByTestId("assistant-run-state");
    expect(runState).toHaveTextContent("Wait");
    expect(runState).toHaveTextContent("Waiting for OpenClaw to respond");
    expect(runState).not.toHaveTextContent("Activity");
  });

  it("wraps long run-state detail content without forcing horizontal overflow", () => {
    render(
      <ChatMessage
        role="assistant"
        content=""
        progressLog={[
          {
            kind: "thinking",
            text:
              "Plan: compare docs/results_table.csv against docs/results_summary_with_extra_long_context_name.md before summarizing.",
          },
        ]}
        timestamp={new Date("2026-04-20T10:00:00.000Z")}
        isStreaming
      />,
    );

    const runState = screen.getByTestId("assistant-run-state");
    expect(
      within(runState).getByText(
        "Plan: compare docs/results_table.csv against docs/results_summary_with_extra_long_context_name.md before summarizing.",
      ),
    ).toHaveClass("break-words");
  });

  it("coalesces consecutive explored file actions into compact summaries", () => {
    render(
      <ChatMessage
        role="assistant"
        content=""
        progressLog={[
          { kind: "activity", text: "Read src/a.ts" },
          { kind: "activity", text: "Read src/b.ts" },
          { kind: "activity", text: "Write docs/summary.md" },
          { kind: "activity", text: "Write docs/chart.md" },
          { kind: "activity", text: "Search gateway in src/hooks/use-unified-chat.ts" },
        ]}
        timestamp={new Date("2026-04-20T10:00:00.000Z")}
        isStreaming
      />,
    );

    const progressLog = screen.getByRole("log");
    expect(progressLog).toHaveTextContent("Read src/a.ts · src/b.ts");
    expect(progressLog).toHaveTextContent("Write docs/summary.md · docs/chart.md");
    expect(progressLog).toHaveTextContent("Search gateway in src/hooks/use-unified-chat.ts");
  });
  it("renders thinking and activity sections in chronological order", () => {
    render(
      <ChatMessage
        role="assistant"
        content=""
        progressLog={[
          { kind: "thinking", text: "Plan: inspect files" },
          { kind: "activity", text: "Read docs/results_table.csv" },
          { kind: "thinking", text: "Now summarize findings" },
          { kind: "activity", text: "Read docs/notes.md" },
        ]}
        timestamp={new Date("2026-04-20T10:20:00.000Z")}
        isStreaming
      />,
    );

    const progressTranscript = screen.getByTestId("assistant-progress-transcript");
    const text = progressTranscript.textContent ?? "";
    const firstPlan = text.indexOf("Plan: inspect files");
    const firstRead = text.indexOf("Read docs/results_table.csv");
    const secondThought = text.indexOf("Now summarize findings");
    const secondRead = text.indexOf("Read docs/notes.md");
    for (const position of [
      firstPlan,
      firstRead,
      secondThought,
      secondRead,
    ]) {
      expect(position).toBeGreaterThan(-1);
    }
    expect(firstPlan).toBeLessThan(firstRead);
    expect(firstRead).toBeLessThan(secondThought);
    expect(secondThought).toBeLessThan(secondRead);
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

  it("renders bold, italic, and code inline formatting in thinking rows", () => {
    render(
      <ChatMessage
        role="assistant"
        content=""
        progressLog={[
          { kind: "thinking", text: "**Moving forward** with *embedding* and `rg`." },
          { kind: "thinking", text: "I think I'll finalize by saying \"Made it\"." },
        ]}
        timestamp={new Date("2026-04-21T10:00:00.000Z")}
        isStreaming
      />,
    );

    const progressLog = screen.getByRole("log");
    expect(progressLog).toHaveTextContent("Moving forward with embedding");
    expect(progressLog).toHaveTextContent("rg");
    expect(progressLog).toHaveTextContent("I think I'll finalize by saying \"Made it\".");
    expect(progressLog).not.toHaveTextContent("**Moving forward** with *embedding* and `rg`.");
    expect(progressLog.querySelector("strong")).toHaveTextContent("Moving forward");
    expect(progressLog.querySelector("em")).toHaveTextContent("embedding");
    expect(progressLog.querySelector("code")).toHaveTextContent("rg");
    expect(screen.getByTestId("chat-streaming-spinner")).toBeInTheDocument();
  });

  it("renders headings, lists, and fenced code when a progress row carries block markdown", () => {
    render(
      <ChatMessage
        role="assistant"
        content=""
        progressLog={[
          {
            kind: "thinking",
            text:
              "## Current plan\n\n" +
              "- Inspect the saved chart\n" +
              "- Compare the timing artifact\n\n" +
              "```ts\nconst ready = true;\n```",
          },
        ]}
        timestamp={new Date("2026-04-21T10:00:00.000Z")}
        isStreaming
      />,
    );

    const progressLog = screen.getByTestId("assistant-progress-transcript");
    expect(screen.getByRole("heading", { level: 2, name: "Current plan" })).toBeInTheDocument();
    expect(progressLog).toHaveTextContent("Inspect the saved chart");
    expect(progressLog).toHaveTextContent("Compare the timing artifact");
    expect(screen.getByText("const ready = true;").closest("pre")).toHaveClass("bg-ink");
    expect(progressLog).not.toHaveTextContent("## Current plan");
    expect(screen.getByTestId("assistant-run-state")).not.toHaveTextContent("## Current plan");
  });

  it("uses a compact markdown scale for progress transcript blocks", () => {
    render(
      <ChatMessage
        role="assistant"
        content=""
        progressLog={[
          {
            kind: "thinking",
            text: "### Plan\n\n- Extract the `results` table\n- Render the chart",
          },
          {
            kind: "activity",
            text: "```bash\npython3 scripts/extract_results_chart.py\n```",
          },
        ]}
        timestamp={new Date("2026-04-21T10:00:00.000Z")}
        isStreaming
      />,
    );

    expect(
      screen.getByRole("heading", { level: 3, name: "Plan" }).parentElement,
    ).toHaveClass("rounded-2xl");
    expect(
      screen.getByRole("heading", { level: 3, name: "Plan" }).parentElement,
    ).toHaveClass("bg-sunk/35");
    expect(
      screen.getByRole("heading", { level: 3, name: "Plan" }),
    ).toHaveClass("text-[13px]");
    expect(screen.getByRole("list")).toHaveClass("space-y-1.5");
    expect(
      screen.getByText("python3 scripts/extract_results_chart.py").closest("pre"),
    ).toHaveClass("rounded-2xl");
    expect(
      screen.getByText("python3 scripts/extract_results_chart.py").closest("pre"),
    ).not.toHaveClass("rounded-3xl");
    expect(screen.getByText("results").closest("code")).toHaveClass("bg-sunk/70");
    expect(screen.getByText("results").closest("code")).toHaveClass("font-normal");
    expect(screen.getByText("results").closest("code")).not.toHaveClass("bg-sunk/90");
  });

  it("adds calmer section rhythm inside progress markdown blocks", () => {
    render(
      <ChatMessage
        role="assistant"
        content=""
        progressLog={[
          {
            kind: "thinking",
            text:
              "### Plan\n\n" +
              "Lead paragraph.\n\n" +
              "- Extract the `results` table\n\n" +
              "```bash\npython3 scripts/extract_results_chart.py\n```",
          },
        ]}
        timestamp={new Date("2026-04-21T10:00:00.000Z")}
        isStreaming
      />,
    );

    expect(screen.getByRole("heading", { level: 3, name: "Plan" })).toHaveClass("mt-3");
    expect(screen.getByText("Lead paragraph.").closest("p")).toHaveClass("mt-2");
    expect(screen.getByRole("list")).toHaveClass("mt-2");
    expect(
      screen.getByText("python3 scripts/extract_results_chart.py").closest("pre"),
    ).toHaveClass("mt-2");
  });

  it("keeps leading progress block elements flush when they start the markdown block", () => {
    render(
      <ChatMessage
        role="assistant"
        content=""
        progressLog={[
          { kind: "thinking", text: "- First item\n- Second item" },
          { kind: "activity", text: "```bash\nnpm run test\n```" },
        ]}
        timestamp={new Date("2026-04-21T10:00:00.000Z")}
        isStreaming
      />,
    );

    expect(screen.getByRole("list")).toHaveClass("first:mt-0");
    expect(screen.getByText("npm run test").closest("pre")).toHaveClass("first:mt-0");
  });

  it("renders markdown tables when a progress row carries GFM table syntax", () => {
    render(
      <ChatMessage
        role="assistant"
        content=""
        progressLog={[
          {
            kind: "thinking",
            text:
              "| Metric | Value |\n" +
              "| --- | --- |\n" +
              "| First chunk | 58 ms |\n" +
              "| Total | 6677 ms |",
          },
        ]}
        timestamp={new Date("2026-04-21T10:00:00.000Z")}
        isStreaming
      />,
    );

    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Metric" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "6677 ms" })).toBeInTheDocument();
    expect(screen.getByRole("table")).toHaveClass("text-[12px]");
    expect(screen.getByRole("table").parentElement).toHaveClass("rounded-2xl");
    expect(screen.getByTestId("assistant-run-state")).not.toHaveTextContent("| Metric | Value |");
  });

  it("detects aligned GFM tables with short delimiter cells", () => {
    render(
      <ChatMessage
        role="assistant"
        content=""
        progressLog={[
          {
            kind: "thinking",
            text:
              "| Metric | Value |\n" +
              "| :- | -: |\n" +
              "| First chunk | 58 ms |",
          },
        ]}
        timestamp={new Date("2026-04-21T10:00:00.000Z")}
        isStreaming
      />,
    );

    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Metric" })).toHaveStyle({ textAlign: "left" });
    expect(screen.getByRole("columnheader", { name: "Value" })).toHaveStyle({ textAlign: "right" });
    expect(screen.getByRole("columnheader", { name: "Metric" })).toHaveAttribute("scope", "col");
    expect(screen.getByRole("cell", { name: "58 ms" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "58 ms" })).toHaveStyle({ textAlign: "right" });
  });

  it("does not treat blank-line separated pseudo-tables as markdown tables", () => {
    render(
      <ChatMessage
        role="assistant"
        content=""
        progressLog={[
          {
            kind: "thinking",
            text:
              "| Metric | Value |\n\n" +
              "| --- | --- |\n" +
              "| First chunk | 58 ms |",
          },
        ]}
        timestamp={new Date("2026-04-21T10:00:00.000Z")}
        isStreaming
      />,
    );

    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.getByTestId("assistant-progress-transcript")).toHaveTextContent("| Metric | Value |");
  });

  it("renders thematic breaks when a progress row carries markdown dividers", () => {
    const { container } = render(
      <ChatMessage
        role="assistant"
        content=""
        progressLog={[
          {
            kind: "thinking",
            text: "## Current plan\n\n---\n\nCompare the latest timing report.",
          },
        ]}
        timestamp={new Date("2026-04-21T10:00:00.000Z")}
        isStreaming
      />,
    );

    expect(container.querySelector('[data-testid="assistant-progress-transcript"] hr')).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "Current plan" })).toBeInTheDocument();
  });

  it("renders progress markdown task lists with compact checkbox styling", () => {
    const { container } = render(
      <ChatMessage
        role="assistant"
        content=""
        progressLog={[
          {
            kind: "thinking",
            text: "- [x] Inspect the timing artifact\n- [ ] Publish the summary",
          },
        ]}
        timestamp={new Date("2026-04-21T10:00:00.000Z")}
        isStreaming
      />,
    );

    const checkboxes = Array.from(
      container.querySelectorAll('[data-testid="assistant-progress-transcript"] input[type="checkbox"]'),
    );
    expect(checkboxes).toHaveLength(2);
    expect(checkboxes[0]).toBeChecked();
    expect(checkboxes[0]).toHaveClass("h-3.5");
    expect(checkboxes[0]).toHaveClass("accent-accent");
    expect(checkboxes[0].closest("li")).toHaveClass("task-list-item");
  });

  it("renders mixed inline formatting inside visible explored transcript rows", () => {
    render(
      <ChatMessage
        role="assistant"
        content=""
        progressLog={[
          { kind: "thinking", text: "Saving output to `docs/results_chart.png` *carefully*." },
          { kind: "activity", text: "Read `docs/results_table.csv` before **summarizing**" },
        ]}
        timestamp={new Date("2026-04-21T10:00:00.000Z")}
        isStreaming
      />,
    );

    const progressLog = screen.getByRole("log");
    const codeTexts = Array.from(progressLog.querySelectorAll("code")).map((node) => node.textContent);
    expect(codeTexts).toContain("docs/results_table.csv");
    expect(codeTexts).toContain("docs/results_chart.png");
    expect(progressLog.querySelector("em")).toHaveTextContent("carefully");
    expect(progressLog.querySelector("strong")).toHaveTextContent("summarizing");
  });

  it("collapses long explored blocks behind a toggle until expanded", () => {
    render(
      <ChatMessage
        role="assistant"
        content=""
        progressLog={[
          { kind: "activity", text: "Read docs/a.md" },
          { kind: "activity", text: "Write docs/b.md" },
          { kind: "activity", text: "Edit docs/c.md" },
          { kind: "activity", text: "Search docs/ for metrics" },
          { kind: "activity", text: "Run python3 scripts/report.py" },
        ]}
        timestamp={new Date("2026-04-21T10:00:00.000Z")}
        isStreaming
      />,
    );

    const transcript = screen.getByTestId("assistant-progress-transcript");
    expect(transcript).toHaveTextContent("Read docs/a.md");
    expect(transcript).toHaveTextContent("Write docs/b.md");
    expect(transcript).toHaveTextContent("Edit docs/c.md");
    expect(within(transcript).queryByText("Search docs/ for metrics")).not.toBeInTheDocument();
    expect(within(transcript).queryByText("Run python3 scripts/report.py")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("assistant-explored-toggle-0"));

    expect(within(transcript).getByText("Search docs/ for metrics")).toBeInTheDocument();
    expect(within(transcript).getByText("Run python3 scripts/report.py")).toBeInTheDocument();
    expect(screen.getByTestId("assistant-explored-toggle-0")).toHaveTextContent(
      "Hide extra lines",
    );
  });

  it("keeps an expanded explored block open when earlier transcript rows are inserted", () => {
    const timestamp = new Date("2026-04-21T10:00:00.000Z");
    const initialProgressLog = [
      { kind: "activity", text: "Read docs/a.md" },
      { kind: "activity", text: "Write docs/b.md" },
      { kind: "activity", text: "Edit docs/c.md" },
      { kind: "activity", text: "Search docs/ for metrics" },
      { kind: "activity", text: "Run python3 scripts/report.py" },
    ] as const;
    const { rerender } = render(
      <ChatMessage
        role="assistant"
        content=""
        progressLog={[...initialProgressLog]}
        timestamp={timestamp}
        isStreaming
      />,
    );

    fireEvent.click(screen.getByTestId("assistant-explored-toggle-0"));

    const transcript = screen.getByTestId("assistant-progress-transcript");
    expect(within(transcript).getByText("Search docs/ for metrics")).toBeInTheDocument();

    rerender(
      <ChatMessage
        role="assistant"
        content=""
        progressLog={[
          { kind: "thinking", text: "Checking the workspace first." },
          ...initialProgressLog,
        ]}
        timestamp={timestamp}
        isStreaming
      />,
    );

    expect(within(screen.getByTestId("assistant-progress-transcript")).getByText(
      "Search docs/ for metrics",
    )).toBeInTheDocument();
    expect(screen.getByTestId("assistant-explored-toggle-1")).toHaveTextContent(
      "Hide extra lines",
    );
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
    expect(progressLog).toHaveTextContent(/Working \(\d+s • esc to interrupt\)/);
    expect(screen.queryByText("Thinking Trace")).not.toBeInTheDocument();
    expect(screen.queryByText("OpenClaw Activity")).not.toBeInTheDocument();
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
    expect(progressLog.querySelector("strong")).toHaveTextContent("planning");
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

  it("collapses long stored progress transcripts until the user expands them", () => {
    render(
      <ChatMessage
        role="assistant"
        content="Final answer"
        progressLog={[
          { kind: "thinking", text: "Planning how to inspect the chart files." },
          { kind: "activity", text: "Preparing workspace context" },
          { kind: "thinking", text: "Comparing prior chart revisions." },
          { kind: "activity", text: "Waiting for OpenClaw to respond" },
          { kind: "thinking", text: "Drafting the summary notes." },
        ]}
        timestamp={new Date("2026-04-20T10:04:00.000Z")}
        isStreaming={false}
      />,
    );

    const transcript = screen.getByTestId("assistant-progress-transcript");
    expect(within(transcript).getByText("Planning how to inspect the chart files.")).toBeInTheDocument();
    expect(within(transcript).getByText("Preparing workspace context")).toBeInTheDocument();
    expect(within(transcript).queryByText("Drafting the summary notes.")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("assistant-progress-transcript-toggle"));

    expect(within(transcript).getByText("Drafting the summary notes.")).toBeInTheDocument();
    expect(screen.getByTestId("assistant-progress-transcript-toggle")).toHaveTextContent(
      "Hide transcript",
    );
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

  it("renders MEDIA paths that contain spaces", () => {
    render(
      <ChatMessage
        role="assistant"
        content={"MEDIA:figures/summary chart final.png"}
        projectId="project-alpha"
        timestamp={new Date("2026-04-21T10:00:10.000Z")}
      />,
    );

    expect(screen.getByAltText("figures/summary chart final.png")).toHaveAttribute(
      "src",
      "/api/workspace?action=raw&file=figures%2Fsummary%20chart%20final.png&projectId=project-alpha",
    );
  });

  it("does not treat inline MEDIA prose as a workspace media directive", () => {
    render(
      <ChatMessage
        role="assistant"
        content={"Here is the chart MEDIA:figures/summary chart final.png see above."}
        projectId="project-alpha"
        timestamp={new Date("2026-04-21T10:00:12.000Z")}
      />,
    );

    expect(screen.queryByAltText("figures/summary chart final.png see above.")).not.toBeInTheDocument();
    expect(screen.getByTestId("assistant-reply-content")).toHaveTextContent(
      "Here is the chart MEDIA:figures/summary chart final.png see above.",
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

  it("groups consecutive assistant images into one responsive gallery", () => {
    render(
      <ChatMessage
        role="assistant"
        content={"MEDIA:docs/results_chart.png\nMEDIA:figures/diagram.avif"}
        projectId="project-alpha"
        timestamp={new Date("2026-04-21T10:00:20.000Z")}
      />,
    );

    const gallery = screen.getByTestId("assistant-media-gallery");
    expect(gallery).toHaveClass("sm:grid-cols-2");
    expect(within(gallery).getByAltText("docs/results_chart.png")).toBeInTheDocument();
    expect(within(gallery).getByAltText("figures/diagram.avif")).toBeInTheDocument();
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

    const video = container.querySelector("video");
    const audio = container.querySelector("audio");

    expect(container.querySelector("video source")).toHaveAttribute("type", "video/mp4");
    expect(container.querySelector("audio source")).toHaveAttribute("type", "audio/mp4");
    expect(video?.closest("figure")).toHaveClass("rounded-[1.35rem]");
    expect(video?.closest("figure")).toHaveClass("shadow-[0_16px_36px_-24px_rgba(15,23,42,0.4)]");
    expect(audio?.closest("figure")).toHaveClass("rounded-[1.35rem]");
    expect(audio?.closest("figure")).toHaveClass("shadow-[0_16px_36px_-24px_rgba(15,23,42,0.4)]");
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
    expect(iframe?.parentElement).toHaveClass("rounded-[1.35rem]");
    expect(iframe?.parentElement).toHaveClass("shadow-[0_16px_36px_-24px_rgba(15,23,42,0.4)]");
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
      "/api/workspace/raw/project-alpha/alpha.html",
    );
    expect(screen.getByTitle("Beta")).toHaveAttribute(
      "src",
      "/api/workspace/raw/project-alpha/beta.html",
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
      "/api/workspace/raw/project-alpha/__openclaw__/canvas/documents/cat-svg-preview/index.html",
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

    const iframe = screen.getByTitle("Snake");
    expect(iframe).toHaveAttribute(
      "src",
      "/api/workspace/raw/project-alpha/figures/snake-game/index.html",
    );
    expect(iframe.parentElement).toHaveClass("rounded-[1.35rem]");
    expect(iframe.parentElement).toHaveClass("shadow-[0_16px_36px_-24px_rgba(15,23,42,0.4)]");
  });

  it("maps legacy MEDIA html aliases to project index previews", () => {
    render(
      <ChatMessage
        role="assistant"
        content={"Here it is.\n\nMEDIA:snake"}
        projectId="project-alpha"
        timestamp={new Date("2026-04-20T10:12:40.000Z")}
      />,
    );

    const iframe = screen.getByTitle("snake");
    expect(iframe).toHaveAttribute(
      "src",
      "/api/workspace/raw/project-alpha/snake/index.html",
    );
    expect(iframe.parentElement).toHaveClass("rounded-[1.35rem]");
    expect(iframe.parentElement).toHaveClass("shadow-[0_16px_36px_-24px_rgba(15,23,42,0.4)]");
  });

  it("maps legacy embed refs to project index previews", () => {
    render(
      <ChatMessage
        role="assistant"
        content={"[embed ref=\"snake-game\" title=\"Snake\" height=\"420\" /]"}
        projectId="project-alpha"
        timestamp={new Date("2026-04-20T10:12:42.000Z")}
      />,
    );

    expect(screen.getByTitle("Snake")).toHaveAttribute(
      "src",
      "/api/workspace/raw/project-alpha/snake/index.html",
    );
  });

  it("maps legacy snake webpage refs to the single-file html preview", () => {
    render(
      <ChatMessage
        role="assistant"
        content={"[embed ref=\"snake-webpage\" title=\"Snake\" height=\"420\" /]\n\nSource: `snake_game.html`"}
        projectId="project-alpha"
        timestamp={new Date("2026-04-20T10:12:42.000Z")}
      />,
    );

    expect(screen.getByTitle("Snake")).toHaveAttribute(
      "src",
      "/api/workspace/raw/project-alpha/snake_game.html",
    );
  });

  it("falls back to legacy embed refs when url is present but empty", () => {
    render(
      <ChatMessage
        role="assistant"
        content={"[embed url=\"\" ref=\"snake-game\" title=\"Snake\" height=\"420\" /]"}
        projectId="project-alpha"
        timestamp={new Date("2026-04-20T10:12:43.000Z")}
      />,
    );

    expect(screen.getByTitle("Snake")).toHaveAttribute(
      "src",
      "/api/workspace/raw/project-alpha/snake/index.html",
    );
  });

  it("keeps non-legacy game folder names intact for extensionless embeds", () => {
    render(
      <ChatMessage
        role="assistant"
        content={"[embed ref=\"project-game\" title=\"Project Game\" height=\"420\" /]"}
        projectId="project-alpha"
        timestamp={new Date("2026-04-20T10:12:44.000Z")}
      />,
    );

    expect(screen.getByTitle("Project Game")).toHaveAttribute(
      "src",
      "/api/workspace/raw/project-alpha/project-game/index.html",
    );
  });

  it("blocks MEDIA html paths that attempt traversal before building raw preview URLs", () => {
    render(
      <ChatMessage
        role="assistant"
        content={"MEDIA:../figures/snake-game/index.html"}
        projectId="project-alpha"
        timestamp={new Date("2026-04-20T10:12:35.000Z")}
      />,
    );

    expect(screen.queryByTitle("../figures/snake-game/index.html")).not.toBeInTheDocument();
    expect(screen.getByText("[media blocked: invalid path]")).toBeInTheDocument();
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
      "/api/workspace/raw/project-alpha/alpha.html",
    );
  });

  it("keeps the compact live transcript header when a live activity log is present", () => {
    render(
      <ChatMessage
        role="assistant"
        content=""
        activityLog={["Turn started"]}
        timestamp={new Date("2026-04-20T10:16:00.000Z")}
        isStreaming
      />,
    );

    expect(screen.getByTestId("chat-streaming-spinner")).toBeInTheDocument();
    expect(screen.getByRole("log")).toHaveTextContent("Working (");
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
      "/api/workspace/raw/project-alpha/alpha.html",
    );
    expect(screen.getByTitle("Beta")).toHaveAttribute(
      "src",
      "/api/workspace/raw/project-alpha/beta.html",
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
      "/api/workspace/raw/project-alpha/alpha.html",
    );
  });
});
