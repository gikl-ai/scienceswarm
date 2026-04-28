// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FileVisualizer } from "@/components/research/file-visualizer";
import type { FilePreviewState } from "@/lib/file-visualization";

vi.mock("shiki", () => ({
  codeToHtml: vi.fn(async (content: string) =>
    `<pre class="shiki"><code>${content.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</code></pre>`,
  ),
}));

const ready = (overrides: Partial<Extract<FilePreviewState, { status: "ready" }>> = {}): FilePreviewState => ({
  status: "ready",
  path: "notes/summary.md",
  source: "workspace",
  kind: "markdown",
  content: "# Summary\n\n| a | b |\n| - | - |\n| 1 | 2 |",
  editable: true,
  ...overrides,
});

describe("FileVisualizer", () => {
  beforeEach(() => {
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn(async () => {}) },
    });
  });

  it("renders empty, loading, and retryable error states", () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <FileVisualizer preview={{ status: "idle" }} onClose={onClose} />,
    );

    expect(screen.getByText("Select a file to preview.")).toBeInTheDocument();

    rerender(
      <FileVisualizer
        preview={{ status: "loading", path: "paper.pdf", source: "workspace" }}
        onClose={onClose}
      />,
    );
    expect(screen.getByText("Loading paper.pdf...")).toBeInTheDocument();

    const onRetry = vi.fn();
    rerender(
      <FileVisualizer
        preview={{
          status: "error",
          path: "paper.pdf",
          source: "workspace",
          message: "File too large to preview.",
          retryable: true,
        }}
        onClose={onClose}
        onRetry={onRetry}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("switches rendered, source, and edit modes and saves edits", async () => {
    const onSaveContent = vi.fn(async () => {});
    render(
      <FileVisualizer
        preview={ready()}
        onClose={vi.fn()}
        onSaveContent={onSaveContent}
      />,
    );

    expect(screen.getByRole("heading", { name: "Summary" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Source/ }));
    await waitFor(() => {
      expect(screen.getByLabelText("Source code")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /Edit/ }));
    const editor = screen.getByLabelText("Edit summary.md");
    fireEvent.change(editor, { target: { value: "# Updated" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(onSaveContent).toHaveBeenCalledWith("# Updated");
    });
  });

  it("renders markdown numbered and bulleted lists with visible marker styles", () => {
    render(
      <FileVisualizer
        preview={ready({
          content: "# Workflow\n\n1. Start the project\n2. Import the tutorial\n\n- Check files\n- Send the prompt",
        })}
        onClose={vi.fn()}
      />,
    );

    const lists = screen.getAllByRole("list");
    const orderedList = lists.find((list) => list.tagName === "OL");
    const unorderedList = lists.find((list) => list.tagName === "UL");

    expect(orderedList).toHaveClass("list-decimal");
    expect(unorderedList).toHaveClass("list-disc");
    expect(screen.getByText("Start the project").closest("li")).toHaveClass("pl-1");
    expect(screen.getByText("Check files").closest("li")).toHaveClass("pl-1");
  });

  it("calls use-in-chat and close callbacks", () => {
    const onUseInChat = vi.fn();
    const onClose = vi.fn();
    render(
      <FileVisualizer
        preview={ready()}
        onClose={onClose}
        onUseInChat={onUseInChat}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Use in chat" }));
    expect(onUseInChat).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Close visualizer" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows an in-chat-context state", () => {
    render(
      <FileVisualizer
        preview={ready()}
        inChatContext
        onClose={vi.fn()}
        onUseInChat={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "In chat context" })).toBeDisabled();
  });

  it("renders HTML through the raw preview URL so scripts and sibling assets can run", () => {
    const rawUrl = "/api/workspace/raw/test-project/reports/index.html";
    const { container } = render(
      <FileVisualizer
        preview={ready({
          path: "reports/index.html",
          kind: "html",
          content: "<h1>Report</h1><script src=\"lib/chart.js\"></script>",
          rawUrl,
        })}
        onClose={vi.fn()}
      />,
    );

    const iframe = container.querySelector("iframe");
    expect(iframe).not.toBeNull();
    expect(iframe).toHaveAttribute("sandbox", "allow-scripts");
    expect(iframe).toHaveAttribute("src", rawUrl);
    expect(iframe).not.toHaveAttribute("srcdoc");
  });

  it("falls back to a scriptless sandboxed iframe when no raw URL is available", () => {
    const { container } = render(
      <FileVisualizer
        preview={ready({
          path: "reports/index.html",
          kind: "html",
          content: "<h1>Report</h1><script>window.bad=true</script>",
        })}
        onClose={vi.fn()}
      />,
    );

    const iframe = container.querySelector("iframe");
    expect(iframe).not.toBeNull();
    expect(iframe).toHaveAttribute("sandbox", "");
    expect(iframe?.getAttribute("sandbox")).not.toContain("allow-scripts");
    expect(iframe?.getAttribute("srcdoc")).toContain("Content-Security-Policy");
  });

  it("does not insert raw Markdown script tags into the DOM", () => {
    const { container } = render(
      <FileVisualizer
        preview={ready({
          content: "# Safe\n\n<script>window.bad = true</script>",
        })}
        onClose={vi.fn()}
      />,
    );

    expect(container.querySelector("script")).toBeNull();
  });

  it("renders notebook cells and malformed notebook fallback", async () => {
    const notebook = {
      nbformat: 4,
      metadata: { language_info: { name: "python" } },
      cells: [
        { cell_type: "markdown", source: ["# Notebook notes"] },
        {
          cell_type: "code",
          source: ["print('hi')"],
          outputs: [
            { output_type: "stream", name: "stdout", text: ["hi\n"] },
            { output_type: "display_data", data: { "text/html": "<strong>html output</strong>" } },
            { output_type: "display_data", data: { "image/png": "iVBORw0KGgo=" } },
            { output_type: "error", ename: "ValueError", evalue: "bad", traceback: ["Traceback"] },
          ],
        },
      ],
    };

    const { rerender } = render(
      <FileVisualizer
        preview={ready({
          path: "notebooks/run.ipynb",
          kind: "notebook",
          content: JSON.stringify(notebook),
        })}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText(/nbformat 4/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Notebook notes" })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByLabelText("Source code")).toBeInTheDocument();
    });
    expect(screen.getByText("hi")).toBeInTheDocument();
    expect(screen.getByText("Traceback")).toBeInTheDocument();

    rerender(
      <FileVisualizer
        preview={ready({
          path: "notebooks/broken.ipynb",
          kind: "notebook",
          content: "{not-json",
        })}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("Notebook could not be parsed.")).toBeInTheDocument();
  });
});
