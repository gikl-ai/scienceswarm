import {
  extractAgentMessageText,
  getConversation,
  getEvents,
  getStartTaskStatus,
  sendPendingMessage,
  startConversation,
} from "@/lib/openhands";
import { slugifyWorkspaceSegment } from "@/lib/workspace-manager";
import type { ArtifactContextBundle } from "./context-bundle";

export interface ArtifactExecutionResult {
  conversationId: string;
  title: string;
  fileName: string;
  content: string;
  assumptions: string[];
  reviewFirst: string[];
  rawResponse: string;
}

const ARTIFACT_EVENT_PAGE_SIZE = 100;
const DEFAULT_ARTIFACT_POLL_INTERVAL_MS = 2000;

export interface ArtifactRunOptions {
  pollIntervalMs?: number;
}

export async function runArtifact(
  bundle: ArtifactContextBundle,
  options: ArtifactRunOptions = {},
): Promise<ArtifactExecutionResult> {
  const responseBaseline = bundle.request.conversationId
    ? await captureResponseBaseline(bundle.request.conversationId)
    : undefined;
  const conversationId = bundle.request.conversationId
    ? await continueConversation(bundle.request.conversationId, bundle.prompt)
    : await startArtifactConversation(bundle.prompt, options);

  const rawResponse = await waitForArtifactResponse(conversationId, responseBaseline, options);
  return parseArtifactResponse(rawResponse, bundle, conversationId);
}

async function startArtifactConversation(
  prompt: string,
  options: ArtifactRunOptions,
): Promise<string> {
  const task = await startConversation({
    message: prompt,
  });
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_ARTIFACT_POLL_INTERVAL_MS;

  let status = task;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (status.status === "READY" || status.status === "ERROR") break;
    await wait(pollIntervalMs);
    const tasks = await getStartTaskStatus(task.id);
    if (!Array.isArray(tasks) || tasks.length === 0) {
      throw new Error("OpenHands returned an empty task status list");
    }
    status = tasks[0];
  }

  if (status.status === "ERROR") {
    throw new Error(status.detail || "OpenHands failed to start artifact execution");
  }

  if (!status.app_conversation_id) {
    throw new Error("OpenHands did not return a conversation id");
  }

  return status.app_conversation_id as string;
}

async function continueConversation(conversationId: string, prompt: string): Promise<string> {
  await sendPendingMessage(conversationId, prompt);
  return conversationId;
}

async function waitForArtifactResponse(
  conversationId: string,
  responseBaseline?: ArtifactResponseBaseline,
  options: ArtifactRunOptions = {},
): Promise<string> {
  let latestResponse = "";
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_ARTIFACT_POLL_INTERVAL_MS;

  for (let attempt = 0; attempt < 30; attempt += 1) {
    await wait(pollIntervalMs);
    const events = await getEvents(conversationId, ARTIFACT_EVENT_PAGE_SIZE);
    const candidateResponse = extractLatestAgentResponse(events, responseBaseline);
    if (candidateResponse) {
      latestResponse = candidateResponse;
    }

    const conversation = await getConversation(conversationId);
    if (["idle", "finished", "error", "stuck"].includes(conversation.execution_status)) {
      break;
    }
  }

  if (!latestResponse) {
    throw new Error("Artifact execution completed without a usable agent response");
  }

  return latestResponse;
}

/**
 * Normalized agent message, version-agnostic between OH 1.5 and 1.6.
 * `key` is a stable identity used for baseline diffing, `text` is the
 * extracted reply (via `extractAgentMessageText`).
 */
interface NormalizedAgentEvent {
  key: string;
  text: string;
}

interface ArtifactResponseBaseline {
  knownEventKeys: Set<string>;
  latestResponse: string;
}

async function captureResponseBaseline(conversationId: string): Promise<ArtifactResponseBaseline> {
  const events = await getEvents(conversationId, ARTIFACT_EVENT_PAGE_SIZE);
  return buildResponseBaseline(events);
}

function buildResponseBaseline(events: unknown[]): ArtifactResponseBaseline {
  const agentEvents = extractAgentEvents(events);
  return {
    knownEventKeys: new Set(agentEvents.map((event) => event.key)),
    latestResponse: agentEvents.map((event) => event.text.trim()).join("\n\n"),
  };
}

function extractLatestAgentResponse(
  events: unknown[],
  responseBaseline?: ArtifactResponseBaseline,
): string {
  const agentEvents = extractAgentEvents(events);
  if (agentEvents.length === 0) {
    return "";
  }

  if (!responseBaseline) {
    return agentEvents.map((event) => event.text.trim()).join("\n\n");
  }

  const newMessages = agentEvents
    .filter((event) => !responseBaseline.knownEventKeys.has(event.key))
    .map((event) => event.text.trim())
    .filter(Boolean);

  if (newMessages.length > 0) {
    return newMessages.join("\n\n");
  }

  const combinedResponse = agentEvents.map((event) => event.text.trim()).join("\n\n");
  return combinedResponse !== responseBaseline.latestResponse ? combinedResponse : "";
}

function extractAgentEvents(events: unknown[]): NormalizedAgentEvent[] {
  const out: NormalizedAgentEvent[] = [];
  for (const raw of events) {
    const text = extractAgentMessageText(raw);
    if (text === null || text.trim().length === 0) continue;
    const rec = raw as { id?: unknown; created_at?: unknown; timestamp?: unknown };
    let key: string;
    if (typeof rec.id === "string" || typeof rec.id === "number") {
      key = `id:${rec.id}`;
    } else {
      const ts =
        typeof rec.created_at === "string"
          ? rec.created_at
          : typeof rec.timestamp === "string"
            ? rec.timestamp
            : "unknown";
      key = `ts:${ts}:${text.trim()}`;
    }
    out.push({ key, text });
  }
  return out;
}

function parseArtifactResponse(
  rawResponse: string,
  bundle: ArtifactContextBundle,
  conversationId: string,
): ArtifactExecutionResult {
  const parsed = extractStructuredPayload(rawResponse);
  const title =
    normalizeString(parsed?.title) ||
    `${bundle.projectTitle} ${bundle.artifactType.replace(/-/g, " ")}`;
  const fileName =
    normalizeString(parsed?.fileName) ||
    `${slugifyWorkspaceSegment(title)}.md`;
  const content =
    normalizeString(parsed?.content) ||
    rawResponse.trim();
  const assumptions = normalizeStringArray(parsed?.assumptions);
  const reviewFirst = normalizeStringArray(parsed?.reviewFirst);

  return {
    conversationId,
    title,
    fileName,
    content,
    assumptions: assumptions.length > 0 ? assumptions : buildFallbackAssumptions(bundle),
    reviewFirst: reviewFirst.length > 0 ? reviewFirst : buildFallbackReviewFirst(bundle),
    rawResponse,
  };
}

function extractStructuredPayload(rawResponse: string): Record<string, unknown> | null {
  const fenced = rawResponse.match(/```json\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced ?? rawResponse.match(/\{[\s\S]*\}/)?.[0];
  if (!candidate) return null;

  try {
    return JSON.parse(candidate) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function buildFallbackAssumptions(bundle: ArtifactContextBundle): string[] {
  return [
    `The first pass relies on the current ${bundle.projectTitle} study memory and may miss context outside the manifest-backed pages.`,
    "Any quantitative claims or citations should be checked against the original sources before reuse.",
  ];
}

function buildFallbackReviewFirst(bundle: ArtifactContextBundle): string[] {
  return [
    `Verify that the ${bundle.artifactType.replace(/-/g, " ")} actually matches the requested intent and audience.`,
    "Inspect unsupported claims, stale tasks, and missing caveats before treating this artifact as final.",
  ];
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
