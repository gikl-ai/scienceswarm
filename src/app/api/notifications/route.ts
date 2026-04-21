// GET  /api/notifications          — list notifications (?unread=true to filter)
// POST /api/notifications          — actions: mark-read, mark-all-read, send

import {
  getNotifications,
  getUnreadCount,
  markRead,
  markAllRead,
  notify,
} from "@/lib/notifications";
import { isLocalRequest } from "@/lib/local-guard";

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const unreadOnly = url.searchParams.get("unread") === "true";
  const projectId = url.searchParams.get("projectId") ?? undefined;
  const rawLimit = url.searchParams.get("limit");
  const parsed = rawLimit !== null ? Number(rawLimit) : NaN;
  const limit = Math.min(Number.isFinite(parsed) ? Math.max(0, parsed) : 20, 100);

  return Response.json({
    notifications: getNotifications(limit, unreadOnly, projectId),
    unreadCount: getUnreadCount(projectId),
  });
}

interface NotificationAction {
  action: string;
  id?: string;
  title?: string;
  message?: string;
  type?: "experiment" | "agent" | "analysis" | "system";
  projectId?: string;
}

export async function POST(request: Request): Promise<Response> {
  let body: NotificationAction;
  try {
    body = (await request.json()) as NotificationAction;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.action) {
    return Response.json(
      { error: "Missing required field: action" },
      { status: 400 },
    );
  }

  switch (body.action) {
    case "mark-read": {
      if (!(await isLocalRequest(request))) {
        return Response.json({ error: "Forbidden" }, { status: 403 });
      }
      if (!body.id) {
        return Response.json(
          { error: "Missing required field: id" },
          { status: 400 },
        );
      }
      markRead(body.id, body.projectId);
      return Response.json({ ok: true });
    }

    case "mark-all-read": {
      if (!(await isLocalRequest(request))) {
        return Response.json({ error: "Forbidden" }, { status: 403 });
      }
      markAllRead(body.projectId);
      return Response.json({ ok: true });
    }

    case "send": {
      // Gate write path behind internal secret when configured
      const secret = process.env.INTERNAL_SECRET;
      if (secret && request.headers.get("x-internal-secret") !== secret) {
        return Response.json({ error: "Unauthorized" }, { status: 403 });
      }
      if (!secret && !(await isLocalRequest(request))) {
        return Response.json({ error: "Forbidden" }, { status: 403 });
      }
      if (!body.title || !body.message) {
        return Response.json(
          { error: "Missing required fields: title, message" },
          { status: 400 },
        );
      }
      const VALID_TYPES = ["experiment", "agent", "analysis", "system"] as const;
      const type = VALID_TYPES.includes(body.type as (typeof VALID_TYPES)[number])
        ? (body.type as (typeof VALID_TYPES)[number])
        : "system";
      await notify({
        type,
        title: body.title,
        message: body.message,
        projectId: body.projectId,
      });
      return Response.json({ ok: true });
    }

    default:
      return Response.json(
        { error: `Unknown action: ${body.action}` },
        { status: 400 },
      );
  }
}
