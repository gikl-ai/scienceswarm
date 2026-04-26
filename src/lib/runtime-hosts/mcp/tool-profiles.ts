import type {
  RuntimeHostId,
  RuntimeHostProfile,
} from "../contracts";
import { requireRuntimeHostProfile } from "../registry";
import {
  RUNTIME_MCP_TOOL_NAMES,
  type RuntimeMcpToolName,
} from "./tokens";

export interface RuntimeMcpResolvedToolProfile {
  hostId: RuntimeHostId | string;
  always: RuntimeMcpToolName[];
  workspace: RuntimeMcpToolName[];
  suppressed: RuntimeMcpToolName[];
  allowedTools: RuntimeMcpToolName[];
}

const PROFILE_TOOL_ALIASES: Record<string, RuntimeMcpToolName[]> = {
  gbrain_read: ["gbrain_search", "gbrain_read", "gbrain_structural_retrieve"],
  gbrain_write: ["gbrain_capture"],
  structural_retrieval: ["gbrain_structural_retrieve"],
  provenance_log: ["provenance_log"],
  project_workspace_read: ["project_workspace_read"],
  artifact_import: ["artifact_import"],
  openhands_delegate: ["openhands_delegate"],
};

function unique(values: readonly RuntimeMcpToolName[]): RuntimeMcpToolName[] {
  return Array.from(new Set(values));
}

export function isRuntimeMcpToolName(value: string): value is RuntimeMcpToolName {
  return RUNTIME_MCP_TOOL_NAMES.includes(value as RuntimeMcpToolName);
}

export function expandRuntimeMcpToolNames(
  tools: readonly string[],
): RuntimeMcpToolName[] {
  return unique(
    tools.flatMap((tool) =>
      PROFILE_TOOL_ALIASES[tool]
        ?? (isRuntimeMcpToolName(tool) ? [tool] : [])
    ),
  );
}

export function resolveRuntimeMcpToolProfile(
  hostOrProfile: RuntimeHostProfile | RuntimeHostId | string,
): RuntimeMcpResolvedToolProfile {
  const host = typeof hostOrProfile === "string"
    ? requireRuntimeHostProfile(hostOrProfile)
    : hostOrProfile;

  if (!host.capabilities.includes("mcp-tools")) {
    return {
      hostId: host.id,
      always: [],
      workspace: [],
      suppressed: [],
      allowedTools: [],
    };
  }

  const always = expandRuntimeMcpToolNames(
    host.mcpToolProfile.alwaysExposeTools,
  );
  const suppressed = expandRuntimeMcpToolNames(
    host.mcpToolProfile.suppressWhenNativeToolsSafe,
  );
  const workspace = expandRuntimeMcpToolNames(
    host.mcpToolProfile.conditionalWorkspaceTools,
  ).filter((tool) => !suppressed.includes(tool));

  return {
    hostId: host.id,
    always,
    workspace,
    suppressed,
    allowedTools: unique([...always, ...workspace]),
  };
}

export function runtimeMcpToolAllowedForHost(input: {
  host: RuntimeHostProfile | RuntimeHostId | string;
  toolName: RuntimeMcpToolName;
}): boolean {
  return resolveRuntimeMcpToolProfile(input.host).allowedTools.includes(
    input.toolName,
  );
}
