"use client";

/**
 * /setup — single-screen bootstrap.
 *
 * The old multi-section page is gone: we now collect handle / email /
 * optional phone, POST to /api/setup/bootstrap, and stream install
 * progress inline. Phone is optional — when omitted the telegram-bot
 * task is skipped and the user can configure Telegram later from Settings.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { useRouter } from "next/navigation";

import {
  BootstrapForm,
  type BootstrapFormValues,
} from "@/components/setup/bootstrap-form";
import { BootstrapProgress } from "@/components/setup/bootstrap-progress";
import { TelegramCodePrompt } from "@/components/setup/telegram-code-prompt";
import { TelegramBotReady } from "@/components/setup/telegram-bot-ready";
import type {
  BootstrapEvent,
  BootstrapSummaryEvent,
  BootstrapStreamEvent,
  BootstrapTaskId,
} from "@/lib/setup/install-tasks/types";
import { createRandomUserHandle } from "@/lib/setup/user-handle";

/**
 * The telegram-bot task emits a "succeeded" event with detail formatted as
 *   "{displayName} — https://t.me/{username}"
 * Parse it back out for the bot-ready card.
 *
 * Note: the displayName itself contains an em-dash (e.g.
 * "Wobblefinch — your ScienceSwarm claw"), so we split on the
 * em-dash immediately preceding the URL, not the first em-dash.
 */
function parseTelegramSuccessDetail(
  detail: string | undefined,
): { botUrl: string; creature: string; displayName: string } | null {
  if (!detail) return null;
  const urlMatch = /https:\/\/t\.me\/(\S+)/.exec(detail);
  if (!urlMatch) return null;
  const botUrl = urlMatch[0];
  const username = urlMatch[1];
  const creature = username.split("_")[0] ?? "claw";
  // Strip everything from " — https://..." onward. If no separator
  // matches (malformed detail), fall back to the raw string.
  const sepIdx = detail.indexOf(" — https://");
  const displayName = sepIdx > 0 ? detail.slice(0, sepIdx) : detail;
  return { botUrl, creature, displayName };
}

function findLast<T, U extends T>(
  arr: readonly T[],
  pred: (item: T) => item is U,
): U | undefined {
  for (let i = arr.length - 1; i >= 0; i -= 1) {
    if (pred(arr[i])) return arr[i] as U;
  }
  return undefined;
}

function getLatestTaskEvent(
  events: readonly BootstrapStreamEvent[],
  task: BootstrapTaskId,
): BootstrapEvent | undefined {
  return findLast(
    events,
    (event): event is BootstrapEvent => event.type === "task" && event.task === task,
  );
}

// Four foundation tasks always rendered.
const BASE_TASKS: BootstrapTaskId[] = [
  "gbrain-init",
  "openclaw",
  "openhands-docker",
  "ollama-gemma",
];

// Fifth task — included when the request uses Telegram, or when the
// server discovers a saved bot token in `.env` and emits telegram-bot
// events during bootstrap.
const TASKS_WITH_TELEGRAM: BootstrapTaskId[] = [
  ...BASE_TASKS,
  "telegram-bot",
];

const BOOTSTRAP_STORAGE_KEY = "scienceswarm.setup.bootstrap.v1";
const AUTO_CONTINUE_DELAY_MS = 1_000;
const DEFERRED_AUTO_CONTINUE_DELAY_MS = 4_000;
const RESUME_PROBE_INTERVAL_MS = 2_000;
const RESUME_STALE_MS = 15_000;
const NON_BLOCKING_BOOTSTRAP_TASKS = new Set<BootstrapTaskId>([
  "openhands-docker",
  "telegram-bot",
]);

interface PersistedBootstrapState {
  submitted: boolean;
  submittedTelegram: boolean;
  events: BootstrapStreamEvent[];
  summary: BootstrapSummaryEvent | null;
  updatedAt: string;
}

interface SetupStatusResponse {
  ready?: boolean;
  defaultHandle?: string;
  desktopMode?: boolean;
  persistedSetup?: {
    complete?: boolean;
  };
}

function clearPersistedBootstrapState(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(BOOTSTRAP_STORAGE_KEY);
}

function persistBootstrapState(state: PersistedBootstrapState): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(BOOTSTRAP_STORAGE_KEY, JSON.stringify(state));
}

function readPersistedBootstrapState(): PersistedBootstrapState | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(BOOTSTRAP_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedBootstrapState>;
    if (
      typeof parsed?.submitted !== "boolean"
      || typeof parsed?.submittedTelegram !== "boolean"
      || typeof parsed?.updatedAt !== "string"
      || !Array.isArray(parsed?.events)
    ) {
      return null;
    }
    return {
      submitted: parsed.submitted,
      submittedTelegram: parsed.submittedTelegram,
      events: parsed.events as BootstrapStreamEvent[],
      summary:
        parsed.summary && parsed.summary.type === "summary"
          ? (parsed.summary as BootstrapSummaryEvent)
          : null,
      updatedAt: parsed.updatedAt,
    };
  } catch {
    return null;
  }
}

function shouldAutoContinue(
  summary: BootstrapSummaryEvent | null,
): boolean {
  if (!summary) return false;
  if (summary.status === "ok") return true;
  if (summary.status !== "partial") return false;
  return summary.failed.every((task) => NON_BLOCKING_BOOTSTRAP_TASKS.has(task));
}

function hasDeferredOpenHands(
  summary: BootstrapSummaryEvent | null,
): boolean {
  if (!summary) return false;
  return (
    summary.failed.includes("openhands-docker")
    || summary.skipped.includes("openhands-docker")
  );
}

function isWaitingForInput(events: BootstrapStreamEvent[]): boolean {
  return events.some(
    (event) => event.type === "task" && event.status === "waiting-for-input",
  );
}

function subscribeToHydration(): () => void {
  return () => undefined;
}

function getHydratedSnapshot(): boolean {
  return true;
}

function getServerHydratedSnapshot(): boolean {
  return false;
}

function isLikelyWindowsBrowser(): boolean {
  if (typeof window === "undefined") return false;
  return /^Win/i.test(window.navigator.platform) || /Windows/i.test(window.navigator.userAgent);
}

export default function SetupPage() {
  const router = useRouter();
  // The setup status endpoint returns a generated anonymous handle,
  // never an OS username or computer name.
  const initialPersistedState = useMemo(
    () => readPersistedBootstrapState(),
    [],
  );
  const hydrated = useSyncExternalStore(
    subscribeToHydration,
    getHydratedSnapshot,
    getServerHydratedSnapshot,
  );
  const [submitted, setSubmitted] = useState(
    () => initialPersistedState?.submitted ?? false,
  );
  const [events, setEvents] = useState<BootstrapStreamEvent[]>(
    () => initialPersistedState?.events ?? [],
  );
  const [summary, setSummary] = useState<BootstrapSummaryEvent | null>(
    () => initialPersistedState?.summary ?? null,
  );
  const [submittedTelegram, setSubmittedTelegram] = useState(
    () => initialPersistedState?.submittedTelegram ?? false,
  );
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(
    () => initialPersistedState?.updatedAt ?? null,
  );
  const [checkingExistingSetup, setCheckingExistingSetup] = useState(true);
  const [suggestedHandle, setSuggestedHandle] = useState<string | undefined>();
  const gbrainEvent = getLatestTaskEvent(events, "gbrain-init");
  const openclawEvent = getLatestTaskEvent(events, "openclaw");
  const openhandsEvent = getLatestTaskEvent(events, "openhands-docker");
  const ollamaEvent = getLatestTaskEvent(events, "ollama-gemma");
  const coreRuntimeReady =
    gbrainEvent?.status === "succeeded"
    && openclawEvent?.status === "succeeded"
    && ollamaEvent?.status === "succeeded";
  const showCoreReadyCard =
    coreRuntimeReady
    && (!summary || summary.type !== "summary")
    && openhandsEvent?.status !== "succeeded";

  const resetSetup = useCallback(() => {
    clearPersistedBootstrapState();
    setSubmitted(false);
    setEvents([]);
    setSummary(null);
    setSubmittedTelegram(false);
    setLastUpdatedAt(null);
  }, []);

  const handleSubmit = useCallback(async (values: BootstrapFormValues) => {
    const now = new Date().toISOString();
    setSubmitted(true);
    setSubmittedTelegram(Boolean(values.phone || values.existingBot?.token));
    setEvents([]);
    setSummary(null);
    setLastUpdatedAt(now);

    // Wrap the whole network + stream path in try/catch. Without it,
    // a fetch rejection (network unreachable, CORS) or a reader error
    // mid-stream escapes the unawaited caller in BootstrapForm, leaves
    // the UI stuck with `submitted=true` and `summary=null`, and the
    // user sees "Installing your runtime…" pinned at pending with no
    // error or retry path.
    try {
      const response = await fetch("/api/setup/bootstrap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });

      if (!response.ok || !response.body) {
        // Forward the API error body so the user sees why the server
        // rejected the request (e.g. malformed email, invalid handle).
        // Without this, the failed card just says "see per-task errors
        // above" while the task rows stay at pending.
        const body = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        setSummary({
          type: "summary",
          status: "failed",
          failed: [],
          skipped: [],
          error: body.error ?? `Bootstrap request failed (HTTP ${response.status}).`,
        });
        setLastUpdatedAt(new Date().toISOString());
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let frameEnd: number;
        while ((frameEnd = buffer.indexOf("\n\n")) !== -1) {
          const rawFrame = buffer.slice(0, frameEnd);
          buffer = buffer.slice(frameEnd + 2);
          const dataLine = rawFrame
            .split(/\r?\n/)
            .find((l) => l.startsWith("data:"));
          if (!dataLine) continue;
          const json = dataLine.slice("data:".length).trim();
          try {
            const event = JSON.parse(json) as BootstrapStreamEvent;
            setEvents((prev) => [...prev, event]);
            setLastUpdatedAt(new Date().toISOString());
            if (event.type === "summary") setSummary(event);
          } catch {
            /* ignore malformed frames */
          }
        }
      }
    } catch (_err) {
      // Surface the network/stream failure so the terminal-state UI
      // renders the failed card instead of leaving the user stranded.
      setSummary({
        type: "summary",
        status: "failed",
        failed: [],
        skipped: [],
        error: "Bootstrap request failed due to a network or stream error. Please try again.",
      });
      setLastUpdatedAt(new Date().toISOString());
    }
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    if (!submitted) {
      clearPersistedBootstrapState();
      return;
    }
    persistBootstrapState({
      submitted,
      submittedTelegram,
      events,
      summary,
      updatedAt: lastUpdatedAt ?? new Date().toISOString(),
    });
  }, [events, hydrated, lastUpdatedAt, submitted, submittedTelegram, summary]);

  useEffect(() => {
    if (!hydrated || submitted) {
      setCheckingExistingSetup(false);
      return;
    }
    const params = new URLSearchParams(window.location.search);
    if (params.get("force") === "1" || params.get("rerun") === "1") {
      setCheckingExistingSetup(false);
      return;
    }

    let cancelled = false;
    const redirectIfSetupAlreadyExists = async () => {
      try {
        const res = await fetch("/api/setup/status", { cache: "no-store" });
        if (!res.ok) {
          return;
        }
        const data = (await res.json()) as SetupStatusResponse;
        if (cancelled) return;
        const defaultHandle = data.defaultHandle?.trim() || createRandomUserHandle();
        setSuggestedHandle(defaultHandle);
        if (data.ready || data.persistedSetup?.complete === true) {
          router.replace("/dashboard/study");
          return;
        }
        if (data.desktopMode === true) {
          await handleSubmit({
            handle: defaultHandle,
            email: "",
            phone: "",
            brainPreset: "scientific_research",
          });
          return;
        }
      } catch {
        // Fall through to the form. A transient status failure should
        // not block a first-time user from completing setup.
      } finally {
        if (!cancelled) setCheckingExistingSetup(false);
      }
    };

    void redirectIfSetupAlreadyExists();
    return () => {
      cancelled = true;
    };
  }, [handleSubmit, hydrated, router, submitted]);

  useEffect(() => {
    if (!submitted || summary || !hydrated) {
      return;
    }
    if (events.length === 0 || isWaitingForInput(events)) {
      return;
    }

    let cancelled = false;
    let settled = false;
    const tick = async () => {
      try {
        const res = await fetch("/api/setup/status", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { ready?: boolean };
        if (cancelled || settled) return;
        if (data.ready) {
          settled = true;
          const recoveredSummary: BootstrapSummaryEvent = {
            type: "summary",
            status: "ok",
            failed: [],
            skipped: [],
          };
          setSummary(recoveredSummary);
          setLastUpdatedAt(new Date().toISOString());
          return;
        }

        const updatedAtMs = lastUpdatedAt ? Date.parse(lastUpdatedAt) : NaN;
        if (
          Number.isFinite(updatedAtMs)
          && Date.now() - updatedAtMs > RESUME_STALE_MS
        ) {
          settled = true;
          setSummary({
            type: "summary",
            status: "failed",
            failed: [],
            skipped: [],
            error:
              "Setup was interrupted before completion. Start setup again to continue.",
          });
          setLastUpdatedAt(new Date().toISOString());
        }
      } catch {
        // Ignore transient probe failures; the page already shows the
        // last known setup state and the user still has a retry path.
      }
    };

    void tick();
    const intervalId = window.setInterval(() => {
      void tick();
    }, RESUME_PROBE_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [events, hydrated, lastUpdatedAt, submitted, summary]);

  useEffect(() => {
    if (!hydrated || !shouldAutoContinue(summary)) {
      return;
    }
    const delayMs = hasDeferredOpenHands(summary)
      ? DEFERRED_AUTO_CONTINUE_DELAY_MS
      : AUTO_CONTINUE_DELAY_MS;
    const timer = window.setTimeout(() => {
      clearPersistedBootstrapState();
      router.push("/dashboard/study?onboarding=continue");
    }, delayMs);
    return () => window.clearTimeout(timer);
  }, [hydrated, router, summary]);

  const autoContinuing = shouldAutoContinue(summary);
  const deferredOpenHands = hasDeferredOpenHands(summary);
  const continueRoute = "/dashboard/study?onboarding=continue";
  const showWindowsNote = hydrated && isLikelyWindowsBrowser();

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-5 px-4 py-8">
      {hydrated && !checkingExistingSetup && !submitted && (
        <BootstrapForm
          disabled={false}
          onSubmit={handleSubmit}
          initialHandle={suggestedHandle}
          showWindowsNote={showWindowsNote}
        />
      )}
      {hydrated && submitted && (
        <BootstrapProgress
          events={events}
          activeTasks={
            submittedTelegram ||
            events.some((e) => e.type === "task" && e.task === "telegram-bot")
              ? TASKS_WITH_TELEGRAM
              : BASE_TASKS
          }
        />
      )}
      {hydrated && (() => {
        // Use the LATEST event for the telegram-bot task, not "any
        // matching event". `findLast(..., waiting-for-input)` used to
        // return the stale waiting event even after the task moved
        // to running/succeeded, leaving the SMS code prompt visible
        // alongside the bot-ready card.
        const latestTelegram = findLast(
          events,
          (e): e is BootstrapEvent =>
            e.type === "task" && e.task === "telegram-bot",
        );
        if (
          !latestTelegram ||
          latestTelegram.status !== "waiting-for-input" ||
          latestTelegram.needs !== "telegram-code" ||
          !latestTelegram.sessionId
        ) {
          return null;
        }
        return (
          <TelegramCodePrompt
            sessionId={latestTelegram.sessionId}
            onSubmitted={() => {
              /* bootstrap resumes on its own */
            }}
          />
        );
      })()}
      {hydrated && (() => {
        const latestTelegram = findLast(
          events,
          (e): e is BootstrapEvent =>
            e.type === "task" && e.task === "telegram-bot",
        );
        if (!latestTelegram || latestTelegram.status !== "succeeded") {
          return null;
        }
        const parsed = parseTelegramSuccessDetail(latestTelegram.detail);
        if (!parsed) return null;
        return (
          <TelegramBotReady
            botUrl={parsed.botUrl}
            creature={parsed.creature}
            displayName={parsed.displayName}
          />
        );
      })()}
      {hydrated && summary?.type === "summary" && summary.status === "ok" && (
        <section
          className="rounded-[28px] border-2 border-ok/30 bg-ok/10 p-5 shadow-sm"
          data-testid="bootstrap-done"
        >
          <h2 className="text-xl font-semibold text-ok">
            OpenClaw is connected.
          </h2>
          <p className="mt-2 text-sm text-ok">
            {submittedTelegram
              ? "Check Telegram for your ScienceSwarm bot. "
              : "Telegram can be connected later from Settings. "}
            The local model and research store are ready; your brain becomes
            useful when you import your first papers, notes, code, or datasets.
            {deferredOpenHands
              ? " OpenHands code execution is not ready yet, but that does not block the import workspace. You can finish enabling it later from Settings."
              : ""}
          </p>
          <button
            type="button"
            onClick={() => {
              clearPersistedBootstrapState();
              router.push(continueRoute);
            }}
            className="mt-4 rounded-xl bg-accent px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-accent-hover"
            data-testid="bootstrap-continue"
          >
            {autoContinuing ? "Opening import workspace…" : "Open import workspace"}
          </button>
        </section>
      )}
      {hydrated && showCoreReadyCard && (
        <section
          className="rounded-[28px] border-2 border-rule bg-sunk p-5 shadow-sm"
          data-testid="bootstrap-core-ready"
        >
          <h2 className="text-xl font-semibold text-body">
            Workspace core is ready.
          </h2>
          <p className="mt-2 text-sm text-body">
            Your local research store, OpenClaw runtime, and local model are ready.
            Code execution is still warming up, so some setup tasks may keep running in
            the background. You can open the import workspace now and finish the rest
            from <code>/dashboard/settings</code>.
          </p>
          <button
            type="button"
            onClick={() => router.push("/dashboard/study")}
            className="mt-4 rounded-xl bg-accent px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-accent-hover"
            data-testid="bootstrap-continue"
          >
            Open import workspace
          </button>
        </section>
      )}
      {hydrated && summary?.type === "summary" && summary.status === "failed" && (
        <section
          className="rounded-[28px] border-2 border-danger/30 bg-danger/10 p-5 shadow-sm"
          data-testid="bootstrap-failed"
          role="alert"
        >
          <h2 className="text-xl font-semibold text-danger">
            Setup did not complete.
          </h2>
          {summary.error ? (
            <p className="mt-2 text-sm text-danger" data-testid="bootstrap-failed-error">
              {summary.error}
            </p>
          ) : (
            <p className="mt-2 text-sm text-danger">
              See the per-task errors above. Fix the issue and try setup again.
            </p>
          )}
          <button
            type="button"
            onClick={resetSetup}
            className="mt-4 rounded-xl border border-danger/40 px-5 py-2.5 text-sm font-semibold text-danger transition-colors hover:bg-danger/10"
            data-testid="bootstrap-retry"
          >
            Start setup again
          </button>
        </section>
      )}
      {hydrated && summary?.type === "summary" && summary.status === "partial" && (
        <section
          className="rounded-[28px] border-2 border-warn/30 bg-warn/10 p-5 shadow-sm"
          data-testid="bootstrap-partial"
        >
          <h2 className="text-xl font-semibold text-warn">
            {shouldAutoContinue(summary) ? "Core setup is ready." : "Setup partially complete."}
          </h2>
          <p className="mt-2 text-sm text-warn">
            {shouldAutoContinue(summary)
              ? "ScienceSwarm can continue with local chat and the import workspace. Optional runtime pieces can be finished later from /dashboard/settings."
              : "Some components failed. ScienceSwarm will run with what is available. Retry the rest from /dashboard/settings later."}
          </p>
          {shouldAutoContinue(summary) ? (
            <button
              type="button"
              onClick={() => {
                clearPersistedBootstrapState();
                router.push(continueRoute);
              }}
              className="mt-4 rounded-xl bg-accent px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-accent-hover"
            >
              Opening import workspace…
            </button>
          ) : (
            <button
              type="button"
              onClick={resetSetup}
              className="mt-4 rounded-xl border border-warn/40 px-5 py-2.5 text-sm font-semibold text-warn transition-colors hover:bg-warn/10"
            >
              Start setup again
            </button>
          )}
        </section>
      )}
    </main>
  );
}
