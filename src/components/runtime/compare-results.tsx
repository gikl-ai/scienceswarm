import type { TurnPreview } from "@/lib/runtime-hosts/contracts";
import { RuntimePrivacyChip, RuntimeStatusChip } from "./runtime-status-chip";

export interface RuntimeCompareChildResult {
  sessionId: string;
  hostId: string;
  status: "completed" | "failed";
  message: string | null;
  error: string | null;
}

export interface RuntimeCompareResult {
  parentSession?: { id: string; status: string } | null;
  childResults: RuntimeCompareChildResult[];
  partialFailure: boolean;
  synthesisPreview?: TurnPreview | null;
}

export function CompareResults({
  result,
  onApproveSynthesis,
}: {
  result: RuntimeCompareResult | null;
  onApproveSynthesis?: () => void;
}) {
  if (!result) return null;

  return (
    <section className="border-t border-border bg-white px-4 py-3" data-testid="compare-results">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Compare results</h2>
          <p className="text-xs text-muted">
            Parent session {result.parentSession?.id ?? "pending"}
          </p>
        </div>
        {result.partialFailure && (
          <RuntimeStatusChip label="Partial failure" tone="warn" />
        )}
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        {result.childResults.map((child) => (
          <article
            key={child.sessionId}
            className="min-w-0 rounded border border-border bg-surface p-3"
          >
            <div className="flex items-center justify-between gap-2">
              <h3 className="min-w-0 truncate text-sm font-semibold text-foreground">
                {child.hostId}
              </h3>
              <RuntimeStatusChip
                label={child.status}
                tone={child.status === "completed" ? "ok" : "danger"}
              />
            </div>
            <p className="mt-2 whitespace-pre-wrap break-words text-sm text-foreground">
              {child.message ?? child.error ?? "No output returned."}
            </p>
          </article>
        ))}
      </div>

      {result.synthesisPreview && (
        <div className="mt-4 rounded border border-border bg-surface p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-foreground">Synthesis preview</span>
            <RuntimePrivacyChip privacyClass={result.synthesisPreview.effectivePrivacyClass} />
            <RuntimeStatusChip
              label={result.synthesisPreview.requiresUserApproval ? "Approval required" : "No approval required"}
              tone={result.synthesisPreview.requiresUserApproval ? "warn" : "ok"}
            />
          </div>
          <p className="mt-2 text-xs text-muted">
            Synthesis uses {result.synthesisPreview.dataIncluded.length} child output
            {result.synthesisPreview.dataIncluded.length === 1 ? "" : "s"}.
          </p>
          {onApproveSynthesis && (
            <button
              type="button"
              onClick={onApproveSynthesis}
              className="mt-3 min-h-9 rounded bg-accent px-3 text-xs font-semibold text-white hover:bg-accent-hover"
            >
              Approve synthesis
            </button>
          )}
        </div>
      )}
    </section>
  );
}
