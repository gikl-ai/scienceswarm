import type {
  BootstrapEvent,
  BootstrapStreamEvent,
  BootstrapTaskId,
} from "@/lib/setup/install-tasks/types";
import { Spinner } from "@/components/spinner";

const TASK_LABELS: Record<BootstrapTaskId, string> = {
  "gbrain-init": "Local research store",
  openclaw: "Private OpenClaw runtime",
  "openhands-docker": "OpenHands code execution",
  "ollama-gemma": "Ollama + Gemma 4 local model",
  "telegram-bot": "Telegram account connection",
};

interface BootstrapProgressProps {
  events: BootstrapStreamEvent[];
  /** Which tasks to display. PR 1 always uses four; PR 2 appends telegram-bot. */
  activeTasks: BootstrapTaskId[];
}

function statusIcon(status: string): string {
  switch (status) {
    case "pending":
      return "○";
    case "succeeded":
      return "✓";
    case "skipped":
      return "—";
    case "failed":
      return "✗";
    case "waiting-for-input":
      return "!";
    default:
      return "?";
  }
}

/** Returns true for statuses that should show a spinner instead of a text icon. */
function isSpinnerStatus(status: string): boolean {
  return status === "running";
}

export function BootstrapProgress({ events, activeTasks }: BootstrapProgressProps) {
  // Last event per task wins.
  const latest = new Map<BootstrapTaskId, BootstrapEvent>();
  for (const e of events) {
    if (e.type === "task") latest.set(e.task, e);
  }

  // Show a spinner in the heading while at least one task is still
  // pending or running (i.e. the bootstrap has not finished).
  const allDone = activeTasks.every((id) => {
    const status = latest.get(id)?.status;
    return status === "succeeded" || status === "skipped" || status === "failed";
  });

  return (
    <section
      data-testid="bootstrap-progress"
      className="rounded-[28px] border-2 border-border bg-white p-5 shadow-sm"
    >
      <h2 className="flex items-center gap-3 text-xl font-semibold text-foreground">
        {!allDone && <Spinner size="h-5 w-5" testId="bootstrap-heading-spinner" />}
        Connecting your runtime
      </h2>
      <p className="mt-2 text-sm leading-6 text-muted">
        ScienceSwarm is preparing the local runtime and research store. Your
        brain becomes useful after you import papers, notes, code, or datasets.
      </p>
      <ul className="mt-4 space-y-2">
        {activeTasks.map((id) => {
          const e = latest.get(id);
          const status = e?.status ?? "pending";
          return (
            <li
              key={id}
              data-testid={`bootstrap-task-${id}`}
              data-status={status}
              className="flex items-start gap-3 rounded-xl border border-border bg-surface/30 px-3 py-2 text-sm"
            >
              <span
                className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border text-xs"
                aria-hidden
              >
                {isSpinnerStatus(status) ? (
                  <Spinner size="h-3.5 w-3.5" testId={`bootstrap-task-${id}-spinner`} />
                ) : (
                  statusIcon(status)
                )}
              </span>
              <div className="flex-1">
                <div className="font-medium text-foreground">
                  {TASK_LABELS[id]}
                </div>
                {e?.detail && (
                  <div className="text-xs text-muted">{e.detail}</div>
                )}
                {status === "waiting-for-input" &&
                  e?.needs === "telegram-nonce-claim" &&
                  e.nonceClaim && (
                    <div className="mt-3 space-y-2" data-testid="telegram-nonce-claim">
                      <a
                        href={e.nonceClaim.deeplink}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex rounded-xl bg-accent px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-accent-hover"
                        data-testid="telegram-nonce-link"
                      >
                        Open @{e.nonceClaim.botUsername}
                      </a>
                      <p className="text-xs text-muted">
                        This window will advance after Telegram receives your
                        start message.
                      </p>
                    </div>
                  )}
                {status === "failed" && e?.error && (
                  <div className="mt-1 text-xs text-danger" role="alert">
                    {e.error}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
