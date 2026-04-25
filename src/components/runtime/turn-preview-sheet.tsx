import { useEffect } from "react";
import type { TurnPreview } from "@/lib/runtime-hosts/contracts";

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

function destinationLabel(preview: TurnPreview): string | null {
  return preview.destinations.map((destination) => destination.label).join(", ") || null;
}

function privacyReminderCopy(preview: TurnPreview): string | null {
  const isLocal = preview.effectivePrivacyClass === "local-only"
    || preview.effectivePrivacyClass === "local-network";
  if (!preview.allowed || !preview.requiresUserApproval || isLocal || preview.mode !== "chat") {
    return null;
  }

  const destination = destinationLabel(preview);
  if (!destination) {
    return [
      "Your prompt and the data listed below will be sent to a third party.",
      "ScienceSwarm will remember this choice for future chat turns to this destination.",
    ].join(" ");
  }
  return [
    `Your prompt and the data listed below will be sent to ${destination}, a third party.`,
    `ScienceSwarm will remember this choice for future chat turns to ${destination}.`,
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
  const title = reminderCopy
    ? "Reminder: your data will be sent to a third party"
    : "Review before sending";

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
              aria-label="Keep draft and close"
            >
              Keep draft
            </button>
          </div>
        </div>

        <div className="space-y-5 overflow-y-auto px-5 py-4">
          {reminderCopy && (
            <p className="rounded border border-warn/30 bg-warn/10 p-3 text-sm text-warn">
              {reminderCopy}
            </p>
          )}

          {preview.blockReason && (
            <p className="rounded border border-danger/30 bg-danger/10 p-3 text-sm text-danger">
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
                </div>
              ))}
            </div>
          </section>

          <section className="space-y-2">
            <h3 className="text-sm font-semibold text-foreground">Account source</h3>
            <div className="rounded border border-border bg-surface p-3 text-sm text-foreground">
              {accountSourceLabel(preview.accountDisclosure.accountSource)}
              {preview.accountDisclosure.costCopyRequired && (
                <span className="ml-2 text-warn">May consume provider quota or cost.</span>
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
            <p className="rounded border border-danger/30 bg-danger/10 p-3 text-sm text-danger">
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
            Change destination
          </button>
          <button
            type="button"
            onClick={onApprove}
            disabled={!preview.allowed || busy}
            className="min-h-11 rounded bg-accent px-4 text-sm font-semibold text-white hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? "Sending..." : reminderCopy ? "Send to third party" : "Approve and send"}
          </button>
        </div>
      </section>
    </div>
  );
}
