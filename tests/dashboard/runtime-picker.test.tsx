// @vitest-environment jsdom

import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { RuntimeHealthHost } from "@/components/runtime/RuntimeHostMatrix";
import { RuntimePicker } from "@/components/runtime/runtime-picker";

function host(input: {
  id: string;
  label: string;
  authMode: "local" | "subscription-native" | "api-key";
  authProvider: "openclaw" | "anthropic" | "openai" | "google-ai" | "openhands";
  privacyClass: "local-only" | "local-network" | "hosted" | "external-network";
  capabilities?: RuntimeHealthHost["profile"]["capabilities"];
  authStatus?: RuntimeHealthHost["auth"]["status"];
  requiresProjectPrivacy?: "local-only" | "cloud-ok" | "execution-ok";
}): RuntimeHealthHost {
  return {
    profile: {
      id: input.id,
      label: input.label,
      authMode: input.authMode,
      authProvider: input.authProvider,
      privacyClass: input.privacyClass,
      transport: { kind: "cli", protocol: "stdio" },
      capabilities: input.capabilities ?? ["chat"],
      lifecycle: {
        canStream: true,
        canCancel: true,
        canResumeNativeSession: false,
        canListNativeSessions: false,
        cancelSemantics: "kill-wrapper-process",
        resumeSemantics: "scienceSwarm-wrapper-session",
      },
      accountDisclosure: {
        storesTokensInScienceSwarm: false,
        requiresProjectPrivacy: input.requiresProjectPrivacy
          ?? (input.privacyClass === "hosted" ? "cloud-ok" : "local-only"),
      },
      mcpTools: [],
    },
    health: { status: "ready", checkedAt: "2026-04-23T00:00:00.000Z" },
    auth: {
      status: input.authStatus ?? (input.authMode === "local" ? "not-required" : "authenticated"),
      authMode: input.authMode,
      provider: input.authProvider,
    },
    privacy: {
      privacyClass: input.privacyClass,
      adapterProof: input.privacyClass === "hosted" ? "declared-hosted" : "declared-local",
    },
  };
}

describe("RuntimePicker", () => {
  it("keeps hosted runtimes disabled under local-only policy and visible before send", () => {
    render(
      <RuntimePicker
        hosts={[
          host({
            id: "openclaw",
            label: "OpenClaw",
            authMode: "local",
            authProvider: "openclaw",
            privacyClass: "local-network",
          }),
          host({
            id: "codex",
            label: "Codex",
            authMode: "subscription-native",
            authProvider: "openai",
            privacyClass: "hosted",
          }),
        ]}
        selectedHostId="openclaw"
        projectPolicy="local-only"
        mode="chat"
        compareHostIds={["openclaw"]}
        onSelectedHostIdChange={vi.fn()}
        onProjectPolicyChange={vi.fn()}
        onModeChange={vi.fn()}
        onCompareHostIdsChange={vi.fn()}
      />,
    );

    const hostSelect = screen.getByTestId("runtime-host-select");
    expect(within(hostSelect).getByRole("option", {
      name: "Codex - Requires cloud-ok",
    })).toBeDisabled();
    expect(screen.getByTestId("runtime-selected-summary")).toHaveTextContent("OpenClaw");
    expect(screen.getByTestId("runtime-selected-summary")).toHaveTextContent("Local network");
  });

  it("supports keyboard-reachable mode and compare host controls", () => {
    const onModeChange = vi.fn();
    const onCompareHostIdsChange = vi.fn();

    render(
      <RuntimePicker
        hosts={[
          host({
            id: "openclaw",
            label: "OpenClaw",
            authMode: "local",
            authProvider: "openclaw",
            privacyClass: "local-network",
          }),
          host({
            id: "claude-code",
            label: "Claude Code",
            authMode: "subscription-native",
            authProvider: "anthropic",
            privacyClass: "hosted",
          }),
        ]}
        selectedHostId="openclaw"
        projectPolicy="cloud-ok"
        mode="compare"
        compareHostIds={["openclaw"]}
        onSelectedHostIdChange={vi.fn()}
        onProjectPolicyChange={vi.fn()}
        onModeChange={onModeChange}
        onCompareHostIdsChange={onCompareHostIdsChange}
      />,
    );

    fireEvent.click(screen.getByTestId("runtime-mode-task"));
    expect(onModeChange).toHaveBeenCalledWith("task");

    fireEvent.click(screen.getByLabelText("Claude Code"));
    expect(onCompareHostIdsChange).toHaveBeenCalledWith(["openclaw", "claude-code"]);
  });
});
