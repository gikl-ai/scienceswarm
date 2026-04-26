import path from "node:path";

import {
  getScienceSwarmBrainRoot,
  getScienceSwarmDataRoot,
} from "@/lib/scienceswarm-paths";
import {
  RunIdSchema,
  StudyIdSchema,
  ThreadIdSchema,
  type RunId,
  type StudyId,
  type ThreadId,
} from "./contracts";

export function assertStudyId(studyId: string): StudyId {
  return StudyIdSchema.parse(studyId);
}

export function assertThreadId(threadId: string): ThreadId {
  return ThreadIdSchema.parse(threadId);
}

export function assertRunId(runId: string): RunId {
  return RunIdSchema.parse(runId);
}

export function getScienceSwarmKnowledgeRoot(): string {
  return getScienceSwarmBrainRoot();
}

export function getCanonicalScienceSwarmStateRoot(): string {
  return path.join(getScienceSwarmDataRoot(), "state");
}

export function getStudiesStateRoot(
  stateRoot = getCanonicalScienceSwarmStateRoot(),
): string {
  return path.join(stateRoot, "studies");
}

export function getStudyStateRoot(
  studyId: string,
  stateRoot = getCanonicalScienceSwarmStateRoot(),
): string {
  return path.join(getStudiesStateRoot(stateRoot), assertStudyId(studyId));
}

export function getStudyStatePath(
  studyId: string,
  stateRoot = getCanonicalScienceSwarmStateRoot(),
): string {
  return path.join(getStudyStateRoot(studyId, stateRoot), "study.json");
}

export function getThreadsStateRoot(
  stateRoot = getCanonicalScienceSwarmStateRoot(),
): string {
  return path.join(stateRoot, "threads");
}

export function getThreadStateRoot(
  threadId: string,
  stateRoot = getCanonicalScienceSwarmStateRoot(),
): string {
  return path.join(getThreadsStateRoot(stateRoot), assertThreadId(threadId));
}

export function getThreadStatePath(
  threadId: string,
  stateRoot = getCanonicalScienceSwarmStateRoot(),
): string {
  return path.join(getThreadStateRoot(threadId, stateRoot), "thread.json");
}

export function getThreadMessagesPath(
  threadId: string,
  stateRoot = getCanonicalScienceSwarmStateRoot(),
): string {
  return path.join(getThreadStateRoot(threadId, stateRoot), "messages.jsonl");
}

export function getRunsStateRoot(
  stateRoot = getCanonicalScienceSwarmStateRoot(),
): string {
  return path.join(stateRoot, "runs");
}

export function getRunStateRoot(
  runId: string,
  stateRoot = getCanonicalScienceSwarmStateRoot(),
): string {
  return path.join(getRunsStateRoot(stateRoot), assertRunId(runId));
}

export function getRunStatePath(
  runId: string,
  stateRoot = getCanonicalScienceSwarmStateRoot(),
): string {
  return path.join(getRunStateRoot(runId, stateRoot), "run.json");
}

export function getAgentWorkspaceRoot(
  dataRoot = getScienceSwarmDataRoot(),
): string {
  return path.join(dataRoot, "workspaces");
}

export function getStudyAgentWorkspaceRoot(
  studyId: string,
  dataRoot = getScienceSwarmDataRoot(),
): string {
  return path.join(getAgentWorkspaceRoot(dataRoot), "studies", assertStudyId(studyId));
}

export function getThreadAgentWorkspaceRoot(
  threadId: string,
  dataRoot = getScienceSwarmDataRoot(),
): string {
  return path.join(getAgentWorkspaceRoot(dataRoot), "threads", assertThreadId(threadId));
}

export function getRuntimeRoot(dataRoot = getScienceSwarmDataRoot()): string {
  return path.join(dataRoot, "runtime");
}

export function getLaunchBundleRoot(
  runId: string,
  host: string,
  dataRoot = getScienceSwarmDataRoot(),
): string {
  const safeHost = host.trim();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(safeHost)) {
    throw new Error("Invalid runtime host");
  }
  return path.join(getRuntimeRoot(dataRoot), "runs", assertRunId(runId), safeHost);
}
