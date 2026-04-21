import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { isLocalRequest } from "@/lib/local-guard";
import {
  approveTelegramPairingRequest,
  listPendingTelegramPairingRequests,
  preapproveTelegramUserId,
  selectLatestPendingTelegramPairing,
} from "@/lib/openclaw/telegram-link";
import { getOpenClawStatus } from "@/lib/openclaw-status";
import { telegramBotTask } from "@/lib/setup/install-tasks/telegram-bot";
import type {
  BootstrapInput,
  BootstrapStreamEvent,
} from "@/lib/setup/install-tasks/types";
import {
  mergeEnvValues,
  parseEnvFile,
  serializeEnvDocument,
  writeEnvFileAtomic,
} from "@/lib/setup/env-writer";
import { isTelegramBotTokenShape } from "@/lib/telegram/bot-token";

const ENV_PATH = resolve(process.cwd(), ".env");

interface PostBody {
  action?: "approve-pending";
  mode?: "fresh" | "reuse";
  handle?: string;
  email?: string;
  phone?: string;
  botToken?: string;
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function parsePostBody(value: unknown): PostBody | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  if (
    !isOptionalString(candidate.action)
    || !isOptionalString(candidate.mode)
    || !isOptionalString(candidate.handle)
    || !isOptionalString(candidate.email)
    || !isOptionalString(candidate.phone)
    || !isOptionalString(candidate.botToken)
  ) {
    return null;
  }

  if (
    candidate.action !== undefined
    && candidate.action !== "approve-pending"
  ) {
    return null;
  }

  if (
    candidate.mode !== undefined
    && candidate.mode !== "fresh"
    && candidate.mode !== "reuse"
  ) {
    return null;
  }

  return {
    action: candidate.action,
    mode: candidate.mode,
    handle: candidate.handle,
    email: candidate.email,
    phone: candidate.phone,
    botToken: candidate.botToken,
  };
}

function isValidHandle(value: string): boolean {
  return /^[a-zA-Z0-9_.-]{1,64}$/.test(value.trim());
}

async function readEffectiveEnv(): Promise<Record<string, string | undefined>> {
  const entries: Record<string, string | undefined> = { ...process.env };
  try {
    const doc = parseEnvFile(await readFile(ENV_PATH, "utf8"));
    for (const line of doc.lines) {
      if (line.type === "entry") {
        entries[line.key] = line.value;
      }
    }
  } catch {
    // Missing .env is fine; process.env remains the fallback.
  }
  return entries;
}

async function persistTelegramUserId(userId: string): Promise<void> {
  let existing = "";
  try {
    existing = await readFile(ENV_PATH, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  const doc = parseEnvFile(existing);
  const merged = mergeEnvValues(doc, {
    TELEGRAM_USER_ID: userId,
  });
  await writeEnvFileAtomic(ENV_PATH, serializeEnvDocument(merged));
}

function streamFrame(event: BootstrapStreamEvent): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

export async function GET(request: Request): Promise<Response> {
  if (!(await isLocalRequest(request))) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const openclawStatus = await getOpenClawStatus();
  if (openclawStatus.source === "external") {
    return Response.json({ pendingPairing: null });
  }

  const pendingRequest = selectLatestPendingTelegramPairing(
    await listPendingTelegramPairingRequests(),
  );

  if (!pendingRequest) {
    return Response.json({ pendingPairing: null });
  }

  return Response.json({
    pendingPairing: {
      userId: pendingRequest.id,
      username: pendingRequest.meta?.username ?? null,
      firstName: pendingRequest.meta?.firstName ?? null,
      lastName: pendingRequest.meta?.lastName ?? null,
      createdAt: pendingRequest.createdAt ?? null,
      lastSeenAt: pendingRequest.lastSeenAt ?? null,
    },
  });
}

export async function POST(request: Request): Promise<Response> {
  if (!(await isLocalRequest(request))) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: PostBody;
  try {
    const parsed = parsePostBody(await request.json());
    if (!parsed) {
      return Response.json({ error: "Invalid body" }, { status: 400 });
    }
    body = parsed;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const openclawStatus = await getOpenClawStatus();
  if (openclawStatus.source === "external") {
    return Response.json(
      {
        error:
          "OpenClaw is attached to an external runtime. Configure Telegram on that OpenClaw instance directly.",
      },
      { status: 400 },
    );
  }
  if (!openclawStatus.installed) {
    return Response.json(
      { error: "Install OpenClaw from Settings before connecting Telegram." },
      { status: 400 },
    );
  }

  if (body.action === "approve-pending") {
    const pendingRequest = selectLatestPendingTelegramPairing(
      await listPendingTelegramPairingRequests(),
    );
    if (!pendingRequest) {
      return Response.json(
        { error: "No pending Telegram pairing was found." },
        { status: 400 },
      );
    }

    const approved = await approveTelegramPairingRequest(pendingRequest);
    if (!approved) {
      return Response.json(
        {
          error:
            "OpenClaw saw your Telegram message but could not finish pairing automatically. Retry from Settings.",
        },
        { status: 500 },
      );
    }

    const preapproval = await preapproveTelegramUserId(pendingRequest.id);
    await persistTelegramUserId(pendingRequest.id);

    return Response.json({
      ok: true,
      userId: pendingRequest.id,
      warning: preapproval.warning,
    });
  }

  if (body.mode !== "fresh" && body.mode !== "reuse") {
    return Response.json(
      { error: "mode must be either 'fresh' or 'reuse'" },
      { status: 400 },
    );
  }

  const env = await readEffectiveEnv();
  const handle = body.handle?.trim() || env.SCIENCESWARM_USER_HANDLE?.trim() || "";
  if (!isValidHandle(handle)) {
    return Response.json(
      {
        error:
          "Save a valid handle in Settings first (1-64 chars, letters/digits/._- only).",
      },
      { status: 400 },
    );
  }

  const email = body.email?.trim() || env.GIT_USER_EMAIL?.trim() || "";
  const phone = body.phone?.trim() || env.TELEGRAM_PHONE?.trim() || "";
  const botToken = body.botToken?.trim() || "";

  if (body.mode === "fresh" && !phone) {
    return Response.json(
      { error: "Enter the Telegram phone number for the account that should own the new bot." },
      { status: 400 },
    );
  }

  if (body.mode === "reuse" && botToken && !isTelegramBotTokenShape(botToken)) {
    return Response.json(
      { error: "Paste a valid Telegram bot token." },
      { status: 400 },
    );
  }

  if (body.mode === "reuse" && !botToken && !env.TELEGRAM_BOT_TOKEN?.trim()) {
    return Response.json(
      { error: "Paste a Telegram bot token or connect a bot here first." },
      { status: 400 },
    );
  }

  const input: BootstrapInput = {
    handle,
    email: email || undefined,
    phone: body.mode === "fresh" ? phone : undefined,
    telegramMode: body.mode,
    existingBot: body.mode === "reuse" && botToken ? { token: botToken } : undefined,
    repoRoot: process.cwd(),
  };

  const stream = new ReadableStream({
    async start(controller) {
      let failed = false;
      let skipped = false;
      try {
        for await (const event of telegramBotTask.run(input)) {
          if (event.status === "failed") failed = true;
          if (event.status === "skipped") skipped = true;
          controller.enqueue(
            streamFrame({ type: "task", task: "telegram-bot", ...event }),
          );
        }
        controller.enqueue(
          streamFrame({
            type: "summary",
            status: failed ? "failed" : skipped ? "partial" : "ok",
            failed: failed ? ["telegram-bot"] : [],
            skipped: skipped ? ["telegram-bot"] : [],
          }),
        );
      } catch (error) {
        controller.enqueue(
          streamFrame({
            type: "summary",
            status: "failed",
            failed: ["telegram-bot"],
            skipped: [],
            error:
              error instanceof Error
                ? error.message
                : "Telegram setup failed unexpectedly.",
          }),
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
