import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  createRuntimeMcpToolset,
  type RuntimeMcpToolsetDeps,
} from "./tools";

type McpToolResponse = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  [key: string]: unknown;
};

export type RegisterRuntimeMcpToolsDeps = RuntimeMcpToolsetDeps;

const projectPolicySchema = z.enum(["local-only", "cloud-ok", "execution-ok"]);
const approvalStateSchema = z.enum([
  "not-required",
  "required",
  "approved",
  "rejected",
]);

const runtimeMcpAuthSchema = {
  token: z.string().describe("Short-lived RuntimeMcpAccessToken"),
  projectId: z.string().describe("ScienceSwarm project slug"),
  runtimeSessionId: z.string().describe("ScienceSwarm runtime session id"),
  hostId: z.string().describe("Runtime host id"),
  projectPolicy: projectPolicySchema.describe("Current project privacy policy"),
  approved: z.boolean().optional().describe("Preview approval already captured"),
};

const runtimeProvenanceSchema = z.object({
  runtimeSessionId: z.string(),
  hostId: z.string(),
  sourceArtifactId: z.string().nullable(),
  promptHash: z.string(),
  inputFileRefs: z.array(z.string()),
  approvalState: approvalStateSchema,
});

function isMcpToolResponse(value: unknown): value is McpToolResponse {
  return Boolean(
    value
    && typeof value === "object"
    && Array.isArray((value as { content?: unknown }).content),
  );
}

function formatToolResult(value: unknown): McpToolResponse {
  if (isMcpToolResponse(value)) return value;
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

function formatToolError(error: unknown): McpToolResponse {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: error instanceof Error ? error.message : String(error),
      },
    ],
  };
}

async function runRuntimeTool(
  operation: () => Promise<unknown>,
): Promise<McpToolResponse> {
  try {
    return formatToolResult(await operation());
  } catch (error) {
    return formatToolError(error);
  }
}

export function registerRuntimeMcpTools(
  server: McpServer,
  deps: RegisterRuntimeMcpToolsDeps = {},
): void {
  const tools = createRuntimeMcpToolset(deps);

  server.tool(
    "gbrain_search",
    "Runtime-authorized gbrain search",
    {
      ...runtimeMcpAuthSchema,
      query: z.string().describe("Search query"),
      mode: z.string().optional().describe("Search mode"),
      limit: z.number().optional().describe("Maximum results"),
      detail: z.string().optional().describe("Search detail level"),
    },
    async (params) => runRuntimeTool(() => tools.gbrainSearch(params)),
  );

  server.tool(
    "gbrain_read",
    "Runtime-authorized gbrain page read",
    {
      ...runtimeMcpAuthSchema,
      path: z.string().describe("gbrain page path relative to the brain root"),
    },
    async (params) => runRuntimeTool(() => tools.gbrainRead(params)),
  );

  server.tool(
    "gbrain_capture",
    "Runtime-authorized gbrain capture with provenance",
    {
      ...runtimeMcpAuthSchema,
      content: z.string().describe("Capture body in markdown"),
      kind: z.string().optional().describe("Capture kind"),
      title: z.string().optional().describe("Optional title"),
      project: z.string().optional().describe("Project slug"),
      tags: z.array(z.string()).optional().describe("Tags"),
      channel: z.string().optional().describe("Origin channel"),
      userId: z.string().optional().describe("Originating user identifier"),
      runtimeProvenance: runtimeProvenanceSchema
        .optional()
        .describe("RuntimeGbrainProvenance for runtime-originated writes"),
    },
    async (params) => runRuntimeTool(() => tools.gbrainCapture(params)),
  );

  server.tool(
    "project_workspace_read",
    "Runtime-authorized project workspace file read",
    {
      ...runtimeMcpAuthSchema,
      workspacePath: z.string().describe("Project-relative file path"),
      projectRoot: z.string().optional().describe("Project root override"),
      maxBytes: z.number().optional().describe("Maximum bytes to return"),
    },
    async (params) => runRuntimeTool(() => tools.projectWorkspaceRead(params)),
  );

  server.tool(
    "provenance_log",
    "Runtime-authorized provenance event log",
    {
      ...runtimeMcpAuthSchema,
      event: z.string().describe("Provenance event label"),
      metadata: z.record(z.string(), z.unknown()).optional().describe("Event metadata"),
      runtimeProvenance: runtimeProvenanceSchema
        .optional()
        .describe("Optional RuntimeGbrainProvenance payload"),
    },
    async (params) => runRuntimeTool(() => tools.provenanceLog(params)),
  );

  server.tool(
    "artifact_import",
    "Runtime-authorized artifact import validation",
    {
      ...runtimeMcpAuthSchema,
      sourcePath: z.string().describe("Artifact source path"),
      sourcePathKind: z
        .enum(["project-relative", "local-absolute", "host-native"])
        .describe("Artifact source path namespace"),
      hostNativePath: z.string().optional().describe("Host-native artifact path"),
      allowedRoots: z.array(z.string()).optional().describe("Approved external roots"),
      approvalState: approvalStateSchema.describe("Artifact import approval state"),
      importReason: z
        .enum([
          "host-declared-artifact",
          "workspace-output-scan",
          "user-selected-external-path",
        ])
        .describe("Artifact import reason"),
      targetPath: z.string().optional().describe("Optional project-relative target"),
      projectRoot: z.string().optional().describe("Project root override"),
      hostWorkspaceRoot: z.string().optional().describe("Runtime host workspace root"),
      requireFile: z.boolean().optional().describe("Require source to be a file"),
      promptHash: z.string().optional().describe("Prompt hash for artifact provenance"),
      inputFileRefs: z.array(z.string()).optional().describe("Input file refs"),
      importedBy: z.string().optional().describe("Importer handle"),
      generatedAt: z.string().optional().describe("Artifact generation timestamp"),
      gbrainSlug: z.string().nullable().optional().describe("Optional gbrain slug"),
    },
    async (params) =>
      runRuntimeTool(() =>
        tools.artifactImport({
          ...params,
          allowedRoots: params.allowedRoots ?? [],
        })
      ),
  );

  server.tool(
    "openhands_delegate",
    "Runtime-authorized OpenHands delegation",
    {
      ...runtimeMcpAuthSchema,
      task: z.string().describe("Task to delegate to OpenHands"),
      repository: z.string().optional().describe("Repository URL or id"),
      branch: z.string().optional().describe("Repository branch"),
      model: z.string().optional().describe("OpenHands model override"),
    },
    async (params) => runRuntimeTool(() => tools.openhandsDelegate(params)),
  );
}
