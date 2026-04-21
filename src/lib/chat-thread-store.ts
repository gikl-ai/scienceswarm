import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  normalizeArtifactProvenanceEntries,
  type ArtifactProvenanceEntry,
} from "@/lib/artifact-provenance";
import {
  getLegacyProjectChatPath,
  getProjectLocalChatPath,
  isProjectLocalStateRoot,
  migrateLegacyProjectChat,
} from "@/lib/state/project-storage";

export interface PersistedChatThreadMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  thinking?: string;
  timestamp: string;
  chatMode?: "reasoning" | "openclaw-tools";
  channel?: string;
  userName?: string;
  captureClarification?: PersistedCaptureClarification;
  taskPhases?: PersistedChatTaskPhase[];
}

export interface PersistedChatTaskPhase {
  id: string;
  label: string;
  status: "pending" | "active" | "completed";
}

export interface PersistedCaptureClarification {
  captureId: string;
  rawPath?: string;
  question: string;
  choices: string[];
  capturedContent: string;
}

export interface PersistedChatThread {
  version: 1;
  project: string;
  conversationId: string | null;
  conversationBackend?: "openclaw" | "agent" | "direct" | null;
  messages: PersistedChatThreadMessage[];
  artifactProvenance?: ArtifactProvenanceEntry[];
}

function isPersistedMessage(value: unknown): value is PersistedChatThreadMessage {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PersistedChatThreadMessage>;
  return (
    typeof candidate.id === "string"
    && (candidate.role === "user" || candidate.role === "assistant" || candidate.role === "system")
    && typeof candidate.content === "string"
    && (candidate.thinking === undefined || typeof candidate.thinking === "string")
    && typeof candidate.timestamp === "string"
    && (
      candidate.chatMode === undefined
      || candidate.chatMode === "reasoning"
      || candidate.chatMode === "openclaw-tools"
    )
    && (candidate.channel === undefined || typeof candidate.channel === "string")
    && (candidate.userName === undefined || typeof candidate.userName === "string")
    && (
      candidate.captureClarification === undefined
      || isPersistedCaptureClarification(candidate.captureClarification)
    )
    && (
      candidate.taskPhases === undefined
      || (
        Array.isArray(candidate.taskPhases)
        && candidate.taskPhases.every((phase) => isPersistedTaskPhase(phase))
      )
    )
  );
}

function isPersistedCaptureClarification(value: unknown): value is PersistedCaptureClarification {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PersistedCaptureClarification>;
  return (
    typeof candidate.captureId === "string"
    && (candidate.rawPath === undefined || typeof candidate.rawPath === "string")
    && typeof candidate.question === "string"
    && Array.isArray(candidate.choices)
    && candidate.choices.every((choice) => typeof choice === "string")
    && typeof candidate.capturedContent === "string"
  );
}

function isPersistedTaskPhase(value: unknown): value is PersistedChatTaskPhase {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PersistedChatTaskPhase>;
  return (
    typeof candidate.id === "string"
    && typeof candidate.label === "string"
    && (
      candidate.status === "pending"
      || candidate.status === "active"
      || candidate.status === "completed"
    )
  );
}

function isPersistedThread(value: unknown): value is PersistedChatThread {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PersistedChatThread>;
  return (
    candidate.version === 1
    && typeof candidate.project === "string"
    && (candidate.conversationId === null || typeof candidate.conversationId === "string")
    && (
      candidate.conversationBackend === undefined
      || candidate.conversationBackend === null
      || candidate.conversationBackend === "openclaw"
      || candidate.conversationBackend === "agent"
      || candidate.conversationBackend === "direct"
    )
    && Array.isArray(candidate.messages)
    && candidate.messages.every((message) => isPersistedMessage(message))
    && (
      candidate.artifactProvenance === undefined
      || Array.isArray(candidate.artifactProvenance)
    )
  );
}

function normalizeConversationBackend(
  value: PersistedChatThread["conversationBackend"],
): PersistedChatThread["conversationBackend"] {
  return value === "openclaw" || value === "agent" || value === "direct" ? value : null;
}

export function getChatThreadPath(
  project: string,
  stateRoot?: string,
): string {
  if (stateRoot) {
    if (isProjectLocalStateRoot(project, stateRoot)) {
      return join(stateRoot, "chat.json");
    }
    return getLegacyProjectChatPath(project, stateRoot);
  }
  return getProjectLocalChatPath(project);
}

export async function readChatThread(
  project: string,
  stateRoot?: string,
): Promise<PersistedChatThread | null> {
  if (!stateRoot) {
    await migrateLegacyProjectChat(project);
  }
  try {
    const raw = await readFile(getChatThreadPath(project, stateRoot), "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isPersistedThread(parsed)) {
      return null;
    }
    return {
      ...parsed,
      conversationBackend: normalizeConversationBackend(parsed.conversationBackend),
      artifactProvenance: Array.isArray(parsed.artifactProvenance)
        ? normalizeArtifactProvenanceEntries(parsed.artifactProvenance)
        : undefined,
    };
  } catch {
    return null;
  }
}

export async function writeChatThread(
  thread: PersistedChatThread,
  stateRoot?: string,
): Promise<void> {
  if (!stateRoot) {
    await migrateLegacyProjectChat(thread.project);
  }
  const targetPath = getChatThreadPath(thread.project, stateRoot);
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, JSON.stringify(thread, null, 2), "utf-8");
}
