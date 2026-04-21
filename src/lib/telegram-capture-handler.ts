import path from "node:path";
import { loadBrainConfig } from "@/brain/config";
import { connectGbrain } from "@/brain/connect-gbrain";
import { detectSetupIntent } from "@/brain/setup-flow";
import type { BrainConfig } from "@/brain/types";
import { parseFile } from "@/lib/file-parser";
import { processCapture } from "@/lib/capture";
import { checkRateLimit } from "@/lib/rate-limit";
import { handleWatchConversation } from "@/lib/watch/conversation";
import { isRadarIntent, handleRadarMessage } from "@/lib/radar/telegram";

const TELEGRAM_MESSAGE_LIMIT = 4000;

export interface ReplyContext {
  reply: (text: string, opts?: Record<string, unknown>) => Promise<unknown>;
}

export interface TelegramTextContext extends ReplyContext {
  from?: { id: string | number } | null;
  message: { text: string };
}

export interface TelegramDocumentContext extends ReplyContext {
  from?: { id: string | number } | null;
  message: {
    document?: {
      file_id: string;
      file_name?: string;
      file_size?: number;
    };
  };
  api: {
    getFile: (fileId: string) => Promise<{ file_path?: string }>;
  };
}

function chunkText(text: string, maxLength: number): string[] {
  if (!text) return [""];

  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += maxLength) {
    chunks.push(text.slice(index, index + maxLength));
  }
  return chunks;
}

async function safeReply(ctx: ReplyContext, text: string): Promise<void> {
  try {
    await ctx.reply(text, { parse_mode: "Markdown" });
  } catch {
    await ctx.reply(text);
  }
}

async function replyLongText(ctx: ReplyContext, text: string): Promise<void> {
  for (const chunk of chunkText(text, TELEGRAM_MESSAGE_LIMIT)) {
    await safeReply(ctx, chunk);
  }
}

export function getConfiguredBrainRoot(): string {
  return getConfiguredBrainConfig().root;
}

export function getConfiguredBrainConfig(): BrainConfig {
  const config = loadBrainConfig();
  if (!config) {
    throw new Error(
      "No research brain is initialized yet. Run /setup, then import data before using Telegram capture.",
    );
  }

  return config;
}

export function getTelegramStateRoot(brainRoot: string): string {
  return path.join(brainRoot, "state");
}

function formatCaptureReply(result: Awaited<ReturnType<typeof processCapture>>): string {
  if (result.status === "needs-clarification") {
    const choices =
      result.choices.length > 0
        ? `Choices: ${result.choices.join(", ")}`
        : "Reply with the project slug you want this linked to.";
    return [
      "Saved capture to the inbox without linking it yet.",
      result.clarificationQuestion ?? "Which project should I link this capture to?",
      choices,
    ].join("\n\n");
  }

  const projectLine = result.project
    ? `Project: ${result.project}`
    : "Saved without a project link.";
  const pathLine = result.materializedPath
    ? `Memory page: ${result.materializedPath}`
    : `Raw capture: ${result.rawPath}`;

  return [
    "Capture saved.",
    projectLine,
    pathLine,
  ].join("\n");
}

async function handleSetupIntent(): Promise<string> {
  const result = await connectGbrain();

  if (!result.success) {
    return [
      "I couldn't initialize your research brain yet.",
      "",
      result.message,
    ].join("\n");
  }

  return [
    "Your research brain is ready!",
    "",
    result.wikiCreated
      ? `Created research wiki at \`${result.brainRoot}\`.`
      : `Research wiki already exists at \`${result.brainRoot}\`.`,
    "",
    "You can now:",
    "- Send papers or notes to capture them",
    "- Ask for a morning briefing",
    "- Import your corpus from the dashboard or `/api/brain/import-project`",
  ].join("\n");
}

export async function handleTelegramTextMessage(ctx: TelegramTextContext): Promise<void> {
  if (!ctx.from) return;

  const userId = String(ctx.from.id);
  const rl = checkRateLimit(userId, "telegram");
  if (!rl.allowed) {
    await safeReply(ctx, `Rate limit reached. Try again in ${Math.ceil(rl.resetMs / 1000)}s.`);
    return;
  }

  if (isRadarIntent(ctx.message.text)) {
    const handled = await handleRadarMessage(ctx);
    if (handled) return;
    // LLM classified as non-radar — fall through to watch/capture
  }

  try {
    // Detect "set up my brain" intent before requiring a configured brain
    if (detectSetupIntent(ctx.message.text)) {
      const reply = await handleSetupIntent();
      await replyLongText(ctx, reply);
      return;
    }

    const config = getConfiguredBrainConfig();
    const watchResult = await handleWatchConversation({
      config,
      channel: "telegram",
      userId,
      message: ctx.message.text,
    });
    if (watchResult.handled) {
      await replyLongText(ctx, watchResult.response ?? "");
      return;
    }

    const brainRoot = config.root;
    const result = await processCapture({
      brainRoot,
      channel: "telegram",
      userId,
      content: ctx.message.text,
    });
    await replyLongText(ctx, formatCaptureReply(result));
  } catch (error) {
    console.error("Telegram text capture error:", error);
    await safeReply(ctx, "Failed to save that capture. Try again.");
  }
}

export async function handleTelegramDocumentMessage(
  ctx: TelegramDocumentContext,
  token: string,
): Promise<void> {
  const doc = ctx.message.document;
  if (!doc || !ctx.from) return;

  const userId = String(ctx.from.id);
  const rl = checkRateLimit(userId, "telegram");
  if (!rl.allowed) {
    await safeReply(ctx, `Rate limit reached. Try again in ${Math.ceil(rl.resetMs / 1000)}s.`);
    return;
  }

  try {
    await safeReply(ctx, "Reading file...");
    const file = await ctx.api.getFile(doc.file_id);
    if (!file.file_path) {
      await safeReply(ctx, "Could not retrieve the file from Telegram.");
      return;
    }

    const response = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
    if (!response.ok) {
      await safeReply(ctx, "Could not download the file from Telegram.");
      return;
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const parsed = await parseFile(buffer, doc.file_name || "file");
    const brainRoot = getConfiguredBrainRoot();
    const result = await processCapture({
      brainRoot,
      channel: "telegram",
      userId,
      content: `[Uploaded: ${doc.file_name || "file"}]\n\n${parsed.text}`,
      attachmentPaths: [file.file_path],
    });
    await replyLongText(ctx, formatCaptureReply(result));
  } catch (error) {
    console.error("Telegram document capture error:", error);
    await safeReply(ctx, "Failed to process the file. Try a different format.");
  }
}
