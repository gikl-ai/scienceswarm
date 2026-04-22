/**
 * POST /api/setup/bootstrap
 *
 * Body: { handle: string, email?: string, phone?: string, existingBot?: { token: string } }
 * Returns: text/event-stream with `data: <json BootstrapStreamEvent>\n\n` frames.
 *
 * Phone is optional. When provided, the orchestrator includes the
 * telegram-bot install task; when omitted, setup completes without
 * Telegram and the user can configure it later from Settings.
 *
 * The handler exits as soon as the orchestrator generator finishes, so
 * client-visible stream closure matches orchestrator completion.
 */

import { runBootstrap } from "@/lib/setup/bootstrap-orchestrator";
import type { BootstrapInput } from "@/lib/setup/install-tasks/types";
import { isLocalRequest } from "@/lib/local-guard";
import { isTelegramBotTokenShape } from "@/lib/telegram/bot-token";
import {
  isBrainPresetId,
  normalizeBrainPreset,
} from "@/brain/presets/types";

function isValidHandle(value: unknown): value is string {
  return (
    typeof value === "string" && /^[a-zA-Z0-9_.-]{1,64}$/.test(value.trim())
  );
}

/**
 * Loose RFC-5322 style check: one @, at least one `.` in the domain.
 * The client form uses `type="email"` for a nicer keyboard + native
 * validation, but a direct API call or a browser with validation
 * bypassed could still send garbage — so we re-check server-side
 * before the value lands in .env as GIT_USER_EMAIL.
 */
function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export async function POST(request: Request): Promise<Response> {
  if (!(await isLocalRequest(request))) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: Partial<BootstrapInput>;
  try {
    body = (await request.json()) as Partial<BootstrapInput>;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!isValidHandle(body.handle)) {
    return Response.json(
      {
        error:
          "handle is required: 1-64 chars, letters/digits/._- only",
      },
      { status: 400 },
    );
  }
  const rawEmail =
    typeof body.email === "string" ? body.email.trim() : "";
  if (rawEmail.length > 0 && !isValidEmail(rawEmail)) {
    return Response.json(
      {
        error:
          "email must be a valid address (e.g. user@example.com) or left blank",
      },
      { status: 400 },
    );
  }
  // Phone is optional. When provided, the bootstrap orchestrator
  // includes the telegram-bot install task which creates a personal
  // Telegram bot for chatting with OpenClaw. When omitted, the user
  // can still configure Telegram later from /dashboard/settings.
  const rawPhone =
    typeof body.phone === "string" ? body.phone.trim() : "";
  const rawExistingToken =
    body.existingBot && typeof body.existingBot.token === "string"
      ? body.existingBot.token.trim()
      : "";
  const rawBrainPreset = body.brainPreset;
  if (rawPhone && rawExistingToken) {
    return Response.json(
      {
        error:
          "Choose one: fresh Telegram setup with phone, or reuse an existing bot token.",
      },
      { status: 400 },
    );
  }
  if (body.existingBot !== undefined && !rawExistingToken) {
    return Response.json(
      { error: "existingBot.token is required to reuse a Telegram bot" },
      { status: 400 },
    );
  }
  if (rawExistingToken && !isTelegramBotTokenShape(rawExistingToken)) {
    return Response.json(
      { error: "existingBot.token does not look like a Telegram bot token" },
      { status: 400 },
    );
  }
  if (rawBrainPreset !== undefined && !isBrainPresetId(rawBrainPreset)) {
    return Response.json(
      { error: "brainPreset must be a valid ScienceSwarm brain preset" },
      { status: 400 },
    );
  }
  const input: BootstrapInput = {
    handle: body.handle.trim(),
    email: rawEmail || undefined,
    phone: rawPhone || undefined,
    brainPreset: normalizeBrainPreset(rawBrainPreset),
    telegramMode: rawExistingToken ? "reuse" : rawPhone ? "fresh" : undefined,
    existingBot: rawExistingToken ? { token: rawExistingToken } : undefined,
    repoRoot: process.cwd(),
  };

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const event of runBootstrap(input)) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
          );
        }
      } catch (err) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              type: "summary",
              status: "failed",
              failed: [],
              skipped: [],
              error: (err as Error).message,
            })}\n\n`,
          ),
        );
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
