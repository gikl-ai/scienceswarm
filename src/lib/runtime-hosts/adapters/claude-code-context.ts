import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildProjectBrief } from "@/brain/briefing";
import { loadBrainConfig } from "@/brain/config";
import {
  getScienceSwarmDataRoot,
  getScienceSwarmProjectRoot,
} from "@/lib/scienceswarm-paths";
import { buildScienceSwarmPromptContextText } from "@/lib/scienceswarm-prompt-config";
import type {
  RuntimeDataIncluded,
  RuntimeProjectPolicy,
  RuntimeTurnRequest,
} from "@/lib/runtime-hosts/contracts";
import { resolveRuntimeMcpToolProfile } from "@/lib/runtime-hosts/mcp/tool-profiles";
import { mintRuntimeMcpAccessToken } from "@/lib/runtime-hosts/mcp/tokens";
import type { RuntimeMcpToolName } from "@/lib/runtime-hosts/mcp/tokens";
import { assertSafeProjectSlug } from "@/lib/state/project-manifests";

const DEFAULT_RUNTIME_MCP_TOKEN_TTL_MS = 15 * 60 * 1000;
const MAX_BRAIN_MD_CHARS = 4_000;

export interface ClaudeCodeInvocationContext {
  cwd?: string;
  appendSystemPrompt?: string;
  addDirs?: string[];
  env?: Record<string, string>;
  mcpConfigPath?: string;
  allowedTools?: string[];
  cleanup?: () => Promise<void>;
}

export interface ClaudeCodeRuntimeContextBuilderInput {
  request: RuntimeTurnRequest;
  wrapperSessionId: string;
  capsuleSessionId?: string;
  env: NodeJS.ProcessEnv;
  repoRoot?: string;
  sessionRoot?: string;
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
  const sessionRoot = path.resolve(
    input.sessionRoot
      ?? path.join(getScienceSwarmDataRoot(), "runtime", "claude-code"),
  );
  const capsuleSessionId = input.capsuleSessionId ?? input.wrapperSessionId;
  const sessionDir = path.join(
    sessionRoot,
    projectSlug,
    safePathSegment(capsuleSessionId),
  );
  await mkdir(sessionDir, { recursive: true });
  await Promise.all([
    mkdir(path.join(sessionDir, ".remember", "logs", "autonomous"), { recursive: true }),
    mkdir(path.join(sessionDir, ".remember", "tmp"), { recursive: true }),
  ]);

  const loadedProjectGuidance = await buildScienceSwarmPromptContextText({
    projectId: input.request.projectId,
    backend: "agent",
  });
  const brainBrief = await buildCompactBrainBrief(input.request.projectId);
  const runtimeMcp = input.enableRuntimeMcp === false || !input.request.projectId
    ? null
    : await buildRuntimeMcpContext({
        projectId: projectSlug,
        runtimeSessionId: input.wrapperSessionId,
        projectPolicy: input.request.preview.projectPolicy,
        approvalStateApproved: input.request.approvalState === "approved"
          || input.request.approvalState === "not-required",
        repoRoot,
        sessionDir,
        env: input.env,
        tokenTtlMs: input.tokenTtlMs ?? DEFAULT_RUNTIME_MCP_TOKEN_TTL_MS,
      });

  const scienceswarmMd = buildScienceSwarmRuntimeMarkdown({
    projectId: input.request.projectId,
    loadedProjectGuidance,
    brainBrief,
    runtimeMcpInstructions: runtimeMcp?.instructions ?? null,
  });
  const claudeMd = [
    "# CLAUDE.md",
    "",
    "This is a generated ScienceSwarm runtime capsule for Claude Code.",
    "",
    "Read `SCIENCESWARM.md` first. It contains the product orientation, current",
    "project/brain context, and the selective gbrain access rules for this session.",
    "",
    "Do not infer ScienceSwarm product behavior from the app source repository unless",
    "the user explicitly asks to work on ScienceSwarm itself.",
  ].join("\n");

  await Promise.all([
    writeFile(path.join(sessionDir, "SCIENCESWARM.md"), scienceswarmMd, "utf8"),
    writeFile(path.join(sessionDir, "CLAUDE.md"), claudeMd, "utf8"),
  ]);

  const addDirs = input.request.projectId
    ? existingDirectories([getScienceSwarmProjectRoot(projectSlug)])
    : [];

  return {
    cwd: sessionDir,
    appendSystemPrompt: scienceswarmMd,
    addDirs,
    env: runtimeMcp?.env,
    mcpConfigPath: runtimeMcp?.configPath,
    allowedTools: runtimeMcp?.allowedTools,
    cleanup: runtimeMcp?.cleanup,
  };
}

function buildScienceSwarmRuntimeMarkdown(input: {
  projectId: string | null;
  loadedProjectGuidance: string | null;
  brainBrief: string | null;
  runtimeMcpInstructions: string | null;
}): string {
  return [
    "# SCIENCESWARM.md",
    "",
    "ScienceSwarm is a local-first research workspace powered by OpenClaw, OpenHands, and gbrain.",
    "",
    "- gbrain is the durable research-memory layer and source of truth.",
    "- OpenClaw is the user-facing manager and communication layer.",
    "- OpenHands is the execution agent for heavier implementation tasks.",
    "- Claude Code is running inside a generated ScienceSwarm session capsule, not inside the ScienceSwarm app source checkout.",
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
  approvalStateApproved: boolean;
  repoRoot: string;
  sessionDir: string;
  env: NodeJS.ProcessEnv;
  tokenTtlMs: number;
}): Promise<{
  configPath: string;
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
  const configPath = path.join(input.sessionDir, "scienceswarm-mcp.json");
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
          ]),
          SCIENCESWARM_RUNTIME_MCP_ACCESS_TOKEN: token,
        },
      },
    },
  };
  await writeFile(configPath, JSON.stringify(mcpConfig, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });

  return {
    configPath,
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
      "For runtime-originated gbrain writes, include RuntimeGbrainProvenance matching this session.",
    ].join("\n"),
    env: {},
    cleanup: async () => {
      await unlink(configPath).catch(ignoreMissingFile);
    },
  };
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

function safePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120)
    || "session";
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
