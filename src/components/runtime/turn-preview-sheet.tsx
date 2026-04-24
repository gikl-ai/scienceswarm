import { useEffect } from "react";
import type { TurnPreview } from "@/lib/runtime-hosts/contracts";
import { RuntimePrivacyChip, RuntimeStatusChip } from "./runtime-status-chip";

function accountSourceLabel(source: TurnPreview["accountDisclosure"]["accountSource"]): string {
  switch (source) {
    case ".env":
      return ".env key; value hidden";
    case "host-cli-login":
      return "Native CLI login";
    case "openhands":
      return "OpenHands local service";
    default:
      return "Local service";
  }
}

function privacyReminderCopy(preview: TurnPreview): string | null {
  const isLocal = preview.effectivePrivacyClass === "local-only"
    || preview.effectivePrivacyClass === "local-network";
  if (!preview.allowed || !preview.requiresUserApproval || isLocal) {
    return null;
  }

  return [
    "This chat will leave the local-only OpenClaw path and go to the selected runtime host.",
    "Review this once so future chat turns to the same host can send without interrupting you.",
  ].join(" ");
}

export function TurnPreviewSheet({
  preview,
  open,
  pendingLabel,
  busy = false,
  error,
  onApprove,
  onCancel,
  onChangeHost,
}: {
  preview: TurnPreview | null;
  open: boolean;
  pendingLabel: string;
  busy?: boolean;
  error?: string | null;
  onApprove: () => void;
  onCancel: () => void;
  onChangeHost: () => void;
}) {
  useEffect(() => {
    if (!open) return undefined;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onCancel, open]);

  if (!open || !preview) return null;
  const reminderCopy = privacyReminderCopy(preview);
  const title = reminderCopy ? "Hosted runtime reminder" : "Runtime preview";

  return (
    <div
      className="fixed inset-0 z-50 flex items-end bg-black/35 sm:items-center sm:justify-center"
      role="presentation"
      data-testid="turn-preview-sheet"
    >
      <section
        className="flex max-h-[100dvh] w-full flex-col overflow-hidden bg-white shadow-xl sm:max-h-[88vh] sm:max-w-2xl sm:rounded-lg"
        role="dialog"
        aria-modal="true"
        aria-labelledby="turn-preview-title"
      >
        <div className="border-b border-border px-5 py-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 id="turn-preview-title" className="text-lg font-semibold text-foreground">
                {title}
              </h2>
              <p className="mt-1 text-sm text-muted">{pendingLabel}</p>
            </div>
            <button
              type="button"
              onClick={onCancel}
              className="min-h-11 rounded border border-border px-3 text-sm font-medium text-muted hover:text-foreground"
              aria-label="Cancel runtime preview"
            >
              Cancel
            </button>
          </div>
        </div>

        <div className="space-y-5 overflow-y-auto px-5 py-4">
          {reminderCopy && (
            <p className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              {reminderCopy}
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            <RuntimeStatusChip
              label={preview.allowed ? "Policy passed" : "Policy blocked"}
              tone={preview.allowed ? "ok" : "danger"}
            />
            <RuntimeStatusChip
              label={preview.requiresUserApproval ? "Approval required" : "No approval required"}
              tone={preview.requiresUserApproval ? "warn" : "ok"}
            />
            <RuntimePrivacyChip privacyClass={preview.effectivePrivacyClass} />
          </div>

          {preview.blockReason && (
            <p className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              {preview.blockReason}
            </p>
          )}

          <section className="space-y-2">
            <h3 className="text-sm font-semibold text-foreground">Destination</h3>
            <div className="divide-y divide-border rounded border border-border">
              {preview.destinations.map((destination) => (
                <div
                  key={`${destination.hostId}-${destination.privacyClass}`}
                  className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                >
                  <span className="min-w-0 truncate font-medium">{destination.label}</span>
                  <RuntimePrivacyChip privacyClass={destination.privacyClass} />
                </div>
              ))}
            </div>
          </section>

          <section className="space-y-2">
            <h3 className="text-sm font-semibold text-foreground">Account source</h3>
            <div className="rounded border border-border bg-surface p-3 text-sm text-foreground">
              {accountSourceLabel(preview.accountDisclosure.accountSource)}
              {preview.accountDisclosure.costCopyRequired && (
                <span className="ml-2 text-amber-700">May consume provider quota or cost.</span>
              )}
            </div>
          </section>

          <section className="space-y-2">
            <h3 className="text-sm font-semibold text-foreground">Data included</h3>
            <ul className="divide-y divide-border rounded border border-border">
              {preview.dataIncluded.length > 0 ? (
                preview.dataIncluded.map((item, index) => (
                  <li
                    key={`${item.kind}-${item.label}-${index}`}
                    className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                  >
                    <span className="min-w-0 truncate">{item.label}</span>
                    <span className="shrink-0 text-xs text-muted">
                      {item.kind}
                      {typeof item.bytes === "number" ? ` / ${item.bytes} B` : ""}
                    </span>
                  </li>
                ))
              ) : (
                <li className="px-3 py-2 text-sm text-muted">No prompt or files included.</li>
              )}
            </ul>
          </section>

          {error && (
            <p className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              {error}
            </p>
          )}
        </div>

        <div className="flex flex-col gap-2 border-t border-border px-5 py-4 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={onChangeHost}
            className="min-h-11 rounded border border-border px-4 text-sm font-semibold text-foreground hover:border-accent"
          >
            Change host
          </button>
          <button
            type="button"
            onClick={onApprove}
            disabled={!preview.allowed || busy}
            className="min-h-11 rounded bg-accent px-4 text-sm font-semibold text-white hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? "Starting..." : reminderCopy ? "Acknowledge and send" : "Approve and send"}
          </button>
        </div>
      </section>
    </div>
  );
}
