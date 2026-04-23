// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { RuntimeTaskBoard } from "@/components/runtime/runtime-task-board";
import { SessionDetail } from "@/components/runtime/session-detail";
import type { RuntimeSessionWithHost } from "@/hooks/use-runtime-hosts";
import type { RuntimeEvent } from "@/lib/runtime-hosts/contracts";

function session(overrides: Partial<RuntimeSessionWithHost> = {}): RuntimeSessionWithHost {
  return {
    id: "rt-session-1",
    hostId: "codex",
    projectId: "project-alpha",
    conversationId: "native-session-1",
    mode: "chat",
    status: "running",
    createdAt: "2026-04-23T00:00:00.000Z",
    updatedAt: "2026-04-23T00:01:00.000Z",
    host: {
      known: true,
      readOnly: false,
      id: "codex",
      label: "Codex",
      profile: {
        lifecycle: { canCancel: true },
        controlSurface: { supportsCancel: true },
      },
    },
    ...overrides,
  };
}

describe("RuntimeTaskBoard", () => {
  it("renders sessions as a dense table with selectable rows and cancel controls", () => {
    const onSelectSession = vi.fn();
    const onCancelSession = vi.fn();

    render(
      <RuntimeTaskBoard
        sessions={[session()]}
        onRefresh={vi.fn()}
        onSelectSession={onSelectSession}
        onCancelSession={onCancelSession}
      />,
    );

    expect(screen.getByRole("table")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Codex" }));
    expect(onSelectSession).toHaveBeenCalledWith("rt-session-1");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancelSession).toHaveBeenCalledWith("rt-session-1");
  });
});

describe("SessionDetail", () => {
  it("shows event logs and artifact writeback state for a selected session", () => {
    const events: RuntimeEvent[] = [
      {
        id: "event-1",
        sessionId: "rt-session-1",
        hostId: "codex",
        type: "message",
        createdAt: "2026-04-23T00:01:00.000Z",
        payload: { text: "Runtime output" },
      },
      {
        id: "event-2",
        sessionId: "rt-session-1",
        hostId: "codex",
        type: "artifact",
        createdAt: "2026-04-23T00:02:00.000Z",
        payload: {
          sourcePath: "outputs/figure.png",
          writebackPhaseStatus: "gbrain-writeback-pending",
        },
      },
    ];

    render(
      <SessionDetail
        session={session({ status: "completed" })}
        events={events}
        onClose={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );

    expect(screen.getByText("Runtime output")).toBeInTheDocument();
    expect(screen.getByText("outputs/figure.png")).toBeInTheDocument();
    expect(screen.getByText("gbrain-writeback-pending")).toBeInTheDocument();
  });
});
