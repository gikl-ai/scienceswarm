import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createApiKeyRuntimeHostAdapter, createApiKeyRuntimeHostProfile } from "@/lib/runtime-hosts/adapters/api-key";
import { buildClaudeCodeRuntimeContext } from "@/lib/runtime-hosts/adapters/claude-code-context";
import { createClaudeCodeRuntimeHostAdapter } from "@/lib/runtime-hosts/adapters/claude-code";
import { createCodexRuntimeHostAdapter } from "@/lib/runtime-hosts/adapters/codex";
import { createGeminiCliRuntimeHostAdapter } from "@/lib/runtime-hosts/adapters/gemini-cli";
import { createOpenClawRuntimeHostAdapter } from "@/lib/runtime-hosts/adapters/openclaw";
import {
  RuntimeHostCapabilityUnsupported,
  RuntimeHostError,
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
import {
  ClaudeCodeStreamAccumulator,
  parseClaudeCodeStreamOutput,
} from "@/lib/runtime-hosts/transport/claude-code-stream";
import { runtimeRunIdFromSessionId } from "@/lib/runtime-hosts/workspace";
import type { SavedLlmRuntimeEnv } from "@/lib/runtime-saved-env";

const noClaudeRuntimeContext = async () => null;

function createTestClaudeCodeRuntimeHostAdapter(
  options: Parameters<typeof createClaudeCodeRuntimeHostAdapter>[0] = {},
) {
  return createClaudeCodeRuntimeHostAdapter({
    contextBuilder: noClaudeRuntimeContext,
    ...options,
  });
}

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
  stderr?: string,
): CliTransportRunResult {
  return {
    command: request.command,
    args: request.args ?? [],
    exitCode: 0,
    signal: null,
    output: normalizeCliOutput({ stdout, stderr }),
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
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("detects Claude Code health/auth and sends approved turns through the CLI transport", async () => {
    const transport = new FakeCliTransport((request) => {
      if (request.args?.includes("--version")) {
        return fakeResult(request, "claude 2.0.0");
      }
      if (request.args?.includes("whoami")) {
        return fakeResult(request, "user@example.test");
      }
      return fakeResult(
        request,
        [
          "{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"claude-native-session\"}",
          "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"Claude draft\"}]}}",
          "{\"type\":\"result\",\"result\":\"Claude answer\",\"session_id\":\"claude-native-session\"}",
        ].join("\n"),
      );
    });
    const adapter = createTestClaudeCodeRuntimeHostAdapter({
      transport,
      authArgs: ["whoami"],
      sessionIdGenerator: () => "session-1",
    });

    await expect(adapter.health()).resolves.toMatchObject({ status: "ready" });
    const authStatus = await adapter.authStatus();
    expect(authStatus).toMatchObject({
      status: "authenticated",
      detail: "CLI authentication is managed by the native host.",
    });
    expect(authStatus).not.toHaveProperty("accountLabel");

    await expect(
      adapter.sendTurn(requestFor(requireRuntimeHostProfile("claude-code"), "chat")),
    ).resolves.toMatchObject({
      hostId: "claude-code",
      sessionId: "claude-native-session",
      message: "Claude answer",
    });
    expect(transport.requests.at(-1)).toMatchObject({
      command: "claude",
      args: expect.arrayContaining([
        "-p",
        "Summarize project-alpha.",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--resume",
        "conversation-alpha",
      ]),
    });
  });

  it("redacts raw subscription-native CLI auth output from status details", async () => {
    const rawIdentity = JSON.stringify({
      account: {
        email: "private-user@example.test",
        id: "acct-secret-123",
      },
      organization: "private-org",
    });
    const transport = new FakeCliTransport((request) => {
      if (request.args?.includes("whoami")) {
        return fakeResult(
          request,
          rawIdentity,
          "subscription private-user@example.test",
        );
      }
      return fakeResult(request, "claude 2.0.0");
    });
    const adapter = createTestClaudeCodeRuntimeHostAdapter({
      transport,
      authArgs: ["whoami"],
    });

    await expect(adapter.authStatus()).resolves.toEqual({
      status: "authenticated",
      authMode: "subscription-native",
      provider: "anthropic",
      detail: "CLI authentication is managed by the native host.",
    });
  });

  it("starts fresh Claude Code sessions without resume args when no native session exists", async () => {
    const generatedSessionId = "11111111-1111-4111-8111-111111111111";
    const transport = new FakeCliTransport((request) =>
      fakeResult(request, `{"type":"result","result":"Fresh answer","session_id":"${generatedSessionId}"}`)
    );
    const adapter = createTestClaudeCodeRuntimeHostAdapter({
      transport,
      sessionIdGenerator: () => generatedSessionId,
    });
    const request = {
      ...requestFor(requireRuntimeHostProfile("claude-code"), "chat"),
      conversationId: null,
    };

    await expect(adapter.sendTurn(request)).resolves.toMatchObject({
      sessionId: generatedSessionId,
      message: "Fresh answer",
    });
    expect(transport.requests.at(-1)?.args).not.toContain("--resume");
    expect(transport.requests.at(-1)?.args).toEqual(expect.arrayContaining([
      "--session-id",
      generatedSessionId,
    ]));
  });

  it("does not resume Claude Code with synthetic wrapper session ids", async () => {
    const generatedSessionId = "22222222-2222-4222-8222-222222222222";
    const transport = new FakeCliTransport((request) =>
      fakeResult(request, `{"type":"result","result":"Wrapper answer","session_id":"${generatedSessionId}"}`)
    );
    const adapter = createTestClaudeCodeRuntimeHostAdapter({
      transport,
      sessionIdGenerator: () => generatedSessionId,
    });
    const request = {
      ...requestFor(requireRuntimeHostProfile("claude-code"), "chat"),
      conversationId: "claude-code-wrapper-session",
    };

    await expect(adapter.sendTurn(request)).resolves.toMatchObject({
      sessionId: generatedSessionId,
      message: "Wrapper answer",
    });
    expect(transport.requests.at(-1)?.args).not.toContain("--resume");
    expect(transport.requests.at(-1)?.args).toEqual(expect.arrayContaining([
      "--session-id",
      generatedSessionId,
    ]));
  });

  it("tracks the ScienceSwarm runtime session id while resuming Claude Code native sessions", async () => {
    const transport = new FakeCliTransport((request) =>
      fakeResult(request, "{\"type\":\"result\",\"result\":\"Resumed answer\",\"session_id\":\"claude-native-existing\"}")
    );
    const adapter = createTestClaudeCodeRuntimeHostAdapter({
      transport,
      sessionIdGenerator: () => "66666666-6666-4666-8666-666666666666",
    });

    await expect(
      adapter.sendTurn({
        ...requestFor(requireRuntimeHostProfile("claude-code"), "chat"),
        runtimeSessionId: "rt-session-cancel-target",
        conversationId: "claude-native-existing",
      }),
    ).resolves.toMatchObject({
      sessionId: "claude-native-existing",
      message: "Resumed answer",
    });
    expect(transport.requests.at(-1)).toMatchObject({
      sessionId: "rt-session-cancel-target",
      args: expect.arrayContaining(["--resume", "claude-native-existing"]),
    });
    expect(transport.requests.at(-1)?.args).not.toContain("--session-id");
  });

  it("keeps wrapper, native, run, and workspace identities distinct for Claude Code", async () => {
    const generatedSessionId = "33333333-3333-4333-8333-333333333333";
    const contextLaunches: Array<{
      wrapperSessionId: string;
      nativeSessionId: string;
      runId: string;
    }> = [];
    const transport = new FakeCliTransport((request) => {
      const sessionIdIndex = request.args?.indexOf("--session-id") ?? -1;
      const resumeIndex = request.args?.indexOf("--resume") ?? -1;
      const sessionIdArg = sessionIdIndex >= 0 ? request.args?.[sessionIdIndex + 1] : undefined;
      const resumeArg = resumeIndex >= 0 ? request.args?.[resumeIndex + 1] : undefined;
      return fakeResult(
        request,
        JSON.stringify({
          type: "result",
          result: resumeArg ? "Resumed answer" : "Fresh answer",
          session_id: resumeArg ?? sessionIdArg,
        }),
      );
    });
    const adapter = createClaudeCodeRuntimeHostAdapter({
      transport,
      sessionIdGenerator: () => generatedSessionId,
      contextBuilder: async (input) => {
        contextLaunches.push({
          wrapperSessionId: input.wrapperSessionId,
          nativeSessionId: input.nativeSessionId,
          runId: input.runId,
        });
        return {
          cwd: "/tmp/scienceswarm/workspaces/studies/study_project-alpha",
          launchBundlePath: `/tmp/scienceswarm/runtime/runs/${input.runId}/claude-code`,
          agentWorkspaceId: "workspace_project-alpha",
        };
      },
    });

    await expect(
      adapter.sendTurn({
        ...requestFor(requireRuntimeHostProfile("claude-code"), "chat"),
        runtimeSessionId: "rt-session-first",
        conversationId: null,
      }),
    ).resolves.toMatchObject({
      sessionId: generatedSessionId,
      message: "Fresh answer",
    });
    await expect(
      adapter.sendTurn({
        ...requestFor(requireRuntimeHostProfile("claude-code"), "chat"),
        runtimeSessionId: "rt-session-second",
        conversationId: generatedSessionId,
      }),
    ).resolves.toMatchObject({
      sessionId: generatedSessionId,
      message: "Resumed answer",
    });

    expect(contextLaunches).toEqual([
      {
        wrapperSessionId: "rt-session-first",
        nativeSessionId: generatedSessionId,
        runId: "run_rt-session-first",
      },
      {
        wrapperSessionId: "rt-session-second",
        nativeSessionId: generatedSessionId,
        runId: "run_rt-session-second",
      },
    ]);
    expect(transport.requests[0]?.cwd).toBe("/tmp/scienceswarm/workspaces/studies/study_project-alpha");
    expect(transport.requests[0]?.args).toEqual(expect.arrayContaining([
      "--session-id",
      generatedSessionId,
    ]));
    expect(transport.requests[1]?.cwd).toBe("/tmp/scienceswarm/workspaces/studies/study_project-alpha");
    expect(transport.requests[1]?.args).toEqual(expect.arrayContaining([
      "--resume",
      generatedSessionId,
    ]));
    expect(transport.requests[1]?.args).not.toContain("--session-id");
  });

  it("normalizes wrapper session ids into schema-safe runtime run ids", () => {
    expect(runtimeRunIdFromSessionId("My-Session.1")).toBe("run_my-session-1");
    expect(runtimeRunIdFromSessionId("  Mixed.Case/Session  ")).toBe("run_mixed-case-session");
  });

  it("starts a fresh Claude Code session when an old resume id is missing", async () => {
    const recoveredSessionId = "44444444-4444-4444-8444-444444444444";
    const transport = new FakeCliTransport((request) => {
      if (request.args?.includes("--resume")) {
        throw new RuntimeHostError({
          code: "RUNTIME_TRANSPORT_ERROR",
          status: 502,
          message: "Runtime CLI exited with code 1: claude",
          userMessage: "Claude Code command failed. Detail: No conversation found with session ID: stale-native-session",
          recoverable: true,
          context: {
            hostId: "claude-code",
            stderr: "No conversation found with session ID: stale-native-session",
          },
        });
      }
      return fakeResult(
        request,
        `{"type":"result","result":"Recovered answer","session_id":"${recoveredSessionId}"}`,
      );
    });
    const adapter = createTestClaudeCodeRuntimeHostAdapter({
      transport,
      sessionIdGenerator: () => recoveredSessionId,
    });

    await expect(
      adapter.sendTurn({
        ...requestFor(requireRuntimeHostProfile("claude-code"), "chat"),
        runtimeSessionId: "rt-session-retry",
        conversationId: "stale-native-session",
      }),
    ).resolves.toMatchObject({
      sessionId: recoveredSessionId,
      message: "Recovered answer",
    });

    expect(transport.requests).toHaveLength(2);
    expect(transport.requests[0]?.args).toEqual(expect.arrayContaining([
      "--resume",
      "stale-native-session",
    ]));
    expect(transport.requests[1]?.args).toEqual(expect.arrayContaining([
      "--session-id",
      recoveredSessionId,
    ]));
    expect(transport.requests[1]?.args).not.toContain("--resume");
  });

  it("preserves Claude Code native sessions and output events for task turns", async () => {
    const transport = new FakeCliTransport((request) =>
      fakeResult(
        request,
        [
          "{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"claude-task-native\"}",
          "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"Task draft\"}]}}",
          "{\"type\":\"result\",\"result\":\"Task answer\",\"session_id\":\"claude-task-native\"}",
        ].join("\n"),
      )
    );
    const adapter = createTestClaudeCodeRuntimeHostAdapter({
      transport,
      sessionIdGenerator: () => "wrapper-session",
    });

    await expect(
      adapter.executeTask({
        ...requestFor(requireRuntimeHostProfile("claude-code"), "task"),
        runtimeSessionId: "rt-session-task",
        conversationId: null,
      }),
    ).resolves.toMatchObject({
      id: "claude-task-native",
      conversationId: "claude-task-native",
      status: "completed",
      events: expect.arrayContaining([
        expect.objectContaining({
          sessionId: "rt-session-task",
          type: "message",
          payload: expect.objectContaining({
            text: "Task answer",
            nativeSessionId: "claude-task-native",
          }),
        }),
      ]),
    });
    expect(transport.requests.at(-1)).toMatchObject({
      sessionId: "rt-session-task",
    });
    expect(transport.requests.at(-1)?.args).not.toContain("--resume");
  });

  it("launches Claude Code from a stable Study workspace with per-run LaunchBundles", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "scienceswarm-claude-context-"));
    try {
      const dataRoot = path.join(tempRoot, "data");
      const brainRoot = path.join(dataRoot, "brain");
      const projectRoot = path.join(dataRoot, "projects", "project-alpha");
      const nativeSessionId = "55555555-5555-4555-8555-555555555555";
      await mkdir(projectRoot, { recursive: true });
      await mkdir(brainRoot, { recursive: true });
      await writeFile(
        path.join(projectRoot, "SCIENCESWARM.md"),
        [
          "---",
          "allowedTools:",
          "  - brain-read",
          "---",
          "# Project Alpha",
          "",
          "Use narrow gbrain reads.",
        ].join("\n"),
        "utf8",
      );
      await writeFile(
        path.join(brainRoot, "BRAIN.md"),
        "# BRAIN.md\n\n## Preferences\nserendipity_rate: 0.1\n",
        "utf8",
      );
      vi.stubEnv("SCIENCESWARM_DIR", dataRoot);
      vi.stubEnv("BRAIN_ROOT", brainRoot);
      const repoRoot = process.cwd();
      const repoBinDir = path.join(repoRoot, "node_modules", ".bin");
      const repoGbrainBin = path.join(
        repoBinDir,
        process.platform === "win32" ? "gbrain.cmd" : "gbrain",
      );

      type CapturedMcpConfig = {
        mcpServers: {
          scienceswarm: {
            command: string;
            args: string[];
            env: Record<string, string>;
          };
        };
      };
      const mcpConfigsAtLaunch: CapturedMcpConfig[] = [];
      const mcpConfigPathsAtLaunch: string[] = [];
      const transport = new FakeCliTransport(async (request) => {
        const mcpConfigIndex = request.args?.indexOf("--mcp-config") ?? -1;
        const mcpConfigPath = request.args?.[mcpConfigIndex + 1] ?? "";
        mcpConfigPathsAtLaunch.push(mcpConfigPath);
        mcpConfigsAtLaunch.push(JSON.parse(await readFile(mcpConfigPath, "utf8")));
        return fakeResult(
          request,
          `{"type":"result","result":"Capsule answer","session_id":"${nativeSessionId}"}`,
        );
      });
      const adapter = createClaudeCodeRuntimeHostAdapter({
        transport,
        dataRoot,
        repoRoot,
        sessionIdGenerator: () => nativeSessionId,
        env: {
          ...process.env,
          SCIENCESWARM_DIR: dataRoot,
          BRAIN_ROOT: brainRoot,
        },
      });

      await expect(
        adapter.sendTurn({
          ...requestFor(requireRuntimeHostProfile("claude-code"), "chat"),
          runtimeSessionId: "rt-session-claude",
          conversationId: null,
        }),
      ).resolves.toMatchObject({
        sessionId: nativeSessionId,
        message: "Capsule answer",
      });

      const launch = transport.requests.at(-1);
      const workspaceRoot = path.join(dataRoot, "workspaces", "studies", "study_project-alpha");
      const launchBundleRoot = path.join(
        dataRoot,
        "runtime",
        "runs",
        "run_rt-session-claude",
        "claude-code",
      );
      expect(launch?.cwd).toBe(workspaceRoot);
      expect(launch?.args).toEqual(expect.arrayContaining([
        "--session-id",
        nativeSessionId,
        "--add-dir",
        projectRoot,
        "--strict-mcp-config",
      ]));
      const allowedToolsIndex = launch?.args?.indexOf("--allowedTools") ?? -1;
      expect(allowedToolsIndex).toBeGreaterThanOrEqual(0);
      expect(launch?.args?.[allowedToolsIndex + 1]).toBe([
        "mcp__scienceswarm__gbrain_search",
        "mcp__scienceswarm__gbrain_read",
        "mcp__scienceswarm__gbrain_structural_retrieve",
        "mcp__scienceswarm__gbrain_capture",
        "mcp__scienceswarm__provenance_log",
        "mcp__scienceswarm__openhands_delegate",
        "mcp__scienceswarm__project_workspace_read",
        "mcp__scienceswarm__artifact_import",
      ].join(","));
      const appendSystemPromptIndex = launch?.args?.indexOf("--append-system-prompt") ?? -1;
      expect(appendSystemPromptIndex).toBeGreaterThanOrEqual(0);
      const appendedPrompt = launch?.args?.[appendSystemPromptIndex + 1] ?? "";
      expect(appendedPrompt).toContain("# ScienceSwarm Launch Context");
      expect(appendedPrompt).not.toContain("# SCIENCESWARM.md");
      expect(appendedPrompt).toContain("Current project: `project-alpha`.");
      expect(appendedPrompt).toContain("Use narrow gbrain reads.");
      expect(appendedPrompt).toContain("runtime-scoped MCP server named `scienceswarm`");
      expect(appendedPrompt).toContain("injects the runtime MCP access token");
      expect(appendedPrompt).not.toContain("- token:");

      const mcpConfigIndex = launch?.args?.indexOf("--mcp-config") ?? -1;
      expect(mcpConfigIndex).toBeGreaterThanOrEqual(0);
      const mcpConfigPath = launch?.args?.[mcpConfigIndex + 1] ?? "";
      expect(mcpConfigPath).toBe(path.join(launchBundleRoot, "mcp.json"));
      expect(mcpConfigsAtLaunch).toHaveLength(1);
      const mcpConfig = mcpConfigsAtLaunch[0] as CapturedMcpConfig;
      expect(mcpConfig.mcpServers.scienceswarm.command).toBe("/bin/sh");
      expect(mcpConfig.mcpServers.scienceswarm.args.join(" ")).toContain(
        "src/lib/runtime-hosts/mcp/runtime-stdio-server.ts",
      );
      expect(mcpConfig.mcpServers.scienceswarm.env.SCIENCESWARM_DIR).toBe(dataRoot);
      expect(mcpConfig.mcpServers.scienceswarm.env.BRAIN_ROOT).toBe(brainRoot);
      expect(mcpConfig.mcpServers.scienceswarm.env.SCIENCESWARM_REPO_ROOT).toBe(repoRoot);
      expect(mcpConfig.mcpServers.scienceswarm.env.SCIENCESWARM_GBRAIN_BIN).toBe(repoGbrainBin);
      expect(mcpConfig.mcpServers.scienceswarm.env.GBRAIN_BIN).toBe(repoGbrainBin);
      expect(mcpConfig.mcpServers.scienceswarm.env.PATH.split(path.delimiter)[0]).toBe(repoBinDir);
      expect(mcpConfig.mcpServers.scienceswarm.env.SCIENCESWARM_RUNTIME_MCP_TOKEN_SECRET)
        .toBeUndefined();
      expect(mcpConfig.mcpServers.scienceswarm.env.SCIENCESWARM_RUNTIME_MCP_ACCESS_TOKEN)
        .toEqual(expect.any(String));
      expect(launch?.env?.SCIENCESWARM_RUNTIME_MCP_TOKEN_SECRET).toBeUndefined();
      expect(launch?.env?.SCIENCESWARM_RUNTIME_MCP_ACCESS_TOKEN).toBeUndefined();
      expect(launch?.env?.SCIENCESWARM_REPO_ROOT).toBe(repoRoot);
      expect(launch?.env?.SCIENCESWARM_GBRAIN_BIN).toBe(repoGbrainBin);
      expect(launch?.env?.GBRAIN_BIN).toBe(repoGbrainBin);
      expect((launch?.env?.PATH ?? "").split(path.delimiter)[0]).toBe(repoBinDir);
      await expect(readFile(mcpConfigPath, "utf8")).rejects.toThrow();

      const stableClaude = await readFile(path.join(workspaceRoot, "CLAUDE.md"), "utf8");
      const stableScienceSwarm = await readFile(path.join(workspaceRoot, "SCIENCESWARM.md"), "utf8");
      expect(stableClaude).toContain("stable ScienceSwarm AgentWorkspace");
      expect(stableScienceSwarm).toContain("ScienceSwarm is a local-first research workspace");
      for (const stableShim of [stableClaude, stableScienceSwarm]) {
        expect(stableShim).not.toContain("Summarize project-alpha.");
        expect(stableShim).not.toContain("Current project:");
        expect(stableShim).not.toContain("runtime-scoped MCP server");
        expect(stableShim).not.toContain("SCIENCESWARM_RUNTIME_MCP_ACCESS_TOKEN");
      }
      await expect(readFile(path.join(launchBundleRoot, "prompt.md"), "utf8"))
        .resolves.toContain("Current project: `project-alpha`.");
      const audit = await readFile(path.join(launchBundleRoot, "launch-audit.redacted.json"), "utf8");
      expect(audit).toContain("\"redacted\": true");
      expect(audit).not.toContain("SCIENCESWARM_RUNTIME_MCP_ACCESS_TOKEN");
      expect(audit).not.toContain(mcpConfig.mcpServers.scienceswarm.env.SCIENCESWARM_RUNTIME_MCP_ACCESS_TOKEN);
      await expect(stat(path.join(workspaceRoot, ".remember"))).rejects.toThrow();
      await expect(readdir(launchBundleRoot)).resolves.not.toContain("CLAUDE.md");
      await expect(readdir(launchBundleRoot)).resolves.not.toContain("SCIENCESWARM.md");
      expect(mcpConfigPathsAtLaunch).toEqual([path.join(launchBundleRoot, "mcp.json")]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("cleans up Claude runtime MCP config if a later LaunchBundle write fails", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "scienceswarm-claude-cleanup-"));
    try {
      const dataRoot = path.join(tempRoot, "data");
      const brainRoot = path.join(dataRoot, "brain");
      const launchBundleRoot = path.join(
        dataRoot,
        "runtime",
        "runs",
        "run_cleanup",
        "claude-code",
      );
      await mkdir(brainRoot, { recursive: true });
      await mkdir(path.join(launchBundleRoot, "prompt.md"), { recursive: true });
      vi.stubEnv("SCIENCESWARM_DIR", dataRoot);
      vi.stubEnv("BRAIN_ROOT", brainRoot);

      await expect(buildClaudeCodeRuntimeContext({
        request: {
          ...requestFor(requireRuntimeHostProfile("claude-code"), "chat"),
          runtimeSessionId: "rt-cleanup",
          conversationId: null,
        },
        wrapperSessionId: "rt-cleanup",
        nativeSessionId: "cleanup-native-session",
        runId: "run_cleanup",
        env: {
          ...process.env,
          SCIENCESWARM_DIR: dataRoot,
          BRAIN_ROOT: brainRoot,
        },
        repoRoot: process.cwd(),
        dataRoot,
      })).rejects.toThrow();

      await expect(readFile(path.join(launchBundleRoot, "mcp.json"), "utf8"))
        .rejects.toThrow();
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("reuses the Study workspace while giving sibling Claude runs distinct LaunchBundle paths", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "scienceswarm-claude-workspace-"));
    try {
      const dataRoot = path.join(tempRoot, "data");
      const brainRoot = path.join(dataRoot, "brain");
      await mkdir(brainRoot, { recursive: true });
      vi.stubEnv("SCIENCESWARM_DIR", dataRoot);
      vi.stubEnv("BRAIN_ROOT", brainRoot);
      const generatedSessionIds = [
        "77777777-7777-4777-8777-777777777777",
        "88888888-8888-4888-8888-888888888888",
      ];
      const transport = new FakeCliTransport((request) => {
        const sessionIdIndex = request.args?.indexOf("--session-id") ?? -1;
        const sessionId = request.args?.[sessionIdIndex + 1] ?? "missing-native-session";
        return fakeResult(
          request,
          JSON.stringify({
            type: "result",
            result: `Answer from ${request.sessionId}`,
            session_id: sessionId,
          }),
        );
      });
      const adapter = createClaudeCodeRuntimeHostAdapter({
        transport,
        dataRoot,
        repoRoot: process.cwd(),
        enableRuntimeMcp: false,
        sessionIdGenerator: () => generatedSessionIds.shift() ?? "99999999-9999-4999-8999-999999999999",
        env: {
          ...process.env,
          SCIENCESWARM_DIR: dataRoot,
          BRAIN_ROOT: brainRoot,
        },
      });

      await adapter.sendTurn({
        ...requestFor(requireRuntimeHostProfile("claude-code"), "chat"),
        runtimeSessionId: "rt-sibling-one",
        conversationId: null,
      });
      await adapter.sendTurn({
        ...requestFor(requireRuntimeHostProfile("claude-code"), "chat"),
        runtimeSessionId: "rt-sibling-two",
        conversationId: null,
      });

      const workspaceRoot = path.join(dataRoot, "workspaces", "studies", "study_project-alpha");
      expect(transport.requests).toHaveLength(2);
      expect(transport.requests[0]?.cwd).toBe(workspaceRoot);
      expect(transport.requests[1]?.cwd).toBe(workspaceRoot);
      await expect(readFile(
        path.join(dataRoot, "runtime", "runs", "run_rt-sibling-one", "claude-code", "prompt.md"),
        "utf8",
      )).resolves.toContain("Current project: `project-alpha`.");
      await expect(readFile(
        path.join(dataRoot, "runtime", "runs", "run_rt-sibling-two", "claude-code", "prompt.md"),
        "utf8",
      )).resolves.toContain("Current project: `project-alpha`.");
      await expect(stat(path.join(workspaceRoot, ".remember"))).rejects.toThrow();
      await expect(readdir(path.join(dataRoot, "runtime", "runs", "run_rt-sibling-one", "claude-code")))
        .resolves.not.toContain("SCIENCESWARM.md");
      await expect(readdir(path.join(dataRoot, "runtime", "runs", "run_rt-sibling-two", "claude-code")))
        .resolves.not.toContain("CLAUDE.md");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("captures only top-level Claude Code session ids for native resume", () => {
    const nestedOnly = parseClaudeCodeStreamOutput({
      hostId: "claude-code",
      sessionId: "wrapper-session",
      lines: [
        JSON.stringify({
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_result",
                session_id: "nested-tool-session",
                content: "tool output",
              },
            ],
          },
        }),
      ],
    });
    const topLevel = parseClaudeCodeStreamOutput({
      hostId: "claude-code",
      sessionId: "wrapper-session",
      lines: [
        JSON.stringify({
          type: "system",
          session_id: "claude-native-session",
          tool_result: {
            session_id: "nested-tool-session",
          },
        }),
        JSON.stringify({
          type: "result",
          result: "done",
          session_id: "claude-native-session",
        }),
      ],
    });

    expect(nestedOnly.nativeSessionId).toBeNull();
    expect(
      nestedOnly.events.some((event) => event.payload.nativeSessionId),
    ).toBe(false);
    expect(topLevel.nativeSessionId).toBe("claude-native-session");
    expect(topLevel.events.at(0)?.payload.nativeSessionId).toBe(
      "claude-native-session",
    );
  });

  it("accumulates Claude Code assistant partials before final result events", () => {
    const accumulator = new ClaudeCodeStreamAccumulator({
      hostId: "claude-code",
      sessionId: "wrapper-session",
    });

    const first = accumulator.acceptLine(JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "First" }],
      },
    }));
    const second = accumulator.acceptLine(JSON.stringify({
      type: "content_block_delta",
      delta: { text: " chunk" },
    }));
    const third = accumulator.acceptLine(JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "text", text: " and second" }],
      },
    }));
    const fourth = accumulator.acceptLine(JSON.stringify({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { text: " streamed" },
      },
    }));

    expect(first?.payload.text).toBe("First");
    expect(second?.payload.text).toBe("First chunk");
    expect(third?.payload.text).toBe("First chunk and second");
    expect(fourth?.payload.text).toBe("First chunk and second streamed");
    expect(accumulator.result().message).toBe("First chunk and second streamed");
  });

  it("separates unrelated Claude Code assistant chunks while streaming", () => {
    const accumulator = new ClaudeCodeStreamAccumulator({
      hostId: "claude-code",
      sessionId: "wrapper-session",
    });

    const first = accumulator.acceptLine(JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "I'll search for X" }],
      },
    }));
    const second = accumulator.acceptLine(JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "Here's what I found: Y" }],
      },
    }));
    const final = accumulator.acceptLine(JSON.stringify({
      type: "result",
      result: "I'll search for X. Here's what I found: Y",
      session_id: "claude-native-session",
    }));

    expect(first?.payload.text).toBe("I'll search for X");
    expect(second?.payload.text).toBe("I'll search for X\nHere's what I found: Y");
    expect(final?.payload.text).toBe("I'll search for X. Here's what I found: Y");
    expect(accumulator.result().message).toBe(
      "I'll search for X. Here's what I found: Y",
    );
  });

  it("emits unique message event ids for repeated wrapper turns in one session", async () => {
    const transport = new FakeCliTransport((request) => fakeResult(request, "answer"));
    const adapter = createTestClaudeCodeRuntimeHostAdapter({ transport });
    const request = requestFor(requireRuntimeHostProfile("claude-code"), "chat");

    const first = await adapter.sendTurn(request);
    const second = await adapter.sendTurn(request);

    expect(first.events?.[0]?.id).toBe("conversation-alpha:message-1");
    expect(second.events?.[0]?.id).toBe("conversation-alpha:message-2");
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

  it("classifies provider authentication errors as auth challenges", () => {
    const output = normalizeCliOutput({
      stderr: [
        "Failed to authenticate. API Error: 401 {\"type\":\"error\",",
        "\"error\":{\"type\":\"authentication_error\",",
        "\"message\":\"Invalid authentication credentials\"}}",
      ].join(" "),
    });

    expect(output.authChallenge).toBe(true);
  });

  it("does not classify 401 suffix words as auth challenges", () => {
    const output = normalizeCliOutput({
      stderr: "Process exitstatus: 401 but the provider auth state is unknown",
    });

    expect(output.authChallenge).toBe(false);
  });

  it("strips provider API-key env vars before launching subscription-native CLIs", async () => {
    const transport = new FakeCliTransport((request) => fakeResult(request, "ok"));
    const env = {
      ...process.env,
      ANTHROPIC_API_KEY: "placeholder-anthropic-api-key",
      ANTHROPIC_BASE_URL: "https://api.anthropic.test",
      OPENAI_API_KEY: "placeholder-openai-api-key",
      OPENAI_BASE_URL: "https://api.openai.test/v1",
      OPENAI_ORG_ID: "org-test",
      OPENAI_PROJECT: "proj-test",
      GEMINI_API_KEY: "placeholder-gemini-api-key",
      GOOGLE_API_KEY: "placeholder-google-api-key",
      GOOGLE_CLOUD_API_KEY: "placeholder-google-cloud-api-key",
      GOOGLE_GENERATIVE_AI_API_KEY: "placeholder-google-generative-ai-key",
      SCIENCESWARM_DIR: "/tmp/scienceswarm",
    };

    await createTestClaudeCodeRuntimeHostAdapter({ transport, env }).health();
    await createCodexRuntimeHostAdapter({ transport, env }).sendTurn(
      requestFor(requireRuntimeHostProfile("codex"), "chat"),
    );
    await createGeminiCliRuntimeHostAdapter({ transport, env }).sendTurn(
      requestFor(requireRuntimeHostProfile("gemini-cli"), "chat"),
    );

    const claudeEnv = transport.requests[0]?.env as NodeJS.ProcessEnv;
    expect(claudeEnv.ANTHROPIC_API_KEY).toBeUndefined();
    expect(claudeEnv.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(claudeEnv.SCIENCESWARM_DIR).toBe("/tmp/scienceswarm");

    const codexEnv = transport.requests[1]?.env as NodeJS.ProcessEnv;
    expect(codexEnv.OPENAI_API_KEY).toBeUndefined();
    expect(codexEnv.OPENAI_BASE_URL).toBeUndefined();
    expect(codexEnv.OPENAI_ORG_ID).toBeUndefined();
    expect(codexEnv.OPENAI_PROJECT).toBeUndefined();
    expect(codexEnv.SCIENCESWARM_DIR).toBe("/tmp/scienceswarm");

    const geminiEnv = transport.requests[2]?.env as NodeJS.ProcessEnv;
    expect(geminiEnv.GEMINI_API_KEY).toBeUndefined();
    expect(geminiEnv.GOOGLE_API_KEY).toBeUndefined();
    expect(geminiEnv.GOOGLE_CLOUD_API_KEY).toBeUndefined();
    expect(geminiEnv.GOOGLE_GENERATIVE_AI_API_KEY).toBeUndefined();
    expect(geminiEnv.SCIENCESWARM_DIR).toBe("/tmp/scienceswarm");
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
    const unapprovedRequest = requestFor(codex, "task", "required");

    await expect(adapter.sendTurn(blockedRequest)).rejects.toThrow(
      RuntimePrivacyBlocked,
    );
    await expect(adapter.executeTask(unapprovedRequest)).rejects.toThrow(
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

  it("routes OpenClaw runtime cancellation to the active gateway chat session", async () => {
    const abortedSessions: string[] = [];
    let releaseTurn!: () => void;
    let markTurnStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markTurnStarted = resolve;
    });
    const adapter = createOpenClawRuntimeHostAdapter({
      sendAgentMessage: async () => {
        markTurnStarted();
        await new Promise<void>((release) => {
          releaseTurn = release;
        });
        return "OpenClaw response";
      },
      abortChat: async (sessionKey) => {
        abortedSessions.push(sessionKey);
        releaseTurn();
        return { aborted: true, runIds: ["run-alpha"] };
      },
    });
    const request = {
      ...requestFor(requireRuntimeHostProfile("openclaw"), "chat"),
      runtimeSessionId: "rt-session-openclaw",
      conversationId: "openclaw-native-session",
    };

    const turn = adapter.sendTurn(request);

    await started;
    await expect(adapter.cancel("rt-session-openclaw")).resolves.toMatchObject({
      cancelled: true,
    });
    await expect(turn).resolves.toMatchObject({
      sessionId: "openclaw-native-session",
      message: "OpenClaw response",
    });

    expect(abortedSessions).toEqual(["openclaw-native-session"]);
  });

  it("resolves OpenClaw cancellation failures without throwing", async () => {
    let releaseTurn!: () => void;
    let markTurnStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markTurnStarted = resolve;
    });
    const adapter = createOpenClawRuntimeHostAdapter({
      sendAgentMessage: async () => {
        await new Promise<void>((release) => {
          releaseTurn = release;
          markTurnStarted();
        });
        return "OpenClaw response";
      },
      abortChat: async () => {
        throw new Error("gateway down");
      },
    });
    const request = {
      ...requestFor(requireRuntimeHostProfile("openclaw"), "chat"),
      runtimeSessionId: "rt-session-openclaw",
      conversationId: "openclaw-native-session",
    };

    const turn = adapter.sendTurn(request);

    await started;
    await expect(adapter.cancel("rt-session-openclaw")).resolves.toMatchObject({
      sessionId: "rt-session-openclaw",
      cancelled: false,
      detail: expect.stringContaining("gateway down"),
    });

    releaseTurn();
    await expect(turn).resolves.toMatchObject({
      sessionId: "openclaw-native-session",
      message: "OpenClaw response",
    });
  });

  it("keeps newer OpenClaw runtime mappings when an older turn completes", async () => {
    const abortedSessions: string[] = [];
    let sendCount = 0;
    let releaseFirstTurn!: () => void;
    let releaseSecondTurn!: () => void;
    let markFirstStarted!: () => void;
    let markSecondStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const secondStarted = new Promise<void>((resolve) => {
      markSecondStarted = resolve;
    });
    const adapter = createOpenClawRuntimeHostAdapter({
      sendAgentMessage: async () => {
        sendCount += 1;
        if (sendCount === 1) {
          await new Promise<void>((release) => {
            releaseFirstTurn = release;
            markFirstStarted();
          });
          return "First OpenClaw response";
        }
        await new Promise<void>((release) => {
          releaseSecondTurn = release;
          markSecondStarted();
        });
        return "Second OpenClaw response";
      },
      abortChat: async (sessionKey) => {
        abortedSessions.push(sessionKey);
        releaseSecondTurn();
        return { aborted: true };
      },
    });
    const baseRequest = {
      ...requestFor(requireRuntimeHostProfile("openclaw"), "chat"),
      runtimeSessionId: "rt-session-openclaw",
    };

    const firstTurn = adapter.sendTurn({
      ...baseRequest,
      conversationId: "openclaw-first-session",
    });
    await firstStarted;
    const secondTurn = adapter.sendTurn({
      ...baseRequest,
      conversationId: "openclaw-second-session",
    });
    await secondStarted;

    releaseFirstTurn();
    await expect(firstTurn).resolves.toMatchObject({
      sessionId: "openclaw-first-session",
      message: "First OpenClaw response",
    });
    await expect(adapter.cancel("rt-session-openclaw")).resolves.toMatchObject({
      cancelled: true,
    });
    await expect(secondTurn).resolves.toMatchObject({
      sessionId: "openclaw-second-session",
      message: "Second OpenClaw response",
    });

    expect(abortedSessions).toEqual(["openclaw-second-session"]);
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

  it("sends Google AI API keys in headers instead of URL query parameters", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const profile = createApiKeyRuntimeHostProfile("google-ai");
    const fetchImpl = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: "Google answer" }] } }],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    });
    const adapter = createApiKeyRuntimeHostAdapter({
      provider: "google-ai",
      profile,
      env: {
        ...baseEnv,
        googleAiApiKey: "placeholder-google-key",
      },
      fetch: fetchImpl,
    });

    await expect(adapter.sendTurn(requestFor(profile, "chat"))).resolves.toMatchObject({
      message: "Google answer",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).not.toContain("placeholder-google-key");
    expect(calls[0]?.url).not.toContain("key=");
    expect(new Headers(calls[0]?.init.headers).get("x-goog-api-key")).toBe(
      "placeholder-google-key",
    );
  });

  it("does not treat Google AI credentials as Vertex AI credentials", async () => {
    const profile = createApiKeyRuntimeHostProfile("vertex-ai");
    const adapter = createApiKeyRuntimeHostAdapter({
      provider: "vertex-ai",
      profile,
      env: {
        ...baseEnv,
        googleAiApiKey: "placeholder-google-key",
        googleApiKey: "placeholder-legacy-google-key",
        vertexAiProject: "project-alpha",
      },
    });

    await expect(adapter.health()).resolves.toMatchObject({ status: "unavailable" });
    await expect(adapter.authStatus()).resolves.toMatchObject({
      status: "missing",
      provider: "vertex-ai",
    });
    await expect(adapter.sendTurn(requestFor(profile, "chat"))).rejects.toThrow(
      "Missing vertex-ai API key",
    );
  });

  it("marks Vertex AI unavailable until project configuration is present", async () => {
    const profile = createApiKeyRuntimeHostProfile("vertex-ai");
    const adapter = createApiKeyRuntimeHostAdapter({
      provider: "vertex-ai",
      profile,
      env: {
        ...baseEnv,
        vertexAiApiKey: "placeholder-vertex-key",
      },
    });

    await expect(adapter.health()).resolves.toMatchObject({
      status: "unavailable",
      detail: "Add VERTEX_AI_PROJECT to .env to enable this runtime.",
    });
    await expect(adapter.authStatus()).resolves.toMatchObject({
      status: "missing",
      provider: "vertex-ai",
      detail: "Add VERTEX_AI_PROJECT to .env to enable this runtime.",
    });
    await expect(adapter.sendTurn(requestFor(profile, "chat"))).rejects.toThrow(
      "VERTEX_AI_PROJECT",
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
