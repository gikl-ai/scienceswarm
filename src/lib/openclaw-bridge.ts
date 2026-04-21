/**
 * OpenClaw Bridge — routes messages from any channel to ScienceSwarm AI.
 *
 * This is the core integration layer: takes an OpenClaw message from any
 * messaging channel (WhatsApp, Telegram, Slack, Discord, web, etc.),
 * routes it to the right ScienceSwarm handler, and returns a response.
 */

import { completeChat, type ChatRequest } from "./message-handler";
import { loadBrainConfig } from "@/brain/config";
import { parseFile } from "./file-parser";
import {
  type OpenClawAttachment,
  type OpenClawMessage,
  getConversationHistory,
} from "./openclaw";
import { startConversation } from "./openhands";
import { handleWatchConversation } from "./watch/conversation";

// ── Types ──────────────────────────────────────────────────────

export interface BridgeConfig {
  enableAgent: boolean; // use OpenHands for code execution
}

interface CommandResult {
  handled: boolean;
  response: string;
}

// ── Default config ─────────────────────────────────────────────

const defaultConfig: BridgeConfig = {
  enableAgent: false,
};

// ── Special commands ───────────────────────────────────────────

async function handleCommand(
  msg: OpenClawMessage,
  config: BridgeConfig
): Promise<CommandResult> {
  const text = msg.content.trim();

  if (text === "/help") {
    return {
      handled: true,
      response: [
        "**ScienceSwarm Commands**",
        "",
        "`/experiment <name>` — trigger an experiment via OpenHands",
        "`/data <query>` — query project data",
        "`/status` — show command-path status and tell you where live project status lives",
        "`/papers` — explain how to inspect real project papers from the gbrain-backed workspace",
        "`/help` — show this help message",
        "",
        "Or just type naturally. In the workspace chat, ask me to \"organize this project\" for a real gbrain-backed summary.",
      ].join("\n"),
    };
  }

  if (text === "/status") {
    return {
      handled: true,
      response: [
        "**ScienceSwarm Status**",
        "",
        "**Agent**: " + (config.enableAgent ? "connected" : "not connected"),
        "**Channel**: " + msg.channel,
        "",
        "This legacy command path is not connected to live gbrain project summaries.",
        "Use the workspace chat and ask `organize this project` for real project threads, duplicates, stale exports, and next steps.",
      ].join("\n"),
    };
  }

  if (text === "/papers") {
    return {
      handled: true,
      response: [
        "**Project Papers**",
        "",
        "This legacy command path does not have a live paper listing.",
        "",
        "Use the workspace chat and ask `organize this project` or `show me duplicate papers` to inspect the real gbrain-backed project papers.",
      ].join("\n"),
    };
  }

  if (text.startsWith("/data ")) {
    const query = text.slice(6).trim();
    return {
      handled: true,
      response: `**Data Query**: "${query}"\n\nData querying is not yet connected to a live dataset. Upload CSV or JSON files, or connect a database to enable data queries.`,
    };
  }

  if (text.startsWith("/experiment ")) {
    const name = text.slice(12).trim();
    if (!config.enableAgent) {
      return {
        handled: true,
        response: `Cannot run experiment **${name}** — OpenHands agent is not connected. Start the agent backend with \`./start.sh\`.`,
      };
    }

    try {
      const result = await startConversation({
        message: `Run the experiment: ${name}. Look in the experiments/ directory for the script and configuration. Run it and report the results.`,
      });
      return {
        handled: true,
        response: `**Experiment started**: ${name}\n\nOpenHands conversation: \`${result.conversation_id || "pending"}\`\n\nI'll process the results when it completes.`,
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        handled: true,
        response: `**Experiment failed to start**: ${name}\n\nError: ${errMsg}`,
      };
    }
  }

  return { handled: false, response: "" };
}

// ── Attachment handling ────────────────────────────────────────

async function processAttachments(
  attachments: OpenClawAttachment[],
): Promise<string[]> {
  const parsed: string[] = [];

  for (const attachment of attachments) {
    try {
      // Validate URL to prevent SSRF attacks
      const url = new URL(attachment.url);
      if (url.protocol !== "https:") {
        parsed.push(`--- ${attachment.name} ---\n[Rejected: only HTTPS URLs are allowed]`);
        continue;
      }
      const hostname = url.hostname.toLowerCase();
      // Normalize IPv6 bracket-wrapped addresses for comparison
      const bare = hostname.startsWith("[") && hostname.endsWith("]")
        ? hostname.slice(1, -1)
        : hostname;
      // Extract IPv4 from IPv4-mapped IPv6 (dotted or hex form)
      const v4Mapped = bare.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
      const v4MappedHex = bare.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
      const effectiveHost = v4Mapped
        ? v4Mapped[1]
        : v4MappedHex
        ? [
            (parseInt(v4MappedHex[1], 16) >> 8) & 0xff,
            parseInt(v4MappedHex[1], 16) & 0xff,
            (parseInt(v4MappedHex[2], 16) >> 8) & 0xff,
            parseInt(v4MappedHex[2], 16) & 0xff,
          ].join(".")
        : bare;
      const ipv4Match = effectiveHost.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
      const isPrivate172Range = ipv4Match
        ? Number(ipv4Match[1]) === 172 &&
          Number(ipv4Match[2]) >= 16 &&
          Number(ipv4Match[2]) <= 31
        : false;
      if (
        effectiveHost === "localhost" ||
        effectiveHost.startsWith("127.") ||
        effectiveHost === "0.0.0.0" ||
        effectiveHost.startsWith("10.") ||
        isPrivate172Range ||
        effectiveHost.startsWith("192.168.") ||
        effectiveHost.startsWith("169.254.") ||
        effectiveHost === "::1" ||
        effectiveHost.startsWith("fe80:") ||
        effectiveHost.startsWith("fc") ||
        effectiveHost.startsWith("fd")
      ) {
        parsed.push(`--- ${attachment.name} ---\n[Rejected: internal URLs are not allowed]`);
        continue;
      }
      const MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024; // 10 MB
      // Disable auto-redirect to prevent SSRF via open redirect (302 to internal IP)
      const res = await fetch(attachment.url, { redirect: "error" });

      // Fast-reject if Content-Length header exceeds limit
      const contentLength = res.headers.get("content-length");
      if (contentLength && parseInt(contentLength, 10) > MAX_DOWNLOAD_BYTES) {
        parsed.push(`--- ${attachment.name} ---\n[Rejected: file exceeds 10 MB limit]`);
        continue;
      }

      // Stream the body with a running byte counter to guard against
      // chunked transfers that omit Content-Length
      const reader = res.body?.getReader();
      if (!reader) {
        parsed.push(`--- ${attachment.name} ---\n[Could not read response body]`);
        continue;
      }
      const chunks: Uint8Array[] = [];
      let totalBytes = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > MAX_DOWNLOAD_BYTES) {
          await reader.cancel();
          throw new Error("Download exceeded 10 MB limit");
        }
        chunks.push(value);
      }
      const buffer = Buffer.concat(chunks);
      const result = await parseFile(buffer, attachment.name);
      parsed.push(
        `--- ${attachment.name} ---\n${result.pages ? `[PDF: ${result.pages} pages]\n` : ""}${result.text}`
      );
    } catch {
      parsed.push(`--- ${attachment.name} ---\n[Could not process file]`);
    }
  }

  return parsed;
}

// ── Channel-specific formatting ────────────────────────────────

function formatForChannel(response: string, channel: string): string {
  // Telegram and WhatsApp support markdown-ish formatting
  if (channel === "telegram" || channel === "whatsapp") {
    return response;
  }

  // Slack uses mrkdwn (slightly different)
  if (channel === "slack") {
    return response
      .replace(/\*\*(.+?)\*\*/g, "*$1*") // bold: **x** -> *x*
      .replace(/`([^`]+)`/g, "`$1`"); // code stays the same
  }

  // Discord supports full markdown
  if (channel === "discord") {
    return response;
  }

  // LINE and others: strip markdown
  if (channel === "line" || channel === "sms") {
    return response
      .replace(/\*\*(.+?)\*\*/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/^- /gm, "* ");
  }

  return response;
}

// ── Main bridge function ───────────────────────────────────────

export async function processMessage(
  msg: OpenClawMessage,
  config: BridgeConfig = defaultConfig
): Promise<string> {
  // 1. Check for special commands
  const commandResult = await handleCommand(msg, config);
  if (commandResult.handled) {
    return formatForChannel(commandResult.response, msg.channel);
  }

  const brainConfig = loadBrainConfig();
  if (brainConfig) {
    try {
      const watchResult = await handleWatchConversation({
        config: brainConfig,
        channel: msg.channel,
        userId: msg.userId,
        message: msg.content,
        timezone: msg.timezone,
      });
      if (watchResult.handled) {
        return formatForChannel(watchResult.response ?? "", msg.channel);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return formatForChannel(`I could not update the frontier watch: ${message}`, msg.channel);
    }
  }

  // 2. Get conversation history from OpenClaw
  let history: Array<{ role: string; content: string }> = [];
  try {
    const rawHistory = await getConversationHistory(msg.conversationId, 20);
    history = rawHistory.map((m: OpenClawMessage) => ({
      role: m.userId === msg.userId ? "user" : "assistant",
      content: m.content,
    }));
  } catch {
    // No history available — proceed with just the current message
  }

  // 3. If message has attachments, download and parse them
  let attachmentContext = "";
  if (msg.attachments && msg.attachments.length > 0) {
    const parsed = await processAttachments(msg.attachments);
    attachmentContext = "\n\n" + parsed.join("\n\n");
  }

  // 4. Build message array and call completeChat
  const currentContent = msg.content + attachmentContext;

  const messages = [
    ...history.slice(0, -1), // history minus the current message (which is last)
    { role: "user", content: currentContent },
  ];

  // Map channel to ChatRequest channel type
  const channelMap: Record<string, ChatRequest["channel"]> = {
    web: "web",
    telegram: "telegram",
    slack: "slack",
    whatsapp: "mobile",
    discord: "web",
    line: "mobile",
    sms: "mobile",
  };

  const chatReq: ChatRequest = {
    messages,
    channel: channelMap[msg.channel] || "web",
    files: msg.attachments?.map((a: OpenClawAttachment) => ({
      name: a.name,
      size: "unknown",
    })),
  };

  const response = await completeChat(chatReq);

  // 5. Format response for the channel and return
  return formatForChannel(response, msg.channel);
}
