import { describe, expect, it } from "vitest";

import {
  BUILT_IN_RUNTIME_HOST_PROFILES,
  RuntimeHostCapabilityUnsupported,
  createRuntimeHostRegistry,
  hasRuntimeHostCapability,
  listRuntimeHostProfiles,
  mapRuntimeHostErrorToApiError,
  requireRuntimeHostProfile,
  resolveRuntimeHostRecord,
  type ArtifactImportRequest,
  type ResearchRuntimeHost,
  type RuntimeCancelResult,
  type RuntimeEvent,
  type RuntimeHostAuthStatus,
  type RuntimeHostHealth,
  type RuntimeHostPrivacyProof,
  type RuntimePrivacyClass,
  type RuntimeSessionRecord,
  type RuntimeTurnRequest,
  type RuntimeTurnResult,
} from "@/lib/runtime-hosts";

describe("runtime host contracts and registry", () => {
  it("defines serializable built-in host profiles for every Track 0 runtime host", () => {
    const profiles = listRuntimeHostProfiles();

    expect(profiles.map((profile) => profile.id)).toEqual([
      "openclaw",
      "claude-code",
      "codex",
      "gemini-cli",
      "openhands",
    ]);
    expect(JSON.parse(JSON.stringify(BUILT_IN_RUNTIME_HOST_PROFILES))).toEqual(
      BUILT_IN_RUNTIME_HOST_PROFILES,
    );

    for (const profile of profiles) {
      expect(profile).toMatchObject({
        id: expect.any(String),
        label: expect.any(String),
        authMode: expect.any(String),
        authProvider: expect.any(String),
        privacyClass: expect.any(String),
        transport: {
          kind: expect.any(String),
          protocol: expect.any(String),
        },
        controlSurface: {
          owner: expect.any(String),
          sessionIdSource: expect.any(String),
          supportsCancel: expect.any(Boolean),
          supportsResume: expect.any(Boolean),
          supportsNativeSessionList: expect.any(Boolean),
        },
        mcpToolProfile: {
          alwaysExposeTools: expect.any(Array),
          conditionalWorkspaceTools: expect.any(Array),
          suppressWhenNativeToolsSafe: expect.any(Array),
        },
        capabilities: expect.any(Array),
        requiresProjectPrivacy: expect.any(String),
        dataSent: expect.any(Array),
        lifecycle: expect.objectContaining({
          canStream: expect.any(Boolean),
          canCancel: expect.any(Boolean),
          canResumeNativeSession: expect.any(Boolean),
          canListNativeSessions: expect.any(Boolean),
        }),
      });
    }
  });

  it("supports capability lookup without relying on host names for controls", () => {
    const openclaw = requireRuntimeHostProfile("openclaw");
    const codex = requireRuntimeHostProfile("codex");
    const openhands = requireRuntimeHostProfile("openhands");

    expect(hasRuntimeHostCapability(openclaw, "chat")).toBe(true);
    expect(hasRuntimeHostCapability(openclaw, "task")).toBe(false);
    expect(hasRuntimeHostCapability(codex, "task")).toBe(true);
    expect(hasRuntimeHostCapability(codex, "resume")).toBe(false);
    expect(hasRuntimeHostCapability(openhands, "chat")).toBe(false);
    expect(openhands.controlSurface.supportsNativeSessionList).toBe(true);
  });

  it("describes Claude Code as a native-session runtime host", () => {
    const profile = requireRuntimeHostProfile("claude-code");

    expect(profile.capabilities).toContain("resume");
    expect(profile.controlSurface).toMatchObject({
      owner: "scienceSwarm-wrapper",
      sessionIdSource: "native-host",
      supportsResume: true,
      supportsNativeSessionList: false,
    });
    expect(profile.lifecycle).toMatchObject({
      canResumeNativeSession: true,
      canListNativeSessions: false,
      resumeSemantics: "open-native-session",
    });
  });

  it("describes non-resumable local CLI adapters as ScienceSwarm wrapper sessions", () => {
    for (const hostId of ["codex", "gemini-cli"] as const) {
      const profile = requireRuntimeHostProfile(hostId);

      expect(profile.controlSurface).toMatchObject({
        owner: "scienceSwarm-wrapper",
        sessionIdSource: "scienceSwarm",
        supportsResume: false,
        supportsNativeSessionList: false,
      });
      expect(profile.lifecycle).toMatchObject({
        canResumeNativeSession: false,
        canListNativeSessions: false,
        resumeSemantics: "scienceSwarm-wrapper-session",
      });
    }
  });

  it("tolerates unknown historical host ids as read-only records", () => {
    expect(resolveRuntimeHostRecord("legacy-runtime-v1")).toEqual({
      known: false,
      readOnly: true,
      id: "legacy-runtime-v1",
      label: "Unknown AI destination (legacy-runtime-v1)",
      profile: null,
    });
    expect(resolveRuntimeHostRecord("codex")).toMatchObject({
      known: true,
      readOnly: false,
      id: "codex",
      label: "Codex",
    });
  });

  it("keeps custom registry registration isolated from the default registry", () => {
    const registry = createRuntimeHostRegistry([]);

    expect(registry.list()).toEqual([]);
    registry.register(requireRuntimeHostProfile("openclaw"));

    expect(registry.list().map((profile) => profile.id)).toEqual(["openclaw"]);
    expect(listRuntimeHostProfiles().map((profile) => profile.id)).toEqual([
      "openclaw",
      "claude-code",
      "codex",
      "gemini-cli",
      "openhands",
    ]);
  });

  it("lets fake hosts satisfy the ResearchRuntimeHost contract", async () => {
    class FakeHost implements ResearchRuntimeHost {
      profile() {
        return requireRuntimeHostProfile("openclaw");
      }

      async health(): Promise<RuntimeHostHealth> {
        return {
          status: "ready",
          checkedAt: "2026-04-22T00:00:00.000Z",
        };
      }

      async authStatus(): Promise<RuntimeHostAuthStatus> {
        const profile = this.profile();
        return {
          status: "not-required",
          authMode: profile.authMode,
          provider: profile.authProvider,
        };
      }

      async privacyProfile(): Promise<
        RuntimePrivacyClass | RuntimeHostPrivacyProof
      > {
        return {
          privacyClass: "local-network",
          adapterProof: "declared-local",
        };
      }

      async sendTurn(_request: RuntimeTurnRequest): Promise<RuntimeTurnResult> {
        return {
          hostId: "openclaw",
          sessionId: "session-1",
          message: "ok",
        };
      }

      async executeTask(
        _request: RuntimeTurnRequest,
      ): Promise<RuntimeSessionRecord> {
        throw new RuntimeHostCapabilityUnsupported({
          hostId: "openclaw",
          capability: "task",
          mode: "task",
        });
      }

      async cancel(sessionId: string): Promise<RuntimeCancelResult> {
        return {
          sessionId,
          cancelled: true,
        };
      }

      async listSessions(_projectId: string): Promise<RuntimeSessionRecord[]> {
        return [];
      }

      async *streamEvents(_sessionId: string): AsyncIterable<RuntimeEvent> {
        return;
      }

      async artifactImportHints(
        _sessionId: string,
      ): Promise<ArtifactImportRequest[]> {
        return [];
      }
    }

    const host = new FakeHost();

    expect(host.profile().id).toBe("openclaw");
    await expect(host.health()).resolves.toMatchObject({ status: "ready" });
    await expect(host.executeTask({} as RuntimeTurnRequest)).rejects.toThrow(
      RuntimeHostCapabilityUnsupported,
    );
  });

  it("maps typed runtime errors to API-safe responses", () => {
    const apiError = mapRuntimeHostErrorToApiError(
      new RuntimeHostCapabilityUnsupported({
        hostId: "openclaw",
        capability: "task",
        mode: "task",
      }),
    );

    expect(apiError).toEqual({
      status: 422,
      body: {
        error: "This destination does not support the requested action.",
        code: "RUNTIME_HOST_CAPABILITY_UNSUPPORTED",
        recoverable: true,
      },
    });
  });
});
