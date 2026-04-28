"use client";

/**
 * useAutoRemediation — self-healing hook for ScienceSwarm infrastructure.
 *
 * Runs once per mount on the project page. Checks service health via
 * `/api/health` and automatically attempts to bring missing services
 * online:
 *
 *   1. OpenClaw installed but not running -> POST /api/settings/openclaw action:"start"
 *   2. Ollama not running -> POST /api/settings action:"start-ollama"
 *   3. Configured Gemma model not pulled -> POST /api/settings action:"pull-model"
 *
 * Each remediation attempt fires at most once per mount (tracked via
 * refs). Status updates are pushed into chat as system messages via
 * the provided `pushSystemMessage` callback.
 *
 * Constraints:
 *   - Does NOT run during the /setup flow — only on the project page.
 *   - OpenClaw binary calls go through the API route which uses runner.ts.
 *   - Local LLM defaults to gemma4:e4b unless explicitly configured.
 */

import { useEffect, useRef, useCallback } from "react";
import { OLLAMA_RECOMMENDED_MODEL } from "@/lib/ollama-constants";

interface HealthPayload {
  openclaw?: "connected" | "disconnected";
  nanoclaw?: "connected" | "disconnected";
  ollama?: "connected" | "disconnected";
  ollamaModels?: string[];
  configuredLocalModel?: string;
  llmProvider?: "openai" | "local";
  agent?: { type: string; status: "connected" | "disconnected" };
}

export interface AutoRemediationMessage {
  id: string;
  role: "system";
  content: string;
  timestamp: Date;
}

type PushMessage = (msg: AutoRemediationMessage) => void;

/** Tracks which remediation steps have been attempted this mount. */
interface RemediationState {
  openclawStartAttempted: boolean;
  ollamaStartAttempted: boolean;
  ollamaPullAttempted: boolean;
}

function makeId(prefix: string): string {
  return `auto-remediate-${prefix}-${Date.now()}`;
}

function sysMsg(prefix: string, content: string): AutoRemediationMessage {
  return {
    id: makeId(prefix),
    role: "system",
    content,
    timestamp: new Date(),
  };
}

async function tryStartOpenClaw(): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch("/api/settings/openclaw", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "start" }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string };
      return { ok: false, error: body.error || `HTTP ${res.status}` };
    }
    const body = await res.json() as { ok?: boolean; running?: boolean };
    return { ok: body.running !== false };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error" };
  }
}

async function tryStartOllama(): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "start-ollama" }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string };
      return { ok: false, error: body.error || `HTTP ${res.status}` };
    }
    const body = await res.json().catch(() => ({})) as { ok?: boolean; error?: string };
    if (body.ok === false) {
      return { ok: false, error: body.error || "Ollama start reported failure" };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error" };
  }
}

async function tryPullModel(model: string): Promise<{ ok: boolean; alreadyPresent?: boolean; error?: string }> {
  try {
    const res = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "pull-model", ollamaModel: model }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string };
      return { ok: false, error: body.error || `HTTP ${res.status}` };
    }
    const body = await res.json() as { ok?: boolean; alreadyPresent?: boolean };
    return { ok: body.ok !== false, alreadyPresent: body.alreadyPresent };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error" };
  }
}

/**
 * Wait for a condition by polling the health endpoint.
 * Returns true if the condition was met, false on timeout or abort.
 */
async function waitForCondition(
  check: (h: HealthPayload) => boolean,
  timeoutMs: number,
  intervalMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) return false;
    await new Promise((r) => setTimeout(r, intervalMs));
    if (signal?.aborted) return false;
    try {
      const res = await fetch("/api/health", { signal });
      if (res.ok) {
        const h = await res.json() as HealthPayload;
        if (check(h)) return true;
      }
    } catch {
      // transient error or abort, keep polling (abort checked at loop top)
    }
  }
  return false;
}

export function useAutoRemediation(pushSystemMessage: PushMessage): void {
  const stateRef = useRef<RemediationState>({
    openclawStartAttempted: false,
    ollamaStartAttempted: false,
    ollamaPullAttempted: false,
  });
  const runningRef = useRef(false);

  const run = useCallback(async (signal: AbortSignal) => {
    if (runningRef.current) return;
    runningRef.current = true;

    try {
      // 1. Fetch current health
      const res = await fetch("/api/health", { signal });
      if (!res.ok) return;
      const health = await res.json() as HealthPayload;

      const state = stateRef.current;
      if (signal.aborted) return;

      // 2. Auto-start OpenClaw if it is the configured agent but not running
      const localChatSelected = health.llmProvider === "local";
      const openclawConfigured = health.agent?.type === "openclaw";
      const openclawDisconnected =
        openclawConfigured &&
        health.openclaw === "disconnected" &&
        health.nanoclaw === "disconnected" &&
        health.agent?.status !== "connected";

      if (openclawDisconnected && !localChatSelected && !state.openclawStartAttempted) {
        state.openclawStartAttempted = true;
        pushSystemMessage(sysMsg("openclaw-starting", "Starting OpenClaw..."));

        const result = await tryStartOpenClaw();
        if (signal.aborted) return;
        if (result.ok) {
          // Wait up to 10s for OpenClaw to come online
          const up = await waitForCondition(
            (h) => h.openclaw === "connected" || h.agent?.status === "connected",
            10_000,
            2_000,
            signal,
          );
          if (signal.aborted) return;
          if (up) {
            pushSystemMessage(sysMsg("openclaw-ready", "OpenClaw is running."));
          } else {
            pushSystemMessage(sysMsg("openclaw-slow", "OpenClaw is starting up. It may take a moment to become fully available."));
          }
        } else {
          // Only show error if start was actually attempted and failed
          // (e.g. not installed at all is a different situation)
          const isNotInstalled = result.error?.toLowerCase().includes("not installed");
          if (!isNotInstalled) {
            pushSystemMessage(
              sysMsg("openclaw-failed", `Could not auto-start OpenClaw: ${result.error ?? "unknown error"}. You can start it manually in Settings.`),
            );
          }
        }
      }

      if (signal.aborted) return;

      // 3. Auto-start Ollama if needed (only when local provider is selected)
      const ollamaNeeded = health.llmProvider === "local";
      const ollamaDown = health.ollama === "disconnected";

      if (ollamaNeeded && ollamaDown && !state.ollamaStartAttempted) {
        state.ollamaStartAttempted = true;
        pushSystemMessage(sysMsg("ollama-starting", "Starting Ollama..."));

        const result = await tryStartOllama();
        if (signal.aborted) return;
        if (result.ok) {
          const up = await waitForCondition(
            (h) => h.ollama === "connected",
            15_000,
            2_000,
            signal,
          );
          if (signal.aborted) return;
          if (up) {
            pushSystemMessage(sysMsg("ollama-ready", "Ollama is running."));
          } else {
            pushSystemMessage(sysMsg("ollama-slow", "Ollama is starting up. It may take a moment to become ready."));
          }
        } else {
          pushSystemMessage(
            sysMsg("ollama-failed", `Could not auto-start Ollama: ${result.error ?? "unknown error"}. You can start it manually in Settings.`),
          );
        }
      }

      if (signal.aborted) return;

      // 4. Re-check health after potential Ollama start to see if model pull is needed
      let latestHealth = health;
      if (state.ollamaStartAttempted && !state.ollamaPullAttempted) {
        try {
          const refreshRes = await fetch("/api/health", { signal });
          if (refreshRes.ok) {
            latestHealth = await refreshRes.json() as HealthPayload;
          }
        } catch {
          // use original health
        }
      }

      if (signal.aborted) return;

      // 5. Auto-pull model if Ollama is running but model is missing
      const ollamaRunning = latestHealth.ollama === "connected";
      const model = latestHealth.configuredLocalModel || OLLAMA_RECOMMENDED_MODEL;
      const modelPresent = (latestHealth.ollamaModels ?? []).some(
        (m) => m === model || m.startsWith(`${model}:`),
      );

      if (ollamaNeeded && ollamaRunning && !modelPresent && !state.ollamaPullAttempted) {
        state.ollamaPullAttempted = true;
        if (signal.aborted) return;
        pushSystemMessage(
          sysMsg("model-pulling", `Downloading ${model}... This may take several minutes for the first download.`),
        );

        const result = await tryPullModel(model);
        if (signal.aborted) return;
        if (result.ok) {
          if (result.alreadyPresent) {
            pushSystemMessage(sysMsg("model-ready", `${model} is ready.`));
          } else {
            pushSystemMessage(
              sysMsg("model-downloading", `${model} download started. It will be available once the download completes.`),
            );
          }
        } else {
          pushSystemMessage(
            sysMsg("model-failed", `Could not download ${model}: ${result.error ?? "unknown error"}. You can pull it manually in Settings.`),
          );
        }
      }
    } catch {
      // Top-level catch: don't crash the page if remediation fails
      // (includes AbortError from signal cancellation)
    } finally {
      runningRef.current = false;
    }
  }, [pushSystemMessage]);

  useEffect(() => {
    const controller = new AbortController();
    void run(controller.signal);
    return () => { controller.abort(); };
  }, [run]);
}
