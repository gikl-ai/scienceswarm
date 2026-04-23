// @vitest-environment jsdom

import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { TurnPreview } from "@/lib/runtime-hosts/contracts";
import { TurnPreviewSheet } from "@/components/runtime/turn-preview-sheet";

function preview(overrides: Partial<TurnPreview> = {}): TurnPreview {
  return {
    allowed: true,
    projectPolicy: "cloud-ok",
    hostId: "codex",
    mode: "chat",
    effectivePrivacyClass: "hosted",
    destinations: [
      { hostId: "codex", label: "Codex", privacyClass: "hosted" },
    ],
    dataIncluded: [
      { kind: "prompt", label: "User prompt", bytes: 12 },
      { kind: "workspace-file", label: "notes/current.md", bytes: 20 },
    ],
    proof: {
      projectGatePassed: true,
      operationPrivacyClass: "hosted",
      adapterProof: "declared-hosted",
    },
    blockReason: null,
    requiresUserApproval: true,
    accountDisclosure: {
      authMode: "subscription-native",
      provider: "openai",
      billingClass: "subscription-native",
      accountSource: "host-cli-login",
      estimatedRequestBytes: 32,
      costCopyRequired: false,
    },
    ...overrides,
  };
}

describe("TurnPreviewSheet", () => {
  it("shows destination, account source, included data, and approve/cancel controls", () => {
    const onApprove = vi.fn();
    const onCancel = vi.fn();

    render(
      <TurnPreviewSheet
        open
        preview={preview()}
        pendingLabel="chat via Codex"
        onApprove={onApprove}
        onCancel={onCancel}
        onChangeHost={vi.fn()}
      />,
    );

    expect(screen.getByRole("dialog", { name: "Runtime preview" })).toBeInTheDocument();
    expect(screen.getByText("Codex")).toBeInTheDocument();
    expect(screen.getByText("Native CLI login")).toBeInTheDocument();
    expect(screen.getByText("notes/current.md")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Approve and send" }));
    expect(onApprove).toHaveBeenCalled();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).toHaveBeenCalled();
  });

  it("disables approval when policy blocks the preview", () => {
    render(
      <TurnPreviewSheet
        open
        preview={preview({
          allowed: false,
          blockReason: "Project policy local-only blocks runtime host codex.",
        })}
        pendingLabel="chat via Codex"
        onApprove={vi.fn()}
        onCancel={vi.fn()}
        onChangeHost={vi.fn()}
      />,
    );

    const sheet = screen.getByTestId("turn-preview-sheet");
    expect(within(sheet).getByText(/local-only blocks/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve and send" })).toBeDisabled();
  });
});
