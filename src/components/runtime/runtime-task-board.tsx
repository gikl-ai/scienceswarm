import type { RuntimeSessionWithHost } from "@/hooks/use-runtime-hosts";
import { RuntimeStatusChip } from "./runtime-status-chip";

function statusTone(status: RuntimeSessionWithHost["status"]) {
  if (status === "completed") return "ok";
  if (status === "failed" || status === "cancelled") return "danger";
  if (status === "running" || status === "queued") return "warn";
  return "neutral";
}

function canCancelSession(session: RuntimeSessionWithHost): boolean {
  if (session.status !== "running" && session.status !== "queued") return false;
  if (session.readOnly) return false;
  const lifecycle = session.host?.profile?.lifecycle;
  const controlSurface = session.host?.profile?.controlSurface;
  return lifecycle?.canCancel === true || controlSurface?.supportsCancel === true;
}

export function RuntimeTaskBoard({
  sessions,
  loading,
  error,
  selectedSessionId,
  onRefresh,
  onSelectSession,
  onCancelSession,
}: {
  sessions: RuntimeSessionWithHost[];
  loading?: boolean;
  error?: string | null;
  selectedSessionId?: string | null;
  onRefresh: () => void;
  onSelectSession: (sessionId: string) => void;
  onCancelSession: (sessionId: string) => void;
}) {
  return (
    <section className="border-t border-border bg-white" data-testid="runtime-task-board">
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Runtime sessions</h2>
          <p className="text-xs text-muted">Chat, task, and compare runs for this project.</p>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          className="min-h-9 rounded border border-border px-3 text-xs font-semibold text-foreground hover:border-accent"
        >
          Refresh
        </button>
      </div>

      {error && (
        <p className="mx-4 mb-3 rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700">
          {error}
        </p>
      )}

      <div className="overflow-x-auto">
        <table className="min-w-[720px] w-full border-collapse text-left text-xs">
          <thead>
            <tr className="border-y border-border bg-surface text-muted">
              <th className="px-4 py-2 font-semibold">Status</th>
              <th className="px-3 py-2 font-semibold">Host</th>
              <th className="px-3 py-2 font-semibold">Mode</th>
              <th className="px-3 py-2 font-semibold">Updated</th>
              <th className="px-3 py-2 font-semibold">Controls</th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((session) => (
              <tr
                key={session.id}
                className={`border-b border-border ${
                  selectedSessionId === session.id ? "bg-accent/5" : "bg-white"
                }`}
              >
                <td className="px-4 py-2">
                  <RuntimeStatusChip label={session.status} tone={statusTone(session.status)} />
                </td>
                <td className="max-w-[12rem] px-3 py-2">
                  <button
                    type="button"
                    onClick={() => onSelectSession(session.id)}
                    className="max-w-full truncate font-semibold text-foreground underline-offset-2 hover:underline"
                    title={session.id}
                  >
                    {session.host?.label ?? session.hostId}
                  </button>
                </td>
                <td className="px-3 py-2 text-muted">{session.mode}</td>
                <td className="px-3 py-2 text-muted">
                  {new Date(session.updatedAt).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </td>
                <td className="px-3 py-2">
                  {canCancelSession(session) ? (
                    <button
                      type="button"
                      onClick={() => onCancelSession(session.id)}
                      className="min-h-8 rounded border border-border px-2 font-semibold text-foreground hover:border-red-300 hover:text-red-700"
                    >
                      Cancel
                    </button>
                  ) : (
                    <span className="text-muted">No cancel control</span>
                  )}
                </td>
              </tr>
            ))}
            {sessions.length === 0 && (
              <tr>
                <td className="px-4 py-4 text-sm text-muted" colSpan={5}>
                  {loading ? "Loading runtime sessions..." : "No runtime sessions yet."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
