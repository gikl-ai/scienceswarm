"use client";

/**
 * OpenClaw section for /setup.
 *
 * Lifts the 4-step OpenClaw setup flow (install → configure → start →
 * stop) from `/dashboard/settings` into `/setup` so a new installer
 * can bring their agent backend online during onboarding instead of
 * later, in a buried settings tab.
 *
 * Behaviour contract
 *   * Wraps `POST /api/settings/openclaw` (`action: "install" |
 *     "configure" | "start" | "stop"`) and refreshes from `GET
 *     /api/settings/openclaw` after every action.
 *   * Seeded from the `initialStatus` prop — the page owns the first
 *     fetch via `GET /api/setup/status`. When that probe fails the
 *     page passes `null` and this component defaults the required
 *     backend choice to OpenClaw until the user picks NanoClaw.
 *   * Short-polls `GET /api/settings/openclaw` every 3s while an
 *     install is in flight (capped at 5 min) because `npm install -g`
 *     can take ~30s and the POST does not stream progress.
 *   * Never blocks save. If OpenClaw fails to install or configure we
 *     surface the truncated error inline with a copy-able fallback
 *     command; the parent page stays free to submit `.env` regardless.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Spinner } from "@/components/spinner";

export type AgentBackend = "openclaw" | "nanoclaw" | "none";
type SelectableAgentBackend = Exclude<AgentBackend, "none">;

export interface OpenClawInitialStatus {
  installed: boolean;
  configured: boolean;
  running: boolean;
}

export interface OpenClawSectionProps {
  initialStatus: OpenClawInitialStatus | null;
  initialStatusLoading?: boolean;
  onBackendChange?: (backend: AgentBackend) => void;
  /**
   * Tracks the currently-typed OpenAI key value in the parent form.
   * Used for visible hints that don't block user action (e.g. "key
   * looks good as you type"). Do NOT use this to gate Configure —
   * the server's Configure action reads OPENAI_API_KEY from `.env`
   * on disk, not the typed-but-unsaved state. Use
   * `hasSavedOpenAiKey` for that.
   */
  hasOpenAiKey: boolean;
  /**
   * Whether an OpenAI key is actually persisted to `.env` (i.e. the
   * status payload reports the key as configured / redacted). Gates
   * the Configure button and its "save first" hint so a user who has
   * typed but not saved a key sees a disabled button rather than
   * hitting an opaque server-side failure.
   */
  hasSavedOpenAiKey: boolean;
  /**
   * The LLM provider the user picked upstream (`openai` | `local`).
   * When `local`, Configure does not require an OpenAI key — OpenClaw
   * can run against the local Ollama daemon — so the OpenAI-key gate
   * and "save first" hint are suppressed. Defaults to `openai` when
   * omitted to preserve historical behavior.
   */
  llmProvider?: "openai" | "local";
  /**
   * Optional seed for the backend radio. When the parent has a
   * concrete `AGENT_BACKEND` value on disk (e.g. a returning user's
   * `.env` holds `nanoclaw`), pass it here so the radio lands on the
   * correct option rather than falling back to the probe-based
   * "installed → openclaw, else required-openclaw" heuristic — which would
   * silently disagree with the persisted value.
   */
  initialBackend?: AgentBackend;
  disabled?: boolean;
  showBackendChoice?: boolean;
  showNanoClawFallback?: boolean;
  /**
   * Extra controls to render inside the OpenClaw flow card, below the
   * status pill and action buttons. Used by /setup to inline the
   * Telegram bot token next to the agent-backend controls that will
   * actually use it.
   */
  extraControls?: ReactNode;
  /**
   * When true, auto-start OpenClaw when it is configured but not
   * running. Manual Start/Configure/Install buttons are hidden while
   * auto-start is in progress and only shown if auto-start fails.
   * Used on Settings to keep the UI clean when auto-remediation is
   * active from the study page. Defaults to false to preserve
   * behaviour for /setup.
   */
  autoStart?: boolean;
}

type ActionName = "install" | "configure" | "start" | "stop";

interface OpenClawStatusPayload {
  installed?: boolean;
  configured?: boolean;
  running?: boolean;
}

interface OpenClawActionError {
  error?: string;
}

// Poll every 3s while an install is in flight. Cap total polling at
// 5 minutes so a truly stuck install doesn't leak an interval
// indefinitely.
const INSTALL_POLL_INTERVAL_MS = 3_000;
const INSTALL_POLL_MAX_MS = 5 * 60 * 1_000;

// Inline error messages are capped so a pathological server response
// (e.g. a stack trace) can't blow up the layout.
const ERROR_MAX_CHARS = 300;

// Canonical recovery command shown alongside an install/configure
// failure. Keeping this in a constant makes it trivial to update in
// both the UI and the tests if the install story ever changes.
const INSTALL_COMMAND = "npm install -g openclaw";

function LoadingSpinner({
  testId,
  size = "h-3.5 w-3.5",
}: {
  testId?: string;
  size?: string;
}) {
  return <Spinner size={size} testId={testId} />;
}

function StatusDot({
  testId,
  tone,
}: {
  testId?: string;
  tone: "neutral" | "progress" | "ready";
}) {
  const className =
    tone === "ready"
      ? "bg-ok"
      : tone === "progress"
        ? "bg-warn"
        : "bg-dim";
  return (
    <span
      aria-hidden="true"
      data-testid={testId}
      className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${className}`}
    />
  );
}

function truncateError(message: string): string {
  const trimmed = message.trim();
  if (trimmed.length <= ERROR_MAX_CHARS) return trimmed;
  return `${trimmed.slice(0, ERROR_MAX_CHARS - 1).trimEnd()}…`;
}

async function parseActionError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as OpenClawActionError;
    if (typeof body.error === "string" && body.error.trim().length > 0) {
      return body.error;
    }
  } catch {
    // Falls through to the HTTP-status fallback below.
  }
  return `Request failed (HTTP ${res.status}).`;
}

function statusPillFor(
  status: OpenClawInitialStatus | null,
): { label: string; tone: "neutral" | "progress" | "ready" } {
  if (!status || !status.installed) {
    return { label: "Not installed", tone: "neutral" };
  }
  if (status.running) {
    return { label: "Running", tone: "ready" };
  }
  if (status.configured) {
    return { label: "Configured, not running", tone: "progress" };
  }
  return { label: "Installed", tone: "progress" };
}

export function OpenClawSection({
  initialStatus,
  initialStatusLoading = false,
  onBackendChange,
  hasOpenAiKey,
  hasSavedOpenAiKey,
  llmProvider = "openai",
  initialBackend,
  disabled = false,
  showBackendChoice = true,
  showNanoClawFallback = true,
  extraControls,
  autoStart = false,
}: OpenClawSectionProps) {
  // If the parent seeded a concrete backend (from the on-disk
  // `AGENT_BACKEND` value), honour it — a returning user whose
  // `.env` holds `nanoclaw` must land on that radio even if the
  // OpenClaw CLI is not installed locally. Historical callers can
  // still pass `"none"` here; setup now normalizes that legacy value
  // to the required OpenClaw default instead of rendering a skip path.
  //
  // Cubic P2 (PR #208): we derive the radio value during render rather
  // than seeding once with `useState(() => derivedBackend)` so a late
  // `/api/setup/status` hydration reaches the radio. Previously the
  // initial `null` prop on first paint snapshotted the probe default and an
  // async `AGENT_BACKEND=nanoclaw` hydration was silently ignored.
  // This mirrors the OllamaSection fix — `localBackend` overlays the
  // derived value once the user acts, so their click is preserved
  // across any subsequent prop update.
  const derivedBackend: SelectableAgentBackend =
    initialBackend === "nanoclaw" ? "nanoclaw" : "openclaw";
  const [localBackend, setLocalBackend] =
    useState<SelectableAgentBackend | null>(null);
  const [userActedOnBackend, setUserActedOnBackend] = useState(false);
  const backend: SelectableAgentBackend =
    userActedOnBackend && localBackend !== null
      ? localBackend
      : derivedBackend;
  // Derive `status` during render so an async-hydrated `initialStatus`
  // prop reaches the UI. User actions (install/configure/start) flip
  // `statusUserActed` and populate `localStatus` via the refresh helpers;
  // after that, the component owns the probe state (same pattern as
  // `OllamaSection`).
  const [localStatus, setLocalStatus] = useState<OpenClawInitialStatus | null>(
    null,
  );
  const [statusUserActed, setStatusUserActed] = useState(false);
  const status =
    statusUserActed && localStatus !== null ? localStatus : initialStatus;
  const [inFlight, setInFlight] = useState<ActionName | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [showInstallRecoveryHint, setShowInstallRecoveryHint] = useState(false);
  // Tracks auto-start: null = not attempted, true = succeeded/in-progress,
  // false = failed (show manual controls).
  const [autoStartFailed, setAutoStartFailed] = useState(false);
  const autoStartAttemptedRef = useRef(false);

  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollDeadlineRef = useRef<number>(0);
  const normalizedLegacyBackendRef = useRef(false);

  const clearPolling = useCallback(() => {
    if (pollTimerRef.current !== null) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    pollDeadlineRef.current = 0;
  }, []);

  // Clean up any pending interval when the component unmounts so a
  // long install poll can't survive a navigation away from /setup.
  useEffect(() => {
    return () => {
      clearPolling();
    };
  }, [clearPolling]);

  useEffect(() => {
    if (userActedOnBackend || initialBackend !== "none") {
      return;
    }
    if (normalizedLegacyBackendRef.current) {
      return;
    }
    normalizedLegacyBackendRef.current = true;
    onBackendChange?.("openclaw");
  }, [initialBackend, onBackendChange, userActedOnBackend]);

  const refreshStatus = useCallback(async (): Promise<
    OpenClawInitialStatus | null
  > => {
    try {
      const res = await fetch("/api/settings/openclaw");
      if (!res.ok) return null;
      const body = (await res.json()) as OpenClawStatusPayload;
      const next: OpenClawInitialStatus = {
        installed: Boolean(body.installed),
        configured: Boolean(body.configured),
        running: Boolean(body.running),
      };
      setStatusUserActed(true);
      setLocalStatus(next);
      return next;
    } catch {
      return null;
    }
  }, []);

  const handleBackendChange = useCallback(
    (next: SelectableAgentBackend) => {
      setUserActedOnBackend(true);
      setLocalBackend(next);
      onBackendChange?.(next);
    },
    [onBackendChange],
  );

  const runAction = useCallback(
    async (action: ActionName) => {
      setInFlight(action);
      setErrorMessage(null);
      setShowInstallRecoveryHint(false);
      try {
        const res = await fetch("/api/settings/openclaw", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action }),
        });
        if (!res.ok) {
          const raw = await parseActionError(res);
          setErrorMessage(truncateError(raw));
          setShowInstallRecoveryHint(action === "install");
          return;
        }
        // Success path — always refetch so the UI mirrors what the
        // CLI actually did, even if the POST echoed a status envelope.
        const latest = await refreshStatus();
        if (action === "start" && latest && !latest.running) {
          setErrorMessage(
            "OpenClaw did not become reachable. Use Start to retry, or open onboarding to rerun setup.",
          );
        }
      } catch (err) {
        setErrorMessage(
          truncateError(
            err instanceof Error
              ? err.message
              : "Request failed — network error.",
          ),
        );
        setShowInstallRecoveryHint(action === "install");
      } finally {
        setInFlight(null);
      }
    },
    [refreshStatus],
  );

  const handleInstallClick = useCallback(async () => {
    // The install itself can take ~30s (npm global install). Start a
    // short poll alongside the POST so the pill flips to "Installed"
    // as soon as the CLI binary lands on PATH, even if the POST is
    // still in flight.
    clearPolling();
    pollDeadlineRef.current = Date.now() + INSTALL_POLL_MAX_MS;
    pollTimerRef.current = setInterval(() => {
      if (Date.now() > pollDeadlineRef.current) {
        clearPolling();
        return;
      }
      void refreshStatus().then((latest) => {
        if (latest?.installed) {
          clearPolling();
        }
      });
    }, INSTALL_POLL_INTERVAL_MS);

    try {
      await runAction("install");
    } finally {
      clearPolling();
    }
  }, [clearPolling, refreshStatus, runAction]);

  const handleConfigureClick = useCallback(() => {
    void runAction("configure");
  }, [runAction]);

  const handleStartClick = useCallback(() => {
    void runAction("start");
  }, [runAction]);

  // Auto-start: when `autoStart` is true and OpenClaw is configured but
  // not running, attempt to start it automatically on first render.
  // Only fires once per component mount. If it fails, `autoStartFailed`
  // flips to true and manual controls are shown.
  useEffect(() => {
    if (!autoStart) return;
    if (autoStartAttemptedRef.current) return;
    if (!status) return; // status not loaded yet
    if (!status.installed || !status.configured || status.running) return;
    // All conditions met: installed + configured + not running
    autoStartAttemptedRef.current = true;
    setInFlight("start");
    setErrorMessage(null);
    setShowInstallRecoveryHint(false);
    void (async () => {
      try {
        const res = await fetch("/api/settings/openclaw", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "start" }),
        });
        if (!res.ok) {
          const raw = await parseActionError(res);
          setErrorMessage(truncateError(raw));
          setShowInstallRecoveryHint(false);
          setAutoStartFailed(true);
        } else {
          const payload = await res.clone().json().catch(() => null) as
            | { running?: unknown; error?: unknown }
            | null;
          if (payload?.running === false) {
            setErrorMessage(
              truncateError(
                typeof payload.error === "string"
                  ? payload.error
                  : "OpenClaw did not become reachable automatically. Use Start to retry, or open onboarding to rerun setup.",
              ),
            );
            setAutoStartFailed(true);
            await refreshStatus();
            return;
          }
          const latest = await refreshStatus();
          if (!latest?.running) {
            setErrorMessage(
              "OpenClaw did not become reachable automatically. Use Start to retry, or open onboarding to rerun setup.",
            );
            setAutoStartFailed(true);
          }
        }
      } catch (err) {
        setErrorMessage(
          truncateError(
            err instanceof Error ? err.message : "Auto-start failed.",
          ),
        );
        setShowInstallRecoveryHint(false);
        setAutoStartFailed(true);
      } finally {
        setInFlight(null);
      }
    })();
  }, [autoStart, status, refreshStatus]);

  const installBusy = inFlight === "install";
  const configureBusy = inFlight === "configure";
  const startBusy = inFlight === "start";

  const installed = status?.installed === true;
  const configured = status?.configured === true;
  const running = status?.running === true;
  const checkingStatus =
    initialStatusLoading && !statusUserActed && inFlight === null;

  const pill = statusPillFor(status);
  const livePill =
    checkingStatus
      ? { label: "Checking", tone: "progress" as const, busy: true }
      : installBusy
      ? { label: "Installing", tone: "progress" as const, busy: true }
      : configureBusy
        ? { label: "Configuring", tone: "progress" as const, busy: true }
        : startBusy
          ? { label: "Starting", tone: "progress" as const, busy: true }
          : { ...pill, busy: false };
  const pillToneClass =
    livePill.tone === "ready"
      ? "border-ok/40 bg-ok/10 text-ok"
      : livePill.tone === "progress"
        ? "border-warn/40 bg-warn/10 text-warn"
        : "border-border bg-surface/60 text-muted";

  // Button availability mirrors the CLI state machine: install first,
  // then configure (needs an LLM reachable from .env), then start.
  //
  // The OpenAI key is only required when the user's chosen LLM
  // provider is OpenAI. If they picked Local (Ollama + Gemma) upstream,
  // OpenClaw configures against the local daemon and the key is moot
  // — gating on `hasSavedOpenAiKey` in that case would lock Configure
  // behind a credential the user never intends to provide.
  const openAiKeyRequired = llmProvider === "openai";
  const openAiKeyBlocksConfigure = openAiKeyRequired && !hasSavedOpenAiKey;
  const installDisabled = disabled || installed || installBusy;
  const configureDisabled =
    disabled ||
    !installed ||
    configured ||
    openAiKeyBlocksConfigure ||
    configureBusy;
  const startDisabled =
    disabled || !installed || !configured || running || startBusy;

  const configureTitle = openAiKeyBlocksConfigure
    ? hasOpenAiKey
      ? "OpenAI key needed — save first"
      : "OpenAI key needed"
    : undefined;

  const showOpenClawFlow = !showBackendChoice || backend === "openclaw";
  const showManualControls =
    !autoStart
    || autoStartFailed
    || !installed
    || !configured
    || (!running && !startBusy);

  const radioBaseClass =
    "flex cursor-pointer items-start gap-3 rounded-xl border-2 px-4 py-3 text-sm";
  const radioActiveClass = "border-accent bg-surface/40";
  const radioIdleClass = "border-border bg-white";

  return (
    <section
      className="rounded-[28px] border-2 border-border bg-white p-5 shadow-sm"
      data-testid="openclaw-section"
    >
      <p className="text-[10px] font-bold uppercase tracking-[0.24em] text-muted">
        AGENT BACKEND
      </p>
      <h2 className="mt-2 text-xl font-semibold text-foreground">
        OpenClaw backend
      </h2>
      <p className="mt-2 text-sm leading-6 text-muted">
        {showBackendChoice
          ? "OpenClaw (or NanoClaw) powers cross-channel agents — chat, email, Telegram. Choose one backend here so setup can route chat and automation through the same agent path end to end."
          : "OpenClaw powers local cross-channel agents — chat, email, and Telegram. Finish install, configure, and start here so onboarding and runtime use the same backend end to end."}
      </p>

      {showBackendChoice && (
        <div className="mt-4 space-y-2" role="radiogroup" aria-label="Agent backend">
          <label
            className={`${radioBaseClass} ${
              backend === "openclaw" ? radioActiveClass : radioIdleClass
            }`}
          >
            <input
              type="radio"
              name="openclaw-backend"
              value="openclaw"
              checked={backend === "openclaw"}
              onChange={() => handleBackendChange("openclaw")}
              disabled={disabled}
              className="mt-1 accent-accent"
            />
            <span>
              <span className="font-medium text-foreground">
                OpenClaw (recommended)
              </span>
              <span className="ml-2 text-xs text-muted">
                — Install during onboarding
              </span>
            </span>
          </label>

          <label
            className={`${radioBaseClass} ${
              backend === "nanoclaw" ? radioActiveClass : radioIdleClass
            }`}
          >
            <input
              type="radio"
              name="openclaw-backend"
              value="nanoclaw"
              checked={backend === "nanoclaw"}
              onChange={() => handleBackendChange("nanoclaw")}
              disabled={disabled}
              className="mt-1 accent-accent"
            />
            <span>
              <span className="font-medium text-foreground">NanoClaw</span>
              <span className="ml-2 text-xs text-muted">
                — Advanced — install separately
              </span>
            </span>
          </label>

        </div>
      )}

      {showOpenClawFlow && (
        <div
          className="mt-5 rounded-2xl border border-border bg-surface/30 p-4"
          data-testid="openclaw-flow"
        >
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs font-medium text-muted">
              OpenClaw local CLI status
            </p>
            <span
              data-testid="openclaw-status-pill"
              data-tone={livePill.tone}
              className={`inline-flex shrink-0 items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold ${pillToneClass}`}
            >
              {livePill.busy ? (
                <LoadingSpinner
                  testId="openclaw-status-spinner"
                  size="h-3 w-3"
                />
              ) : (
                <StatusDot
                  testId={
                    livePill.tone === "ready"
                      ? "openclaw-status-ready-indicator"
                      : undefined
                  }
                  tone={livePill.tone}
                />
              )}
              <span>{livePill.label}</span>
            </span>
          </div>

          {/* When autoStart is active, show a status-only view unless auto-start
              failed — in that case fall back to manual controls. On /setup
              (autoStart=false) the full button row is always shown. */}
          {autoStart && !autoStartFailed && running && (
            <p className="mt-3 text-xs text-ok" data-testid="openclaw-auto-status">
              OpenClaw started automatically and is running.
            </p>
          )}
          {autoStart && !autoStartFailed && startBusy && (
            <p className="mt-3 flex items-center gap-2 text-xs text-warn" data-testid="openclaw-auto-starting">
              <LoadingSpinner size="h-3 w-3" />
              <span>Auto-starting OpenClaw...</span>
            </p>
          )}

          {showManualControls && (
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <button
                type="button"
                data-testid="openclaw-install-button"
                onClick={handleInstallClick}
                disabled={installDisabled}
                className="inline-flex items-center gap-2 rounded-xl border-2 border-border bg-white px-4 py-2 text-sm font-medium text-foreground transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
              >
                {installBusy && (
                  <LoadingSpinner
                    testId="openclaw-install-spinner"
                    size="h-3 w-3"
                  />
                )}
                <span>{installBusy ? "Installing…" : "Install"}</span>
              </button>
              <button
                type="button"
                data-testid="openclaw-configure-button"
                onClick={handleConfigureClick}
                disabled={configureDisabled}
                title={configureTitle}
                className="inline-flex items-center gap-2 rounded-xl border-2 border-border bg-white px-4 py-2 text-sm font-medium text-foreground transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
              >
                {configureBusy && (
                  <LoadingSpinner
                    testId="openclaw-configure-spinner"
                    size="h-3 w-3"
                  />
                )}
                <span>{configureBusy ? "Configuring…" : "Configure"}</span>
              </button>
              <button
                type="button"
                data-testid="openclaw-start-button"
                onClick={handleStartClick}
                disabled={startDisabled}
                className="inline-flex items-center gap-2 rounded-xl border-2 border-border bg-white px-4 py-2 text-sm font-medium text-foreground transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
              >
                {startBusy && (
                  <LoadingSpinner
                    testId="openclaw-start-spinner"
                    size="h-3 w-3"
                  />
                )}
                <span>{startBusy ? "Starting…" : "Start"}</span>
              </button>
            </div>
          )}

          {openAiKeyBlocksConfigure && (
            <p
              className="mt-3 text-xs text-muted"
              data-testid="openclaw-key-hint"
            >
              {hasOpenAiKey
                ? "OpenAI key needed — save first so Configure can read it from .env."
                : "Configure is disabled until you save an OpenAI API key above."}
            </p>
          )}

          {extraControls && (
            <div className="mt-4" data-testid="openclaw-extra-controls">
              {extraControls}
            </div>
          )}

          {errorMessage && (
            <div
              role="alert"
              data-testid="openclaw-error"
              className="mt-4 rounded-xl border border-danger/30 bg-danger/10 p-3 text-xs text-danger"
            >
              <p className="font-medium">Action failed</p>
              <p
                className="mt-1 leading-relaxed"
                data-testid="openclaw-error-message"
              >
                {errorMessage}
              </p>
              {showInstallRecoveryHint && (
              <div className="mt-3">
                <p className="text-[11px] font-medium text-danger">
                  Try installing it yourself, then come back:
                </p>
                <pre
                  data-testid="openclaw-install-command"
                  className="mt-1 overflow-x-auto rounded-lg border border-danger/30 bg-raised px-3 py-2 font-mono text-[11px] text-danger"
                >
                  {INSTALL_COMMAND}
                </pre>
                {showNanoClawFallback && (
                  <button
                    type="button"
                    data-testid="openclaw-switch-nanoclaw-button"
                    onClick={() => handleBackendChange("nanoclaw")}
                    className="mt-2 text-[11px] font-medium text-danger underline hover:text-danger/80"
                  >
                    Use NanoClaw instead
                  </button>
                )}
              </div>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
