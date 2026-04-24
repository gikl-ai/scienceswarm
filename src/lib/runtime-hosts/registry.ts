import { getOpenHandsUrl } from "@/lib/config/ports";
import {
  RUNTIME_HOST_IDS,
  type RuntimeHostCapability,
  type RuntimeHostId,
  type RuntimeHostProfile,
} from "./contracts";
import { RuntimeHostError } from "./errors";

const BUILT_IN_PROFILES: RuntimeHostProfile[] = [
  {
    id: "openclaw",
    label: "OpenClaw",
    authMode: "local",
    authProvider: "openclaw",
    privacyClass: "local-network",
    transport: {
      kind: "desktop-bridge",
      protocol: "websocket",
    },
    controlSurface: {
      owner: "scienceSwarm-wrapper",
      sessionIdSource: "scienceSwarm",
      supportsCancel: true,
      supportsResume: true,
      supportsNativeSessionList: false,
    },
    mcpToolProfile: {
      alwaysExposeTools: ["gbrain_read", "gbrain_write", "provenance_log"],
      conditionalWorkspaceTools: ["project_workspace_read"],
      suppressWhenNativeToolsSafe: [],
    },
    capabilities: ["chat", "stream", "cancel", "resume", "mcp-tools"],
    requiresProjectPrivacy: "local-only",
    dataSent: ["prompt", "gbrain-excerpt", "workspace-file"],
    storesTokensInScienceSwarm: false,
    lifecycle: {
      status: "available",
      canStream: true,
      canCancel: true,
      canResumeNativeSession: false,
      canListNativeSessions: false,
      cancelSemantics: "kill-wrapper-process",
      resumeSemantics: "scienceSwarm-wrapper-session",
    },
  },
  {
    id: "claude-code",
    label: "Claude Code",
    authMode: "subscription-native",
    authProvider: "anthropic",
    privacyClass: "hosted",
    transport: {
      kind: "local-cli",
      protocol: "stdout-jsonl",
      cliMode: "stdout-jsonl",
      command: "claude",
    },
    controlSurface: {
      owner: "scienceSwarm-wrapper",
      sessionIdSource: "native-host",
      supportsCancel: true,
      supportsResume: true,
      supportsNativeSessionList: false,
    },
    mcpToolProfile: {
      alwaysExposeTools: ["gbrain_read", "gbrain_write", "provenance_log"],
      conditionalWorkspaceTools: ["project_workspace_read", "artifact_import"],
      suppressWhenNativeToolsSafe: ["project_workspace_write"],
    },
    capabilities: [
      "chat",
      "task",
      "stream",
      "cancel",
      "resume",
      "mcp-tools",
      "artifact-import",
    ],
    requiresProjectPrivacy: "cloud-ok",
    dataSent: ["prompt", "gbrain-excerpt", "workspace-file", "artifact"],
    storesTokensInScienceSwarm: false,
    lifecycle: {
      status: "requires-auth",
      canStream: true,
      canCancel: true,
      canResumeNativeSession: true,
      canListNativeSessions: false,
      cancelSemantics: "kill-wrapper-process",
      resumeSemantics: "open-native-session",
    },
  },
  {
    id: "codex",
    label: "Codex",
    authMode: "subscription-native",
    authProvider: "openai",
    privacyClass: "hosted",
    transport: {
      kind: "local-cli",
      protocol: "stdio",
      cliMode: "stdio",
      command: "codex",
    },
    controlSurface: {
      owner: "scienceSwarm-wrapper",
      sessionIdSource: "scienceSwarm",
      supportsCancel: true,
      supportsResume: false,
      supportsNativeSessionList: false,
    },
    mcpToolProfile: {
      alwaysExposeTools: ["gbrain_read", "gbrain_write", "provenance_log"],
      conditionalWorkspaceTools: ["project_workspace_read", "artifact_import"],
      suppressWhenNativeToolsSafe: ["project_workspace_write"],
    },
    capabilities: [
      "chat",
      "task",
      "stream",
      "cancel",
      "mcp-tools",
      "artifact-import",
    ],
    requiresProjectPrivacy: "cloud-ok",
    dataSent: ["prompt", "gbrain-excerpt", "workspace-file", "artifact"],
    storesTokensInScienceSwarm: false,
    lifecycle: {
      status: "requires-auth",
      canStream: true,
      canCancel: true,
      canResumeNativeSession: false,
      canListNativeSessions: false,
      cancelSemantics: "kill-wrapper-process",
      resumeSemantics: "scienceSwarm-wrapper-session",
    },
  },
  {
    id: "gemini-cli",
    label: "Gemini CLI",
    authMode: "subscription-native",
    authProvider: "google-ai",
    privacyClass: "hosted",
    transport: {
      kind: "local-cli",
      protocol: "stdio",
      cliMode: "stdio",
      command: "gemini",
    },
    controlSurface: {
      owner: "scienceSwarm-wrapper",
      sessionIdSource: "scienceSwarm",
      supportsCancel: true,
      supportsResume: false,
      supportsNativeSessionList: false,
    },
    mcpToolProfile: {
      alwaysExposeTools: ["gbrain_read", "gbrain_write", "provenance_log"],
      conditionalWorkspaceTools: ["project_workspace_read", "artifact_import"],
      suppressWhenNativeToolsSafe: ["project_workspace_write"],
    },
    capabilities: [
      "chat",
      "task",
      "stream",
      "cancel",
      "mcp-tools",
      "artifact-import",
    ],
    requiresProjectPrivacy: "cloud-ok",
    dataSent: ["prompt", "gbrain-excerpt", "workspace-file", "artifact"],
    storesTokensInScienceSwarm: false,
    lifecycle: {
      status: "requires-auth",
      canStream: true,
      canCancel: true,
      canResumeNativeSession: false,
      canListNativeSessions: false,
      cancelSemantics: "kill-wrapper-process",
      resumeSemantics: "scienceSwarm-wrapper-session",
    },
  },
  {
    id: "openhands",
    label: "OpenHands",
    authMode: "local",
    authProvider: "openhands",
    privacyClass: "local-network",
    transport: {
      kind: "managed-openhands",
      protocol: "http",
      endpoint: getOpenHandsUrl(),
    },
    controlSurface: {
      owner: "scienceSwarm-wrapper",
      sessionIdSource: "native-host",
      supportsCancel: true,
      supportsResume: true,
      supportsNativeSessionList: true,
    },
    mcpToolProfile: {
      alwaysExposeTools: ["gbrain_read", "gbrain_write", "provenance_log"],
      conditionalWorkspaceTools: ["artifact_import"],
      suppressWhenNativeToolsSafe: ["project_workspace_read", "project_workspace_write"],
    },
    capabilities: [
      "task",
      "stream",
      "cancel",
      "resume",
      "list-sessions",
      "mcp-tools",
      "artifact-import",
    ],
    requiresProjectPrivacy: "execution-ok",
    dataSent: ["prompt", "gbrain-excerpt", "workspace-file", "artifact"],
    storesTokensInScienceSwarm: false,
    lifecycle: {
      status: "requires-install",
      canStream: true,
      canCancel: true,
      canResumeNativeSession: true,
      canListNativeSessions: true,
      cancelSemantics: "host-api-cancel",
      resumeSemantics: "open-native-session",
    },
  },
];

export const BUILT_IN_RUNTIME_HOST_PROFILES: readonly RuntimeHostProfile[] =
  BUILT_IN_PROFILES;

export interface RuntimeHostRecord {
  known: true;
  readOnly: false;
  id: RuntimeHostId;
  label: string;
  profile: RuntimeHostProfile;
}

export interface UnknownRuntimeHostRecord {
  known: false;
  readOnly: true;
  id: string;
  label: string;
  profile: null;
}

export type RuntimeHostHistoricalRecord =
  | RuntimeHostRecord
  | UnknownRuntimeHostRecord;

export class RuntimeHostRegistry {
  private readonly profiles = new Map<RuntimeHostId, RuntimeHostProfile>();

  constructor(profiles: readonly RuntimeHostProfile[] = BUILT_IN_PROFILES) {
    for (const profile of profiles) {
      this.register(profile);
    }
  }

  register(profile: RuntimeHostProfile): void {
    this.profiles.set(profile.id, profile);
  }

  list(): RuntimeHostProfile[] {
    return Array.from(this.profiles.values());
  }

  get(hostId: RuntimeHostId | string): RuntimeHostProfile | null {
    return this.profiles.get(hostId as RuntimeHostId) ?? null;
  }

  require(hostId: RuntimeHostId | string): RuntimeHostProfile {
    const profile = this.get(hostId);
    if (profile) return profile;

    throw new RuntimeHostError({
      code: "RUNTIME_HOST_UNKNOWN",
      status: 404,
      message: `Unknown runtime host: ${hostId}`,
      userMessage: "That runtime host is no longer available.",
      recoverable: true,
      context: { hostId },
    });
  }

  resolveHistorical(hostId: RuntimeHostId | string): RuntimeHostHistoricalRecord {
    const profile = this.get(hostId);
    if (profile) {
      return {
        known: true,
        readOnly: false,
        id: profile.id,
        label: profile.label,
        profile,
      };
    }

    return {
      known: false,
      readOnly: true,
      id: hostId,
      label: `Unknown runtime host (${hostId})`,
      profile: null,
    };
  }
}

export function createRuntimeHostRegistry(
  profiles: readonly RuntimeHostProfile[] = BUILT_IN_PROFILES,
): RuntimeHostRegistry {
  return new RuntimeHostRegistry(profiles);
}

const defaultRuntimeHostRegistry = createRuntimeHostRegistry();

export function listRuntimeHostProfiles(): RuntimeHostProfile[] {
  return defaultRuntimeHostRegistry.list();
}

export function getRuntimeHostProfile(
  hostId: RuntimeHostId | string,
): RuntimeHostProfile | null {
  return defaultRuntimeHostRegistry.get(hostId);
}

export function requireRuntimeHostProfile(
  hostId: RuntimeHostId | string,
): RuntimeHostProfile {
  return defaultRuntimeHostRegistry.require(hostId);
}

export function resolveRuntimeHostRecord(
  hostId: RuntimeHostId | string,
): RuntimeHostHistoricalRecord {
  return defaultRuntimeHostRegistry.resolveHistorical(hostId);
}

export function isRuntimeHostId(value: string): value is RuntimeHostId {
  return RUNTIME_HOST_IDS.includes(value as RuntimeHostId);
}

export function hasRuntimeHostCapability(
  profile: RuntimeHostProfile,
  capability: RuntimeHostCapability,
): boolean {
  return profile.capabilities.includes(capability);
}
