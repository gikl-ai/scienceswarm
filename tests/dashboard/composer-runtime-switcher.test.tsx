// @vitest-environment jsdom

import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ComposerRuntimeSwitcher } from "@/components/runtime/composer-runtime-switcher";
import type { RuntimeHealthHost } from "@/components/runtime/RuntimeHostMatrix";

function host(input: {
  id: string;
  label: string;
  authProvider: RuntimeHealthHost["auth"]["provider"];
  privacyClass: RuntimeHealthHost["profile"]["privacyClass"];
  authStatus?: RuntimeHealthHost["auth"]["status"];
  healthStatus?: RuntimeHealthHost["health"]["status"];
  capabilities?: RuntimeHealthHost["profile"]["capabilities"];
  requiresProjectPrivacy?: RuntimeHealthHost["profile"]["accountDisclosure"]["requiresProjectPrivacy"];
}): RuntimeHealthHost {
  const authMode = input.id === "openclaw" ? "local" : "subscription-native";
  return {
    profile: {
      id: input.id,
      label: input.label,
      authMode,
      authProvider: input.authProvider,
      privacyClass: input.privacyClass,
      transport: {
        kind: input.id === "openclaw" ? "desktop-bridge" : "local-cli",
        protocol: input.id === "openclaw" ? "websocket" : "stdio",
        command: input.id === "claude-code" ? "claude" : input.id,
      },
      capabilities: input.capabilities ?? ["chat", "task", "stream", "resume"],
      lifecycle: {
        canStream: true,
        canCancel: true,
        canResumeNativeSession: input.id === "claude-code",
        canListNativeSessions: input.id === "claude-code",
        cancelSemantics: "kill-wrapper-process",
        resumeSemantics: input.id === "claude-code" ? "open-native-session" : "none",
      },
      accountDisclosure: {
        storesTokensInScienceSwarm: false,
        requiresProjectPrivacy: input.requiresProjectPrivacy
          ?? (input.privacyClass === "hosted" ? "cloud-ok" : "local-only"),
      },
      mcpTools: [],
    },
    health: {
      status: input.healthStatus ?? "ready",
      checkedAt: "2026-04-23T01:00:00.000Z",
    },
    auth: {
      status: input.authStatus ?? (authMode === "local" ? "not-required" : "authenticated"),
      authMode,
      provider: input.authProvider,
    },
    privacy: {
      privacyClass: input.privacyClass,
      adapterProof: input.privacyClass === "hosted" ? "declared-hosted" : "declared-local",
    },
  };
}

const hosts = [
  host({
    id: "openclaw",
    label: "OpenClaw",
    authProvider: "openclaw",
    privacyClass: "local-network",
  }),
  host({
    id: "claude-code",
    label: "Claude Code",
    authProvider: "anthropic",
    privacyClass: "hosted",
  }),
  host({
    id: "codex",
    label: "Codex",
    authProvider: "openai",
    privacyClass: "hosted",
  }),
  host({
    id: "gemini-cli",
    label: "Gemini CLI",
    authProvider: "google-ai",
    privacyClass: "hosted",
  }),
];

describe("ComposerRuntimeSwitcher", () => {
  it("renders an assistant picker without exposing runtime jargon", async () => {
    const onOpenChange = vi.fn();

    render(
      <ComposerRuntimeSwitcher
        hosts={hosts}
        selectedHostId="claude-code"
        projectPolicy="cloud-ok"
        open={false}
        onOpenChange={onOpenChange}
        onSelectedHostIdChange={vi.fn()}
        onProjectPolicyChange={vi.fn()}
        onModeChange={vi.fn()}
      />,
    );

    const trigger = screen.getByRole("button", { name: "Change assistant" });
    expect(trigger).toHaveAttribute("data-testid", "composer-runtime-trigger");
    expect(within(trigger).getByText("Assistant")).toBeInTheDocument();
    expect(trigger).toHaveTextContent("Claude Code");
    expect(trigger).not.toHaveTextContent("Run with");
    expect(trigger).not.toHaveTextContent("Cloud ok");

    fireEvent.click(trigger);
    expect(onOpenChange).toHaveBeenCalledWith(true);

    render(
      <ComposerRuntimeSwitcher
        hosts={hosts}
        selectedHostId="claude-code"
        projectPolicy="cloud-ok"
        open
        onOpenChange={vi.fn()}
        onSelectedHostIdChange={vi.fn()}
        onProjectPolicyChange={vi.fn()}
        onModeChange={vi.fn()}
      />,
    );

    const dialog = await screen.findByRole("dialog", { name: "Assistant" });
    expect(dialog).toHaveClass("fixed");
    expect(within(dialog).getByText("Assistant")).toBeInTheDocument();
    expect(within(dialog).getByText("Choose who answers this turn.")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "OpenClaw" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Claude Code" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(within(dialog).getByRole("button", { name: "Codex" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Gemini CLI" })).toBeInTheDocument();

    expect(within(dialog).queryByText("Task")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("Compare")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("Data boundary")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("Hosted")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("Execution ok")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("Cloud ok")).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/Uses your signed-in/)).not.toBeInTheDocument();
    expect(within(dialog).queryByText("Private local assistant for ScienceSwarm.")).not.toBeInTheDocument();
  });

  it("selects Claude Code as a plain assistant choice and hides policy details", async () => {
    const onProjectPolicyChange = vi.fn();
    const onSelectedHostIdChange = vi.fn();
    const onModeChange = vi.fn();
    const onOpenChange = vi.fn();

    render(
      <ComposerRuntimeSwitcher
        hosts={hosts}
        selectedHostId="openclaw"
        projectPolicy="local-only"
        open
        onOpenChange={onOpenChange}
        onSelectedHostIdChange={onSelectedHostIdChange}
        onProjectPolicyChange={onProjectPolicyChange}
        onModeChange={onModeChange}
      />,
    );

    const dialog = await screen.findByRole("dialog", { name: "Assistant" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Claude Code" }));

    expect(onProjectPolicyChange).toHaveBeenCalledWith("cloud-ok");
    expect(onModeChange).toHaveBeenCalledWith("chat");
    expect(onSelectedHostIdChange).toHaveBeenCalledWith("claude-code");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("returns to the private local assistant without asking for a mode", async () => {
    const onProjectPolicyChange = vi.fn();
    const onSelectedHostIdChange = vi.fn();
    const onModeChange = vi.fn();
    const onOpenChange = vi.fn();

    render(
      <ComposerRuntimeSwitcher
        hosts={hosts}
        selectedHostId="codex"
        projectPolicy="cloud-ok"
        open
        onOpenChange={onOpenChange}
        onSelectedHostIdChange={onSelectedHostIdChange}
        onProjectPolicyChange={onProjectPolicyChange}
        onModeChange={onModeChange}
      />,
    );

    const dialog = await screen.findByRole("dialog", { name: "Assistant" });
    fireEvent.click(within(dialog).getByRole("button", { name: "OpenClaw" }));

    expect(onProjectPolicyChange).toHaveBeenCalledWith("local-only");
    expect(onModeChange).toHaveBeenCalledWith("chat");
    expect(onSelectedHostIdChange).toHaveBeenCalledWith("openclaw");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
