import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createRuntimeConcurrencyManager,
} from "@/lib/runtime-hosts/concurrency";
import {
  createRuntimeMcpToolset,
} from "@/lib/runtime-hosts/mcp/tools";
import {
  mintRuntimeMcpAccessToken,
  type RuntimeMcpToolName,
} from "@/lib/runtime-hosts/mcp/tokens";
import type { RuntimeProjectPolicy } from "@/lib/runtime-hosts/contracts";

const SECRET = "runtime-mcp-integration-secret";
const NOW = new Date("2026-04-22T11:00:00.000Z");
const RUNTIME_PROVENANCE = {
  runtimeSessionId: "session-1",
  hostId: "codex",
  sourceArtifactId: "artifact-1",
  promptHash: "prompt-hash-1",
  inputFileRefs: ["gbrain:wiki/notes/assay-summary"],
  approvalState: "approved" as const,
};

let tempRoot = "";

afterEach(async () => {
  if (tempRoot) {
    await rm(tempRoot, { recursive: true, force: true });
  }
  tempRoot = "";
});

function auth(input: {
  allowedTools: RuntimeMcpToolName[];
  hostId?: string;
  projectPolicy?: RuntimeProjectPolicy;
  projectId?: string;
  runtimeSessionId?: string;
}) {
  const projectId = input.projectId ?? "project-alpha";
  const runtimeSessionId = input.runtimeSessionId ?? "session-1";
  const hostId = input.hostId ?? "codex";
  return {
    token: mintRuntimeMcpAccessToken({
      projectId,
      runtimeSessionId,
      hostId,
      allowedTools: input.allowedTools,
      now: () => NOW,
      secret: SECRET,
      tokenId: `${hostId}-${runtimeSessionId}`,
    }),
    projectId,
    runtimeSessionId,
    hostId,
    projectPolicy: input.projectPolicy ?? "cloud-ok",
  };
}

describe("runtime MCP tool wrappers", () => {
  it("rejects missing tokens before data access", async () => {
    const brainSearch = vi.fn(async () => ({ status: "should-not-run" }));
    const tools = createRuntimeMcpToolset({
      tokenSecret: SECRET,
      now: () => NOW,
      brainSearch,
    });

    await expect(
      tools.gbrainSearch({
        token: null,
        projectId: "project-alpha",
        runtimeSessionId: "session-1",
        hostId: "codex",
        projectPolicy: "cloud-ok",
        query: "alpha",
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_MCP_UNAUTHORIZED" });
    expect(brainSearch).not.toHaveBeenCalled();
  });

  it("rejects expired tokens before data access", async () => {
    const brainRead = vi.fn(async () => ({ status: "should-not-run" }));
    const tools = createRuntimeMcpToolset({
      tokenSecret: SECRET,
      now: () => NOW,
      brainRead,
    });

    await expect(
      tools.gbrainRead({
        token: mintRuntimeMcpAccessToken({
          projectId: "project-alpha",
          runtimeSessionId: "session-1",
          hostId: "codex",
          allowedTools: ["gbrain_read"],
          ttlMs: 1_000,
          now: () => new Date("2026-04-22T10:00:00.000Z"),
          secret: SECRET,
          tokenId: "expired-token",
        }),
        projectId: "project-alpha",
        runtimeSessionId: "session-1",
        hostId: "codex",
        projectPolicy: "cloud-ok",
        path: "wiki/notes/alpha.md",
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_MCP_UNAUTHORIZED" });
    expect(brainRead).not.toHaveBeenCalled();
  });

  it("rejects tool calls outside the token allowlist before data access", async () => {
    const brainSearch = vi.fn(async () => ({ status: "should-not-run" }));
    const tools = createRuntimeMcpToolset({
      tokenSecret: SECRET,
      now: () => NOW,
      brainSearch,
    });

    await expect(
      tools.gbrainSearch({
        ...auth({ allowedTools: ["gbrain_read"] }),
        query: "alpha",
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_MCP_UNAUTHORIZED" });
    expect(brainSearch).not.toHaveBeenCalled();
  });

  it("recomputes TurnPreview and blocks hosted hosts from local-only project data", async () => {
    const projectWorkspaceRead = vi.fn(async () => ({
      projectId: "project-alpha",
      workspacePath: "notes.md",
      content: "should-not-run",
      bytes: 14,
      truncated: false,
    }));
    const tools = createRuntimeMcpToolset({
      tokenSecret: SECRET,
      now: () => NOW,
      projectWorkspaceRead,
    });

    await expect(
      tools.projectWorkspaceRead({
        ...auth({
          allowedTools: ["project_workspace_read"],
          hostId: "codex",
          projectPolicy: "local-only",
        }),
        workspacePath: "notes.md",
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_PRIVACY_BLOCKED" });
    expect(projectWorkspaceRead).not.toHaveBeenCalled();
  });

  it("rejects workspace tools suppressed by the host MCP profile", async () => {
    const projectWorkspaceRead = vi.fn(async () => ({
      projectId: "project-alpha",
      workspacePath: "notes.md",
      content: "should-not-run",
      bytes: 14,
      truncated: false,
    }));
    const tools = createRuntimeMcpToolset({
      tokenSecret: SECRET,
      now: () => NOW,
      projectWorkspaceRead,
    });

    await expect(
      tools.projectWorkspaceRead({
        ...auth({
          allowedTools: ["project_workspace_read"],
          hostId: "openhands",
          projectPolicy: "execution-ok",
        }),
        workspacePath: "notes.md",
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_MCP_TOOL_NOT_ALLOWED" });
    expect(projectWorkspaceRead).not.toHaveBeenCalled();
  });

  it("runs authorized gbrain reads through the injected handler", async () => {
    const brainSearch = vi.fn(async () => ({ hits: ["alpha"] }));
    const tools = createRuntimeMcpToolset({
      tokenSecret: SECRET,
      now: () => NOW,
      brainSearch,
    });

    await expect(
      tools.gbrainSearch({
        ...auth({ allowedTools: ["gbrain_search"] }),
        query: "alpha",
        limit: 3,
      }),
    ).resolves.toEqual({ hits: ["alpha"] });
    expect(brainSearch).toHaveBeenCalledWith({
      query: "alpha",
      mode: undefined,
      limit: 3,
      detail: undefined,
    });
  });

  it("runs authorized provenance logs through the injected handler", async () => {
    const provenanceLog = vi.fn(async () => ({ logged: "artifact-imported" }));
    const tools = createRuntimeMcpToolset({
      tokenSecret: SECRET,
      now: () => NOW,
      provenanceLog,
    });

    await expect(
      tools.provenanceLog({
        ...auth({ allowedTools: ["provenance_log"] }),
        event: "artifact-imported",
        metadata: { artifactId: "artifact-1" },
      }),
    ).resolves.toEqual({ logged: "artifact-imported" });
    expect(provenanceLog).toHaveBeenCalledWith({
      event: "artifact-imported",
      metadata: { artifactId: "artifact-1" },
      runtimeProvenance: undefined,
    });
  });

  it("rejects runtime gbrain_capture before write access when provenance is missing", async () => {
    const brainCapture = vi.fn(async () => ({ status: "should-not-run" }));
    const tools = createRuntimeMcpToolset({
      tokenSecret: SECRET,
      now: () => NOW,
      brainCapture,
    });

    await expect(
      tools.gbrainCapture({
        ...auth({ allowedTools: ["gbrain_capture"] }),
        content: "Runtime note",
        title: "Runtime note",
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_MCP_UNAUTHORIZED" });
    expect(brainCapture).not.toHaveBeenCalled();
  });

  it("rate-limits MCP reads with the runtime concurrency policy", async () => {
    const brainSearch = vi.fn(async () => ({ status: "should-not-run" }));
    const concurrencyManager = createRuntimeConcurrencyManager({
      policy: { mcp: { maxRead: 1, maxWrite: 1 } },
      idGenerator: () => "slot",
      now: () => NOW,
    });
    const heldSlot = concurrencyManager.requestSlot({
      lane: "mcp-read",
      sessionId: "other-session",
      queue: false,
    });
    const tools = createRuntimeMcpToolset({
      tokenSecret: SECRET,
      now: () => NOW,
      concurrencyManager,
      brainSearch,
    });

    await expect(
      tools.gbrainSearch({
        ...auth({ allowedTools: ["gbrain_search"] }),
        query: "alpha",
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_MCP_RATE_LIMITED" });
    expect(brainSearch).not.toHaveBeenCalled();
    concurrencyManager.releaseSlot(heldSlot.id);
  });

  it("rate-limits MCP writes with the runtime concurrency policy", async () => {
    const brainCapture = vi.fn(async () => ({ status: "should-not-run" }));
    const concurrencyManager = createRuntimeConcurrencyManager({
      policy: { mcp: { maxRead: 1, maxWrite: 1 } },
      idGenerator: () => "write-slot",
      now: () => NOW,
    });
    const heldSlot = concurrencyManager.requestSlot({
      lane: "mcp-write",
      sessionId: "other-session",
      queue: false,
    });
    const tools = createRuntimeMcpToolset({
      tokenSecret: SECRET,
      now: () => NOW,
      concurrencyManager,
      brainCapture,
    });

    await expect(
      tools.gbrainCapture({
        ...auth({ allowedTools: ["gbrain_capture"] }),
        content: "Runtime note",
        title: "Runtime note",
        runtimeProvenance: RUNTIME_PROVENANCE,
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_MCP_RATE_LIMITED" });
    expect(brainCapture).not.toHaveBeenCalled();
    concurrencyManager.releaseSlot(heldSlot.id);
  });

  it("reads project workspace files for hosts whose profile allows the tool", async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "scienceswarm-mcp-"));
    await writeFile(path.join(tempRoot, "notes.md"), "alpha notes", "utf-8");
    const tools = createRuntimeMcpToolset({
      tokenSecret: SECRET,
      now: () => NOW,
    });

    await expect(
      tools.projectWorkspaceRead({
        ...auth({
          allowedTools: ["project_workspace_read"],
          hostId: "openclaw",
          projectPolicy: "local-only",
        }),
        workspacePath: "notes.md",
        projectRoot: tempRoot,
      }),
    ).resolves.toMatchObject({
      projectId: "project-alpha",
      workspacePath: "notes.md",
      content: "alpha notes",
      truncated: false,
    });
  });

  it("validates artifact imports only after token and policy checks pass", async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "scienceswarm-mcp-"));
    const tools = createRuntimeMcpToolset({
      tokenSecret: SECRET,
      now: () => NOW,
    });

    await expect(
      tools.artifactImport({
        ...auth({ allowedTools: ["artifact_import"] }),
        sourcePath: "results/summary.md",
        sourcePathKind: "project-relative",
        allowedRoots: [tempRoot],
        approvalState: "not-required",
        importReason: "host-declared-artifact",
        projectRoot: tempRoot,
        promptHash: "prompt-hash-1",
        inputFileRefs: ["gbrain:wiki/notes/assay-summary"],
        importedBy: "@tester",
        generatedAt: "2026-04-22T11:05:00.000Z",
      }),
    ).resolves.toMatchObject({
      validation: {
        ok: true,
        mapping: {
          projectRelativePath: "results/summary.md",
        },
      },
      artifact: {
        workspacePath: "results/summary.md",
        provenance: {
          promptHash: "prompt-hash-1",
          inputFileRefs: ["gbrain:wiki/notes/assay-summary"],
        },
      },
    });
  });
});
