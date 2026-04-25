import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";

import { createCodexRuntimeHostAdapter } from "@/lib/runtime-hosts/adapters/codex";
import {
  computeTurnPreview,
  requireRuntimeHostProfile,
  type RuntimeHostProfile,
  type RuntimeTurnMode,
  type RuntimeTurnRequest,
} from "@/lib/runtime-hosts";
import { resolveRuntimeMcpToolProfile } from "@/lib/runtime-hosts/mcp/tool-profiles";
import {
  type CliTransport,
  type CliTransportRunRequest,
  type CliTransportRunResult,
} from "@/lib/runtime-hosts/transport/cli";
import { normalizeCliOutput } from "@/lib/runtime-hosts/transport/output-normalizer";

class FakeCliTransport implements CliTransport {
  readonly requests: CliTransportRunRequest[] = [];

  async run(request: CliTransportRunRequest): Promise<CliTransportRunResult> {
    this.requests.push(request);
    return {
      command: request.command,
      args: request.args ?? [],
      exitCode: 0,
      signal: null,
      output: normalizeCliOutput({ stdout: "Codex answer" }),
    };
  }
}

function requestFor(
  profile: RuntimeHostProfile,
  mode: RuntimeTurnMode,
): RuntimeTurnRequest {
  const preview = computeTurnPreview({
    projectPolicy: "cloud-ok",
    host: profile,
    mode,
    dataIncluded: [
      { kind: "prompt", label: "project-alpha prompt", bytes: 20 },
    ],
  });

  return {
    hostId: profile.id,
    projectId: "project-alpha",
    conversationId: null,
    mode,
    prompt: "Summarize project-alpha.",
    inputFileRefs: [],
    dataIncluded: preview.dataIncluded,
    approvalState: "approved",
    preview,
  };
}

function decodeRuntimeMcpToken(token: string): Record<string, unknown> {
  const [payload] = token.split(".");
  return JSON.parse(
    Buffer.from(payload, "base64url").toString("utf8"),
  ) as Record<string, unknown>;
}

describe("Codex runtime MCP launch", () => {
  it("passes MCP config overrides and token env without leaking the token into args or prompt", async () => {
    const transport = new FakeCliTransport();
    const adapter = createCodexRuntimeHostAdapter({
      transport,
      repoRoot: "/tmp/scienceswarm-repo",
      sessionIdGenerator: () => "session-1",
      env: {
        ...process.env,
        BRAIN_ROOT: "/tmp/scienceswarm-brain",
        SCIENCESWARM_DIR: "/tmp/scienceswarm-data",
      },
    });
    const allowedTools = resolveRuntimeMcpToolProfile("codex").allowedTools;
    expect(allowedTools).toHaveLength(6);

    await expect(
      adapter.sendTurn(requestFor(requireRuntimeHostProfile("codex"), "chat")),
    ).resolves.toMatchObject({
      hostId: "codex",
      sessionId: "codex-session-1",
      message: "Codex answer",
    });

    const launch = transport.requests.at(-1);
    expect(launch).toBeDefined();
    expect(launch?.command).toBe("codex");
    expect(launch?.sessionId).toBe("codex-session-1");
    expect(launch?.args?.slice(0, 2)).toEqual(["exec", "--json"]);

    const args = launch?.args ?? [];
    const argsText = JSON.stringify(args);
    expect(args).toContain('mcp_servers.scienceswarm.command="/bin/sh"');
    expect(argsText).toContain(
      "src/lib/runtime-hosts/mcp/runtime-stdio-server.ts",
    );
    expect(args).toContain(
      'mcp_servers.scienceswarm.env_vars=["SCIENCESWARM_RUNTIME_MCP_ACCESS_TOKEN","BRAIN_ROOT","SCIENCESWARM_DIR","NODE_ENV","PATH"]',
    );
    expect(args).toContain(
      `mcp_servers.scienceswarm.enabled_tools=${JSON.stringify(allowedTools)}`,
    );
    expect(args).toContain("mcp_servers.scienceswarm.enabled=true");

    const token = launch?.env?.SCIENCESWARM_RUNTIME_MCP_ACCESS_TOKEN;
    expect(token).toEqual(expect.any(String));
    expect(launch?.env?.BRAIN_ROOT).toBe("/tmp/scienceswarm-brain");
    expect(launch?.env?.SCIENCESWARM_DIR).toBe("/tmp/scienceswarm-data");

    const prompt = launch?.args?.at(-1) ?? "";
    expect(prompt).toContain("runtime-scoped MCP server named `scienceswarm`");
    expect(prompt).toContain("- projectId: project-alpha");
    expect(prompt).toContain("- runtimeSessionId: codex-session-1");
    expect(prompt).toContain("- hostId: codex");
    expect(prompt).toContain(`Allowed tools: ${allowedTools.join(", ")}.`);
    expect(prompt).toContain("User prompt:\nSummarize project-alpha.");

    expect(argsText).not.toContain(token as string);
    expect(prompt).not.toContain(token as string);
    expect(prompt).not.toContain("- token:");

    const claims = decodeRuntimeMcpToken(token as string);
    expect(claims).toMatchObject({
      projectId: "project-alpha",
      runtimeSessionId: "codex-session-1",
      hostId: "codex",
    });
    expect(claims.allowedTools).toEqual(allowedTools);
  });
});
