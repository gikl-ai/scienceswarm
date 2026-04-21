import {
  startConversation,
  getStartTaskStatus,
  getConversation,
  sendPendingMessage,
  getEvents,
  OPENHANDS_URL,
} from "@/lib/openhands";
import { enforceExecutionPrivacy } from "@/lib/privacy-policy";
import { assertSafeProjectSlug } from "@/lib/state/project-manifests";

// POST /api/agent — start conversation or send message
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { action } = body;
    const projectId = typeof body.projectId === "string" ? body.projectId : null;

    if (action === "start" || action === "message") {
      if (!projectId) {
        return Response.json({ error: "projectId is required for agent start/message actions" }, { status: 400 });
      }

      try {
        assertSafeProjectSlug(projectId);
      } catch {
        return Response.json({ error: "projectId must be a safe bare slug" }, { status: 400 });
      }

      const privacyError = await enforceExecutionPrivacy(projectId);
      if (privacyError) {
        return privacyError;
      }
    }

    switch (action) {
      case "start": {
        const { message, repository, branch, model } = body;
        const task = await startConversation({ message, repository, branch, model });

        // Poll until ready (max 60s)
        const taskId = task.id;
        let status = task;
        for (let i = 0; i < 30; i++) {
          if (status.status === "READY" || status.status === "ERROR") break;
          await new Promise((r) => setTimeout(r, 2000));
          const tasks = await getStartTaskStatus(taskId);
          status = tasks[0];
        }

        if (status.status === "ERROR") {
          return Response.json(
            { error: status.detail || "Agent failed to start" },
            { status: 500 }
          );
        }

        return Response.json({
          conversationId: status.app_conversation_id,
          sandboxId: status.sandbox_id,
          status: status.status,
          wsUrl: `${OPENHANDS_URL.replace("http", "ws")}?conversation_id=${status.app_conversation_id}&latest_event_id=-1`,
        });
      }

      case "message": {
        const { conversationId, message } = body;
        const result = await sendPendingMessage(conversationId, message);
        return Response.json(result);
      }

      case "status": {
        const { conversationId } = body;
        const conv = await getConversation(conversationId);
        return Response.json(conv);
      }

      case "events": {
        const { conversationId, limit } = body;
        const events = await getEvents(conversationId, limit || 50);
        return Response.json(events);
      }

      default:
        return Response.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Agent error";
    console.error("Agent API error:", message);
    return Response.json({ error: message }, { status: 500 });
  }
}

// GET /api/agent?action=health — check if OpenHands is running
export async function GET(request: Request) {
  const url = new URL(request.url);
  const action = url.searchParams.get("action");

  if (action === "health") {
    try {
      const res = await fetch(`${OPENHANDS_URL}/`, {
        signal: AbortSignal.timeout(3000),
      });
      return Response.json({ status: res.ok ? "connected" : "error", code: res.status, url: OPENHANDS_URL });
    } catch {
      return Response.json({ status: "disconnected", error: "OpenHands not reachable" });
    }
  }

  return Response.json({ error: "Unknown action" }, { status: 400 });
}
