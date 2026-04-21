import { verifySlackRequest } from "@/lib/slack-auth";
import { markdownToBlocks, errorBlock } from "@/lib/slack-blocks";
import {
  getSession,
  addMessage,
  clearSession,
  sessionKey,
  getChannelMessages,
} from "@/lib/slack-sessions";
import { completeChat } from "@/lib/message-handler";

const signingSecret = process.env.SLACK_SIGNING_SECRET;

/** Parse URL-encoded form body into a key-value map */
function parseFormBody(body: string): Record<string, string> {
  const params = new URLSearchParams(body);
  const result: Record<string, string> = {};
  for (const [key, value] of params.entries()) {
    result[key] = value;
  }
  return result;
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

  const form = parseFormBody(rawBody);
  const text = (form.text || "").trim();
  const teamId = form.team_id || "unknown";
  const channelId = form.channel_id || "unknown";
  const responseUrl = form.response_url;

  // Parse subcommand: /scienceswarm <subcommand> [args]
  const spaceIndex = text.indexOf(" ");
  const subcommand = spaceIndex > -1 ? text.slice(0, spaceIndex) : text;
  const args = spaceIndex > -1 ? text.slice(spaceIndex + 1).trim() : "";

  // Use a stable thread key for commands (no thread_ts, use "cmd" prefix)
  const key = sessionKey(teamId, channelId, "cmd");

  switch (subcommand.toLowerCase()) {
    case "ask": {
      if (!args) {
        return Response.json({
          response_type: "ephemeral",
          text: "Usage: `/scienceswarm ask <your question>`",
        });
      }

      addMessage(key, "user", args);
      const session = getSession(key);

      // Respond asynchronously via response_url since AI may take a while
      if (responseUrl) {
        processAskCommand(session, key, args, responseUrl).catch((err) => {
          console.error("Slash command ask error:", err);
        });

        return Response.json({
          response_type: "ephemeral",
          text: ":hourglass_flowing_sand: Thinking...",
        });
      }

      // Fallback: synchronous response
      try {
        const response = await completeChat({
          messages: session,
          channel: "slack",
        });
        addMessage(key, "assistant", response);
        const blocks = markdownToBlocks(response);
        return Response.json({
          response_type: "in_channel",
          blocks,
          text: response,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        return Response.json({
          response_type: "ephemeral",
          blocks: errorBlock(msg),
          text: msg,
        });
      }
    }

    case "papers": {
      // Scan all sessions in this channel (files are uploaded in thread sessions,
      // not the "cmd" session) to find uploaded papers
      const allMessages = getChannelMessages(teamId, channelId);
      const fileMessages = allMessages.filter((m) =>
        m.content.startsWith("[Uploaded file:")
      );

      if (fileMessages.length === 0) {
        return Response.json({
          response_type: "ephemeral",
          text: "No papers in the current conversation context. Upload a PDF in the channel first.",
        });
      }

      const paperList = fileMessages
        .map((m) => {
          const match = m.content.match(/\[Uploaded file: (.+?)\]/);
          return match ? `- ${match[1]}` : null;
        })
        .filter(Boolean)
        .join("\n");

      return Response.json({
        response_type: "ephemeral",
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*Papers in context:*\n${paperList}`,
            },
          },
        ],
        text: `Papers in context:\n${paperList}`,
      });
    }

    case "clear": {
      clearSession(key);
      return Response.json({
        response_type: "ephemeral",
        text: "Conversation cleared. Starting fresh.",
      });
    }

    default: {
      return Response.json({
        response_type: "ephemeral",
        text: [
          "*ScienceSwarm Commands:*",
          "`/scienceswarm ask <question>` — Ask the AI a research question",
          "`/scienceswarm papers` — List papers in the current context",
          "`/scienceswarm clear` — Clear conversation history",
        ].join("\n"),
      });
    }
  }
}

/** Process an ask command asynchronously and post the result via response_url */
async function processAskCommand(
  session: Array<{ role: string; content: string }>,
  key: string,
  _question: string,
  responseUrl: string
): Promise<void> {
  try {
    const response = await completeChat({
      messages: session,
      channel: "slack",
    });
    addMessage(key, "assistant", response);
    const blocks = markdownToBlocks(response);

    await fetch(responseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        response_type: "in_channel",
        replace_original: false,
        blocks,
        text: response,
      }),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    await fetch(responseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        response_type: "ephemeral",
        replace_original: true,
        blocks: errorBlock(msg),
        text: msg,
      }),
    });
  }
}
