import { randomUUID } from "node:crypto";
import path from "node:path";
import type {
  CaptureChannel,
  CaptureRequest,
  CaptureResult,
  ChannelSessionState,
} from "@/brain/types";
import { appendAuditEvent } from "@/lib/state/audit-log";
import {
  readChannelSession,
  updateChannelSession,
} from "@/lib/state/channel-sessions";
import { classifyCapture } from "./classify-capture";
import { materializeMemory } from "./materialize-memory";
import {
  persistRawCapture,
  readPersistedRawCapture,
  updatePersistedRawCapture,
} from "./persist-raw";
import { resolveProject } from "./resolve-project";
import { assertSafeProjectSlug } from "@/lib/state/project-manifests";
import { extractTasks, createTaskPages } from "@/brain/task-extractor";
import type { BrainConfig } from "@/brain/types";

interface ProcessCaptureInput extends CaptureRequest {
  brainRoot: string;
  defaultChannel?: CaptureChannel;
  defaultUserId?: string;
}

interface ResolvePendingCaptureInput {
  brainRoot: string;
  channel: CaptureChannel;
  captureId: string;
  project: string;
  rawPath?: string;
}

function normalizeContent(value: string): string {
  return value.trim();
}

function appendRecentCaptureIds(ids: string[], captureId: string): string[] {
  return [captureId, ...ids.filter((id) => id !== captureId)].slice(0, 20);
}

function buildEmptySession(channel: "telegram", userId: string): ChannelSessionState {
  return {
    version: 1,
    channel,
    userId,
    activeProject: null,
    pendingClarification: null,
    recentCaptureIds: [],
    updatedAt: new Date().toISOString(),
  };
}

export async function clearChannelSession(
  channel: "telegram",
  userId: string,
  stateRoot: string,
): Promise<ChannelSessionState> {
  return updateChannelSession(
    channel,
    userId,
    (current) => ({
      ...(current ?? buildEmptySession(channel, userId)),
      activeProject: null,
      pendingClarification: null,
      recentCaptureIds: [],
      updatedAt: new Date().toISOString(),
    }),
    stateRoot,
  );
}

export async function getChannelSession(
  channel: "telegram",
  userId: string,
  stateRoot: string,
): Promise<ChannelSessionState | null> {
  return readChannelSession(channel, userId, stateRoot);
}

function resolveStateRoot(brainRoot: string): string {
  return path.join(brainRoot, "state");
}

export function isCaptureChannel(value: unknown): value is CaptureChannel {
  return value === "telegram" || value === "web" || value === "openclaw";
}

function matchClarificationChoice(
  content: string,
  choices: string[],
): string | null {
  const normalized = content.trim().toLowerCase();
  return choices.find((choice) => choice.toLowerCase() === normalized) ?? null;
}

function buildTaskExtractorConfig(brainRoot: string): BrainConfig {
  return {
    root: brainRoot,
    extractionModel: "gpt-4.1-mini",
    synthesisModel: "gpt-4.1",
    rippleCap: 15,
    paperWatchBudget: 50,
    serendipityRate: 0.2,
  };
}

async function extractTaskPaths(input: {
  brainRoot: string;
  content: string;
  project: string | null;
  sourceCapture: string;
}): Promise<string[] | undefined> {
  try {
    const tasks = extractTasks(input.content, {
      project: input.project ?? undefined,
    });
    if (tasks.length === 0) {
      return undefined;
    }

    const tasksWithSource = tasks.map((task) => ({
      ...task,
      sourceCapture: input.sourceCapture,
    }));

    return await createTaskPages(
      buildTaskExtractorConfig(input.brainRoot),
      tasksWithSource,
    );
  } catch {
    // Task extraction is best-effort — don't fail the capture
    return undefined;
  }
}

export async function resolvePendingCapture(
  input: ResolvePendingCaptureInput,
): Promise<CaptureResult> {
  const safeProject = assertSafeProjectSlug(input.project);
  const stateRoot = resolveStateRoot(input.brainRoot);
  const pendingCapture = await readPersistedRawCapture(
    input.brainRoot,
    input.channel,
    input.captureId,
    input.rawPath,
  );

  if (!pendingCapture) {
    throw new Error(`Pending capture ${input.captureId} not found`);
  }

  const materialized = await materializeMemory({
    brainRoot: input.brainRoot,
    capture: pendingCapture,
    project: safeProject,
    confidence: "medium",
  });

  const updatedCapture = await updatePersistedRawCapture(
    input.brainRoot,
    input.channel,
    pendingCapture.captureId,
    (current) => ({
      ...current,
      project: safeProject,
      requiresClarification: false,
      clarificationQuestion: undefined,
      materializedPath: materialized.materializedPath,
    }),
    pendingCapture.rawPath,
  );

  await appendAuditEvent({
    ts: new Date().toISOString(),
    kind: "capture",
    action: "clarified",
    project: safeProject,
    captureId: pendingCapture.captureId,
    privacy: pendingCapture.privacy,
    details: {
      channel: input.channel,
      choice: safeProject,
      materializedPath: materialized.materializedPath,
    },
  }, stateRoot);

  const extractedTaskPaths = await extractTaskPaths({
    brainRoot: input.brainRoot,
    content: pendingCapture.content,
    project: safeProject,
    sourceCapture: materialized.materializedPath ?? pendingCapture.rawPath,
  });

  return {
    captureId: pendingCapture.captureId,
    channel: input.channel,
    userId: pendingCapture.userId,
    kind: pendingCapture.kind,
    project: safeProject,
    privacy: pendingCapture.privacy,
    rawPath: pendingCapture.rawPath,
    materializedPath: materialized.materializedPath,
    requiresClarification: false,
    clarificationQuestion: undefined,
    choices: [],
    status: "saved",
    createdAt: updatedCapture.createdAt,
    extractedTasks: extractedTaskPaths,
  };
}

export async function processCapture(input: ProcessCaptureInput): Promise<CaptureResult> {
  const channelCandidate = input.channel ?? input.defaultChannel ?? "web";
  if (!isCaptureChannel(channelCandidate)) {
    throw new Error("Invalid capture channel");
  }
  const channel = channelCandidate;

  const userId = input.userId ?? input.defaultUserId;
  const content = normalizeContent(input.content);
  const stateRoot = resolveStateRoot(input.brainRoot);

  if (!userId) {
    throw new Error("Capture userId is required");
  }

  if (!content) {
    throw new Error("Capture content is required");
  }

  const explicitProject = typeof input.project === "string" ? input.project.trim() : undefined;
  if (explicitProject) {
    assertSafeProjectSlug(explicitProject);
  }
  const allowSingleProjectFallback = input.project !== null;

  const session =
    channel === "telegram"
      ? await readChannelSession("telegram", userId, stateRoot)
      : null;

  if (channel === "telegram" && session?.pendingClarification) {
    const chosenProject = matchClarificationChoice(content, session.pendingClarification.choices);
    if (chosenProject) {
      const resolved = await resolvePendingCapture({
        brainRoot: input.brainRoot,
        channel,
        captureId: session.pendingClarification.captureId,
        project: chosenProject,
        rawPath: session.pendingClarification.rawPath,
      });

      await updateChannelSession(
        "telegram",
        userId,
        (current) => {
          const base = current ?? buildEmptySession("telegram", userId);
          return {
            ...base,
            activeProject: resolved.project,
            pendingClarification: null,
            recentCaptureIds: appendRecentCaptureIds(base.recentCaptureIds, resolved.captureId),
            updatedAt: resolved.createdAt,
          };
        },
        stateRoot,
      );

      return resolved;
    }
  }

  const classification = classifyCapture(content, input.kind);
  const projectResolution = await resolveProject({
    stateRoot,
    explicitProject: explicitProject ?? undefined,
    sessionActiveProject: session?.activeProject ?? null,
    allowSingleProjectFallback,
  });
  const resolvedProject = projectResolution.project?.trim()
    ? assertSafeProjectSlug(projectResolution.project.trim())
    : null;

  const captureId = randomUUID();
  const requiresClarification = resolvedProject === null;
  const privacy = input.privacy ?? "cloud-ok";

  const rawCapture = await persistRawCapture({
    brainRoot: input.brainRoot,
    captureId,
    channel,
    userId,
    kind: classification.kind,
    project: resolvedProject,
    privacy,
    content,
    transcript: input.transcript,
    attachmentPaths: input.attachmentPaths,
    sourceRefs: input.sourceRefs,
    requiresClarification,
    clarificationQuestion: projectResolution.clarificationQuestion,
  });

  const materialized = await materializeMemory({
    brainRoot: input.brainRoot,
    capture: rawCapture,
    project: resolvedProject,
    confidence: classification.confidence,
  });

  if (resolvedProject || materialized.materializedPath) {
    await updatePersistedRawCapture(
      input.brainRoot,
      channel,
      captureId,
      (current) => ({
        ...current,
        study: resolvedProject,
        project: resolvedProject,
        requiresClarification: false,
        clarificationQuestion: undefined,
        materializedPath: materialized.materializedPath,
      }),
      rawCapture.rawPath,
    );
  }

  if (channel === "telegram") {
    await updateChannelSession(
      "telegram",
      userId,
      (current) => {
        const base = current ?? buildEmptySession("telegram", userId);
        return {
          ...base,
          activeProject: resolvedProject ?? base.activeProject,
          pendingClarification: requiresClarification
            ? {
                captureId,
                rawPath: rawCapture.rawPath,
                question: projectResolution.clarificationQuestion ?? "Which study should I link this capture to?",
                choices: projectResolution.choices,
              }
            : null,
          recentCaptureIds: appendRecentCaptureIds(base.recentCaptureIds, captureId),
          updatedAt: rawCapture.createdAt,
        };
      },
      stateRoot,
    );
  }

  await appendAuditEvent({
    ts: rawCapture.createdAt,
    kind: "capture",
    action: requiresClarification ? "saved-unlinked" : "materialized",
    project: resolvedProject ?? undefined,
    captureId,
    privacy,
    details: {
      channel,
      kind: classification.kind,
      confidence: classification.confidence,
      choices: projectResolution.choices,
      materializedPath: materialized.materializedPath,
    },
  }, stateRoot);

  const extractedTaskPaths = await extractTaskPaths({
    brainRoot: input.brainRoot,
    content,
    project: resolvedProject,
    sourceCapture: materialized.materializedPath ?? rawCapture.rawPath,
  });

  return {
    captureId,
    channel,
    userId,
    kind: classification.kind,
    study: resolvedProject,
    project: resolvedProject,
    privacy,
    rawPath: rawCapture.rawPath,
    materializedPath: materialized.materializedPath,
    requiresClarification,
    clarificationQuestion: projectResolution.clarificationQuestion,
    choices: projectResolution.choices,
    status: requiresClarification ? "needs-clarification" : "saved",
    createdAt: rawCapture.createdAt,
    extractedTasks: extractedTaskPaths,
  };
}
