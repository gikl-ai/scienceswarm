/**
 * OpenClaw Integration
 *
 * Prefers the OpenClaw gateway WebSocket for session-scoped web chat turns so
 * dashboard messages do not pay CLI spawn overhead. The CLI remains the
 * compatibility path for health/status probes, explicit channel delivery, and
 * non-web invocation modes that still rely on upstream CLI semantics.
 */

import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { getOpenClawGatewayUrl } from "@/lib/config/ports";
import { getScienceSwarmOpenClawStateDir } from "@/lib/scienceswarm-paths";
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

export interface OpenClawGatewayStatus {
  status: "connected" | "disconnected";
  gateway: string;
}

const OPENCLAW_SESSION_FILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const MAX_PERSISTED_WEB_SESSION_METADATA = 4096;
const persistedWebSessionMetadata = new Set<string>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function fallbackGatewayUrl(): string {
  return gatewayBaseUrl();
}

function normalizeOpenClawSessionFileId(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || !OPENCLAW_SESSION_FILE_ID_PATTERN.test(trimmed)) {
    return null;
  }
  return trimmed;
}

function gatewayHealthUrl(): string {
  return gatewayBaseUrl().replace(/^ws:/, "http:").replace(/^wss:/, "https:");
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

function parseCliJsonObject<T>(stdout: string): T | null {
  const normalized = stripAnsi(stdout).trim();
  if (!normalized) {
    return null;
  }

  const firstObjectIndex = normalized.indexOf("{");
  const candidate =
    firstObjectIndex >= 0 ? normalized.slice(firstObjectIndex) : normalized;
  try {
    return JSON.parse(candidate) as T;
  } catch {
    return null;
  }
}

async function embeddedTurnReady(): Promise<boolean> {
  const result = await runOpenClaw(["models", "status", "--json"], {
    timeoutMs: 12000,
  });
  if (!result.ok) return false;

  const data = parseCliJsonObject<unknown>(result.stdout);
  return isRecord(data) && modelStatusHasEmbeddedTurnPath(data);
}

async function probeGatewayHealth(timeoutMs: number): Promise<{
  reachable: boolean;
  gateway: string;
}> {
  try {
    const httpUrl = gatewayHealthUrl();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${httpUrl}/health`, {
        signal: controller.signal,
      });
      if (!res.ok) {
        return { reachable: false, gateway: "" };
      }
      const body = (await res.json()) as { ok?: boolean };
      return body.ok === true
        ? { reachable: true, gateway: httpUrl }
        : { reachable: false, gateway: "" };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return { reachable: false, gateway: "" };
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

function extractSessionTextPart(part: unknown): string | null {
  if (typeof part === "string") {
    return part.trim().length > 0 ? part : null;
  }
  if (!isRecord(part)) {
    return null;
  }

  const type = part.type;
  if (
    (type === "text" || type === "input_text" || type === "output_text")
    && typeof part.text === "string"
    && part.text.trim().length > 0
  ) {
    return part.text;
  }

  return null;
}

function extractSessionMessageText(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part) => extractSessionTextPart(part))
    .filter((part): part is string => Boolean(part))
    .join("\n\n")
    .trim();
}

async function readConversationHistoryFromSessionFile(
  conversationId: string,
  limit: number,
): Promise<OpenClawMessage[]> {
  const sessionFile = openClawSessionFilePath(conversationId);
  if (!sessionFile) {
    return [];
  }

  let raw: string;
  try {
    raw = await readFile(sessionFile, "utf8");
  } catch {
    return [];
  }

  const messages: OpenClawMessage[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }

    if (!isRecord(parsed) || parsed.type !== "message" || !isRecord(parsed.message)) {
      continue;
    }

    const role = parsed.message.role;
    if (role !== "user" && role !== "assistant" && role !== "system") {
      continue;
    }

    const content = extractSessionMessageText(parsed.message.content);
    if (!content) {
      continue;
    }

    const timestampCandidate =
      typeof parsed.timestamp === "string"
        ? parsed.timestamp
        : typeof parsed.message.timestamp === "string"
          ? parsed.message.timestamp
          : null;
    if (!timestampCandidate || Number.isNaN(Date.parse(timestampCandidate))) {
      continue;
    }

    messages.push({
      id:
        typeof parsed.id === "string"
          ? parsed.id
          : `${conversationId}:${messages.length + 1}`,
      userId:
        role === "assistant"
          ? "assistant"
          : role === "system"
            ? "system"
            : "web-user",
      role,
      channel: "web",
      content,
      timestamp: timestampCandidate,
      conversationId,
    });
  }

  return messages.slice(-limit);
}

function openClawSessionFilePath(conversationId: string): string | null {
  const sessionFileId = normalizeOpenClawSessionFileId(conversationId);
  if (!sessionFileId) {
    return null;
  }

  return path.join(
    getScienceSwarmOpenClawStateDir(),
    "agents",
    "main",
    "sessions",
    `${sessionFileId}.jsonl`,
  );
}

function shouldUseGatewayForWebSession(options?: {
  channel?: string;
  session?: string;
  deliver?: boolean;
  cwd?: string;
  timeoutMs?: number;
  onEvent?: (event: unknown) => void;
}): options is {
  channel: "web";
  session: string;
  deliver?: boolean;
  cwd?: string;
  timeoutMs?: number;
  onEvent?: (event: unknown) => void;
} {
  return Boolean(
    options?.session &&
    options.channel === "web" &&
    !options.deliver,
  );
}

function shouldUseGatewayTransport(options?: {
  channel?: string;
  session?: string;
  deliver?: boolean;
  cwd?: string;
}): boolean {
  return Boolean(
    shouldUseGatewayForWebSession(options) ||
    (
      options?.session &&
      !options.channel &&
      !options.deliver &&
      !options.cwd
    ),
  );
}

async function persistWebSessionMetadata(
  session: string,
  cwd?: string,
): Promise<void> {
  if (!cwd) {
    return;
  }

  const cacheKey = `${session}:${cwd}`;
  if (persistedWebSessionMetadata.has(cacheKey)) {
    return;
  }

  const sessionFile = openClawSessionFilePath(session);
  if (!sessionFile) {
    return;
  }

  if (persistedWebSessionMetadata.size >= MAX_PERSISTED_WEB_SESSION_METADATA) {
    persistedWebSessionMetadata.clear();
  }

  persistedWebSessionMetadata.add(cacheKey);
  try {
    await mkdir(path.dirname(sessionFile), { recursive: true });
    await writeFile(
      sessionFile,
      `${JSON.stringify({ type: "session", id: session, cwd })}\n`,
      { flag: "a" },
    );
  } catch {
    persistedWebSessionMetadata.delete(cacheKey);
    // Best-effort only. The gateway may still maintain the canonical session
    // file; skipping this metadata should not break the turn itself.
  }
}

/** Check if OpenClaw is running and reachable */
export async function healthCheck(): Promise<OpenClawStatus> {
  // Fast path: HTTP-ping the gateway health endpoint to detect a running
  // gateway quickly (~100ms vs ~7s for `openclaw status --json`). This
  // only determines *connectivity* — channel/agent/session data still
  // comes from the CLI probe below so that callers like broadcastMessage
  // and getConfiguredAgentRuntimeStatus see the real channel list.
  const { reachable: httpReachable, gateway: httpGateway } =
    await probeGatewayHealth(3000);

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

  if (await embeddedTurnReady()) {
    return {
      status: "connected",
      gateway: fallbackGatewayUrl(),
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

/**
 * Lightweight gateway-only readiness probe for hot chat-turn paths.
 *
 * Unlike `healthCheck()`, this avoids the expensive CLI status scan and only
 * verifies that the web gateway required for session-scoped dashboard chat is
 * responding. Use this when the caller only needs to know whether a web turn
 * can be attempted right now; inventory fields like `channels` still require
 * the full `healthCheck()` path.
 */
export async function gatewayHealthCheck(): Promise<OpenClawGatewayStatus> {
  const { reachable, gateway } = await probeGatewayHealth(1500);
  if (!reachable) {
    return {
      status: "disconnected",
      gateway: "",
    };
  }

  return {
    status: "connected",
    gateway,
  };
}

/**
 * Send a message through OpenClaw agent and get a response.
 *
 * Prefers the WebSocket gateway transport for session-scoped in-process turns.
 * Dashboard web chat (`channel: "web"`) is WS-only and does NOT fall back to
 * the CLI on gateway failure. Explicit channel delivery and non-web
 * compatibility paths still use the CLI.
 */
export async function sendAgentMessage(
  message: string,
  options?: {
    channel?: string;
    agent?: string;
    session?: string;
    deliver?: boolean;
    cwd?: string;
    timeoutMs?: number;
    /**
     * Called for every non-infra event observed during a WS turn. Ignored
     * when the call falls back to the CLI transport (the CLI is batch).
     */
    onEvent?: (event: unknown) => void;
  }
): Promise<string> {
  const useGatewayTransport = shouldUseGatewayTransport(options);
  const useGatewayWebSession = shouldUseGatewayForWebSession(options);

  if (useGatewayTransport && options?.session) {
    try {
      if (useGatewayWebSession) {
        await persistWebSessionMetadata(options.session, options.cwd);
      }
      const { sendMessageViaGateway } = await import(
        "@/lib/openclaw/gateway-ws-client"
      );
      const result = await sendMessageViaGateway(options.session, message, {
        timeoutMs: options.timeoutMs ?? 600_000,
        onEvent: options.onEvent,
      });
      return result.text;
    } catch (err) {
      // Distinguish two failure regimes from the gateway:
      //
      //   (a) Pre-ACK failure (connect/auth/send-rpc never landed): safe to
      //       retry on the same session via the CLI — the gateway never had
      //       the message. Fall through to the CLI path below.
      //
      //   (b) Post-ACK failure (turn timeout, WS drop after sessions.send
      //       succeeded): the gateway already has the message and may be
      //       dispatching it. Re-running the CLI with the SAME --session-id
      //       would deliver the user message twice and trigger duplicate
      //       tool executions. Surface the error to the caller instead.
      const { isGatewayPostAckError } = await import(
        "@/lib/openclaw/gateway-ws-client"
      );
      if (useGatewayWebSession || isGatewayPostAckError(err)) {
        throw err;
      }
      // Pre-ACK gateway failure (no token, gateway not running, auth failed,
      // pre-send transport error, etc.) — fall through to the CLI path only
      // for the legacy non-web compatibility mode.
    }
  }

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
  const sessionMessages = await readConversationHistoryFromSessionFile(
    conversationId,
    limit,
  );
  if (sessionMessages.length > 0) {
    return sessionMessages;
  }

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
