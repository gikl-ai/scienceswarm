import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  getAgentWorkspaceRoot,
  getLaunchBundleRoot,
  getStudyAgentWorkspaceRoot,
} from "@/lib/studies";
import { parseLegacyProjectSlug } from "@/lib/studies/context";
import { RunIdSchema, StudyIdSchema, type RunId, type StudyId } from "@/lib/studies/contracts";

export interface RuntimeAgentWorkspace {
  id: string;
  scope: "study" | "global";
  cwd: string;
  studyId?: StudyId;
  legacyProjectSlug?: string;
  stableShimPaths: {
    claudeMd: string;
    scienceSwarmMd: string;
  };
}

export interface RuntimeLaunchBundle {
  runId: RunId;
  host: string;
  root: string;
  promptSnapshotPath: string;
  mcpConfigPath: string;
  redactedAuditPath: string;
}

export interface RuntimeWorkspaceResolution {
  agentWorkspace: RuntimeAgentWorkspace;
  launchBundle: RuntimeLaunchBundle;
}

export function runtimeRunIdFromSessionId(sessionId: string): RunId {
  const safeSegment = safeRuntimePathSegment(sessionId);
  return RunIdSchema.parse(`run_${safeSegment}`);
}

export function resolveRuntimeWorkspace(input: {
  projectId?: string | null;
  runId: string;
  host: string;
  dataRoot?: string;
}): RuntimeWorkspaceResolution {
  const runId = RunIdSchema.parse(input.runId);
  const host = input.host;
  const launchRoot = getLaunchBundleRoot(runId, host, input.dataRoot);
  const agentWorkspace = resolveAgentWorkspace({
    projectId: input.projectId,
    dataRoot: input.dataRoot,
  });

  return {
    agentWorkspace,
    launchBundle: {
      runId,
      host,
      root: launchRoot,
      promptSnapshotPath: path.join(launchRoot, "prompt.md"),
      mcpConfigPath: path.join(launchRoot, "mcp.json"),
      redactedAuditPath: path.join(launchRoot, "launch-audit.redacted.json"),
    },
  };
}

export async function ensureRuntimeWorkspace(input: {
  agentWorkspace: RuntimeAgentWorkspace;
  launchBundle: RuntimeLaunchBundle;
  stableScienceSwarmMarkdown: string;
  stableClaudeMarkdown: string;
}): Promise<void> {
  await Promise.all([
    mkdir(input.agentWorkspace.cwd, { recursive: true }),
    mkdir(input.launchBundle.root, { recursive: true }),
  ]);
  await Promise.all([
    writeFileIfMissing(
      input.agentWorkspace.stableShimPaths.scienceSwarmMd,
      input.stableScienceSwarmMarkdown,
    ),
    writeFileIfMissing(
      input.agentWorkspace.stableShimPaths.claudeMd,
      input.stableClaudeMarkdown,
    ),
  ]);
}

function resolveAgentWorkspace(input: {
  projectId?: string | null;
  dataRoot?: string;
}): RuntimeAgentWorkspace {
  const legacyProject = parseLegacyProjectSlug(input.projectId);
  if (legacyProject.ok) {
    const studyId = StudyIdSchema.parse(`study_${legacyProject.legacyProjectSlug}`);
    const cwd = getStudyAgentWorkspaceRoot(studyId, input.dataRoot);
    return {
      id: `workspace_${studyId.slice("study_".length)}`,
      scope: "study",
      cwd,
      studyId,
      legacyProjectSlug: legacyProject.legacyProjectSlug,
      stableShimPaths: {
        claudeMd: path.join(cwd, "CLAUDE.md"),
        scienceSwarmMd: path.join(cwd, "SCIENCESWARM.md"),
      },
    };
  }

  const cwd = path.join(getAgentWorkspaceRoot(input.dataRoot), "global");
  return {
    id: "workspace_global",
    scope: "global",
    cwd,
    stableShimPaths: {
      claudeMd: path.join(cwd, "CLAUDE.md"),
      scienceSwarmMd: path.join(cwd, "SCIENCESWARM.md"),
    },
  };
}

async function writeFileIfMissing(filePath: string, content: string): Promise<void> {
  try {
    await writeFile(filePath, content, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (
      typeof error === "object"
      && error !== null
      && "code" in error
      && (error as { code?: unknown }).code === "EEXIST"
    ) {
      return;
    }
    throw error;
  }
}

function safeRuntimePathSegment(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120)
    || "session";
}
