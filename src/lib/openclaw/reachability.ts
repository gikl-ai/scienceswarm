import { getOpenClawGatewayUrl, getOpenClawPort } from "@/lib/config/ports";

function normalizeGatewayHostname(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

export function isLocalOpenClawGatewayUrl(): boolean {
  try {
    const parsed = new URL(getOpenClawGatewayUrl());
    const hostname = normalizeGatewayHostname(parsed.hostname).toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return !process.env.OPENCLAW_URL?.trim();
  }
}

export function resolveOpenClawHealthUrl(): string {
  try {
    const parsed = new URL(getOpenClawGatewayUrl());
    if (parsed.protocol === "ws:") {
      parsed.protocol = "http:";
    } else if (parsed.protocol === "wss:") {
      parsed.protocol = "https:";
    }
    parsed.pathname = parsed.pathname.replace(/\/ws\/?$/, "/health");
    return parsed.toString();
  } catch {
    return `http://127.0.0.1:${getOpenClawPort()}/health`;
  }
}

export async function isOpenClawGatewayReachable(timeoutMs = 3_000): Promise<boolean> {
  try {
    const response = await fetch(resolveOpenClawHealthUrl(), {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      return false;
    }

    const payload = await response.json().catch(() => null) as
      | { ok?: unknown; status?: unknown }
      | null;
    return (
      payload?.ok === true
      || payload?.status === "live"
      || payload?.status === "connected"
      || payload?.status === "ok"
    );
  } catch {
    return false;
  }
}
