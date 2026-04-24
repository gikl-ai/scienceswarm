// @vitest-environment jsdom

import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  RuntimeHostMatrix,
  runtimeHostSelectableForDefault,
  type RuntimeHealthHost,
  type RuntimeHealthResponse,
} from "@/components/runtime/RuntimeHostMatrix";
import { RuntimeAccountSetupGuide } from "@/components/runtime/RuntimeAccountSetupGuide";
import { RuntimeDefaultsForm } from "@/components/runtime/RuntimeDefaultsForm";
import { RuntimeSetupCallouts } from "@/components/runtime/RuntimeSetupCallouts";

function host(input: {
  id: string;
  label: string;
  authMode: "local" | "subscription-native" | "api-key";
  authProvider:
    | "openclaw"
    | "anthropic"
    | "openai"
    | "google-ai"
    | "vertex-ai"
    | "ollama"
    | "openhands";
  privacyClass: "local-only" | "local-network" | "hosted" | "external-network";
  healthStatus?: "ready" | "unavailable" | "misconfigured";
  healthDetail?: string;
  authStatus?: "not-required" | "authenticated" | "missing" | "invalid" | "unknown";
  capabilities?: RuntimeHealthHost["profile"]["capabilities"];
  command?: string;
  mcpTools?: string[];
  canCancel?: boolean;
  canResumeNativeSession?: boolean;
  canListNativeSessions?: boolean;
  requiresProjectPrivacy?: "local-only" | "cloud-ok" | "execution-ok";
}): RuntimeHealthHost {
  return {
    profile: {
      id: input.id,
      label: input.label,
      authMode: input.authMode,
      authProvider: input.authProvider,
      privacyClass: input.privacyClass,
      transport: {
        kind: input.authMode === "api-key" ? "http" : "cli",
        protocol: input.authMode === "api-key" ? "https" : "stdio",
        command: input.command,
      },
      capabilities: input.capabilities ?? ["chat"],
      lifecycle: {
        canStream: true,
        canCancel: input.canCancel ?? false,
        canResumeNativeSession: input.canResumeNativeSession ?? false,
        canListNativeSessions: input.canListNativeSessions ?? false,
        cancelSemantics: input.canCancel ? "kill-wrapper-process" : "none",
        resumeSemantics: input.canResumeNativeSession
          ? "open-native-session"
          : "none",
      },
      accountDisclosure: {
        storesTokensInScienceSwarm: input.authMode === "api-key"
          ? "api-key-only"
          : false,
        requiresProjectPrivacy: input.requiresProjectPrivacy
          ?? (input.privacyClass === "hosted" ? "cloud-ok" : "local-only"),
      },
      mcpTools: input.mcpTools ?? [],
    },
    health: {
      status: input.healthStatus ?? "ready",
      checkedAt: "2026-04-23T01:00:00.000Z",
      detail: input.healthDetail,
    },
    auth: {
      status: input.authStatus ?? (input.authMode === "local" ? "not-required" : "authenticated"),
      authMode: input.authMode,
      provider: input.authProvider,
      accountLabel: input.authMode === "api-key" ? "sk-live-secret-value" : undefined,
    },
    privacy: {
      privacyClass: input.privacyClass,
      adapterProof: input.privacyClass === "hosted"
        ? "declared-hosted"
        : "declared-local",
      observedAt: "2026-04-23T01:00:00.000Z",
    },
  };
}

function runtimeHealth(hosts: RuntimeHealthHost[]): RuntimeHealthResponse {
  return {
    hosts,
    checkedAt: "2026-04-23T01:00:00.000Z",
  };
}

describe("RuntimeHostMatrix", () => {
  it("shows credential ownership without exposing subscription or API-key secrets", () => {
    render(
      <RuntimeHostMatrix
        runtimeHealth={runtimeHealth([
          host({
            id: "claude-code",
            label: "Claude Code",
            authMode: "subscription-native",
            authProvider: "anthropic",
            privacyClass: "hosted",
            command: "claude",
            mcpTools: ["gbrain_search"],
          }),
          host({
            id: "openai-api",
            label: "OpenAI API key",
            authMode: "api-key",
            authProvider: "openai",
            privacyClass: "hosted",
          }),
        ])}
      />,
    );

    expect(screen.getByText("Claude Code")).toBeInTheDocument();
    expect(screen.getByText("Uses native CLI login; ScienceSwarm stores no subscription tokens")).toBeInTheDocument();
    expect(screen.getByText(".env source; key value hidden")).toBeInTheDocument();
    expect(screen.queryByText("sk-live-secret-value")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: /token|key/i })).not.toBeInTheDocument();
  });

  it("renders capability and lifecycle truth from the health response", () => {
    render(
      <RuntimeHostMatrix
        runtimeHealth={runtimeHealth([
          host({
            id: "codex",
            label: "Codex",
            authMode: "subscription-native",
            authProvider: "openai",
            privacyClass: "hosted",
            capabilities: ["chat", "task", "mcp-tools"],
            canCancel: true,
            canResumeNativeSession: true,
            canListNativeSessions: false,
            mcpTools: ["gbrain_search", "gbrain_capture"],
          }),
          host({
            id: "openhands",
            label: "OpenHands",
            authMode: "local",
            authProvider: "openhands",
            privacyClass: "local-network",
            capabilities: ["task", "mcp-tools"],
          }),
        ])}
      />,
    );

    expect(screen.getByTitle("Codex supports Chat")).toHaveTextContent("Yes");
    expect(screen.getByTitle("Codex supports Compare")).toHaveTextContent("Yes");
    expect(screen.getByTitle("No compare")).toHaveTextContent("No");
    expect(screen.getByTitle("Codex supports MCP tools")).toHaveTextContent("Yes");
    expect(screen.getAllByTitle("No import")[0]).toHaveTextContent("No");
    expect(screen.getByText("wrapper process stop; native session resume")).toBeInTheDocument();
    expect(screen.getByText("2 MCP tools exposed")).toBeInTheDocument();
  });
});

describe("RuntimeDefaultsForm", () => {
  it("blocks hosted defaults under local-only policy", () => {
    const onSelectedHostIdChange = vi.fn();
    const onPolicyChange = vi.fn();
    const hosts = [
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
    ];

    render(
      <RuntimeDefaultsForm
        hosts={hosts}
        selectedHostId="openclaw"
        policy="local-only"
        onSelectedHostIdChange={onSelectedHostIdChange}
        onPolicyChange={onPolicyChange}
      />,
    );

    const select = screen.getByTestId("runtime-default-host-select");
    expect(within(select).getByRole("option", {
      name: "Codex - Blocked by current policy",
    })).toBeDisabled();
    expect(runtimeHostSelectableForDefault(hosts[1], "local-only")).toBe(false);

    fireEvent.change(screen.getByTestId("runtime-policy-select"), {
      target: { value: "cloud-ok" },
    });

    expect(onPolicyChange).toHaveBeenCalledWith("cloud-ok");
  });

  it("keeps API-key hosts with unknown auth status out of default selection", () => {
    const hosts = [
      host({
        id: "openclaw",
        label: "OpenClaw",
        authMode: "local",
        authProvider: "openclaw",
        privacyClass: "local-network",
      }),
      host({
        id: "openai-api",
        label: "OpenAI API key",
        authMode: "api-key",
        authProvider: "openai",
        privacyClass: "hosted",
        authStatus: "unknown",
      }),
    ];

    render(
      <RuntimeDefaultsForm
        hosts={hosts}
        selectedHostId="openclaw"
        policy="cloud-ok"
        onSelectedHostIdChange={vi.fn()}
        onPolicyChange={vi.fn()}
      />,
    );

    const select = screen.getByTestId("runtime-default-host-select");
    expect(within(select).getByRole("option", {
      name: "OpenAI API key - Login or .env setup required",
    })).toBeDisabled();
    expect(runtimeHostSelectableForDefault(hosts[1], "cloud-ok")).toBe(false);
  });

  it("allows ready subscription CLIs with host-owned auth checks as draft defaults", () => {
    const hosts = [
      host({
        id: "openclaw",
        label: "OpenClaw",
        authMode: "local",
        authProvider: "openclaw",
        privacyClass: "local-network",
      }),
      host({
        id: "gemini-cli",
        label: "Gemini CLI",
        authMode: "subscription-native",
        authProvider: "google-ai",
        privacyClass: "hosted",
        authStatus: "unknown",
      }),
    ];

    render(
      <RuntimeDefaultsForm
        hosts={hosts}
        selectedHostId="gemini-cli"
        policy="cloud-ok"
        onSelectedHostIdChange={vi.fn()}
        onPolicyChange={vi.fn()}
      />,
    );

    const select = screen.getByTestId("runtime-default-host-select");
    expect(within(select).getByRole("option", {
      name: "Gemini CLI",
    })).not.toBeDisabled();
    expect(screen.getByText("The native CLI owns sign-in; first send can surface host login if needed.")).toBeInTheDocument();
    expect(runtimeHostSelectableForDefault(hosts[1], "cloud-ok")).toBe(true);
  });
});

describe("RuntimeAccountSetupGuide", () => {
  it("shows exact provider CLI commands without asking for subscription tokens", () => {
    render(
      <RuntimeAccountSetupGuide
        hosts={[
          host({
            id: "claude-code",
            label: "Claude Code",
            authMode: "subscription-native",
            authProvider: "anthropic",
            privacyClass: "hosted",
            authStatus: "missing",
          }),
          host({
            id: "codex",
            label: "Codex",
            authMode: "subscription-native",
            authProvider: "openai",
            privacyClass: "hosted",
          }),
          host({
            id: "gemini-cli",
            label: "Gemini CLI",
            authMode: "subscription-native",
            authProvider: "google-ai",
            privacyClass: "hosted",
            authStatus: "unknown",
          }),
        ]}
      />,
    );

    expect(screen.getByText("No tokens stored")).toBeInTheDocument();
    expect(screen.getByText("npm install -g @anthropic-ai/claude-code")).toBeInTheDocument();
    expect(screen.getByText("claude auth login")).toBeInTheDocument();
    expect(screen.getByText("codex login status")).toBeInTheDocument();
    expect(screen.getByText("npm install -g @google/gemini-cli")).toBeInTheDocument();
    expect(screen.getAllByText("gemini")).toHaveLength(2);
    expect(screen.getByText("Choose Login with Google when Gemini asks how to authenticate.")).toBeInTheDocument();
    expect(screen.getByText("If Gemini opens without asking for an auth method, its native CLI session is usable.")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: /token|key/i })).not.toBeInTheDocument();
  });
});

describe("RuntimeSetupCallouts", () => {
  it("shows setup actions for unavailable hosts without claiming readiness", () => {
    render(
      <RuntimeSetupCallouts
        hosts={[
          host({
            id: "openhands",
            label: "OpenHands",
            authMode: "local",
            authProvider: "openhands",
            privacyClass: "local-network",
            healthStatus: "unavailable",
            healthDetail: "OpenHands service is not reachable.",
            authStatus: "unknown",
          }),
        ]}
      />,
    );

    expect(screen.getByText("OpenHands service is not reachable.")).toBeInTheDocument();
    expect(screen.getByText("Install and start the local OpenHands service.")).toBeInTheDocument();
    expect(screen.queryByText("Ready.")).not.toBeInTheDocument();
  });

  it("uses exact native CLI setup commands for subscription hosts", () => {
    render(
      <RuntimeSetupCallouts
        hosts={[
          host({
            id: "codex",
            label: "Codex",
            authMode: "subscription-native",
            authProvider: "openai",
            privacyClass: "hosted",
            healthStatus: "unavailable",
            authStatus: "missing",
          }),
        ]}
      />,
    );

    expect(screen.getByText("Install with npm install -g @openai/codex, then run codex login.")).toBeInTheDocument();
  });

  it("does not flag ready subscription hosts with CLI-owned auth as setup blockers", () => {
    render(
      <RuntimeSetupCallouts
        hosts={[
          host({
            id: "gemini-cli",
            label: "Gemini CLI",
            authMode: "subscription-native",
            authProvider: "google-ai",
            privacyClass: "hosted",
            authStatus: "unknown",
          }),
        ]}
      />,
    );

    expect(screen.getByText("Runtime hosts reported ready setup state.")).toBeInTheDocument();
    expect(screen.queryByText("Authentication status is unknown.")).not.toBeInTheDocument();
  });
});
