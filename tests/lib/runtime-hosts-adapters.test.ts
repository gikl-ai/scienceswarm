import { describe, expect, it } from "vitest";

import { createApiKeyRuntimeHostAdapter, createApiKeyRuntimeHostProfile } from "@/lib/runtime-hosts/adapters/api-key";
import { createClaudeCodeRuntimeHostAdapter } from "@/lib/runtime-hosts/adapters/claude-code";
import { createCodexRuntimeHostAdapter } from "@/lib/runtime-hosts/adapters/codex";
import { createGeminiCliRuntimeHostAdapter } from "@/lib/runtime-hosts/adapters/gemini-cli";
import {
  RuntimeHostCapabilityUnsupported,
  RuntimePreviewApprovalRequired,
  RuntimePrivacyBlocked,
  computeTurnPreview,
  requireRuntimeHostProfile,
  type RuntimeHostProfile,
  type RuntimeTurnMode,
  type RuntimeTurnRequest,
} from "@/lib/runtime-hosts";
import {
  RuntimeCliAuthRequiredError,
  RuntimeCliTimeoutError,
  type CliTransport,
  type CliTransportRunRequest,
  type CliTransportRunResult,
} from "@/lib/runtime-hosts/transport/cli";
import {
  RuntimeCliMalformedOutputError,
  normalizeCliOutput,
} from "@/lib/runtime-hosts/transport/output-normalizer";
import type { SavedLlmRuntimeEnv } from "@/lib/runtime-saved-env";

class FakeCliTransport implements CliTransport {
  readonly requests: CliTransportRunRequest[] = [];
  cancelResult = false;

  constructor(
    private readonly handler: (
      request: CliTransportRunRequest,
    ) => Promise<CliTransportRunResult> | CliTransportRunResult,
  ) {}

  async run(request: CliTransportRunRequest): Promise<CliTransportRunResult> {
    this.requests.push(request);
    return await this.handler(request);
  }

  async cancel(_sessionId: string): Promise<boolean> {
    return this.cancelResult;
  }
}

const baseEnv: SavedLlmRuntimeEnv = {
  strictLocalOnly: false,
  llmProvider: "openai",
  llmModel: null,
  ollamaModel: null,
  anthropicApiKey: null,
  openaiApiKey: null,
  googleAiApiKey: null,
  googleApiKey: null,
  vertexAiApiKey: null,
  vertexAiProject: null,
  vertexAiLocation: null,
  agentBackend: null,
  agentUrl: null,
  agentApiKey: null,
  openclawInternalApiKey: null,
};

function fakeResult(
  request: CliTransportRunRequest,
  stdout: string,
): CliTransportRunResult {
  return {
    command: request.command,
    args: request.args ?? [],
    exitCode: 0,
    signal: null,
    output: normalizeCliOutput({ stdout }),
  };
}

function requestFor(
  profile: RuntimeHostProfile,
  mode: RuntimeTurnMode,
  approvalState: RuntimeTurnRequest["approvalState"] = "approved",
): RuntimeTurnRequest {
  const preview = computeTurnPreview({
    projectPolicy: mode === "task" ? "execution-ok" : "cloud-ok",
    host: profile,
    mode,
    dataIncluded: [{ kind: "prompt", label: "project-alpha prompt", bytes: 20 }],
  });

  return {
    hostId: profile.id,
    projectId: "project-alpha",
    conversationId: "conversation-alpha",
    mode,
    prompt: "Summarize project-alpha.",
    inputFileRefs: [],
    dataIncluded: preview.dataIncluded,
    approvalState,
    preview,
  };
}

describe("runtime host adapters", () => {
  it("detects Claude Code health/auth and sends approved turns through the CLI transport", async () => {
    const transport = new FakeCliTransport((request) => {
      if (request.args?.includes("--version")) {
        return fakeResult(request, "claude 2.0.0");
      }
      if (request.args?.includes("whoami")) {
        return fakeResult(request, "user@example.test");
      }
      return fakeResult(request, "\u001b[32m{\"message\":\"Claude answer\"}\u001b[0m");
    });
    const adapter = createClaudeCodeRuntimeHostAdapter({
      transport,
      authArgs: ["whoami"],
      sessionIdGenerator: () => "session-1",
    });

    await expect(adapter.health()).resolves.toMatchObject({ status: "ready" });
    await expect(adapter.authStatus()).resolves.toMatchObject({
      status: "authenticated",
      accountLabel: "user@example.test",
    });

    await expect(
      adapter.sendTurn(requestFor(requireRuntimeHostProfile("claude-code"), "chat")),
    ).resolves.toMatchObject({
      hostId: "claude-code",
      sessionId: "conversation-alpha",
      message: "Claude answer",
    });
    expect(transport.requests.at(-1)).toMatchObject({
      command: "claude",
      args: expect.arrayContaining(["-p", "Summarize project-alpha."]),
    });
  });

  it("surfaces Codex auth-required and timeout transport failures as typed errors", async () => {
    const authTransport = new FakeCliTransport((request) => {
      throw new RuntimeCliAuthRequiredError({
        hostId: "codex",
        command: request.command,
      });
    });
    const timeoutTransport = new FakeCliTransport((request) => {
      throw new RuntimeCliTimeoutError({
        hostId: "codex",
        command: request.command,
        timeoutMs: 10,
      });
    });

    await expect(
      createCodexRuntimeHostAdapter({
        transport: authTransport,
        authArgs: ["auth", "status"],
      }).authStatus(),
    ).resolves.toMatchObject({ status: "missing" });

    await expect(
      createCodexRuntimeHostAdapter({ transport: timeoutTransport }).sendTurn(
        requestFor(requireRuntimeHostProfile("codex"), "chat"),
      ),
    ).rejects.toThrow(RuntimeCliTimeoutError);
  });

  it("surfaces malformed Gemini CLI output from the shared normalizer", async () => {
    const transport = new FakeCliTransport(() => {
      throw new RuntimeCliMalformedOutputError({
        hostId: "gemini-cli",
        command: "gemini",
        detail: "bad json",
      });
    });

    await expect(
      createGeminiCliRuntimeHostAdapter({ transport }).sendTurn(
        requestFor(requireRuntimeHostProfile("gemini-cli"), "chat"),
      ),
    ).rejects.toThrow(RuntimeCliMalformedOutputError);
  });

  it("rejects blocked or unapproved previews before transport receives prompt text", async () => {
    const transport = new FakeCliTransport((request) => fakeResult(request, "ok"));
    const adapter = createCodexRuntimeHostAdapter({ transport });
    const codex = requireRuntimeHostProfile("codex");
    const blockedPreview = computeTurnPreview({
      projectPolicy: "local-only",
      host: codex,
      mode: "chat",
      dataIncluded: [{ kind: "prompt", label: "project-alpha prompt", bytes: 20 }],
    });
    const blockedRequest: RuntimeTurnRequest = {
      ...requestFor(codex, "chat"),
      preview: blockedPreview,
    };
    const unapprovedRequest = requestFor(codex, "chat", "required");

    await expect(adapter.sendTurn(blockedRequest)).rejects.toThrow(
      RuntimePrivacyBlocked,
    );
    await expect(adapter.sendTurn(unapprovedRequest)).rejects.toThrow(
      RuntimePreviewApprovalRequired,
    );
    expect(transport.requests).toHaveLength(0);
  });

  it("reports honest cancel and unsupported list/session capabilities", async () => {
    const transport = new FakeCliTransport((request) => fakeResult(request, "ok"));
    transport.cancelResult = true;
    const adapter = createGeminiCliRuntimeHostAdapter({ transport });

    await expect(adapter.cancel("rt-session-1")).resolves.toMatchObject({
      cancelled: true,
    });
    await expect(adapter.listSessions("project-alpha")).rejects.toThrow(
      RuntimeHostCapabilityUnsupported,
    );
  });

  it("keeps API-key auth status masked and exposes .env cost disclosure through preview metadata", async () => {
    const profile = createApiKeyRuntimeHostProfile("openai");
    const adapter = createApiKeyRuntimeHostAdapter({
      provider: "openai",
      profile,
      env: {
        ...baseEnv,
        openaiApiKey: "placeholder-openai-key",
      },
      client: {
        async sendTurn() {
          return { message: "OpenAI API answer" };
        },
      },
      sessionIdGenerator: () => "session-1",
    });
    const preview = computeTurnPreview({
      projectPolicy: "cloud-ok",
      host: profile,
      mode: "chat",
      dataIncluded: [{ kind: "prompt", label: "project-alpha prompt", bytes: 42 }],
    });

    expect(preview).toMatchObject({
      requiresUserApproval: true,
      accountDisclosure: {
        authMode: "api-key",
        provider: "openai",
        billingClass: "api-key",
        accountSource: ".env",
        estimatedRequestBytes: 42,
        costCopyRequired: true,
      },
    });
    await expect(adapter.authStatus()).resolves.toMatchObject({
      status: "authenticated",
      accountLabel: "openai API key configured in .env",
    });
    await expect(adapter.authStatus()).resolves.not.toMatchObject({
      accountLabel: expect.stringContaining("placeholder-openai-key"),
    });
    await expect(
      adapter.sendTurn({
        ...requestFor(profile, "chat"),
        preview,
      }),
    ).resolves.toMatchObject({
      message: "OpenAI API answer",
    });
    await expect(adapter.executeTask(requestFor(profile, "task"))).rejects.toThrow(
      RuntimeHostCapabilityUnsupported,
    );
  });

  it("marks API-key hosts unavailable when their .env credential is absent", async () => {
    const adapter = createApiKeyRuntimeHostAdapter({
      provider: "anthropic",
      env: baseEnv,
    });

    await expect(adapter.health()).resolves.toMatchObject({
      status: "unavailable",
    });
    await expect(adapter.authStatus()).resolves.toMatchObject({
      status: "missing",
      provider: "anthropic",
    });
  });
});
