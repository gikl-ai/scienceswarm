import type { RuntimeEvent } from "@/lib/runtime-hosts/contracts";
import type { RuntimeSessionWithHost } from "@/hooks/use-runtime-hosts";
import { RuntimeStatusChip } from "./runtime-status-chip";

function eventText(event: RuntimeEvent): string {
  const payload = event.payload;
  if (typeof payload.text === "string") return payload.text;
  if (typeof payload.message === "string") return payload.message;
  if (typeof payload.status === "string") return payload.status;
  return JSON.stringify(payload);
}

export function SessionDetail({
  session,
  events,
  loading,
  error,
  onClose,
  onRefresh,
}: {
  session: RuntimeSessionWithHost | null;
  events: RuntimeEvent[];
  loading?: boolean;
  error?: string | null;
  onClose: () => void;
  onRefresh: () => void;
}) {
  if (!session) return null;

  const artifactEvents = events.filter((event) => event.type === "artifact");

  return (
    <aside
      className="border-t border-border bg-surface px-4 py-3"
      data-testid="runtime-session-detail"
      aria-label="AI session detail"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-foreground">
            {session.host?.label ?? session.hostId}
          </h2>
          <p className="mt-1 break-all font-mono text-xs text-muted">{session.id}</p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onRefresh}
            className="min-h-9 rounded border border-border px-3 text-xs font-semibold text-foreground hover:border-accent"
          >
            Refresh
          </button>
          <button
            type="button"
            onClick={onClose}
            className="min-h-9 rounded border border-border px-3 text-xs font-semibold text-foreground hover:border-accent"
          >
            Close
          </button>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <RuntimeStatusChip label={session.status} tone={session.status === "completed" ? "ok" : session.status === "failed" ? "danger" : "warn"} />
        <RuntimeStatusChip label={session.mode} />
        {session.readOnly && <RuntimeStatusChip label="Read only history" tone="warn" />}
      </div>

      {error && (
        <p className="mt-3 rounded border border-danger/30 bg-danger/10 p-2 text-xs text-danger">
          {error}
        </p>
      )}

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <section>
          <h3 className="text-xs font-semibold uppercase text-muted">Events and logs</h3>
          <ol className="mt-2 max-h-56 overflow-y-auto rounded border border-border bg-white">
            {events.map((event) => (
              <li key={event.id} className="border-b border-border px-3 py-2 last:border-0">
                <div className="flex items-center justify-between gap-3 text-xs">
                  <span className="font-semibold text-foreground">{event.type}</span>
                  <span className="shrink-0 text-muted">
                    {new Date(event.createdAt).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                </div>
                <p className="mt-1 break-words text-xs text-muted">{eventText(event)}</p>
              </li>
            ))}
            {events.length === 0 && (
              <li className="px-3 py-3 text-xs text-muted">
                {loading ? "Loading events..." : "No runtime events yet."}
              </li>
            )}
          </ol>
        </section>

        <section>
          <h3 className="text-xs font-semibold uppercase text-muted">Artifacts and recovery</h3>
          <div className="mt-2 rounded border border-border bg-white">
            {artifactEvents.length > 0 ? (
              artifactEvents.map((event) => (
                <div key={event.id} className="border-b border-border px-3 py-2 text-xs last:border-0">
                  <p className="font-semibold text-foreground">
                    {typeof event.payload.sourcePath === "string"
                      ? event.payload.sourcePath
                      : "Runtime artifact"}
                  </p>
                  <p className="mt-1 text-muted">
                    {typeof event.payload.writebackPhaseStatus === "string"
                      ? event.payload.writebackPhaseStatus
                      : "Import recorded"}
                  </p>
                </div>
              ))
            ) : (
              <p className="px-3 py-3 text-xs text-muted">
                No artifact imports have been recorded for this session.
              </p>
            )}
            {session.status === "failed" && (
              <p className="border-t border-border px-3 py-2 text-xs text-muted">
                Retry from the composer after changing destination or policy.
              </p>
            )}
          </div>
        </section>
      </div>
    </aside>
  );
}
