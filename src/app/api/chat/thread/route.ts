import { isLocalRequest } from "@/lib/local-guard";
import {
  normalizeArtifactProvenanceEntries,
  type ArtifactProvenanceEntry,
} from "@/lib/artifact-provenance";
import { sanitizeOpenClawUserVisibleResponse } from "@/lib/openclaw/response-sanitizer";
import {
  readChatThread,
  writeChatThread,
  type PersistedCaptureClarification,
  type PersistedChatTaskPhase,
  type PersistedChatThreadMessage,
} from "@/lib/chat-thread-store";

function emptyThread(project: string) {
  return {
    version: 1 as const,
    project,
    conversationId: null,
    conversationBackend: null,
    messages: [] as PersistedChatThreadMessage[],
    artifactProvenance: [] as ArtifactProvenanceEntry[],
  };
}

function normalizeProject(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeMessages(value: unknown): PersistedChatThreadMessage[] | null {
  if (!Array.isArray(value)) return null;

  const normalized: PersistedChatThreadMessage[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return null;
    const candidate = entry as Partial<PersistedChatThreadMessage>;
    if (
      typeof candidate.id !== "string"
      || (candidate.role !== "user" && candidate.role !== "assistant" && candidate.role !== "system")
      || typeof candidate.content !== "string"
      || typeof candidate.timestamp !== "string"
    ) {
      return null;
    }

    normalized.push({
      id: candidate.id,
      role: candidate.role,
      content: candidate.content,
      thinking: typeof candidate.thinking === "string" ? candidate.thinking : undefined,
      timestamp: candidate.timestamp,
      chatMode: normalizeChatMode(candidate.chatMode),
      channel: typeof candidate.channel === "string" ? candidate.channel : undefined,
      userName: typeof candidate.userName === "string" ? candidate.userName : undefined,
      captureClarification: normalizeCaptureClarification(candidate.captureClarification),
      taskPhases: normalizeTaskPhases(candidate.taskPhases),
    });
  }

  return normalized;
}

function normalizeArtifactProvenance(value: unknown): ArtifactProvenanceEntry[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  return normalizeArtifactProvenanceEntries(value);
}

function normalizeCaptureClarification(value: unknown): PersistedCaptureClarification | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object") return undefined;

  const candidate = value as Partial<PersistedCaptureClarification>;
  if (
    typeof candidate.captureId !== "string"
    || typeof candidate.question !== "string"
    || !Array.isArray(candidate.choices)
    || !candidate.choices.every((choice) => typeof choice === "string")
    || typeof candidate.capturedContent !== "string"
  ) {
    return undefined;
  }

  return {
    captureId: candidate.captureId,
    rawPath: typeof candidate.rawPath === "string" ? candidate.rawPath : undefined,
    question: candidate.question,
    choices: candidate.choices,
    capturedContent: candidate.capturedContent,
  };
}

function normalizeChatMode(value: unknown): PersistedChatThreadMessage["chatMode"] {
  return value === "reasoning" || value === "openclaw-tools" ? value : undefined;
}

function normalizeConversationBackend(
  value: unknown,
): "openclaw" | "agent" | "direct" | null {
  return value === "openclaw" || value === "agent" || value === "direct" ? value : null;
}

function normalizeTaskPhases(value: unknown): PersistedChatTaskPhase[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const phases = value
    .filter((entry): entry is Partial<PersistedChatTaskPhase> => Boolean(entry && typeof entry === "object"))
    .map((entry) => {
      if (
        typeof entry.id !== "string"
        || typeof entry.label !== "string"
        || (entry.status !== "pending" && entry.status !== "active" && entry.status !== "completed")
      ) {
        return null;
      }

      return {
        id: entry.id,
        label: entry.label,
        status: entry.status,
      } satisfies PersistedChatTaskPhase;
    })
    .filter((phase): phase is PersistedChatTaskPhase => phase !== null);

  return phases.length > 0 ? phases : undefined;
}

export async function GET(request: Request) {
  if (!(await isLocalRequest())) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const project = normalizeProject(new URL(request.url).searchParams.get("project"));
  if (!project) {
    return Response.json({ error: "Missing project" }, { status: 400 });
  }

  const stored = await readChatThread(project);
  if (!stored) {
    return Response.json(emptyThread(project));
  }
  const sanitizedMessages = stored.messages.map((message) => ({
    ...message,
    content: sanitizeOpenClawUserVisibleResponse(message.content),
    thinking:
      typeof message.thinking === "string"
        ? sanitizeOpenClawUserVisibleResponse(message.thinking)
        : undefined,
  }));
  return Response.json({
    ...stored,
    messages: sanitizedMessages,
  });
}

export async function POST(request: Request) {
  if (!(await isLocalRequest())) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const candidate = body as {
    project?: unknown;
    conversationId?: unknown;
    conversationBackend?: unknown;
    messages?: unknown;
    artifactProvenance?: unknown;
  };

  const project = normalizeProject(candidate.project);
  if (!project) {
    return Response.json({ error: "Missing project" }, { status: 400 });
  }

  const messages = normalizeMessages(candidate.messages);
  if (!messages) {
    return Response.json({ error: "Invalid messages" }, { status: 400 });
  }
  const artifactProvenance = normalizeArtifactProvenance(candidate.artifactProvenance);
  if (!artifactProvenance) {
    return Response.json({ error: "Invalid artifact provenance" }, { status: 400 });
  }

  const conversationId =
    candidate.conversationId === null || typeof candidate.conversationId === "string"
      ? candidate.conversationId
      : null;
  const conversationBackend = normalizeConversationBackend(candidate.conversationBackend);

  const thread = {
    version: 1 as const,
    project,
    conversationId,
    conversationBackend,
    messages,
    artifactProvenance,
  };

  await writeChatThread(thread);
  return Response.json({ ok: true });
}
