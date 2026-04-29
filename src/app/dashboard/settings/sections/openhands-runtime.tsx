"use client";

import { useState } from "react";

import { Section } from "./_primitives";

interface Props {
  openhandsStatus: "connected" | "disconnected" | null;
  disabled?: boolean;
  primaryButtonClassName: string;
  secondaryButtonClassName: string;
  onPrepared: () => void;
}

interface PrepareOpenHandsResponse {
  ok?: boolean;
  status?: "succeeded" | "skipped" | "failed";
  detail?: string | null;
  error?: string | null;
}

async function parsePrepareError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as PrepareOpenHandsResponse;
    return body.error || body.detail || `OpenHands setup failed (HTTP ${res.status}).`;
  } catch {
    return `OpenHands setup failed (HTTP ${res.status}).`;
  }
}

export function OpenHandsRuntimeSection({
  openhandsStatus,
  disabled = false,
  primaryButtonClassName,
  secondaryButtonClassName,
  onPrepared,
}: Props) {
  const [preparing, setPreparing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ready = openhandsStatus === "connected";

  const prepareOpenHands = async () => {
    setPreparing(true);
    setMessage("Preparing Docker and OpenHands. This can take several minutes on a cold machine.");
    setError(null);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "prepare-openhands" }),
      });
      if (!res.ok) {
        throw new Error(await parsePrepareError(res));
      }
      const body = (await res.json()) as PrepareOpenHandsResponse;
      setMessage(body.detail || "OpenHands is ready.");
      onPrepared();
    } catch (err) {
      setError(err instanceof Error ? err.message : "OpenHands setup failed.");
    } finally {
      setPreparing(false);
    }
  };

  return (
    <Section title="OpenHands execution">
      <p className="text-sm text-muted">
        OpenHands uses Docker for heavier code execution. ScienceSwarm does not
        bundle Docker Desktop; this action installs/starts Docker when possible,
        pulls the pinned OpenHands image, and starts the managed local container.
      </p>
      <div className="rounded-lg border border-border bg-background p-3 text-sm text-muted">
        <span className="font-medium text-foreground">Status:</span>{" "}
        {ready ? "OpenHands is reachable" : "OpenHands is not reachable"}
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={ready ? secondaryButtonClassName : primaryButtonClassName}
          disabled={disabled || preparing}
          onClick={() => void prepareOpenHands()}
          data-testid="prepare-openhands-runtime"
        >
          {preparing ? "Preparing OpenHands..." : ready ? "Re-run setup" : "Set up OpenHands"}
        </button>
      </div>
      {message && <p className="text-xs text-muted">{message}</p>}
      {error && (
        <p className="text-xs text-danger" role="alert">
          {error}
        </p>
      )}
    </Section>
  );
}
