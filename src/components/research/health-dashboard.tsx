"use client";

import { useState, useEffect, useCallback } from "react";

interface HealthData {
  openclaw: "connected" | "disconnected";
  nanoclaw?: "connected" | "disconnected";
  openhands: "connected" | "disconnected";
  openai: "configured" | "missing";
  llmProvider?: "openai" | "local";
  configuredLocalModel?: string;
  ollamaModels?: string[];
  runtime?: {
    state: "ready" | "attention" | "blocked";
    title: string;
    detail: string;
    nextAction?: string;
  };
  features: {
    chat: boolean;
    codeExecution: boolean;
    github: boolean;
    multiChannel: boolean;
    structuredCritique: boolean;
  };
}

const POLL_INTERVAL_MS = 30_000;

function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span
      className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${
        ok ? "bg-ok" : "bg-danger"
      }`}
    />
  );
}

export function HealthDashboard() {
  const [health, setHealth] = useState<HealthData | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState(false);

  const fetchHealth = useCallback(async () => {
    try {
      const res = await fetch("/api/health");
      if (!res.ok) {
        setError(true);
        return;
      }
      const data = (await res.json()) as HealthData;
      setHealth(data);
      setError(false);
    } catch {
      setError(true);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (!cancelled) await fetchHealth();
    };
    run();
    const id = setInterval(run, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [fetchHealth]);

  // Don't render anything until we have data
  if (!health && !error) return null;

  // If we had a fetch error, show a minimal warning
  if (error && !health) {
    return (
      <div className="px-4 py-2 bg-warn/10 border-b border-warn/30 text-warn text-xs">
        Unable to reach health endpoint.
      </div>
    );
  }

  if (!health) return null;

  const openaiOk = health.openai === "configured";
  const openhandsOk = health.openhands === "connected";
  const openclawOk = health.openclaw === "connected";
  const nanoclawOk = health?.nanoclaw === "connected";
  const agentOk = openclawOk || nanoclawOk;
  const runtime = health.runtime;
  const allGreen = runtime?.state === "ready" || (openaiOk && openhandsOk && agentOk);
  const runtimeTitle = runtime?.title || (allGreen ? "Runtime ready" : "Services need attention");
  const runtimeHint = runtime?.detail
    || (allGreen
      ? "OpenClaw or NanoClaw, OpenHands, and OpenAI are connected."
      : !openaiOk
        ? "Set up the OpenAI API key first."
        : !openhandsOk || !agentOk
          ? "Start the missing backend in Settings."
          : "Check the service details below.");
  const featureList: Array<{ label: string; available: boolean }> = [
    { label: "AI Chat", available: health.features.chat },
    { label: "Code Execution", available: health.features.codeExecution },
    { label: "GitHub Integration", available: health.features.github },
    { label: "Multi-Channel Messaging", available: health.features.multiChannel },
    { label: "Structured Critique", available: health.features.structuredCritique },
  ];

  return (
    <div className="border-b border-warn/30 bg-warn/10 text-xs flex-shrink-0">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-3 px-4 py-2 hover:bg-warn/10 transition-colors text-left"
      >
        <span className={`font-medium ${runtime?.state === "blocked" ? "text-danger" : allGreen ? "text-ok" : "text-warn"}`}>
          {runtimeTitle}
        </span>
        <span className="text-muted truncate">
          {runtimeHint}
        </span>
        <span className="ml-auto text-warn">
          {expanded ? "Hide details" : "Details"}
        </span>
      </button>

      {!expanded && (
        <div className="px-4 pb-2 text-[11px] text-muted flex items-center gap-2">
          {allGreen
            ? "Next step: import a local study or open chat to turn the runtime into study results."
            : runtimeHint}
          {runtime?.nextAction && !allGreen && (
            <span className="inline-flex items-center rounded-full border border-warn/30 bg-raised px-2 py-0.5 text-[10px] font-semibold text-warn">
              {runtime.nextAction}
            </span>
          )}
        </div>
      )}

      {expanded && (
        <div className="px-4 pb-3 pt-1 space-y-2">
          {/* Service indicators */}
          <div className="flex flex-wrap gap-4">
            <div className="flex items-center gap-1.5">
              <StatusDot ok={openaiOk} />
              <span className={openaiOk ? "text-foreground" : "text-danger"}>
                OpenAI {openaiOk ? "" : "(no API key)"}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <StatusDot ok={openhandsOk} />
              <span className={openhandsOk ? "text-foreground" : "text-warn"}>
                OpenHands {openhandsOk ? "" : "(not running)"}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <StatusDot ok={agentOk} />
              <span className={agentOk ? "text-foreground" : "text-warn"}>
                Agent {openclawOk ? "(OpenClaw)" : nanoclawOk ? "(NanoClaw)" : "(not running)"}
              </span>
            </div>
          </div>

          {/* Feature availability */}
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted">
            {featureList.map((f) => (
              <span key={f.label} className="flex items-center gap-1">
                <span>{f.available ? "+" : "-"}</span>
                <span className={f.available ? "" : "line-through opacity-60"}>
                  {f.label}
                </span>
              </span>
            ))}
          </div>

        </div>
      )}
    </div>
  );
}
