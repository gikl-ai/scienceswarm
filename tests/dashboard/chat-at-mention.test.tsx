// @vitest-environment jsdom

import { useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createEvent, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  ChatMentionInput,
  type MentionFile,
  type SlashCommandOption,
  getActiveMention,
  getActiveSlashCommand,
} from "@/components/research/chat-mention-input";

const SAMPLE_FILES: MentionFile[] = [
  { name: "figure-1.png", path: "results/figure-1.png" },
  { name: "figure-2.png", path: "results/figure-2.png" },
  { name: "notes.md", path: "papers/notes.md" },
  { name: "analysis.py", path: "code/analysis.py" },
  { name: "Critique for Hubble 1929", path: "gbrain:hubble-1929-critique" },
];

const SAMPLE_SLASH_COMMANDS: SlashCommandOption[] = [
  {
    command: "help",
    description: "Show slash command help",
    kind: "builtin",
  },
  {
    command: "project-organizer",
    description: "Organize the current project",
    argumentHint: "[request]",
    kind: "skill",
    skillSlug: "project-organizer",
  },
  {
    command: "pubmed",
    description: "Search PubMed",
    argumentHint: "[query or identifier]",
    kind: "skill",
    skillSlug: "db-pubmed",
  },
];

function Harness({ initial = "" }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <div>
      <ChatMentionInput
        value={value}
        onValueChange={setValue}
        mentionFiles={SAMPLE_FILES}
        slashCommands={SAMPLE_SLASH_COMMANDS}
        data-testid="chat-input"
        rows={2}
      />
      <output data-testid="current-value">{value}</output>
    </div>
  );
}

function HarnessWithMentionCallback({
  onMentionSelect,
}: {
  onMentionSelect: (file: MentionFile) => void;
}) {
  const [value, setValue] = useState("");
  return (
    <div>
      <ChatMentionInput
        value={value}
        onValueChange={setValue}
        mentionFiles={SAMPLE_FILES}
        slashCommands={SAMPLE_SLASH_COMMANDS}
        onMentionSelect={onMentionSelect}
        data-testid="chat-input"
        rows={2}
      />
      <output data-testid="current-value">{value}</output>
    </div>
  );
}

function HarnessWithSlashLoading({
  onKeyDown,
}: {
  onKeyDown: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => void;
}) {
  const [value, setValue] = useState("");
  return (
    <div>
      <ChatMentionInput
        value={value}
        onValueChange={setValue}
        mentionFiles={SAMPLE_FILES}
        slashCommands={[]}
        slashCommandsLoading
        onKeyDown={onKeyDown}
        data-testid="chat-input"
        rows={2}
      />
      <output data-testid="current-value">{value}</output>
    </div>
  );
}

describe("getActiveMention", () => {
  it("returns the query when caret sits after an @ token", () => {
    expect(getActiveMention("hello @fig", 10)).toEqual({
      query: "fig",
      start: 6,
    });
  });

  it("returns null when @ is not preceded by whitespace", () => {
    expect(getActiveMention("email me@host", 13)).toBeNull();
  });

  it("returns null when whitespace appears between @ and caret", () => {
    expect(getActiveMention("@foo bar", 8)).toBeNull();
  });
});

describe("getActiveSlashCommand", () => {
  it("returns the query when the caret sits inside a leading slash command", () => {
    expect(getActiveSlashCommand("/pubmed tp53", 7)).toEqual({
      query: "pubmed",
      start: 0,
    });
  });

  it("ignores slashes that do not start the active line", () => {
    expect(getActiveSlashCommand("look at /tmp/file", 13)).toBeNull();
  });
});

describe("ChatMentionInput @-autocomplete", () => {
  it("filters suggestions as the user types @fig and inserts the reference on Enter", () => {
    render(<Harness />);
    const textarea = screen.getByTestId("chat-input") as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "@fig" } });
    // Force caret to end-of-input for deterministic mention detection.
    textarea.setSelectionRange(4, 4);
    fireEvent.keyUp(textarea);

    const listbox = screen.getByRole("listbox");
    expect(listbox).toBeTruthy();

    const options = screen.getAllByRole("option");
    const labels = options.map((o) => o.textContent || "");
    expect(labels.some((l) => l.includes("figure-1.png"))).toBe(true);
    expect(labels.some((l) => l.includes("figure-2.png"))).toBe(true);
    expect(labels.some((l) => l.includes("notes.md"))).toBe(false);

    expect(textarea.getAttribute("aria-expanded")).toBe("true");

    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(screen.getByTestId("current-value").textContent).toBe(
      "@figure-1.png ",
    );
  });

  it("reports the durable file path when inserting a compact mention", () => {
    const onMentionSelect = vi.fn();
    render(<HarnessWithMentionCallback onMentionSelect={onMentionSelect} />);
    const textarea = screen.getByTestId("chat-input") as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "@fig" } });
    textarea.setSelectionRange(4, 4);
    fireEvent.keyUp(textarea);
    fireEvent.keyDown(textarea, { key: "Tab" });

    expect(screen.getByTestId("current-value").textContent).toBe(
      "@figure-1.png ",
    );
    expect(onMentionSelect).toHaveBeenCalledWith({
      name: "figure-1.png",
      path: "results/figure-1.png",
    });
  });

  it("closes the dropdown on Escape", () => {
    render(<Harness />);
    const textarea = screen.getByTestId("chat-input") as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "@fig" } });
    textarea.setSelectionRange(4, 4);
    fireEvent.keyUp(textarea);

    expect(screen.queryByRole("listbox")).not.toBeNull();

    fireEvent.keyDown(textarea, { key: "Escape" });

    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("filters suggestions by inserted reference path", () => {
    render(<Harness />);
    const textarea = screen.getByTestId("chat-input") as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "@gbrain" } });
    textarea.setSelectionRange(7, 7);
    fireEvent.keyUp(textarea);

    const labels = screen
      .getAllByRole("option")
      .map((o) => o.textContent || "");
    expect(labels.some((l) => l.includes("Critique for Hubble 1929"))).toBe(
      true,
    );
  });

  it("reopens the dropdown when caret-only navigation lands on a different @ token", () => {
    render(<Harness initial="@fig hello @not" />);
    const textarea = screen.getByTestId("chat-input") as HTMLTextAreaElement;

    // Caret at end of the first `@fig` token (position 4) → dropdown opens
    // for the `@fig` mention.
    textarea.focus();
    textarea.setSelectionRange(4, 4);
    fireEvent.keyUp(textarea);
    expect(screen.queryByRole("listbox")).not.toBeNull();

    // User dismisses this mention with Escape.
    fireEvent.keyDown(textarea, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();

    // Caret-only navigation (no onChange) to inside the second `@not` token
    // at position 15. This is a DIFFERENT mention start, so the dropdown
    // must reopen — not stay suppressed because `dismissedAt` still points
    // at the old position.
    textarea.setSelectionRange(15, 15);
    fireEvent.keyUp(textarea);

    expect(screen.queryByRole("listbox")).not.toBeNull();
    const labels = screen
      .getAllByRole("option")
      .map((o) => o.textContent || "");
    expect(labels.some((l) => l.includes("notes.md"))).toBe(true);
  });
});

describe("ChatMentionInput slash-command autocomplete", () => {
  it("filters slash commands as the user types and inserts the command on Enter", () => {
    render(<Harness />);
    const textarea = screen.getByTestId("chat-input") as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "/pub" } });
    textarea.setSelectionRange(4, 4);
    fireEvent.keyUp(textarea);

    const listbox = screen.getByRole("listbox", {
      name: "Slash command suggestions",
    });
    expect(listbox).toBeTruthy();
    expect(screen.getByRole("option", { name: /pubmed/i })).toBeInTheDocument();

    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(screen.getByTestId("current-value").textContent).toBe("/pubmed ");
  });

  it("shows built-in help when the user types a bare slash", () => {
    render(<Harness />);
    const textarea = screen.getByTestId("chat-input") as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "/" } });
    textarea.setSelectionRange(1, 1);
    fireEvent.keyUp(textarea);

    const labels = screen
      .getAllByRole("option")
      .map((option) => option.textContent || "");
    expect(labels.some((label) => label.includes("/help"))).toBe(true);
    expect(labels.some((label) => label.includes("/project-organizer"))).toBe(
      true,
    );
  });

  it("suppresses submit/navigation keys while slash commands are still loading", () => {
    const onKeyDown = vi.fn();
    render(<HarnessWithSlashLoading onKeyDown={onKeyDown} />);
    const textarea = screen.getByTestId("chat-input") as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "/cap" } });
    textarea.setSelectionRange(4, 4);
    fireEvent.keyUp(textarea);

    expect(
      screen.getByRole("listbox", { name: "Slash command suggestions" }),
    ).toBeTruthy();
    expect(screen.getByText("Loading installed skills...")).toBeInTheDocument();

    const enterEvent = createEvent.keyDown(textarea, { key: "Enter" });
    fireEvent(textarea, enterEvent);
    expect(enterEvent.defaultPrevented).toBe(true);

    const arrowEvent = createEvent.keyDown(textarea, { key: "ArrowDown" });
    fireEvent(textarea, arrowEvent);
    expect(arrowEvent.defaultPrevented).toBe(true);
    expect(onKeyDown).not.toHaveBeenCalled();
    expect(screen.getByTestId("current-value").textContent).toBe("/cap");
  });
});
