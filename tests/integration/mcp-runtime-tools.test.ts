import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createRuntimeConcurrencyManager,
} from "@/lib/runtime-hosts/concurrency";
import {
  createRuntimeMcpToolset,
  type RuntimeMcpArtifactImportResult,
} from "@/lib/runtime-hosts/mcp/tools";
import type { RuntimeStructuralRetrievalResult } from "@/lib/runtime-hosts/mcp/structural-retrieval";
import { resolveRuntimeMcpToolProfile } from "@/lib/runtime-hosts/mcp/tool-profiles";
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

function structuralRetrievalResult(
  overrides: Partial<RuntimeStructuralRetrievalResult> = {},
): RuntimeStructuralRetrievalResult {
  return {
    status: "ok",
    degraded: false,
    records: [],
    provenance: {
      engine: "gbrain",
      projectId: "project-alpha",
      studyId: null,
      studySlug: null,
      runtimeSessionIdHash: "hash",
      hostId: "codex",
      capability: {
        structuralNavigationAvailable: true,
        schemaVersion: 29,
        chunkerVersion: "4",
        blockers: [],
      },
      queryHash: "query-hash",
      filters: {
        sourceIds: [],
        pageIds: [],
        nearSymbol: null,
        walkDepth: 1,
        limit: 8,
      },
    },
    ...overrides,
  };
}

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
  approved?: boolean;
  omitApproval?: boolean;
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
    ...(input.omitApproval ? {} : { approved: input.approved ?? true }),
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

  it("recomputes TurnPreview and blocks third-party destinations from local-only project data", async () => {
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

  it("requires explicit approval for hosted MCP tool calls", async () => {
    const brainSearch = vi.fn(async () => ({ status: "should-not-run" }));
    const tools = createRuntimeMcpToolset({
      tokenSecret: SECRET,
      now: () => NOW,
      brainSearch,
    });

    await expect(
      tools.gbrainSearch({
        ...auth({
          allowedTools: ["gbrain_search"],
          hostId: "codex",
          projectPolicy: "cloud-ok",
          omitApproval: true,
        }),
        query: "alpha",
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_PREVIEW_APPROVAL_REQUIRED" });
    expect(brainSearch).not.toHaveBeenCalled();
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

  it("invokes all claude-code runtime MCP tools with valid authorization", async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "scienceswarm-mcp-"));
    await writeFile(path.join(tempRoot, "notes.md"), "alpha notes", "utf-8");
    const runtimeProvenance = {
      ...RUNTIME_PROVENANCE,
      hostId: "claude-code",
    };

    const brainSearch = vi.fn(async () => ({ hits: ["alpha"] }));
    const brainRead = vi.fn(async () => ({ content: "alpha doc", path: "notes.md" }));
    const structuralRetrieval = vi.fn(async () =>
      structuralRetrievalResult({
        provenance: {
          ...structuralRetrievalResult().provenance,
          hostId: "claude-code",
        },
      })
    );
    const brainCapture = vi.fn(async () => ({ status: "captured" }));
    const provenanceLog = vi.fn(async () => ({ logged: true }));
    const projectWorkspaceRead = vi.fn(async () => ({
      projectId: "project-alpha",
      workspacePath: "notes.md",
      content: "alpha notes",
      bytes: 10,
      truncated: false,
    }));
    const artifactImport = vi.fn(async (_params: unknown, _mapper: unknown): Promise<RuntimeMcpArtifactImportResult> => ({
      validation: {
        ok: true,
        approvalRequired: false,
        mapping: {
          projectId: "project-alpha",
          hostId: "claude-code",
          projectRelativePath: "results/summary.md",
          localAbsolutePath: path.join(tempRoot, "results/summary.md"),
          hostNativePath: "results/summary.md",
        },
        request: {
          projectId: "project-alpha",
          sourceHostId: "claude-code",
          sourceSessionId: "session-1",
          sourcePath: "results/summary.md",
          sourcePathKind: "project-relative",
          allowedRoots: ["/tmp"],
          approvalState: "not-required",
          importReason: "host-declared-artifact",
        },
      },
      artifact: {
        artifactId: "artifact-1",
        projectId: "project-alpha",
        sourceHostId: "claude-code",
        sourceSessionId: "session-1",
        sourcePath: "results/summary.md",
        workspacePath: "results/summary.md",
        gbrainSlug: null,
        provenance: {
          promptHash: "prompt-hash-1",
          inputFileRefs: ["gbrain:wiki/notes/assay-summary"],
          generatedAt: "2026-04-22T11:00:00.000Z",
          importedBy: "runtime-mcp",
          approvalState: "approved" as const,
        },
      },
    }));
    const openhandsDelegate = vi.fn(async () => ({ status: "delegated" }));
    const tools = createRuntimeMcpToolset({
      tokenSecret: SECRET,
      now: () => NOW,
      brainSearch,
      brainRead,
      structuralRetrieval,
      brainCapture,
      provenanceLog,
      projectWorkspaceRead,
      artifactImport,
      openhandsDelegate,
    });

    const profileTools = resolveRuntimeMcpToolProfile("claude-code").allowedTools;
    expect(profileTools).toEqual(
      expect.arrayContaining([
        "gbrain_search",
        "gbrain_read",
        "gbrain_structural_retrieve",
        "gbrain_capture",
        "provenance_log",
        "openhands_delegate",
        "project_workspace_read",
        "artifact_import",
      ]),
    );

    await expect(
      tools.gbrainSearch({
        ...auth({
          allowedTools: ["gbrain_search"],
          hostId: "claude-code",
          projectPolicy: "cloud-ok",
        }),
        query: "alpha",
        limit: 3,
      }),
    ).resolves.toEqual({ hits: ["alpha"] });

    await expect(
      tools.gbrainRead({
        ...auth({
          allowedTools: ["gbrain_read"],
          hostId: "claude-code",
          projectPolicy: "cloud-ok",
        }),
        path: "notes.md",
      }),
    ).resolves.toEqual({ content: "alpha doc", path: "notes.md" });

    await expect(
      tools.gbrainStructuralRetrieve({
        ...auth({
          allowedTools: ["gbrain_structural_retrieve"],
          hostId: "claude-code",
          projectPolicy: "cloud-ok",
        }),
        query: "alpha",
        limit: 2,
      }),
    ).resolves.toMatchObject({ status: "ok", degraded: false });

    await expect(
      tools.gbrainCapture({
        ...auth({
          allowedTools: ["gbrain_capture"],
          hostId: "claude-code",
          projectPolicy: "cloud-ok",
        }),
        content: "Runtime note",
        title: "Runtime note",
        runtimeProvenance,
      }),
    ).resolves.toEqual({ status: "captured" });

    await expect(
      tools.provenanceLog({
        ...auth({
          allowedTools: ["provenance_log"],
          hostId: "claude-code",
          projectPolicy: "cloud-ok",
        }),
        event: "artifact-imported",
        metadata: { artifactId: "artifact-1" },
      }),
    ).resolves.toEqual({ logged: true });

    await expect(
      tools.openhandsDelegate({
        ...auth({
          allowedTools: ["openhands_delegate"],
          hostId: "claude-code",
          projectPolicy: "cloud-ok",
        }),
        task: "Run unit tests",
      }),
    ).resolves.toEqual({ status: "delegated" });

    await expect(
      tools.projectWorkspaceRead({
        ...auth({
          allowedTools: ["project_workspace_read"],
          hostId: "claude-code",
          projectPolicy: "cloud-ok",
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

    await expect(
      tools.artifactImport({
        ...auth({
          allowedTools: ["artifact_import"],
          hostId: "claude-code",
          projectPolicy: "cloud-ok",
        }),
        sourcePath: "results/summary.md",
        sourcePathKind: "project-relative",
        allowedRoots: [tempRoot],
        approvalState: "not-required",
        importReason: "host-declared-artifact",
        projectRoot: tempRoot,
        promptHash: "prompt-hash-1",
        inputFileRefs: ["gbrain:wiki/notes/assay-summary"],
      }),
    ).resolves.toMatchObject({
      validation: { ok: true },
      artifact: {
        workspacePath: "results/summary.md",
      },
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

  it("runs authorized structural retrieval without passing token material to the reader", async () => {
    const structuralRetrieval = vi.fn(async () =>
      structuralRetrievalResult({
        status: "degraded",
        degraded: true,
        provenance: {
          ...structuralRetrievalResult().provenance,
          capability: {
            structuralNavigationAvailable: false,
            schemaVersion: null,
            chunkerVersion: "4",
            blockers: ["capability gate failed"],
          },
        },
      })
    );
    const tools = createRuntimeMcpToolset({
      tokenSecret: SECRET,
      now: () => NOW,
      structuralRetrieval,
    });

    await expect(
      tools.gbrainStructuralRetrieve({
        ...auth({ allowedTools: ["gbrain_structural_retrieve"] }),
        query: "alpha",
      }),
    ).resolves.toMatchObject({ status: "degraded" });
    expect(structuralRetrieval).toHaveBeenCalledWith(
      expect.not.objectContaining({ token: expect.any(String) }),
    );
  });

  it("runs authorized openhands delegation through the injected handler", async () => {
    const openhandsDelegate = vi.fn(async () => ({ status: "delegated" }));
    const tools = createRuntimeMcpToolset({
      tokenSecret: SECRET,
      now: () => NOW,
      openhandsDelegate,
    });

    await expect(
      tools.openhandsDelegate({
        ...auth({
          allowedTools: ["openhands_delegate"],
          hostId: "claude-code",
          projectPolicy: "cloud-ok",
        }),
        task: "Run unit tests",
      }),
    ).resolves.toEqual({ status: "delegated" });
    expect(openhandsDelegate).toHaveBeenCalledWith({
      task: "Run unit tests",
      repository: undefined,
      branch: undefined,
      model: undefined,
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
