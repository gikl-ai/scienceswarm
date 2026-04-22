/**
 * OpenClaw Gateway WebSocket Client
 *
 * Singleton WebSocket client that communicates with the OpenClaw gateway using
 * the v3 auth protocol (Ed25519 device identity + connect.challenge).
 *
 * This module does NOT shell out to the `openclaw` binary — it speaks the
 * gateway WebSocket protocol directly. It lives under `src/lib/openclaw/`
 * because it is part of the OpenClaw integration surface and needs access to
 * the ScienceSwarm state dir for reading `openclaw.json` (gateway token) and
 * persisting the device identity.
 *
 * Exports:
 *   - sendMessageViaGateway(sessionKey, message, options?) → Promise<SendMessageResult>
 *   - isGatewayConnected() → boolean
 *   - closeGatewayConnection() → void
 *
 * Security:
 *   - Auth tokens are read from the local OpenClaw config file (mode 0600 by
 *     OpenClaw) and never logged.
 *   - The WS connection is opened with an `Origin` header that matches the
 *     gateway's localhost listener (auto-pairing only succeeds for localhost).
 *   - Event listeners are scoped to the session key they registered for so
 *     concurrent `sendMessageViaGateway` calls cannot observe each other's
 *     turns.
 *   - `console.log` of inbound frames is gated behind `DEBUG_GATEWAY_WS`.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import WebSocket from "ws";

import { getOpenClawGatewayUrl, getOpenClawPort } from "@/lib/config/ports";
import {
  getScienceSwarmOpenClawStateDir,
  getScienceSwarmOpenClawConfigPath,
} from "@/lib/scienceswarm-paths";
import { resolveOpenClawMode } from "@/lib/openclaw/runner";

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Thrown when a turn fails AFTER the gateway has already accepted the message
 * (`sessions.send` ACKed). Examples: turn timeout, WebSocket drop while the
 * agent is still processing, listener reject after-the-fact.
 *
 * The defining property: the gateway has the message and may already be
 * dispatching it to the agent. Callers MUST NOT retry the same message on the
 * same session via a different transport, or the agent will see the user
 * message twice (with potential duplicate tool executions).
 */
export class GatewayPostAckError extends Error {
  readonly code = "GATEWAY_POST_ACK_FAILURE" as const;
  readonly sessionKey: string;
  constructor(sessionKey: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "GatewayPostAckError";
    this.sessionKey = sessionKey;
  }
}

/**
 * Returns true if `err` is a post-ACK failure where the gateway already
 * received the message. See {@link GatewayPostAckError} for why this matters.
 */
export function isGatewayPostAckError(err: unknown): err is GatewayPostAckError {
  return err instanceof GatewayPostAckError;
}

export interface SendMessageResult {
  /** Final assistant response text (empty string if no text response received). */
  text: string;
  /** All non-infra events received during the turn. */
  events: GatewayEvent[];
}

export interface SendMessageOptions {
  /** Timeout in ms for the entire turn (connect + send + wait for response). Default: 600_000 (10 min). */
  timeoutMs?: number;
  /** Called for every non-infra event received during the turn. */
  onEvent?: (event: GatewayEvent) => void;
}

export interface GatewayEvent {
  type: string;
  method?: string;
  payload?: unknown;
  raw: unknown;
}

interface DeviceIdentity {
  publicKey: string; // base64url raw 32-byte Ed25519 public key
  privateKey: string; // base64url PKCS8 DER private key
  deviceId: string; // SHA-256 hex of raw 32-byte public key
  deviceToken?: string; // returned by gateway after first auth
}

interface ConnectChallengePayload {
  nonce: string;
}

interface GatewayFrame {
  type: string;
  id?: string;
  method?: string;
  event?: string;
  ok?: boolean;
  payload?: Record<string, unknown>;
  params?: Record<string, unknown>;
  error?: unknown;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const CLIENT_ID = "openclaw-control-ui";
const CLIENT_MODE = "webchat";
const CLIENT_VERSION = "0.1.0";
const ROLE = "operator";
const SCOPES = [
  "operator.admin",
  "operator.read",
  "operator.write",
  "operator.approvals",
  "operator.pairing",
];
const PROTOCOL_VERSION = 3;

/** Events to filter out — infra/keepalive traffic that callers do not need. */
const INFRA_EVENTS = new Set([
  "tick",
  "health",
  "heartbeat",
  "presence",
  "connect.challenge",
  "connect.ack",
  "pong",
]);

/** Methods that signal the agent turn is complete. */
const TURN_COMPLETE_SIGNALS = new Set([
  "sessions.turn.complete",
  "sessions.done",
  "turn.complete",
  "done",
]);

function debugLog(message: string, ...args: unknown[]): void {
  if (process.env.DEBUG_GATEWAY_WS) {
    // Intentionally use console.log here only when explicitly opted in.
    console.log(`[gateway-ws] ${message}`, ...args);
  }
}

// ─── Device Identity Persistence ─────────────────────────────────────────────

function getDeviceIdentityPath(): string {
  return path.join(getScienceSwarmOpenClawStateDir(), "ws-device.json");
}

function loadDeviceIdentity(): DeviceIdentity | null {
  const identityPath = getDeviceIdentityPath();
  try {
    const raw = fs.readFileSync(identityPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<DeviceIdentity>;
    if (parsed.publicKey && parsed.privateKey && parsed.deviceId) {
      return parsed as DeviceIdentity;
    }
    return null;
  } catch {
    return null;
  }
}

function generateDeviceIdentity(): DeviceIdentity {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");

  // Extract raw 32-byte public key from SPKI DER
  const spki = publicKey.export({ type: "spki", format: "der" });
  const rawKey = spki.subarray(spki.length - 32);

  // Device ID = SHA-256(raw 32-byte public key).hex
  const deviceId = crypto.createHash("sha256").update(rawKey).digest("hex");
  const rawPubKey = rawKey.toString("base64url");

  // Export private key as PKCS8 DER for persistence
  const pkcs8 = privateKey.export({ type: "pkcs8", format: "der" });

  return {
    publicKey: rawPubKey,
    privateKey: pkcs8.toString("base64url"),
    deviceId,
  };
}

function saveDeviceIdentity(identity: DeviceIdentity): void {
  const identityPath = getDeviceIdentityPath();
  fs.mkdirSync(path.dirname(identityPath), { recursive: true });
  fs.writeFileSync(identityPath, JSON.stringify(identity, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
}

function getOrCreateDeviceIdentity(): DeviceIdentity {
  const existing = loadDeviceIdentity();
  if (existing) return existing;

  const identity = generateDeviceIdentity();
  saveDeviceIdentity(identity);
  return identity;
}

function importPrivateKey(base64urlPkcs8: string): crypto.KeyObject {
  const der = Buffer.from(base64urlPkcs8, "base64url");
  return crypto.createPrivateKey({ key: der, format: "der", type: "pkcs8" });
}

// ─── Gateway Token ───────────────────────────────────────────────────────────

function readGatewayToken(): string {
  // The gateway token lives in the openclaw.json config under
  // gateway.auth.token. We check both profile-mode and state-dir-mode paths.
  const mode = resolveOpenClawMode();
  let configPath: string;

  if (mode.kind === "state-dir") {
    configPath = mode.configPath;
  } else {
    // Profile mode: upstream OpenClaw stores config at ~/.openclaw/openclaw.json
    configPath = path.join(
      process.env.HOME ?? os.homedir(),
      ".openclaw",
      "openclaw.json",
    );
  }

  // Also check the default ~/.openclaw/openclaw.json since the state-dir mode
  // agent uses the default profile for gateway auth (see sendAgentMessage in
  // src/lib/openclaw.ts which clears OPENCLAW_STATE_DIR for agent commands).
  const paths = [configPath, getScienceSwarmOpenClawConfigPath()];
  if (mode.kind === "state-dir") {
    const defaultPath = path.join(
      process.env.HOME ?? os.homedir(),
      ".openclaw",
      "openclaw.json",
    );
    if (!paths.includes(defaultPath)) paths.push(defaultPath);
  }

  for (const p of paths) {
    try {
      const raw = fs.readFileSync(p, "utf8");
      const config = JSON.parse(raw) as {
        gateway?: { auth?: { token?: string } };
      };
      const token = config?.gateway?.auth?.token;
      if (token && token.trim().length > 0) return token.trim();
    } catch {
      // Try next path
    }
  }

  throw new Error(
    "Cannot read OpenClaw gateway token. Ensure the gateway is installed and " +
      "openclaw.json contains gateway.auth.token. " +
      `Searched: ${paths.join(", ")}`,
  );
}

// ─── WebSocket Singleton ─────────────────────────────────────────────────────

let _ws: WebSocket | null = null;
let _authenticated = false;
let _connectPromise: Promise<void> | null = null;
const _pendingRequests = new Map<
  string,
  {
    resolve: (value: GatewayFrame) => void;
    reject: (err: Error) => void;
  }
>();
let _eventListeners: Array<{
  sessionKey: string;
  handler: (event: GatewayFrame) => void;
  reject: (err: Error) => void;
}> = [];
let _requestIdCounter = 0;

function nextRequestId(): string {
  _requestIdCounter += 1;
  return `sw-${_requestIdCounter}-${Date.now().toString(36)}`;
}

function getGatewayWsUrl(): string {
  return getOpenClawGatewayUrl();
}

function getGatewayOrigin(): string {
  // Auto-pairing only accepts localhost origins. Use 127.0.0.1 explicitly so
  // we don't rely on /etc/hosts resolution of "localhost".
  return `http://127.0.0.1:${getOpenClawPort()}`;
}

/**
 * Ensure the singleton WebSocket is connected and authenticated.
 * Returns immediately if already connected.
 */
async function ensureConnected(): Promise<void> {
  if (_ws && _ws.readyState === WebSocket.OPEN && _authenticated) {
    return;
  }

  // If a connection attempt is already in progress, await it.
  if (_connectPromise) {
    return _connectPromise;
  }

  _connectPromise = connectAndAuth();
  try {
    await _connectPromise;
  } finally {
    _connectPromise = null;
  }
}

async function connectAndAuth(): Promise<void> {
  // Clean up any stale connection
  if (_ws) {
    try {
      _ws.terminate();
    } catch {
      // ignore
    }
    _ws = null;
  }
  _authenticated = false;

  const wsUrl = getGatewayWsUrl();
  const origin = getGatewayOrigin();
  const identity = getOrCreateDeviceIdentity();
  const token = readGatewayToken();

  return new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { origin });
    let challengeTimeout: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (challengeTimeout) {
        clearTimeout(challengeTimeout);
        challengeTimeout = null;
      }
    };

    ws.on("error", (err) => {
      cleanup();
      _ws = null;
      _authenticated = false;
      reject(
        new Error(
          `OpenClaw gateway WebSocket connection failed: ${err.message}. ` +
            `URL: ${wsUrl}. Ensure the gateway is running.`,
        ),
      );
    });

    ws.on("close", () => {
      cleanup();
      _ws = null;
      _authenticated = false;
      // Reject any pending requests
      for (const [, { reject: rej }] of _pendingRequests) {
        rej(new Error("WebSocket connection closed"));
      }
      _pendingRequests.clear();
      const staleListeners = _eventListeners;
      _eventListeners = [];
      for (const entry of staleListeners) {
        entry.reject(new Error("WebSocket connection closed"));
      }
    });

    ws.on("open", () => {
      _ws = ws;
      // Wait for connect.challenge
      challengeTimeout = setTimeout(() => {
        ws.terminate();
        reject(
          new Error(
            "OpenClaw gateway did not send connect.challenge within 10 seconds",
          ),
        );
      }, 10_000);
    });

    ws.on("message", (data) => {
      let frame: GatewayFrame;
      try {
        frame = JSON.parse(data.toString()) as GatewayFrame;
      } catch {
        return; // skip non-JSON messages
      }

      // Handle connect.challenge during auth handshake
      if (
        !_authenticated &&
        (frame.type === "event" || frame.type === "push") &&
        (frame.event === "connect.challenge" ||
          frame.method === "connect.challenge")
      ) {
        cleanup();
        const challengePayload = frame.payload as
          | ConnectChallengePayload
          | undefined;
        const nonce = challengePayload?.nonce;
        if (!nonce) {
          ws.terminate();
          reject(new Error("connect.challenge missing nonce"));
          return;
        }

        // Build and send connect frame
        const connectId = nextRequestId();
        const signedAt = Date.now();
        const privateKey = importPrivateKey(identity.privateKey);
        const v3payload = [
          "v3",
          identity.deviceId,
          CLIENT_ID,
          CLIENT_MODE,
          ROLE,
          SCOPES.join(","),
          String(signedAt),
          token,
          nonce,
          process.platform,
          "",
        ].join("|");
        const signature = crypto
          .sign(null, Buffer.from(v3payload, "utf8"), privateKey)
          .toString("base64url");

        const connectFrame = {
          type: "req",
          id: connectId,
          method: "connect",
          params: {
            minProtocol: PROTOCOL_VERSION,
            maxProtocol: PROTOCOL_VERSION,
            client: {
              id: CLIENT_ID,
              mode: CLIENT_MODE,
              version: CLIENT_VERSION,
              platform: process.platform,
            },
            auth: { token },
            device: {
              id: identity.deviceId,
              publicKey: identity.publicKey,
              signature,
              signedAt,
              nonce,
            },
            role: ROLE,
            scopes: SCOPES,
            caps: ["tool-events"],
          },
        };

        // Register pending request for connect response
        _pendingRequests.set(connectId, {
          resolve: (response: GatewayFrame) => {
            if (response.ok) {
              _authenticated = true;
              // Save deviceToken if returned
              const authPayload = response.payload?.auth as
                | { deviceToken?: string }
                | undefined;
              if (authPayload?.deviceToken) {
                identity.deviceToken = authPayload.deviceToken;
                saveDeviceIdentity(identity);
              }
              resolve();
            } else {
              ws.terminate();
              // Do NOT include the auth token in the error message — only
              // surface the gateway's diagnostic payload.
              reject(
                new Error(
                  `OpenClaw gateway auth failed: ${JSON.stringify(response.error ?? response.payload)}`,
                ),
              );
            }
          },
          reject: (err: Error) => {
            ws.terminate();
            reject(err);
          },
        });

        ws.send(JSON.stringify(connectFrame));
        return;
      }

      // Handle responses to pending requests
      if (frame.type === "res" && frame.id) {
        const pending = _pendingRequests.get(frame.id);
        if (pending) {
          _pendingRequests.delete(frame.id);
          if (frame.ok === false) {
            pending.reject(
              new Error(
                `Gateway request failed: ${JSON.stringify(frame.error ?? frame.payload)}`,
              ),
            );
          } else {
            pending.resolve(frame);
          }
          return;
        }
      }

      // Forward events to listeners (for session events during active turns).
      // Listeners are session-scoped so concurrent turns cannot see each
      // other's events.
      if (frame.type === "event" || frame.type === "push") {
        const frameSessionKey =
          (frame.params?.key as string | undefined) ??
          (frame.payload?.key as string | undefined) ??
          (frame.payload?.session_key as string | undefined) ??
          "";
        for (const entry of _eventListeners) {
          // Deliver to the matching session listener, or to all if the
          // gateway didn't tag the frame with a session key.
          if (!frameSessionKey || entry.sessionKey === frameSessionKey) {
            try {
              entry.handler(frame);
            } catch {
              // Don't let a bad listener break the connection
            }
          }
        }
      }
    });
  });
}

/**
 * Send a request frame and await the response.
 */
async function sendRequest(
  method: string,
  params: Record<string, unknown>,
  timeoutMs = 30_000,
): Promise<GatewayFrame> {
  await ensureConnected();

  if (!_ws || _ws.readyState !== WebSocket.OPEN) {
    throw new Error("WebSocket not connected after ensureConnected()");
  }

  const id = nextRequestId();
  const frame = { type: "req", id, method, params };

  return new Promise<GatewayFrame>((resolve, reject) => {
    const timeout = setTimeout(() => {
      _pendingRequests.delete(id);
      reject(
        new Error(`Gateway request ${method} timed out after ${timeoutMs}ms`),
      );
    }, timeoutMs);

    _pendingRequests.set(id, {
      resolve: (response) => {
        clearTimeout(timeout);
        resolve(response);
      },
      reject: (err) => {
        clearTimeout(timeout);
        reject(err);
      },
    });

    _ws!.send(JSON.stringify(frame));
  });
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Send a message to an OpenClaw session via the gateway WebSocket and wait
 * for the agent turn to complete. Returns the final response text and all
 * events received during the turn.
 *
 * Flow:
 *   1. Connect + auth (reuses singleton)
 *   2. sessions.create (ignore "already exists" error)
 *   3. sessions.messages.subscribe (receive events for this session)
 *   4. sessions.send (non-blocking send)
 *   5. Listen for turn-complete signals
 */
export async function sendMessageViaGateway(
  sessionKey: string,
  message: string,
  options?: SendMessageOptions,
): Promise<SendMessageResult> {
  const timeoutMs = options?.timeoutMs ?? 600_000;
  const onEvent = options?.onEvent;
  const events: GatewayEvent[] = [];
  let responseText = "";
  let turnComplete = false;

  // Ensure connected
  await ensureConnected();

  // 1. Create session (ignore "already exists")
  try {
    await sendRequest("sessions.create", { key: sessionKey }, 15_000);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Ignore "already exists" errors — session may already be active
    if (
      !msg.includes("already exists") &&
      !msg.includes("already_exists") &&
      !msg.includes("duplicate") &&
      !msg.includes("conflict")
    ) {
      throw err;
    }
  }

  // 2. Subscribe to session events
  try {
    await sendRequest(
      "sessions.messages.subscribe",
      { key: sessionKey },
      10_000,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Some gateway versions auto-subscribe on create; ignore subscribe errors
    if (
      !msg.includes("already subscribed") &&
      !msg.includes("already_subscribed")
    ) {
      // Surface but don't fail — the turn may still work
      debugLog("sessions.messages.subscribe warning:", msg);
    }
  }

  // 3. Set up event listener for this turn.
  // Hoist cleanup outside the Promise executor so it can be called if
  // sessions.send fails — prevents leaked listeners and timeouts.
  let turnTimeoutId: ReturnType<typeof setTimeout> | null = null;
  let listenerEntry: {
    sessionKey: string;
    handler: (event: GatewayFrame) => void;
    reject: (err: Error) => void;
  } | null = null;

  const cleanupListener = () => {
    if (turnTimeoutId !== null) {
      clearTimeout(turnTimeoutId);
      turnTimeoutId = null;
    }
    if (listenerEntry) {
      const idx = _eventListeners.indexOf(listenerEntry);
      if (idx !== -1) _eventListeners.splice(idx, 1);
      listenerEntry = null;
    }
  };

  const turnPromise = new Promise<void>((resolve, reject) => {
    turnTimeoutId = setTimeout(() => {
      cleanupListener();
      reject(
        new Error(
          `OpenClaw agent turn timed out after ${timeoutMs}ms for session "${sessionKey}"`,
        ),
      );
    }, timeoutMs);

    const listener = (frame: GatewayFrame) => {
      if (turnComplete) return;

      const method = frame.event ?? frame.method ?? "";
      const eventType = frame.type;

      // Filter infra events
      if (INFRA_EVENTS.has(method)) return;
      debugLog("event:", method, JSON.stringify(frame).slice(0, 150));

      const event: GatewayEvent = {
        type: eventType,
        method,
        payload: frame.payload,
        raw: frame,
      };

      // Forward to caller
      events.push(event);
      if (onEvent) {
        try {
          onEvent(event);
        } catch {
          // Don't let caller errors break the listener
        }
      }

      // Capture assistant text from streaming events
      if (method === "agent" && frame.payload) {
        const p = frame.payload as {
          stream?: string;
          data?: { text?: string; delta?: string; phase?: string };
        };
        if (p.stream === "assistant" && p.data?.text) {
          responseText = p.data.text;
        }
        if (p.stream === "lifecycle" && p.data?.phase === "end") {
          turnComplete = true;
          cleanupListener();
          resolve();
          return;
        }
      }

      // Capture assistant text from session.message events
      if (method === "session.message" && frame.payload) {
        const p = frame.payload as {
          message?: {
            role?: string;
            content?: Array<{ type?: string; text?: string }>;
          };
        };
        if (
          p.message?.role === "assistant" &&
          Array.isArray(p.message.content)
        ) {
          const textPart = p.message.content.find((c) => c.type === "text");
          if (textPart?.text) responseText = textPart.text;
        }
      }

      // Legacy turn-complete signals
      if (TURN_COMPLETE_SIGNALS.has(method)) {
        turnComplete = true;
        cleanupListener();
        resolve();
        return;
      }

      // Legacy session message events
      if (
        (method === "sessions.message" ||
          method === "sessions.messages.new") &&
        frame.payload
      ) {
        const payload = frame.payload as {
          role?: string;
          text?: string;
          message?: string;
          content?: string;
        };
        if (payload.role === "assistant") {
          const text =
            payload.text ?? payload.message ?? payload.content ?? "";
          if (text) responseText = text;
          turnComplete = true;
          cleanupListener();
          resolve();
          return;
        }
      }
    };

    listenerEntry = {
      sessionKey,
      handler: listener,
      reject: (err: Error) => {
        cleanupListener();
        reject(err);
      },
    };
    _eventListeners.push(listenerEntry);
  });

  // 4. Send the message and wait for turn to complete.
  //
  // Two failure regimes are intentionally distinguished here:
  //
  //   (a) sessions.send itself fails → the gateway never accepted the
  //       message. Safe for the caller to retry on the same session via a
  //       different transport. Surface the raw error.
  //
  //   (b) sessions.send succeeds, then turnPromise fails (timeout, WS drop,
  //       listener reject) → the gateway has the message and may already be
  //       dispatching it. Wrap in GatewayPostAckError so the caller knows
  //       NOT to retry on the same session (would cause duplicate delivery).
  let sendAcked = false;
  try {
    await sendRequest(
      "sessions.send",
      { key: sessionKey, message, timeoutMs },
      30_000,
    );
    sendAcked = true;

    // 5. Wait for turn to complete
    await turnPromise;
  } catch (err) {
    cleanupListener();
    if (sendAcked) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new GatewayPostAckError(
        sessionKey,
        `OpenClaw gateway accepted the message for session "${sessionKey}" but ` +
          `the turn failed before completion: ${detail}`,
        { cause: err },
      );
    }
    throw err;
  }

  return { text: responseText, events };
}

/**
 * Returns true if the singleton WebSocket is connected and authenticated.
 */
export function isGatewayConnected(): boolean {
  return (
    _ws !== null && _ws.readyState === WebSocket.OPEN && _authenticated
  );
}

/**
 * Close the singleton WebSocket connection. Safe to call multiple times.
 */
export function closeGatewayConnection(): void {
  if (_ws) {
    try {
      _ws.close(1000, "client shutdown");
    } catch {
      try {
        _ws.terminate();
      } catch {
        // ignore
      }
    }
    _ws = null;
  }
  _authenticated = false;
  _connectPromise = null;
  for (const [, { reject }] of _pendingRequests) {
    reject(new Error("Connection closed by client"));
  }
  _pendingRequests.clear();
  _eventListeners = [];
}
