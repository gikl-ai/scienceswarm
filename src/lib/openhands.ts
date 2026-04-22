import { getOpenHandsUrl } from "@/lib/config/ports";
import { resolveOpenHandsConversationModel } from "@/lib/runtime";
import { getCurrentLlmRuntimeEnv } from "@/lib/runtime-saved-env";

export interface ConversationStartRequest {
  message: string;
  repository?: string;
  branch?: string;
  model?: string;
}

export interface Conversation {
  id: string;
  sandbox_id: string;
  sandbox_status: string;
  execution_status: string;
  selected_repository?: string;
  title?: string;
  created_at: string;
}

export async function startConversation(req: ConversationStartRequest) {
  const runtime = getCurrentLlmRuntimeEnv(process.env);
  const resolvedConversationModel = resolveOpenHandsConversationModel({
    LLM_PROVIDER: runtime.llmProvider,
    LLM_MODEL: runtime.llmModel ?? undefined,
    OLLAMA_MODEL: runtime.ollamaModel ?? undefined,
  });

  // OpenHands 1.6 takes a request with `initial_message` populated,
  // but that path goes through `_construct_initial_message_with_plugin_params`
  // and the sandbox's start-conversation endpoint which does NOT
  // dispatch the message to the agent loop in our headless setup.
  // The frontend (when its WebSocket isn't connected) instead queues
  // the user message via POST /api/v1/conversations/<task-id>/pending-messages
  // and lets the orchestrator deliver it once the conversation
  // transitions to READY — which `_process_pending_messages` does
  // with `run: True`. We use that same path: send a null
  // initial_message in the start, then queue the prompt as a pending
  // message via `queuePendingMessage` immediately after.
  //
  // See OpenHands 1.6 source:
  //   openhands/app_server/app_conversation/live_status_app_conversation_service.py:1554-1593
  //   openhands/app_server/pending_messages/pending_message_router.py
  //   frontend/src/contexts/conversation-websocket-context.tsx:849
  const res = await fetch(`${getOpenHandsUrl()}/api/v1/app-conversations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      initial_message: null,
      selected_repository: req.repository || null,
      selected_branch: req.branch || "main",
      git_provider: req.repository ? "github" : null,
      llm_model: req.model || resolvedConversationModel,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenHands start failed: ${res.status} ${err}`);
  }

  return res.json();
}

/**
 * Queue a user message to be delivered to the conversation once it is
 * READY. Used as the "first message" entry point for headless callers
 * that don't hold an agent-server WebSocket. Pass either a task id
 * (immediately after `startConversation`) or a real
 * `app_conversation_id` (after the start-task has resolved). The
 * orchestrator handles the task → conversation rename in
 * `_process_pending_messages` and then POSTs each queued message to
 * the sandbox at `/api/conversations/<conv_id>/events` with
 * `run: True`, which fires the agent loop.
 *
 * The router accepts both forms via the `task-<hex>` prefix
 * convention; pass `taskId` here as the bare hex from the start
 * response and we'll add the prefix.
 */
export async function queuePendingMessage(
  taskOrConversationId: string,
  message: string,
): Promise<void> {
  // The orchestrator's _process_pending_messages stores task-id-keyed
  // rows under `task-<hex>`. The frontend's use-create-conversation
  // hook builds the same prefix when navigating to a fresh task. We
  // detect a bare hex id (32 chars, no hyphens) and add the prefix;
  // if a caller already passed a `task-...` or a UUID-with-hyphens
  // (real conversation id) we leave it alone.
  const conversationId = /^[a-f0-9]{32}$/i.test(taskOrConversationId)
    ? `task-${taskOrConversationId}`
    : taskOrConversationId;
  const res = await fetch(
    `${getOpenHandsUrl()}/api/v1/conversations/${conversationId}/pending-messages`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        role: "user",
        content: [{ type: "text", text: message }],
      }),
    },
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(
      `OpenHands pending-message queue failed: ${res.status} ${err}`,
    );
  }
}

export async function getStartTaskStatus(taskId: string) {
  const res = await fetch(
    `${getOpenHandsUrl()}/api/v1/app-conversations/start-tasks?ids=${taskId}`
  );
  if (!res.ok) throw new Error(`Failed to get task status: ${res.status}`);
  return res.json();
}

export async function getConversation(conversationId: string) {
  const res = await fetch(
    `${getOpenHandsUrl()}/api/v1/app-conversations?ids=${conversationId}`
  );
  if (!res.ok) throw new Error(`Failed to get conversation: ${res.status}`);
  const data = await res.json();
  return data[0] as Conversation;
}

export async function sendPendingMessage(
  conversationId: string,
  message: string
) {
  const res = await fetch(
    `${getOpenHandsUrl()}/api/v1/conversations/${conversationId}/pending-messages`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: [{ type: "text", text: message }],
        role: "user",
      }),
    }
  );
  if (!res.ok) throw new Error(`Failed to send message: ${res.status}`);
  return res.json();
}

export async function uploadFiles(
  conversationId: string,
  files: FormData
) {
  const res = await fetch(
    `${getOpenHandsUrl()}/api/conversations/${conversationId}/upload-files`,
    { method: "POST", body: files }
  );
  if (!res.ok) throw new Error(`Failed to upload: ${res.status}`);
  return res.json();
}

export async function listFiles(conversationId: string, path = "/workspace") {
  const res = await fetch(
    `${getOpenHandsUrl()}/api/conversations/${conversationId}/list-files?path=${encodeURIComponent(path)}`
  );
  if (!res.ok) throw new Error(`Failed to list files: ${res.status}`);
  return res.json();
}

export async function readFile(conversationId: string, filePath: string) {
  const res = await fetch(
    `${getOpenHandsUrl()}/api/v1/app-conversations/${conversationId}/file?file_path=${encodeURIComponent(filePath)}`
  );
  if (!res.ok) throw new Error(`Failed to read file: ${res.status}`);
  return res.text();
}

export async function getEvents(
  conversationId: string,
  limit = 50,
  sortOrder: "TIMESTAMP" | "TIMESTAMP_DESC" = "TIMESTAMP_DESC"
): Promise<unknown[]> {
  // OpenHands 1.6 enum: must be "TIMESTAMP" or "TIMESTAMP_DESC".
  // Older 1.5 accepted "asc"/"desc"; passing those returns 422.
  //
  // Response-shape normalization: OH 1.5 returned the event list as a
  // raw array; OH 1.6 wraps it in `{items: [...]}`. Every caller
  // wants an array, so unwrap here. This keeps all downstream
  // consumers (run-job waitForFinish, run-artifact poll, unified
  // chat fallback, /api/agent events proxy) version-agnostic and
  // avoids a `Array.isArray(events)` check that silently fails on
  // OH 1.6.
  const res = await fetch(
    `${getOpenHandsUrl()}/api/v1/conversation/${conversationId}/events/search?limit=${limit}&sort_order=${sortOrder}`
  );
  if (!res.ok) throw new Error(`Failed to get events: ${res.status}`);
  const body = (await res.json()) as unknown;
  if (Array.isArray(body)) return body;
  if (
    body &&
    typeof body === "object" &&
    Array.isArray((body as { items?: unknown }).items)
  ) {
    return (body as { items: unknown[] }).items;
  }
  return [];
}

/**
 * Extract an agent-authored text message from an event returned by
 * `getEvents`. Handles both:
 *
 * - OH 1.5: `{ source: "agent", message: "..." }` (flat)
 * - OH 1.6: `{ kind: "MessageEvent", source: "agent",
 *             llm_message: { content: [{ type: "text", text: "..." }] } }`
 *
 * Returns `null` if the event is not an agent message. Using this
 * helper keeps every caller version-agnostic and avoids silently
 * filtering to zero results when the OH version changes under us.
 */
export function extractAgentMessageText(event: unknown): string | null {
  if (!event || typeof event !== "object") return null;
  const rec = event as {
    source?: unknown;
    message?: unknown;
    kind?: unknown;
    llm_message?: { content?: unknown };
  };
  if (rec.source !== "agent") return null;

  // OH 1.6 MessageEvent shape.
  if (rec.kind === "MessageEvent") {
    const content = rec.llm_message?.content;
    if (!Array.isArray(content)) return null;
    const text = content
      .map((c) => {
        if (!c || typeof c !== "object") return "";
        const row = c as { type?: unknown; text?: unknown };
        return row.type === "text" && typeof row.text === "string"
          ? row.text
          : "";
      })
      .filter((t) => t.length > 0)
      .join("\n");
    return text || null;
  }

  // OH 1.5 flat shape.
  if (typeof rec.message === "string" && rec.message.length > 0) {
    return rec.message;
  }
  return null;
}

export function getWebSocketUrl(conversationId: string) {
  const wsBase = getOpenHandsUrl().replace("http", "ws");
  return `${wsBase}?conversation_id=${conversationId}&latest_event_id=-1`;
}

/**
 * Backwards-compatible named export resolved eagerly at module load.
 *
 * Existing consumers (`src/app/api/chat/unified/route.ts`,
 * `src/app/api/agent/route.ts`) import this symbol directly. Preserving the
 * eager binding matches the prior behavior exactly — in Next.js server code
 * env vars are set at boot, so the one-shot resolution is equivalent to the
 * previous `process.env.OPENHANDS_URL || "http://localhost:3000"`.
 *
 * New call sites inside this module route through `getOpenHandsUrl()` which
 * re-reads the environment on every call; tests exercise that path via
 * `vi.stubEnv("OPENHANDS_URL", ...)`.
 */
export const OPENHANDS_URL: string = getOpenHandsUrl();
