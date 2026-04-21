/**
 * NanoClaw HTTP API client
 * Talks to NanoClaw's HTTP channel on port 3002
 */

import { getNanoClawUrl } from "@/lib/config/ports";

const NANOCLAW_URL = getNanoClawUrl();

export interface NanoClawHealth {
  status: "connected" | "disconnected";
  channel: string;
}

export async function healthCheck(): Promise<NanoClawHealth> {
  try {
    const res = await fetch(`${NANOCLAW_URL}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      return (await res.json()) as NanoClawHealth;
    }
    return { status: "disconnected", channel: "http" };
  } catch {
    return { status: "disconnected", channel: "http" };
  }
}

export async function sendMessage(
  message: string,
  chatId?: string
): Promise<{ response: string; chatId: string }> {
  const res = await fetch(`${NANOCLAW_URL}/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, chatId }),
    signal: AbortSignal.timeout(120_000), // 2 min for agent responses
  });

  if (!res.ok) {
    const err = await res.text().catch(() => "Unknown error");
    throw new Error(`NanoClaw error ${res.status}: ${err}`);
  }

  const data = (await res.json()) as { response: string; chatId: string };
  return { response: data.response, chatId: data.chatId };
}

export { NANOCLAW_URL };
