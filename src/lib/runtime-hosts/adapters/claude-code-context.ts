import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildProjectBrief } from "@/brain/briefing";
import { loadBrainConfig } from "@/brain/config";
import {
  getScienceSwarmProjectRoot,
} from "@/lib/scienceswarm-paths";
import { buildScienceSwarmGbrainEnv } from "@/lib/gbrain/source-of-truth";
import { buildScienceSwarmPromptContextText } from "@/lib/scienceswarm-prompt-config";
import type {
  RuntimeDataIncluded,
  RuntimeProjectPolicy,
  RuntimeTurnRequest,
} from "@/lib/runtime-hosts/contracts";
import { resolveRuntimeMcpToolProfile } from "@/lib/runtime-hosts/mcp/tool-profiles";
import { mintRuntimeMcpAccessToken } from "@/lib/runtime-hosts/mcp/tokens";
import type { RuntimeMcpToolName } from "@/lib/runtime-hosts/mcp/tokens";
import { LaunchAuditStateSchema } from "@/lib/studies";
import {
  ensureRuntimeWorkspace,
  resolveRuntimeWorkspace,
} from "@/lib/runtime-hosts/workspace";
import { assertSafeProjectSlug } from "@/lib/state/project-manifests";

// Claude Code turns can spend most of their wall clock inside scientific
// tools before the final gbrain write. Keep the scoped MCP token alive longer
// than the adapter timeout so final provenance writes do not fail after a
// successful long-running run.
const DEFAULT_RUNTIME_MCP_TOKEN_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_BRAIN_MD_CHARS = 4_000;

export interface ClaudeCodeInvocationContext {
  cwd?: string;
  appendSystemPrompt?: string;
  addDirs?: string[];
  env?: NodeJS.ProcessEnv;
  mcpConfigPath?: string;
  allowedTools?: string[];
  agentWorkspaceId?: string;
  launchBundlePath?: string;
  runId?: string;
  cleanup?: () => Promise<void>;
}

export interface ClaudeCodeRuntimeContextBuilderInput {
  request: RuntimeTurnRequest;
  wrapperSessionId: string;
  nativeSessionId: string;
  runId: string;
  env: NodeJS.ProcessEnv;
  repoRoot?: string;
  dataRoot?: string;
  enableRuntimeMcp?: boolean;
  tokenTtlMs?: number;
}

export type ClaudeCodeRuntimeContextBuilder = (
  input: ClaudeCodeRuntimeContextBuilderInput,
) => Promise<ClaudeCodeInvocationContext | null>;

export function claudeCodeRuntimeContextDataIncluded(input: {
  projectId?: string | null;
  includeRuntimeMcp?: boolean;
}): RuntimeDataIncluded[] {
  if (!input.projectId) return [];
  const data: RuntimeDataIncluded[] = [
    {
      kind: "workspace-file",
      label: "ScienceSwarm runtime guidance (SCIENCESWARM.md)",
    },
    {
      kind: "gbrain-excerpt",
      label: "Compact gbrain project brief",
    },
  ];

  if (input.includeRuntimeMcp !== false) {
    data.push({
      kind: "mcp-tool-call",
      label: "Scoped gbrain MCP tools",
    });
  }

  return data;
}

export async function buildClaudeCodeRuntimeContext(
  input: ClaudeCodeRuntimeContextBuilderInput,
): Promise<ClaudeCodeInvocationContext> {
  const projectSlug = input.request.projectId
    ? assertSafeProjectSlug(input.request.projectId)
    : "global";
  const repoRoot = path.resolve(input.repoRoot ?? process.cwd());
  const runtimeEnv = buildScienceSwarmGbrainEnv(input.env, repoRoot);
  const workspace = resolveRuntimeWorkspace({
    projectId: input.request.projectId,
    runId: input.runId,
    host: "claude-code",
    dataRoot: input.dataRoot,
  });
  await ensureRuntimeWorkspace({
    agentWorkspace: workspace.agentWorkspace,
    launchBundle: workspace.launchBundle,
    stableScienceSwarmMarkdown: buildStableScienceSwarmWorkspaceMarkdown(),
    stableClaudeMarkdown: buildStableClaudeWorkspaceMarkdown(),
  });

  const loadedProjectGuidance = await buildScienceSwarmPromptContextText({
    projectId: input.request.projectId,
    backend: "agent",
  });
  const brainBrief = await buildCompactBrainBrief(input.request.projectId);
  let runtimeMcp: Awaited<ReturnType<typeof buildRuntimeMcpContext>> | null = null;
  try {
    runtimeMcp = input.enableRuntimeMcp === false || !input.request.projectId
      ? null
      : await buildRuntimeMcpContext({
          projectId: projectSlug,
          runtimeSessionId: input.wrapperSessionId,
          projectPolicy: input.request.preview.projectPolicy,
          promptHash:
            input.request.promptHash ?? contentSha256(input.request.prompt),
          inputFileRefs: input.request.inputFileRefs,
          approvalState: input.request.approvalState,
          approvalStateApproved: input.request.approvalState === "approved"
            || input.request.approvalState === "not-required",
          repoRoot,
          mcpConfigPath: workspace.launchBundle.mcpConfigPath,
          env: runtimeEnv,
          tokenTtlMs: input.tokenTtlMs ?? DEFAULT_RUNTIME_MCP_TOKEN_TTL_MS,
        });

    const dynamicPrompt = buildClaudeCodeRuntimePromptMarkdown({
      projectId: input.request.projectId,
      loadedProjectGuidance,
      brainBrief,
      runtimeMcpInstructions: runtimeMcp?.instructions ?? null,
    });
    await writeFile(workspace.launchBundle.promptSnapshotPath, dynamicPrompt, {
      encoding: "utf8",
      mode: 0o600,
    });
    await writeRedactedLaunchAudit({
      runId: input.runId,
      cwd: workspace.agentWorkspace.cwd,
      launchBundlePath: workspace.launchBundle.root,
      prompt: dynamicPrompt,
      mcpConfigHash: runtimeMcp?.configHash ?? null,
      hasRuntimeMcpAccessToken: Boolean(runtimeMcp),
      auditPath: workspace.launchBundle.redactedAuditPath,
    });

    const addDirs = input.request.projectId
      ? existingDirectories([getScienceSwarmProjectRoot(projectSlug)])
      : [];

    return {
      cwd: workspace.agentWorkspace.cwd,
      appendSystemPrompt: dynamicPrompt,
      addDirs,
      env: runtimeEnv,
      mcpConfigPath: runtimeMcp?.configPath,
      allowedTools: runtimeMcp?.allowedTools,
      agentWorkspaceId: workspace.agentWorkspace.id,
      launchBundlePath: workspace.launchBundle.root,
      runId: input.runId,
      cleanup: runtimeMcp?.cleanup,
    };
  } catch (error) {
    await runtimeMcp?.cleanup().catch(() => undefined);
    throw error;
  }
}

function buildStableClaudeWorkspaceMarkdown(): string {
  return [
    "# CLAUDE.md",
    "",
    "This is a stable ScienceSwarm AgentWorkspace for Claude Code.",
    "",
    "Read `SCIENCESWARM.md` first for durable workspace orientation.",
    "",
    "Run-specific prompts, current user requests, runtime MCP configuration,",
    "model policy, and auth material are injected at launch time and do not",
    "belong in this file.",
    "",
    "Do not infer ScienceSwarm product behavior from the app source repository unless",
    "the user explicitly asks to work on ScienceSwarm itself.",
  ].join("\n");
}

function buildStableScienceSwarmWorkspaceMarkdown(): string {
  return [
    "# SCIENCESWARM.md",
    "",
    "ScienceSwarm is a local-first research workspace powered by OpenClaw, OpenHands, and gbrain.",
    "",
    "- gbrain is the durable research-memory layer and source of truth.",
    "- OpenClaw is the user-facing manager and communication layer.",
    "- OpenHands is the execution agent for heavier implementation tasks.",
    "- This directory is the stable AgentWorkspace for a ScienceSwarm research context.",
    "",
    "Current run context, compact brain briefs, MCP access, and user requests are",
    "delivered through the launch prompt and LaunchBundle, not stable workspace shims.",
  ].join("\n");
}

function buildClaudeCodeRuntimePromptMarkdown(input: {
  projectId: string | null;
  loadedProjectGuidance: string | null;
  brainBrief: string | null;
  runtimeMcpInstructions: string | null;
}): string {
  return [
    "# ScienceSwarm Launch Context",
    "",
    "ScienceSwarm is a local-first research workspace powered by OpenClaw, OpenHands, and gbrain.",
    "",
    "- gbrain is the durable research-memory layer and source of truth.",
    "- OpenClaw is the user-facing manager and communication layer.",
    "- OpenHands is the execution agent for heavier implementation tasks.",
    "- Claude Code is running from a stable ScienceSwarm AgentWorkspace, not from a per-run capsule or the ScienceSwarm app source checkout.",
    "- Per-run prompt snapshots and MCP configuration live in the ScienceSwarm LaunchBundle for this run.",
    "",
    "Scientific runtime convention:",
    "- Use an already-working project or system Python environment when it satisfies the requested toolchain.",
    "- If a conda/mamba runtime must be created, keep the package-manager install under `$SCIENCESWARM_DIR/runtimes/` (default `~/.scienceswarm/runtimes/`) and keep named environments under `$SCIENCESWARM_DIR/runtimes/conda/envs/`.",
    "- Do not install package managers, conda distributions, or persistent scientific software into the ScienceSwarm app checkout or an imported project folder.",
    "- Before installing new persistent software, report the proposed install location and wait for user approval.",
    "",
    input.projectId ? `Current project: \`${input.projectId}\`.` : "No project is currently scoped.",
    "",
    "Use the compact context below first. Do not dump or scan the whole brain.",
    "Search gbrain selectively, then read only the specific pages that matter for the user's request.",
    "",
    input.loadedProjectGuidance
      ? ["## Loaded Project Guidance", "", input.loadedProjectGuidance].join("\n")
      : [
          "## Loaded Project Guidance",
          "",
          "No project-specific SCIENCESWARM.md was found, so this generated capsule provides the runtime guidance.",
        ].join("\n"),
    "",
    input.brainBrief
      ? ["## Compact Brain Brief", "", input.brainBrief].join("\n")
      : [
          "## Compact Brain Brief",
          "",
          "No configured gbrain brief was available for this launch.",
        ].join("\n"),
    "",
    input.runtimeMcpInstructions
      ? ["## Selective Gbrain Tools", "", input.runtimeMcpInstructions].join("\n")
      : [
          "## Selective Gbrain Tools",
          "",
          "No runtime-scoped gbrain MCP tools were configured for this launch.",
        ].join("\n"),
  ].join("\n").trim();
}

async function buildCompactBrainBrief(projectId: string | null): Promise<string | null> {
  const config = loadBrainConfig();
  if (!config) return null;

  const sections: string[] = [];
  const brainMd = await readFile(path.join(config.root, "BRAIN.md"), "utf8")
    .then((content) => trimForPrompt(content, MAX_BRAIN_MD_CHARS))
    .catch(() => null);
  if (brainMd) {
    sections.push("### BRAIN.md", brainMd);
  }

  if (projectId) {
    try {
      const brief = await buildProjectBrief({ config, project: projectId });
      sections.push(
        "### Project Brief",
        `Project: ${brief.project}`,
      );
      if (brief.topMatters.length > 0) {
        sections.push(
          "",
          "Top matters:",
          ...brief.topMatters.slice(0, 5).map((item) => `- ${item.summary}`),
        );
      }
      if (brief.unresolvedRisks.length > 0) {
        sections.push(
          "",
          "Unresolved risks:",
          ...brief.unresolvedRisks.slice(0, 5).map((item) => `- ${item.risk}`),
        );
      }
      if (brief.nextMove?.recommendation) {
        sections.push("", `Next move: ${brief.nextMove.recommendation}`);
      }
      if (brief.dueTasks.length > 0) {
        sections.push(
          "",
          "Due tasks:",
          ...brief.dueTasks.slice(0, 5).map((item) =>
            `- ${item.title} (${item.status}) - ${item.path}`
          ),
        );
      }
      if (brief.frontier.length > 0) {
        sections.push(
          "",
          "Frontier:",
          ...brief.frontier.slice(0, 5).map((item) =>
            `- ${item.title} (${item.status}) - ${item.path}`
          ),
        );
      }
    } catch {
      sections.push(
        "### Project Brief",
        `Project brief unavailable for ${projectId}. Use gbrain search before making project-specific claims.`,
      );
    }
  }

  return sections.length > 0 ? sections.join("\n").trim() : null;
}

async function buildRuntimeMcpContext(input: {
  projectId: string;
  runtimeSessionId: string;
  projectPolicy: RuntimeProjectPolicy;
  promptHash: string;
  inputFileRefs: string[];
  approvalState: RuntimeTurnRequest["approvalState"];
  approvalStateApproved: boolean;
  repoRoot: string;
  mcpConfigPath: string;
  env: NodeJS.ProcessEnv;
  tokenTtlMs: number;
}): Promise<{
  configPath: string;
  configHash: string;
  allowedTools: string[];
  instructions: string;
  env: Record<string, string>;
  cleanup: () => Promise<void>;
}> {
  const secret = randomBytes(32).toString("base64url");
  const allowedTools = resolveRuntimeMcpToolProfile("claude-code").allowedTools;
  const token = mintRuntimeMcpAccessToken({
    projectId: input.projectId,
    runtimeSessionId: input.runtimeSessionId,
    hostId: "claude-code",
    allowedTools,
    ttlMs: input.tokenTtlMs,
    secret,
  });
  const shell = input.env.SCIENCESWARM_RUNTIME_MCP_SHELL ?? "/bin/sh";
  const command = [
    "cd",
    shellQuote(input.repoRoot),
    "&&",
    "NODE_OPTIONS=--preserve-symlinks",
    "npx",
    "tsx",
    "src/lib/runtime-hosts/mcp/runtime-stdio-server.ts",
  ].join(" ");
  const mcpConfig = {
    mcpServers: {
      scienceswarm: {
        command: shell,
        args: ["-c", command],
        env: {
          ...copyEnv(input.env, [
            "BRAIN_ROOT",
            "SCIENCESWARM_DIR",
            "NODE_ENV",
            "PATH",
            "SCIENCESWARM_REPO_ROOT",
            "SCIENCESWARM_GBRAIN_BIN",
            "GBRAIN_BIN",
            "SCIENCESWARM_RUNTIME_APP_ORIGIN",
          ]),
          SCIENCESWARM_RUNTIME_MCP_ACCESS_TOKEN: token,
          SCIENCESWARM_RUNTIME_MCP_PROJECT_ID: input.projectId,
          SCIENCESWARM_RUNTIME_MCP_SESSION_ID: input.runtimeSessionId,
          SCIENCESWARM_RUNTIME_MCP_HOST_ID: "claude-code",
          SCIENCESWARM_RUNTIME_MCP_PROJECT_POLICY: input.projectPolicy,
          SCIENCESWARM_RUNTIME_MCP_APPROVED: input.approvalStateApproved
            ? "true"
            : "false",
          SCIENCESWARM_RUNTIME_MCP_PROMPT_HASH: input.promptHash,
          SCIENCESWARM_RUNTIME_MCP_INPUT_FILE_REFS: JSON.stringify(
            input.inputFileRefs,
          ),
          SCIENCESWARM_RUNTIME_MCP_APPROVAL_STATE: input.approvalState,
        },
      },
    },
  };
  const mcpConfigJson = JSON.stringify(mcpConfig, null, 2);
  await writeFile(input.mcpConfigPath, mcpConfigJson, {
    encoding: "utf8",
    mode: 0o600,
  });

  return {
    configPath: input.mcpConfigPath,
    configHash: contentSha256(mcpConfigJson),
    allowedTools: claudeMcpToolNames("scienceswarm", allowedTools),
    instructions: [
      "A runtime-scoped MCP server named `scienceswarm` is available for selective gbrain access.",
      "Use search before read. Prefer narrow queries tied to the user's project or named artifact.",
      "Do not enumerate the whole brain or read broad directories.",
      "ScienceSwarm injects the runtime MCP access token through the MCP server environment.",
      "Do not ask the user for bearer tokens, and do not write token values into prompts, files, or captured notes.",
      "",
      "For each `scienceswarm` MCP call, include these non-secret auth fields exactly:",
      `- projectId: ${input.projectId}`,
      `- runtimeSessionId: ${input.runtimeSessionId}`,
      "- hostId: claude-code",
      `- projectPolicy: ${input.projectPolicy}`,
      `- approved: ${input.approvalStateApproved ? "true" : "false"}`,
      "",
      `Allowed tools: ${allowedTools.join(", ")}.`,
      "For runtime-originated gbrain writes, ScienceSwarm attaches RuntimeGbrainProvenance automatically. Do not fabricate provenance values.",
    ].join("\n"),
    env: {},
    cleanup: async () => {
      await unlink(input.mcpConfigPath).catch(ignoreMissingFile);
    },
  };
}

async function writeRedactedLaunchAudit(input: {
  runId: string;
  cwd: string;
  launchBundlePath: string;
  prompt: string;
  mcpConfigHash: string | null;
  hasRuntimeMcpAccessToken: boolean;
  auditPath: string;
}): Promise<void> {
  const now = new Date().toISOString();
  const audit = LaunchAuditStateSchema.parse({
    version: 1,
    runId: input.runId,
    host: "claude-code",
    launchBundlePath: input.launchBundlePath,
    cwd: input.cwd,
    redactedEnv: {},
    promptHash: contentSha256(input.prompt),
    ...(input.mcpConfigHash ? { mcpConfigHash: input.mcpConfigHash } : {}),
    tokenMaterial: [
      {
        label: "runtime MCP access token",
        present: input.hasRuntimeMcpAccessToken,
        redacted: true,
      },
    ],
    createdAt: now,
  });
  await writeFile(input.auditPath, JSON.stringify(audit, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
}

function contentSha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function claudeMcpToolNames(
  serverName: string,
  tools: readonly RuntimeMcpToolName[],
): string[] {
  return tools.map((tool) => `mcp__${serverName}__${tool}`);
}

function ignoreMissingFile(error: unknown): void {
  if (
    typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === "ENOENT"
  ) {
    return;
  }
  throw error;
}

function trimForPrompt(value: string, maxChars: number): string {
  const normalized = value.replace(/\r\n/g, "\n").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars).trimEnd()}\n[truncated]`;
}

function existingDirectories(paths: string[]): string[] {
  return paths.filter((candidate) => existsSync(candidate));
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function copyEnv(
  env: NodeJS.ProcessEnv,
  keys: readonly string[],
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of keys) {
    const value = env[key];
    if (typeof value === "string" && value.length > 0) {
      result[key] = value;
    }
  }
  return result;
}
