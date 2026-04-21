import { NextRequest } from "next/server";
import {
  healthCheck,
  sendAgentMessage,
  broadcastMessage,
} from "@/lib/openclaw";

// ── GET — health check ───────────────────────────────────────

export async function GET(req: NextRequest) {
  const action = req.nextUrl.searchParams.get("action");

  if (action === "health") {
    try {
      const status = await healthCheck();
      return Response.json(status);
    } catch {
      return Response.json({ status: "disconnected", channels: [] });
    }
  }

  return Response.json({ error: "Unknown action" }, { status: 400 });
}

// ── POST — send messages ─────────────────────────────────────

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { action } = body;

    // Require internal API key for send/broadcast actions — always enforced
    if (action === "send" || action === "broadcast") {
      const internalKey = process.env.OPENCLAW_INTERNAL_API_KEY;
      if (!internalKey) {
        return Response.json(
          { error: "OPENCLAW_INTERNAL_API_KEY not configured. Set it in .env to enable send/broadcast." },
          { status: 403 }
        );
      }
      const authHeader = request.headers.get("x-internal-api-key");
      if (authHeader !== internalKey) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
    }

    switch (action) {
      case "send": {
        const { message, channel, agent, session } = body;
        if (!message) return Response.json({ error: "message required" }, { status: 400 });
        const response = await sendAgentMessage(message, { channel, agent, session });
        return Response.json({ response });
      }

      case "broadcast": {
        const { message } = body;
        if (!message) return Response.json({ error: "message required" }, { status: 400 });
        await broadcastMessage(message);
        return Response.json({ ok: true });
      }

      case "health": {
        const status = await healthCheck();
        return Response.json(status);
      }

      default:
        return Response.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "OpenClaw error";
    return Response.json({ error: message }, { status: 500 });
  }
}
