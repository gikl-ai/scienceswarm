/**
 * OpenClaw Integration
 *
 * Uses the `openclaw agent` CLI command for message routing.
 * The CLI handles auth, session management, and channel delivery.
 *
 * For health checks, uses `openclaw status` parsed output.
 */

import { getOpenClawGatewayUrl } from "@/lib/config/ports";
import { runOpenClaw, runOpenClawSync } from "@/lib/openclaw/runner";

/**
 * OpenClaw status/health responses use the gateway host WITHOUT the `/ws`
 * websocket path suffix. The canonical URL from `getOpenClawGatewayUrl()`
 * includes `/ws`; strip it here so the value matches what the CLI reports.
 */
function gatewayBaseUrl(): string {
  return getOpenClawGatewayUrl().replace(/\/ws$/, "");
}

export interface OpenClawAttachment {
  name: string;
  url: string;
  mimeType?: string;
}

export interface OpenClawMessage {
  id: string;
  userId: string;
  role?: "user" | "assistant" | "system";
  channel: string;
  content: string;
  timestamp: string;
  conversationId: string;
  timezone?: string;
  attachments?: OpenClawAttachment[];
}

export interface OpenClawStatus {
  status: "connected" | "disconnected";
  gateway: string;
  channels: string[];
  agents: number;
  sessions: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function fallbackGatewayUrl(): string {
  return gatewayBaseUrl();
}

function stripAnsi(value: string): string {
  return value
    .replace(/\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g, "")
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001B[@-_]/g, "");
}

function internalOutputMarker(): RegExp {
  return /<(?:channel|planner|lane|assistant|final)(?:-[a-z0-9]+)?\|>/gi;
}
const INTERNAL_OUTPUT_LINE_PATTERNS = [
  /^<(?:channel|planner|lane|assistant|final)(?:-[a-z0-9]+)?\|>\s*$/i,
  /^\[diagnostic\]/i,
  /^Gateway agent failed; falling back to embedded:/i,
  /^FailoverError:/i,
  /^I(?:'m| am)? going to use (?:the |a )?coding-agent(?: skill| process)?(?: to [^.!?]+)?[.!?]?\s*$/i,
  /^I will (?:use|call|spawn) (?:the |a )?coding-agent(?: skill| process)?(?: to [^.!?]+)?[.!?]?\s*$/i,
  /^I(?:'m| am)? going to use (?:the |a )?(?:background agent|sub-agent) process(?: to [^.!?]+)?[.!?]?\s*$/i,
  /^I will (?:use|call|spawn) (?:the |a )?(?:background agent|sub-agent) process(?: to [^.!?]+)?[.!?]?\s*$/i,
  /^This requires spawning a background agent process\.?$/i,
  /^This requires spawning a sub-agent(?: process)?\.?$/i,
  /^⚠️\s*🤖\s*Subagents?:/i,
  /^Subagents?:\s+`?agent:/i,
];

function sanitizeAgentOutput(value: string): string {
  const normalized = stripAnsi(value).replace(/\r\n/g, "\n").trim();
  if (!normalized) return "";

  const markerMatches = Array.from(normalized.matchAll(internalOutputMarker()));
  const lastMatch = markerMatches.at(-1);
  const secondLastMatch = markerMatches.at(-2);
  const candidate = markerMatches.length > 0
    ? normalized.slice((lastMatch?.index ?? 0) + (lastMatch?.[0].length ?? 0))
    : normalized;
  const fallbackStart = secondLastMatch
    ? (secondLastMatch.index ?? 0) + secondLastMatch[0].length
    : 0;
  const fallbackEnd = lastMatch?.index ?? normalized.length;
  const effective = candidate.trim()
    ? candidate
    : normalized.slice(fallbackStart, fallbackEnd);

  return effective
    .replace(/\s*⚠️\s*(?:📝\s*)?(?:Edit|Write|Read|Tool):[^\n]*(?:failed|error)[^\n]*/gi, "")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => !INTERNAL_OUTPUT_LINE_PATTERNS.some((pattern) => pattern.test(line.trim())))
    .join("\n")
    .trim();
}

function enabledChannels(data: Record<string, unknown>): string[] {
  if (Array.isArray(data.channelSummary)) {
    return data.channelSummary
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => /^([^:]+):\s+configured$/.exec(entry.trim())?.[1])
      .filter((name): name is string => Boolean(name));
  }

  if (Array.isArray(data.channels)) {
    return data.channels
      .filter((channel): channel is Record<string, unknown> => isRecord(channel) && channel.enabled === true)
      .map((channel) => channel.name)
      .filter((name): name is string => typeof name === "string");
  }

  return [];
}

function agentCount(data: Record<string, unknown>): number {
  const agents = data.agents;
  if (!isRecord(agents)) return 0;
  if (Array.isArray(agents.agents)) return agents.agents.length;
  if (typeof agents.count === "number") return agents.count;
  return 0;
}

function sessionCount(data: Record<string, unknown>): number {
  const sessions = data.sessions;
  if (!isRecord(sessions)) return 0;
  if (typeof sessions.count === "number") return sessions.count;
  if (typeof sessions.active === "number") return sessions.active;
  return 0;
}

function modelStatusHasEmbeddedTurnPath(data: Record<string, unknown>): boolean {
  const resolvedDefault = data.resolvedDefault;
  if (typeof resolvedDefault !== "string" || resolvedDefault.trim().length === 0) {
    return false;
  }

  const auth = isRecord(data.auth) ? data.auth : null;
  const missingProvidersInUse = auth?.missingProvidersInUse;
  if (Array.isArray(missingProvidersInUse) && missingProvidersInUse.length > 0) {
    return false;
  }

  return true;
}

async function embeddedTurnReady(): Promise<boolean> {
  const result = await runOpenClaw(["models", "status", "--json"], {
    timeoutMs: 12000,
  });
  if (!result.ok) return false;

  try {
    const data = JSON.parse(result.stdout);
    return isRecord(data) && modelStatusHasEmbeddedTurnPath(data);
  } catch {
    return false;
  }
}

function inferMessageRole(message: OpenClawMessage): "user" | "assistant" | "system" {
  if (message.role === "assistant" || message.role === "system") {
    return message.role;
  }

  const userId = typeof message.userId === "string" ? message.userId.toLowerCase() : "";
  if (userId === "assistant" || userId === "agent" || userId === "openclaw") {
    return "assistant";
  }
  if (userId === "system") {
    return "system";
  }
  return "user";
}

/** Check if OpenClaw is running and reachable */
export async function healthCheck(): Promise<OpenClawStatus> {
  // Fast path: HTTP-ping the gateway health endpoint to detect a running
  // gateway quickly (~100ms vs ~7s for `openclaw status --json`). This
  // only determines *connectivity* — channel/agent/session data still
  // comes from the CLI probe below so that callers like broadcastMessage
  // and getConfiguredAgentRuntimeStatus see the real channel list.
  let httpReachable = false;
  let httpGateway = "";
  try {
    const httpUrl = gatewayBaseUrl().replace(/^ws:/, "http:").replace(/^wss:/, "https:");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      const res = await fetch(`${httpUrl}/health`, { signal: controller.signal });
      if (res.ok) {
        const body = (await res.json()) as { ok?: boolean };
        if (body.ok) {
          httpReachable = true;
          httpGateway = httpUrl;
        }
      }
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // gateway not reachable via HTTP; fall through to CLI probe
  }

  const statusResult = await runOpenClaw(["status", "--json"], { timeoutMs: 12000 });
  if (statusResult.ok) {
    try {
      const data = JSON.parse(statusResult.stdout);
      if (!isRecord(data)) throw new Error("Invalid OpenClaw status response");
      const gatewayRecord = isRecord(data.gateway) ? data.gateway : null;
      const gatewayReachable = gatewayRecord?.reachable;
      if (gatewayReachable !== false) {
        const gateway = gatewayRecord && typeof gatewayRecord.url === "string"
          ? gatewayRecord.url
          : fallbackGatewayUrl();

        return {
          status: "connected",
          gateway,
          channels: enabledChannels(data),
          agents: agentCount(data),
          sessions: sessionCount(data),
        };
      }
      // The CLI explicitly reported the gateway as unreachable. When the
      // HTTP fast path also failed, trust the CLI and report disconnected.
      // When the HTTP probe succeeded, skip this early return and let the
      // function fall through to the httpReachable branch at the bottom —
      // the gateway IS responding even if the CLI's view is stale.
      if (gatewayReachable === false && !httpReachable) {
        if (await embeddedTurnReady()) {
          return {
            status: "connected",
            gateway: gatewayRecord && typeof gatewayRecord.url === "string"
              ? gatewayRecord.url
              : fallbackGatewayUrl(),
            channels: enabledChannels(data),
            agents: agentCount(data),
            sessions: sessionCount(data),
          };
        }
        return {
          status: "disconnected",
          gateway: "",
          channels: [],
          agents: 0,
          sessions: 0,
        };
      }
    } catch {
      // Parsing failed; fall through to health fallback below.
    }
  }

  // Fallback: try `openclaw health` which actually pings the gateway
  const healthResult = await runOpenClaw(["health"], { timeoutMs: 12000 });
  if (healthResult.ok) {
    const output = stripAnsi(`${healthResult.stdout}\n${healthResult.stderr}`).trim();
    // Only connected on a narrow known-good phrase. Ambiguous fallback output
    // should stay disconnected rather than silently flipping to connected.
    if (/gateway.*reachable/i.test(output) && !/unreachable|not ok|error/i.test(output)) {
      return {
        status: "connected",
        gateway: fallbackGatewayUrl(),
        channels: [],
        agents: 0,
        sessions: 0,
      };
    }
  }

  // If the HTTP health check succeeded earlier but both CLI probes failed
  // (e.g. the gateway is a cross-profile instance the CLI can't see),
  // report connected with the HTTP-derived gateway URL. Channel data is
  // unavailable in this case, but the caller at least sees the correct
  // connection status.
  if (httpReachable) {
    return {
      status: "connected",
      gateway: httpGateway,
      channels: [],
      agents: 0,
      sessions: 0,
    };
  }

  return {
    status: "disconnected",
    gateway: "",
    channels: [],
    agents: 0,
    sessions: 0,
  };
}

/** Send a message through OpenClaw agent and get a response */
export async function sendAgentMessage(
  message: string,
  options?: {
    channel?: string;
    agent?: string;
    session?: string;
    deliver?: boolean;
    cwd?: string;
    timeoutMs?: number;
  }
): Promise<string> {
  const args = ["agent", "-m", message];

  if (options?.agent) args.push("--agent", options.agent);
  if (options?.session) args.push("--session-id", options.session);
  if (options?.channel) args.push("--channel", options.channel);
  if (options?.deliver) args.push("--deliver");
  const result = await runOpenClaw(args, {
    cwd: options?.cwd,
    timeoutMs: options?.timeoutMs ?? 600000,
  });

  if (!result.ok) {
    // Preserve the previous throw-on-error shape so callers relying on
    // rejected promises (e.g. the embedded fallback path in the gateway
    // agent client) still see an Error with the CLI's stderr attached.
    throw new Error(
      result.stderr?.trim() || `openclaw agent failed with code ${result.code ?? "unknown"}`,
    );
  }

  return sanitizeAgentOutput(result.stdout);
}

/** Best-effort session history lookup. Returns an empty list if the CLI cannot provide messages. */
export async function getConversationHistory(
  conversationId: string,
  limit = 20,
): Promise<OpenClawMessage[]> {
  const historyResult = await runOpenClaw(
    ["history", "--conversation", conversationId, "--limit", String(limit), "--json"],
    { timeoutMs: 10000 },
  );
  if (historyResult.ok) {
    try {
      return JSON.parse(historyResult.stdout) as OpenClawMessage[];
    } catch {
      // Fall back to the broader sessions listing for older CLI versions.
    }
  }

  const sessionsResult = await runOpenClaw(["sessions", "--json"], { timeoutMs: 5000 });
  if (!sessionsResult.ok) return [];
  try {
    const sessions = JSON.parse(sessionsResult.stdout);
    const session = Array.isArray(sessions)
      ? sessions.find((entry) =>
          entry?.id === conversationId ||
          entry?.sessionId === conversationId ||
          entry?.conversationId === conversationId,
        )
      : null;
    const messages = Array.isArray(session?.messages) ? session.messages : [];
    return messages.slice(-limit) as OpenClawMessage[];
  } catch {
    return [];
  }
}

export async function getConversationMessagesSince(
  conversationId: string,
  since: string,
  limit = 100,
): Promise<OpenClawMessage[]> {
  const messages = await getConversationHistory(conversationId, limit);
  if (!Array.isArray(messages)) {
    return [];
  }
  const sinceTime = Date.parse(since);
  return messages
    .filter(
      (message) =>
        typeof message.timestamp === "string"
        && !Number.isNaN(Date.parse(message.timestamp))
        && Date.parse(message.timestamp) > sinceTime
        && typeof message.channel === "string"
        && (
          message.channel !== "web"
          || inferMessageRole(message) === "assistant"
          || inferMessageRole(message) === "system"
        ),
    )
    .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
}

/** Deliver a message to a specific channel (Telegram, Slack, etc.) */
export async function deliverToChannel(
  message: string,
  channel: string
): Promise<void> {
  await sendAgentMessage(message, {
    channel,
    deliver: true,
    agent: "main",
    session: "agent:main:main",
  });
}

/** Broadcast a message to all enabled channels */
export async function broadcastMessage(message: string): Promise<void> {
  const status = await healthCheck();
  for (const channel of status.channels) {
    try {
      await deliverToChannel(message, channel);
    } catch (err) {
      console.error(`Failed to deliver to ${channel}:`, err);
    }
  }
}

/**
 * @deprecated Use the async healthCheck() instead. This blocks the event loop
 * and is not safe for API route handlers.
 */
export function isConnected(): boolean {
  // Synchronous check — just verify the binary exists.
  const result = runOpenClawSync(["--version"], { timeoutMs: 2000 });
  return result !== null;
}
