import { WebClient, type KnownBlock } from "@slack/web-api";
import { verifySlackRequest } from "@/lib/slack-auth";
import { markdownToBlocks, errorBlock } from "@/lib/slack-blocks";
import {
  getSession,
  addMessage,
  sessionKey,
} from "@/lib/slack-sessions";
import { completeChat } from "@/lib/message-handler";
import { parseFile } from "@/lib/file-parser";
import { checkRateLimit } from "@/lib/rate-limit";

const slackClient = new WebClient(process.env.SLACK_BOT_TOKEN);
const signingSecret = process.env.SLACK_SIGNING_SECRET;

/** Post a Block Kit reply in a thread */
async function postReply(
  channel: string,
  threadTs: string,
  blocks: KnownBlock[]
): Promise<void> {
  await slackClient.chat.postMessage({
    channel,
    thread_ts: threadTs,
    blocks,
    text: "ScienceSwarm response", // fallback for notifications
  });
}

/** Download a Slack-hosted file and parse its contents */
async function downloadAndParseFile(
  fileId: string
): Promise<{ name: string; text: string } | null> {
  const info = await slackClient.files.info({ file: fileId });
  const file = info.file;
  if (!file?.url_private || !file.name) return null;

  const resp = await fetch(file.url_private, {
    headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
  });
  if (!resp.ok) return null;

  const buffer = Buffer.from(await resp.arrayBuffer());
  const parsed = await parseFile(buffer, file.name);
  return { name: file.name, text: parsed.text };
}

/** Handle an incoming message or app_mention event */
async function handleMessage(event: Record<string, unknown>): Promise<void> {
  // Ignore bot messages to avoid loops
  if (event.bot_id || event.subtype === "bot_message") return;

  const channel = event.channel as string;
  const teamId = (event.team as string) || "unknown";
  const threadTs = (event.thread_ts as string) || (event.ts as string);
  const userText = (event.text as string) || "";
  const slackUserId = (event.user as string) || "unknown";

  if (!channel || !userText.trim()) return;

  // Rate limit per Slack user
  const rl = checkRateLimit(slackUserId, "slack");
  if (!rl.allowed) {
    await postReply(channel, threadTs, errorBlock(
      `Rate limit reached. Try again in ${Math.ceil(rl.resetMs / 1000)}s.`
    ));
    return;
  }

  const key = sessionKey(teamId, channel, threadTs);

  // Handle file attachments
  const files = event.files as Array<Record<string, string>> | undefined;
  if (files && files.length > 0) {
    for (const f of files) {
      const parsed = await downloadAndParseFile(f.id);
      if (parsed) {
        addMessage(
          key,
          "user",
          `[Uploaded file: ${parsed.name}]\n\n${parsed.text}`
        );
      }
    }
  }

  // Strip the bot mention from text (e.g. <@U12345> ask me something)
  const cleanText = userText.replace(/<@[A-Z0-9]+>/g, "").trim();
  if (!cleanText) return;

  addMessage(key, "user", cleanText);

  const session = getSession(key);

  try {
    const response = await completeChat({
      messages: session,
      channel: "slack",
    });

    addMessage(key, "assistant", response);

    const blocks = markdownToBlocks(response);
    await postReply(channel, threadTs, blocks);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    await postReply(channel, threadTs, errorBlock(msg));
  }
}

export async function POST(request: Request): Promise<Response> {
  const rawBody = await request.text();

  // Verify request signature — fail closed if secret is not configured
  if (!signingSecret) {
    console.error("SLACK_SIGNING_SECRET is not configured");
    return new Response("Server misconfigured", { status: 401 });
  }

  const timestamp = request.headers.get("x-slack-request-timestamp") || "";
  const signature = request.headers.get("x-slack-signature") || "";

  if (!verifySlackRequest(signingSecret, timestamp, rawBody, signature)) {
    return new Response("Invalid signature", { status: 401 });
  }

  const body = JSON.parse(rawBody) as Record<string, unknown>;

  // Handle Slack URL verification challenge
  if (body.type === "url_verification") {
    return Response.json({ challenge: body.challenge });
  }

  // Handle event callbacks
  if (body.type === "event_callback") {
    const event = body.event as Record<string, unknown>;
    if (!event) {
      return new Response("No event", { status: 400 });
    }

    const eventType = event.type as string;

    if (
      eventType === "message" ||
      eventType === "app_mention"
    ) {
      // Process in background — Slack expects a 200 within 3 seconds
      handleMessage(event).catch((err) => {
        console.error("Slack message handler error:", err);
      });
    }

    // Acknowledge immediately
    return new Response("ok", { status: 200 });
  }

  return new Response("Unhandled event type", { status: 400 });
}
