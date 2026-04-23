import { useState } from "react";
import type { RuntimeProjectPolicy } from "@/lib/runtime-hosts/contracts";
import { RuntimeStatusChip } from "./runtime-status-chip";

type ArtifactAction = "validate" | "import" | "retry";

export interface RuntimeArtifactApprovalRequest {
  projectId: string;
  hostId: string;
  sessionId: string;
  sourcePath: string;
  sourcePathKind: "project-relative" | "local-absolute" | "host-native";
  importReason:
    | "host-declared-artifact"
    | "workspace-output-scan"
    | "user-selected-external-path";
  targetPath?: string;
  projectPolicy: RuntimeProjectPolicy;
}

export function ArtifactApproval({
  request,
  onImported,
}: {
  request: RuntimeArtifactApprovalRequest;
  onImported?: () => void;
}) {
  const [status, setStatus] = useState<"idle" | "working" | "ok" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  const runAction = async (action: ArtifactAction) => {
    setStatus("working");
    setMessage(null);
    try {
      const response = await fetch("/api/runtime/artifacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...request,
          action,
          approvalState: "approved",
        }),
      });
      const payload = await response.json().catch(() => null) as
        | { validation?: { ok?: boolean; reason?: string }; error?: string }
        | null;
      if (!response.ok) {
        throw new Error(payload?.error || `Artifact ${action} failed: ${response.status}`);
      }
      if (payload?.validation?.ok === false) {
        throw new Error(payload.validation.reason || "Artifact path was rejected.");
      }
      setStatus("ok");
      setMessage(action === "validate" ? "Artifact path is allowed." : "Artifact import queued.");
      if (action !== "validate") onImported?.();
    } catch (err) {
      setStatus("error");
      setMessage(err instanceof Error ? err.message : "Artifact action failed.");
    }
  };

  return (
    <section
      className="rounded border border-border bg-white p-3"
      data-testid="artifact-approval"
      aria-label="Artifact approval"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-foreground">
            Artifact approval
          </h2>
          <p className="mt-1 break-all font-mono text-xs text-muted">
            {request.sourcePath}
          </p>
        </div>
        <RuntimeStatusChip
          label={status === "idle" ? "Needs approval" : status}
          tone={status === "ok" ? "ok" : status === "error" ? "danger" : "warn"}
        />
      </div>

      {message && (
        <p className={`mt-3 rounded border p-2 text-xs ${
          status === "error"
            ? "border-red-200 bg-red-50 text-red-700"
            : "border-emerald-200 bg-emerald-50 text-emerald-700"
        }`}
        >
          {message}
        </p>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void runAction("validate")}
          disabled={status === "working"}
          className="min-h-9 rounded border border-border px-3 text-xs font-semibold text-foreground hover:border-accent disabled:opacity-50"
        >
          Validate
        </button>
        <button
          type="button"
          onClick={() => void runAction("import")}
          disabled={status === "working"}
          className="min-h-9 rounded bg-accent px-3 text-xs font-semibold text-white hover:bg-accent-hover disabled:opacity-50"
        >
          Import
        </button>
        <button
          type="button"
          onClick={() => void runAction("retry")}
          disabled={status === "working"}
          className="min-h-9 rounded border border-border px-3 text-xs font-semibold text-foreground hover:border-accent disabled:opacity-50"
        >
          Retry writeback
        </button>
      </div>
    </section>
  );
}
