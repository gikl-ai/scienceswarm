/**
 * Universal Agent Client
 *
 * HTTP-only client for reaching any claw agent (OpenClaw, NanoClaw, Hermes,
 * future agents) over the network. All backward-compat logic for legacy env
 * vars (OPENCLAW_URL, NANOCLAW_URL, NANOCLAW_PORT) is isolated here.
 *
 * Every agent implements the same contract:
 *   GET  /health  → { status: "connected" | "disconnected" }
 *   POST /message → { response, conversationId? }
 */

import { getNanoClawUrl, getOpenClawGatewayUrl } from "@/lib/config/ports";
import { getCurrentLlmRuntimeEnv } from "@/lib/runtime-saved-env";

// ── Types ───────────────────────────────────────────────────────

export interface AgentConfig {
  type: string;
  url: string;
  apiKey?: string;
}

export interface AgentHealthResult {
  status: "connected" | "disconnected";
}

export interface AgentMessageResult {
  response: string;
  conversationId?: string;
}

// ── Config Resolution ───────────────────────────────────────────

/**
 * Convert a WebSocket URL to HTTP. Handles ws://, wss://, and strips
 * trailing /ws path segments that OpenClaw uses.
 */
function wsToHttp(wsUrl: string): string {
  try {
    const parsed = new URL(wsUrl);
    parsed.protocol = parsed.protocol === "wss:" ? "https:" : "http:";
    // Strip trailing /ws or /ws/ path used by OpenClaw gateway
    parsed.pathname = parsed.pathname.replace(/\/ws\/?$/, "");
    const result = parsed.origin + parsed.pathname;
    // Remove trailing slash for clean URL joining with /health, /message
    return result.endsWith("/") ? result.slice(0, -1) : result;
  } catch {
    // Malformed URL — return as-is, health check will fail gracefully
    return wsUrl.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
  }
}

/**
 * Resolve which agent to use from environment variables.
 *
 * Priority for URL:
 *   1. AGENT_URL (universal)
 *   2. Per-type legacy vars (OPENCLAW_URL, NANOCLAW_URL, NANOCLAW_PORT)
 *
 * Priority for API key:
 *   1. AGENT_API_KEY (universal)
 *   2. OPENCLAW_INTERNAL_API_KEY (legacy, openclaw only)
 *
 * Returns null when AGENT_BACKEND is "none", empty, or missing.
 *
 * Reads the runtime-saved env overlay (same one `isLocalProviderConfigured`
 * uses) so UI-driven changes to AGENT_BACKEND / AGENT_URL / AGENT_API_KEY /
 * OPENCLAW_INTERNAL_API_KEY take effect on the next request without a server
 * restart. Pass an explicit `env` argument in tests or when you already have
 * a materialized env map — when provided, it is used verbatim and the saved
 * .env overlay is NOT consulted (mirrors `isLocalProviderConfigured`).
 */
export function resolveAgentConfig(
  env?: Record<string, string | undefined> | NodeJS.ProcessEnv,
): AgentConfig | null {
  // When an explicit env is provided, read each value from it directly.
  // Otherwise, consult the runtime-saved env overlay so UI edits to .env are
  // picked up on the next request, falling back to process.env when a key is
  // not part of the mutable overlay (OPENCLAW_URL etc. remain process.env-only).
  const overlay = env ? null : getCurrentLlmRuntimeEnv(process.env);
  const source: Record<string, string | undefined> = env ?? process.env;

  const rawBackend = overlay?.agentBackend ?? source.AGENT_BACKEND;
  const type = rawBackend?.trim().toLowerCase();
  if (!type || type === "none") return null;

  // Universal URL takes precedence
  let url = (overlay?.agentUrl ?? source.AGENT_URL)?.trim();

  // Legacy fallbacks per agent type. These read OPENCLAW_URL/OPENCLAW_PORT/
  // NANOCLAW_URL/NANOCLAW_PORT directly from process.env via config/ports.ts
  // — those vars are not part of the mutable runtime overlay and are only
  // relevant for local dev defaults.
  if (!url) {
    switch (type) {
      case "openclaw": {
        url = wsToHttp(getOpenClawGatewayUrl());
        break;
      }
      case "nanoclaw": {
        // Delegate to the central config module so NANOCLAW_URL,
        // NANOCLAW_PORT, and the default port live in exactly one place.
        url = getNanoClawUrl();
        break;
      }
      // Future agents (hermes, etc.) have no legacy vars — AGENT_URL is required
    }
  }

  if (!url) return null;

  // Normalize: strip trailing slash so /health and /message join cleanly
  url = url.replace(/\/+$/, "");

  // Resolve API key
  const agentApiKey = (overlay?.agentApiKey ?? source.AGENT_API_KEY)?.trim();
  const openclawApiKey =
    type === "openclaw"
      ? (overlay?.openclawInternalApiKey ?? source.OPENCLAW_INTERNAL_API_KEY)?.trim()
      : undefined;
  const apiKey = agentApiKey || openclawApiKey || undefined;

  return { type, url, apiKey };
}

// ── HTTP Helpers ────────────────────────────────────────────────

function authHeaders(apiKey?: string): Record<string, string> {
  if (!apiKey) return {};
  return { Authorization: `Bearer ${apiKey}` };
}

async function isOpenClawGatewayAuthReady(cfg: AgentConfig): Promise<boolean> {
  if (cfg.type !== "openclaw" || cfg.apiKey) return true;
  try {
    const { hasOpenClawGatewayAuthToken } = await import(
      "@/lib/openclaw/gateway-auth"
    );
    return hasOpenClawGatewayAuthToken();
  } catch {
    return false;
  }
}

// ── Health Check ────────────────────────────────────────────────

/**
 * Check if the configured agent is reachable.
 * Returns { status: "disconnected" } if no agent is configured.
 */
export async function agentHealthCheck(
  config?: AgentConfig,
): Promise<AgentHealthResult> {
  const cfg = config ?? resolveAgentConfig();
  if (!cfg) return { status: "disconnected" };

  try {
    if (!(await isOpenClawGatewayAuthReady(cfg))) {
      return { status: "disconnected" };
    }

    const res = await fetch(`${cfg.url}/health`, {
      headers: authHeaders(cfg.apiKey),
      signal: AbortSignal.timeout(5_000),
    });

    if (!res.ok) {
      return { status: "disconnected" };
    }

    const data = await res.json();
    // Accept common health payloads across claw gateway versions.
    const status = data?.status;
    if (data?.ok === true || status === "connected" || status === "ok" || status === "live") {
      return { status: "connected" };
    }
    return { status: "disconnected" };
  } catch {
    return { status: "disconnected" };
  }
}

// ── Send Message ────────────────────────────────────────────────

/**
 * Send a message to the configured agent and get a response.
 * Throws if no agent is configured or the agent returns an error.
 */
export async function sendAgentMessage(
  message: string,
  options?: { conversationId?: string },
  config?: AgentConfig,
): Promise<AgentMessageResult> {
  const cfg = config ?? resolveAgentConfig();
  if (!cfg) {
    throw new Error("No agent configured. Set AGENT_BACKEND and AGENT_URL.");
  }

  const res = await fetch(`${cfg.url}/message`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(cfg.apiKey),
    },
    body: JSON.stringify({
      message,
      conversationId: options?.conversationId,
    }),
    signal: AbortSignal.timeout(120_000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(
      `Agent ${cfg.type} error ${res.status}: ${errText || "request failed"}`,
    );
  }

  const data = await res.json();
  return {
    response: data.response ?? "",
    conversationId: data.conversationId ?? data.chatId,
  };
}
