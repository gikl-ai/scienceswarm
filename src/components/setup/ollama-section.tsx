"use client";

/**
 * Ollama section for the /setup page.
 *
 * Wraps the existing Ollama install / start / pull-model infrastructure
 * so users can set up a local model during onboarding. Advisory-only:
 * never blocks Save. Gracefully degrades when the binary is absent.
 *
 * Four UI states, all derived from the same probe shape:
 *   1. Not installed  — show install command + install URL fallback.
 *   2. Installed, not running — show start command.
 *   3. Running, missing model — show "Pull gemma4" button; poll progress.
 *   4. Running + model ready  — show green check.
 *
 * Probing hits the existing `/api/settings?action=local-health` POST,
 * and the pull flow uses `action=pull-model` + `action=pull-status`.
 * Initial status (when available) is seeded from `/api/setup/status`
 * via the `initialStatus` prop so the first paint doesn't flash empty.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import {
  OLLAMA_LOCAL_MODEL_OPTIONS,
  OLLAMA_RECOMMENDED_MODEL,
} from "@/lib/ollama-constants";
import {
  normalizeInstalledOllamaModels,
  ollamaModelsMatch,
} from "@/lib/ollama-models";
import type { OllamaStatusSummary } from "@/lib/setup/config-status";
import { Spinner } from "@/components/spinner";

/**
 * Recommended model the setup flow nudges users toward. Aliased from
 * the shared constant so the server probe in `/api/setup/status` and
 * this component cannot drift on which model is "the default".
 */
const RECOMMENDED_MODEL = OLLAMA_RECOMMENDED_MODEL;

/**
 * Polling cadence after a user action (install / start / pull). Tight
 * enough that the Start Ollama button transitions to "Running" within
 * ~1s of the daemon binding the port, loose enough that a stuck
 * daemon doesn't hammer the API.
 */
const PROBE_INTERVAL_MS = 1_000;
const PULL_POLL_INTERVAL_MS = 2_000;
/** Safety cap on polling to keep the tab from hammering the server. */
const MAX_POLL_DURATION_MS = 5 * 60 * 1_000;

type ProbeShape = Pick<
  OllamaStatusSummary,
  "installed" | "running" | "hasRecommendedModel" | "installCommand" | "startCommand"
> & { models: string[] };

/**
 * Derived UI state. Enumerating every branch up front keeps the
 * component body flat and makes the state transitions explicit.
 */
type DerivedState =
  | "unknown"
  | "not-installed"
  | "installed-not-running"
  | "running-missing-model"
  | "ready";

function deriveState(
  probe: ProbeShape | null,
  targetModelReady: boolean,
): DerivedState {
  if (probe === null) return "unknown";
  if (!probe.installed) return "not-installed";
  if (!probe.running) return "installed-not-running";
  if (!targetModelReady) return "running-missing-model";
  return "ready";
}

/**
 * Shape accepted from either `/api/setup/status` (which emits
 * `OllamaStatusSummary`) or `/api/settings?action=local-health`
 * (which spreads `OllamaInstallStatus` using `binaryInstalled`).
 * Normalizing here means the rest of the component only ever touches
 * `ProbeShape`.
 */
interface RawProbe {
  installed?: boolean;
  binaryInstalled?: boolean;
  running?: boolean;
  hasRecommendedModel?: boolean;
  installCommand?: string | null;
  startCommand?: string | null;
  models?: unknown;
}

function normalizeProbeModels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return normalizeInstalledOllamaModels(
    value.filter((item): item is string => typeof item === "string"),
  );
}

function resolveInstalledModel(installedModels: string[], targetModel: string): string | null {
  if (!targetModel.trim()) return null;
  return installedModels.find((model) => ollamaModelsMatch(targetModel, model)) ?? null;
}

function isRecommendedFamilyFallbackModel(model: string): boolean {
  const trimmed = model.trim();
  return trimmed === RECOMMENDED_MODEL || trimmed === `${RECOMMENDED_MODEL}:latest`;
}

function probeHasTargetModel(probe: ProbeShape | null, targetModel: string): boolean {
  if (!probe) return false;
  return resolveInstalledModel(probe.models, targetModel) !== null
    || (isRecommendedFamilyFallbackModel(targetModel) && Boolean(probe.hasRecommendedModel));
}

function buildSelectableModels(
  configuredModel: string,
  installedModels: string[],
): Array<{ value: string; label: string; description: string }> {
  const options: Array<{ value: string; label: string; description: string }> = [];
  const seen = new Set<string>();

  const addOption = (value: string, label: string, description: string) => {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    options.push({ value: trimmed, label, description });
  };

  for (const option of OLLAMA_LOCAL_MODEL_OPTIONS) {
    addOption(option.value, option.label, option.description);
  }

  for (const model of installedModels) {
    addOption(model, model, "Installed locally and ready once selected.");
  }

  if (configuredModel.trim()) {
    addOption(configuredModel, configuredModel, "Saved as the current local model.");
  }

  return options;
}

function normalizeProbe(raw: RawProbe | null | undefined): ProbeShape | null {
  if (!raw || typeof raw !== "object") return null;
  const installed = raw.installed ?? raw.binaryInstalled ?? false;
  return {
    installed,
    running: raw.running ?? false,
    hasRecommendedModel: raw.hasRecommendedModel ?? false,
    installCommand: raw.installCommand ?? undefined,
    startCommand: raw.startCommand ?? undefined,
    models: normalizeProbeModels(raw.models),
  };
}

export interface OllamaSectionProps {
  /** Initial probe seed, typically from `/api/setup/status`. */
  initialStatus: OllamaStatusSummary | null;
  /** Optional preloaded configured model from the parent settings page. */
  initialConfiguredModel?: string;
  /** Fired when a concrete local model becomes ready. */
  onModelSelected?: (model: string) => void;
  /** Fired after the configured local model is successfully saved. */
  onConfiguredModelChange?: (model: string) => void;
  /** Disable user interactions (e.g. while the parent form is saving). */
  disabled?: boolean;
  /** Lock the section to one required model instead of exposing model choice. */
  fixedModel?: string;
  /** Hide the local-model picker and keep the current target fixed. */
  showInstalledModelPicker?: boolean;
  /**
   * When true, drop the outer card styling + "Local model" heading so
   * the section can nest inside the Step 2 Language Model card (the
   * parent card already labels the region). Default `false` preserves
   * the standalone look for any remaining callers.
   */
  embedded?: boolean;
  /**
   * When true, automatically start Ollama and pull the target model
   * when the component detects they are needed. Manual action buttons
   * are hidden while auto-remediation is in progress and only shown
   * if it fails. Used on Settings to complement the project-page
   * auto-remediation hook. Default `false` preserves the interactive
   * /setup flow.
   */
  autoRemediate?: boolean;
}

function LoadingSpinner({
  testId,
  size = "h-3.5 w-3.5",
}: {
  testId?: string;
  size?: string;
}) {
  return <Spinner size={size} testId={testId} />;
}

export function OllamaSection({
  initialStatus,
  initialConfiguredModel,
  onModelSelected,
  onConfiguredModelChange,
  disabled = false,
  fixedModel,
  showInstalledModelPicker = true,
  embedded = false,
  autoRemediate = false,
}: OllamaSectionProps) {
  // Component-owned probe state that overlays the parent snapshot
  // once the user interacts (reprobe / pull). Before any user action,
  // we derive `probe` directly from `initialStatus` during render so
  // async parent hydration appears without an effect-driven setState
  // (which would trip `react-hooks/set-state-in-effect`).
  const [localProbe, setLocalProbe] = useState<ProbeShape | null>(null);
  const [userActed, setUserActed] = useState(false);
  const probe =
    userActed && localProbe !== null
      ? localProbe
      : normalizeProbe(initialStatus);

  const [pulling, setPulling] = useState(false);
  const [pullError, setPullError] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [configuredModel, setConfiguredModel] = useState(
    () => fixedModel?.trim() || initialConfiguredModel?.trim() || "",
  );
  const [configuredModelLoaded, setConfiguredModelLoaded] = useState(
    () => Boolean(fixedModel?.trim() || initialConfiguredModel?.trim()),
  );
  const [savingConfiguredModel, setSavingConfiguredModel] = useState(false);
  const [configuredModelError, setConfiguredModelError] = useState<string | null>(null);
  // Tick counter for the "Starting Ollama… (Ns)" label. Updates every
  // second while starting=true so the user has a concrete sign that
  // something is in flight (the old silent spinner looked frozen).
  const [startElapsedSec, setStartElapsedSec] = useState(0);

  const targetModel = fixedModel?.trim() || configuredModel.trim() || RECOMMENDED_MODEL;

  const probeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pullTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const probeStartedAtRef = useRef<number | null>(null);
  const pullStartedAtRef = useRef<number | null>(null);
  const unmountedRef = useRef(false);
  const notifiedModelRef = useRef<string | null>(null);

  const stopProbePolling = useCallback(() => {
    if (probeTimerRef.current !== null) {
      clearTimeout(probeTimerRef.current);
      probeTimerRef.current = null;
    }
    probeStartedAtRef.current = null;
  }, []);

  const stopPullPolling = useCallback(() => {
    if (pullTimerRef.current !== null) {
      clearTimeout(pullTimerRef.current);
      pullTimerRef.current = null;
    }
    pullStartedAtRef.current = null;
  }, []);

  useEffect(
    () => () => {
      unmountedRef.current = true;
      stopProbePolling();
      stopPullPolling();
    },
    [stopProbePolling, stopPullPolling],
  );

  useEffect(() => {
    if (fixedModel?.trim() || initialConfiguredModel?.trim()) {
      return;
    }

    let cancelled = false;

    const loadConfiguredModel = async () => {
      try {
        const response = await fetch("/api/settings");
        if (!response.ok) return;
        const body = (await response.json()) as { ollamaModel?: unknown };
        if (cancelled || typeof body.ollamaModel !== "string") return;

        const nextModel = body.ollamaModel.trim();
        if (nextModel) {
          setConfiguredModel(nextModel);
        }
      } catch {
        // Setup still works with the recommended fallback if settings
        // cannot be loaded here.
      } finally {
        if (!cancelled) {
          setConfiguredModelLoaded(true);
        }
      }
    };

    void loadConfiguredModel();

    return () => {
      cancelled = true;
    };
  }, [fixedModel, initialConfiguredModel]);

  const fetchProbe = useCallback(async (): Promise<ProbeShape | null> => {
    try {
      const response = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "local-health" }),
      });
      if (!response.ok) return null;
      const body = (await response.json()) as RawProbe;
      return normalizeProbe(body);
    } catch {
      return null;
    }
  }, []);

  const advanceProbeOnce = useCallback(async () => {
    const next = await fetchProbe();
    if (unmountedRef.current) return;
    if (next !== null) {
      setUserActed(true);
      setLocalProbe(next);
    }
  }, [fetchProbe]);

  /**
   * Begin polling `local-health` every PROBE_INTERVAL_MS until the
   * derived state advances past `baseline` or MAX_POLL_DURATION_MS
   * elapses. Safe to call multiple times — only the latest loop runs.
   */
  const startProbePolling = useCallback(
    (baseline: DerivedState) => {
      stopProbePolling();
      probeStartedAtRef.current = Date.now();
      const tick = async () => {
        const startedAt = probeStartedAtRef.current;
        if (startedAt === null) return;
        if (Date.now() - startedAt > MAX_POLL_DURATION_MS) {
          stopProbePolling();
          setInstalling(false);
          setStarting(false);
          return;
        }
        const next = await fetchProbe();
        if (unmountedRef.current) return;
        if (next !== null) {
          setUserActed(true);
          setLocalProbe(next);
        }
        if (next !== null && deriveState(next, probeHasTargetModel(next, targetModel)) !== baseline) {
          stopProbePolling();
          // The probe advanced past the baseline (e.g. daemon came up
          // after a Start click). Clear the transient `starting` flag
          // so a later daemon crash / reprobe loop doesn't spuriously
          // flip the UI back into "Starting Ollama…" without the user
          // ever clicking Start again.
          setInstalling(false);
          setStarting(false);
          return;
        }
        probeTimerRef.current = setTimeout(tick, PROBE_INTERVAL_MS);
      };
      probeTimerRef.current = setTimeout(tick, PROBE_INTERVAL_MS);
    },
    [fetchProbe, stopProbePolling, targetModel],
  );

  const installedModels = probe?.models ?? [];
  const selectedInstalledModel = resolveInstalledModel(installedModels, targetModel);
  const targetModelReady = probeHasTargetModel(probe, targetModel);
  const derived = deriveState(probe, targetModelReady);
  const configuredOrSelectedModel =
    (selectedInstalledModel ?? (fixedModel?.trim() ? targetModel : configuredModel.trim())) || null;
  const readyModel =
    derived === "ready"
      ? selectedInstalledModel ?? (configuredModelLoaded ? targetModel : null)
      : null;
  const selectableModels = buildSelectableModels(configuredModel, installedModels);

  // Notify the parent when a concrete local model is actually usable.
  // When local-health reports installed models, prefer the exact
  // installed tag; otherwise fall back to the recommended model in the
  // existing ready state so the setup page can keep its current
  // "recommended by default" behavior.
  useEffect(() => {
    if (!readyModel || notifiedModelRef.current === readyModel) return;
    notifiedModelRef.current = readyModel;
    onModelSelected?.(readyModel);
  }, [onModelSelected, readyModel]);

  const handleConfiguredModelChange = useCallback(async (nextModel: string) => {
    if (disabled || fixedModel?.trim()) return;

    const trimmed = nextModel.trim();
    const previousModel = configuredModel.trim();
    if (!trimmed || trimmed === previousModel) return;

    setConfiguredModel(trimmed);
    setConfiguredModelLoaded(true);
    setConfiguredModelError(null);
    setSavingConfiguredModel(true);

    try {
      const response = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "save-ollama-model",
          ollamaModel: trimmed,
        }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        ollamaModel?: string;
      };
      if (!response.ok || body.ok === false) {
        throw new Error(
          typeof body.error === "string" && body.error.trim().length > 0
            ? body.error
            : "Failed to save the local model.",
        );
      }

      const savedModel = body.ollamaModel?.trim() || trimmed;
      setConfiguredModel(savedModel);
      onConfiguredModelChange?.(savedModel);
    } catch (error) {
      setConfiguredModel(previousModel);
      setConfiguredModelError(
        error instanceof Error && error.message.trim().length > 0
          ? error.message
          : "Failed to save the local model.",
      );
    } finally {
      setSavingConfiguredModel(false);
    }
  }, [configuredModel, disabled, fixedModel, onConfiguredModelChange]);

  const handleReprobe = useCallback(
    async (baseline: DerivedState) => {
      setUserActed(true);
      await advanceProbeOnce();
      startProbePolling(baseline);
    },
    [advanceProbeOnce, startProbePolling],
  );

  // Upper bound on how long we show "Starting Ollama…" before giving
  // up and surfacing an actionable error. `nohup ollama serve` and
  // `brew services start ollama` both bind on localhost:11434 within
  // 2–4s on a healthy system. 15s is generous for a cold start while
  // still bailing fast enough that a misconfigured binary path or a
  // port conflict surfaces as a concrete failure instead of a frozen
  // spinner.
  const START_TIMEOUT_MS = 15_000;

  // Kick off `ollama serve` server-side and poll local-health until the
  // daemon is up. Replaces the old copy-paste-a-nohup-command UX: one
  // click, the caller sees "Starting…" then "Running" without ever
  // leaving the browser.
  const handleStartClick = useCallback(async () => {
    if (disabled || starting) return;
    setUserActed(true);
    setStartError(null);
    setStartElapsedSec(0);
    setStarting(true);
    try {
      const response = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start-ollama" }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!response.ok || body.ok === false) {
        setStarting(false);
        setStartError(
          typeof body.error === "string" && body.error.length > 0
            ? body.error
            : "Failed to start Ollama.",
        );
        return;
      }
    } catch (err) {
      setStarting(false);
      setStartError(
        err instanceof Error && err.message.length > 0
          ? err.message
          : "Failed to start Ollama.",
      );
      return;
    }
    // Daemon launch is async — kick off a probe immediately so users
    // whose daemon binds in well under PROBE_INTERVAL_MS see the
    // button flip to "Running" without an extra 1s wait, then start
    // the polling loop for slower cold starts.
    const immediate = await fetchProbe();
    if (unmountedRef.current) return;
    if (immediate !== null) {
      setUserActed(true);
      setLocalProbe(immediate);
      if (deriveState(immediate, probeHasTargetModel(immediate, targetModel)) !== "installed-not-running") {
        // Already up — no need to poll; the derived state will drive
        // the UI and we clear the transient starting flag here.
        setStarting(false);
        return;
      }
    }
    startProbePolling("installed-not-running");
  }, [disabled, fetchProbe, starting, startProbePolling, targetModel]);

  const handleInstallClick = useCallback(async () => {
    if (disabled || installing) return;
    setUserActed(true);
    setInstallError(null);
    setInstalling(true);
    try {
      const response = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "install-ollama" }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        installing?: boolean;
        alreadyInstalled?: boolean;
        error?: string;
      };
      if (!response.ok || body.ok === false) {
        setInstalling(false);
        setInstallError(
          typeof body.error === "string" && body.error.length > 0
            ? body.error
            : "Failed to start the Ollama install.",
        );
        return;
      }
      if (body.alreadyInstalled) {
        setInstalling(false);
        await advanceProbeOnce();
        return;
      }
    } catch (err) {
      setInstalling(false);
      setInstallError(
        err instanceof Error && err.message.length > 0
          ? err.message
          : "Failed to start the Ollama install.",
      );
      return;
    }

    const immediate = await fetchProbe();
    if (unmountedRef.current) return;
    if (immediate !== null) {
      setUserActed(true);
      setLocalProbe(immediate);
      if (deriveState(immediate, probeHasTargetModel(immediate, targetModel)) !== "not-installed") {
        setInstalling(false);
        return;
      }
    }
    startProbePolling("not-installed");
  }, [advanceProbeOnce, disabled, fetchProbe, installing, startProbePolling, targetModel]);

  // Only show the "Starting…" UI while we're genuinely waiting on the
  // daemon — once the probe advances past `installed-not-running` the
  // daemon is up (or something else went wrong) and the parent state
  // machine takes over. Deriving during render instead of mutating via
  // an effect avoids the `react-hooks/set-state-in-effect` cascade.
  const effectiveStarting =
    starting && (derived === "installed-not-running" || derived === "unknown");

  // Tick an elapsed-seconds counter while starting is true and bail
  // out with a helpful error if we exceed START_TIMEOUT_MS — keeps the
  // user from watching an apparently-frozen "Starting…" pill forever
  // when `exec('ollama serve')` silently failed (bad PATH, port in
  // use, LaunchAgent permissions, etc.).
  useEffect(() => {
    if (!effectiveStarting) return;
    const started = Date.now();
    const interval = setInterval(() => {
      const elapsedMs = Date.now() - started;
      setStartElapsedSec(Math.floor(elapsedMs / 1000));
      if (elapsedMs >= START_TIMEOUT_MS) {
        clearInterval(interval);
        // Also stop the background probe loop — without this it
        // would keep hammering `local-health` every second for the
        // remainder of MAX_POLL_DURATION_MS (up to 5 min) on a start
        // that already failed.
        stopProbePolling();
        if (!unmountedRef.current) {
          setStarting(false);
          setStartError(
            "Ollama didn't come online within 15s. It may have failed to "
              + "start — try the manual command below or check "
              + "/tmp/ollama-serve.log for errors.",
          );
        }
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [effectiveStarting, stopProbePolling]);

  // Ref-indirection breaks the self-reference that a straight
  // `useCallback(pollPullStatus, [pollPullStatus])` would create.
  const pollPullStatusRef = useRef<() => Promise<void>>(async () => undefined);
  const pollPullStatus = useCallback(async () => {
    const startedAt = pullStartedAtRef.current;
    if (startedAt === null) return;
    if (Date.now() - startedAt > MAX_POLL_DURATION_MS) {
      stopPullPolling();
      if (!unmountedRef.current) {
        setPulling(false);
        setPullError("Pull timed out. Try again.");
      }
      return;
    }

    let stillPulling = false;
    let errorMessage: string | null = null;
    try {
      const response = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "pull-status",
          ollamaModel: targetModel,
        }),
      });
      if (response.ok) {
        const body = (await response.json()) as {
          pulling?: boolean;
          error?: string | null;
        };
        stillPulling = Boolean(body.pulling);
        errorMessage = typeof body.error === "string" ? body.error : null;
      }
    } catch {
      // Network hiccup — try again on the next tick unless we've
      // exceeded the polling cap.
    }

    if (unmountedRef.current) return;

    if (errorMessage) {
      stopPullPolling();
      setPulling(false);
      setPullError(errorMessage);
      await advanceProbeOnce();
      return;
    }

    if (!stillPulling) {
      stopPullPolling();
      setPulling(false);
      await advanceProbeOnce();
      return;
    }

    // Refresh the main probe alongside the pull status so the green
    // check appears the instant the model finishes installing.
    await advanceProbeOnce();
    pullTimerRef.current = setTimeout(
      () => pollPullStatusRef.current(),
      PULL_POLL_INTERVAL_MS,
    );
  }, [advanceProbeOnce, stopPullPolling, targetModel]);

  // Keep the ref tracking the latest `pollPullStatus` so scheduled
  // setTimeout callbacks always call the current closure. Writing the
  // ref during render would break React's strict rules; an effect is
  // the right place.
  useEffect(() => {
    pollPullStatusRef.current = pollPullStatus;
  }, [pollPullStatus]);

  const handlePullClick = useCallback(async () => {
    if (disabled || pulling) return;
    setUserActed(true);
    setPullError(null);
    setPulling(true);
    try {
      const response = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "pull-model",
          ollamaModel: targetModel,
        }),
      });
      const body = (await response
        .json()
        .catch(() => ({}))) as {
        ok?: boolean;
        pulling?: boolean;
        alreadyPresent?: boolean;
        error?: string;
      };
      if (!response.ok || body.ok === false) {
        setPulling(false);
        setPullError(
          typeof body.error === "string" && body.error.length > 0
            ? body.error
            : "Failed to start model pull.",
        );
        return;
      }
      if (body.alreadyPresent) {
        setPulling(false);
        await advanceProbeOnce();
        return;
      }
    } catch (err) {
      setPulling(false);
      setPullError(
        err instanceof Error && err.message.length > 0
          ? err.message
          : "Failed to start model pull.",
      );
      return;
    }

    stopPullPolling();
    pullStartedAtRef.current = Date.now();
    pullTimerRef.current = setTimeout(
      () => pollPullStatusRef.current(),
      PULL_POLL_INTERVAL_MS,
    );
  }, [advanceProbeOnce, disabled, pulling, stopPullPolling, targetModel]);

  // ── Auto-remediation ──
  // When `autoRemediate` is true, automatically start Ollama and pull
  // the target model on first render if they are needed. Each step
  // fires at most once.
  const autoStartAttemptedRef = useRef(false);
  const autoPullAttemptedRef = useRef(false);
  const [autoRemediateFailed, setAutoRemediateFailed] = useState(false);

  useEffect(() => {
    if (!autoRemediate) return;
    if (derived === "unknown") return; // still loading
    if (!configuredModelLoaded) return;

    // Auto-start Ollama if installed but not running
    if (derived === "installed-not-running" && !autoStartAttemptedRef.current) {
      autoStartAttemptedRef.current = true;
      void handleStartClick();
    }
  }, [autoRemediate, configuredModelLoaded, derived, handleStartClick]);

  useEffect(() => {
    if (!autoRemediate) return;
    if (derived === "unknown") return;
    if (!configuredModelLoaded) return;

    // Auto-pull model if Ollama is running but model is missing
    if (derived === "running-missing-model" && !autoPullAttemptedRef.current) {
      autoPullAttemptedRef.current = true;
      void handlePullClick();
    }
  }, [autoRemediate, configuredModelLoaded, derived, handlePullClick]);

  // Track auto-remediation failure: if start or pull errored while
  // auto-remediate is active, show manual controls as a fallback.
  useEffect(() => {
    if (!autoRemediate) return;
    if ((startError || installError || pullError) && !autoRemediateFailed) {
      setAutoRemediateFailed(true);
    }
  }, [autoRemediate, startError, installError, pullError, autoRemediateFailed]);

  // Whether to hide manual controls: autoRemediate is on, no failure
  // has occurred, and we haven't reached the ready state yet.
  const hideManualControls =
    autoRemediate && !autoRemediateFailed && derived !== "ready";

  const handleCopy = useCallback(async (key: string, value: string) => {
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(value);
      }
    } catch {
      // Clipboard unavailable (permissions, insecure context). The
      // command is still visible on screen — the copy button is a
      // convenience, not a requirement.
    }
    setCopiedKey(key);
    setTimeout(() => {
      setCopiedKey((prev) => (prev === key ? null : prev));
    }, 1500);
  }, []);

  const sectionClass = embedded
    ? "mt-5 rounded-2xl border border-border bg-surface/30 p-4"
    : "rounded-[28px] border-2 border-border bg-white p-5 shadow-sm";
  const commandBoxClass =
    "mt-2 flex items-start gap-2 rounded-xl border border-border bg-surface/40 px-3 py-2 font-mono text-xs text-foreground";
  const primaryButtonClass =
    "rounded-xl border border-border bg-white px-4 py-2 text-sm font-medium text-foreground transition-colors hover:border-accent hover:text-accent disabled:opacity-50";
  const pullButtonClass =
    "rounded-xl bg-accent px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-accent-hover disabled:opacity-50";

  const renderConfiguredModelCard = () => {
    if (!configuredOrSelectedModel) return null;

    return (
      <div
        className="rounded-xl border border-border bg-white/70 px-3 py-3"
        data-testid={selectedInstalledModel ? "ollama-selected-model" : "ollama-configured-model"}
      >
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">
          {fixedModel?.trim()
            ? "Required local model"
            : selectedInstalledModel
              ? "Selected local model"
              : "Configured local model"}
        </p>
        <p className="mt-1 text-sm font-medium text-foreground">
          {configuredOrSelectedModel}
        </p>
        <p className="mt-1 text-xs text-muted">
          {fixedModel?.trim()
            ? "Onboarding uses this local Gemma model and does not expose model switching here."
            : selectedInstalledModel
            ? "Installed locally and ready to use for this setup flow."
            : "This is the current local-model choice saved for setup."}
        </p>
      </div>
    );
  };

  const renderModelPicker = () => {
    if (!showInstalledModelPicker || fixedModel?.trim()) {
      return null;
    }

    return (
      <label className="mt-4 block space-y-2" data-testid="ollama-model-picker">
        <span className="text-xs font-medium uppercase tracking-[0.14em] text-muted">
          Choose local model
        </span>
        <select
          value={targetModel}
          onChange={(event) => {
            void handleConfiguredModelChange(event.target.value);
          }}
          disabled={disabled || savingConfiguredModel || pulling}
          className="w-full rounded-xl border border-border bg-white px-3 py-2 text-sm text-foreground disabled:opacity-50"
          data-testid="ollama-model-select"
        >
          {selectableModels.map((model) => (
            <option key={model.value} value={model.value}>
              {model.label}
            </option>
          ))}
        </select>
        <p className="text-xs text-muted">
          ScienceSwarm defaults to {RECOMMENDED_MODEL}. You can switch to any saved or
          installed local model listed here, including the larger Gemma variants exposed
          in Settings.
        </p>
        {savingConfiguredModel && (
          <p className="text-xs text-muted" data-testid="ollama-model-saving">
            Saving local model…
          </p>
        )}
        {configuredModelError && (
          <p
            className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700"
            data-testid="ollama-model-error"
          >
            {configuredModelError}
          </p>
        )}
      </label>
    );
  };

  return (
    <section
      className={sectionClass}
      data-testid="ollama-section"
      data-state={derived}
    >
      {!embedded && (
        <>
          <p className="text-[10px] font-bold uppercase tracking-[0.24em] text-muted">
            OPTIONAL
          </p>
          <h2 className="mt-2 text-xl font-semibold text-foreground">
            Local model (Ollama + Gemma)
          </h2>
          <p className="mt-2 text-sm leading-6 text-muted">
            Free, private, no API key needed. Optional — you can always use OpenAI.
          </p>
        </>
      )}

      {renderModelPicker()}

      {derived === "unknown" && (
        <div
          className="mt-4 flex items-center gap-2 text-xs text-muted"
          data-testid="ollama-unknown-hint"
        >
          <LoadingSpinner testId="ollama-probe-spinner" />
          <span>Checking for a local Ollama install…</span>
        </div>
      )}

      {derived === "not-installed" && (
        <div className="mt-4 space-y-3" data-testid="ollama-not-installed">
          <p className="text-sm text-foreground">
            Ollama isn&apos;t installed yet. Run this in your terminal:
          </p>
          <button
            type="button"
            onClick={handleInstallClick}
            disabled={disabled || installing}
            className={pullButtonClass}
            data-testid="ollama-install-button"
          >
            {installing ? "Installing Ollama…" : "Install Ollama"}
          </button>
          {installing && (
            <div
              className="space-y-2 text-xs text-muted"
              data-testid="ollama-install-progress"
            >
              <div className="flex items-center gap-2">
                <LoadingSpinner testId="ollama-install-spinner" />
                <span>Starting the local Ollama install and checking for the binary.</span>
              </div>
              {probe?.installCommand && (
                <code
                  className="block rounded-lg border border-border bg-white px-3 py-2 font-mono text-[11px] text-foreground"
                  data-testid="ollama-install-progress-command"
                >
                  {probe.installCommand}
                </code>
              )}
            </div>
          )}
          {installError && !installing && (
            <div
              className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700"
              data-testid="ollama-install-error"
            >
              {installError.length > 240
                ? `${installError.slice(0, 240)}…`
                : installError}
              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleInstallClick}
                  disabled={disabled}
                  className="rounded-lg border border-red-300 bg-white px-3 py-1 text-xs font-medium text-red-700 hover:border-red-500 disabled:opacity-50"
                  data-testid="ollama-install-retry"
                >
                  Try again
                </button>
                {probe?.installCommand && (
                  <button
                    type="button"
                    onClick={() =>
                      handleCopy("install", probe.installCommand ?? "")
                    }
                    disabled={disabled}
                    className="rounded-lg border border-border bg-white px-3 py-1 text-xs font-medium text-foreground hover:border-accent hover:text-accent disabled:opacity-50"
                  >
                    {copiedKey === "install"
                      ? "Copied install command"
                      : "Copy install command"}
                  </button>
                )}
              </div>
            </div>
          )}
          {probe?.installCommand ? (
            <div className={commandBoxClass}>
              <code
                className="flex-1 break-all"
                data-testid="ollama-install-command"
              >
                {probe.installCommand}
              </code>
              <button
                type="button"
                onClick={() =>
                  handleCopy("install", probe.installCommand ?? "")
                }
                disabled={disabled}
                className="shrink-0 rounded-lg border border-border bg-white px-2 py-1 text-[11px] font-medium text-foreground hover:border-accent hover:text-accent disabled:opacity-50"
                aria-label="Copy install command"
              >
                {copiedKey === "install" ? "Copied" : "Copy"}
              </button>
            </div>
          ) : (
            <p className="text-xs text-muted">
              No automated installer is available for this platform.
            </p>
          )}
          <p className="text-xs text-muted">
            Or download from{" "}
            <a
              href="https://ollama.com/download"
              target="_blank"
              rel="noreferrer noopener"
              data-testid="ollama-install-url"
              className="font-medium text-accent underline-offset-2 hover:underline"
            >
              ollama.com/download
            </a>
            .
          </p>
          <button
            type="button"
            onClick={() => handleReprobe("not-installed")}
            disabled={disabled}
            className={primaryButtonClass}
            data-testid="ollama-reprobe-installed"
          >
            I&apos;ve installed it
          </button>
        </div>
      )}

      {derived === "installed-not-running" && (
        <div
          className="mt-4 space-y-3"
          data-testid="ollama-installed-not-running"
        >
          {hideManualControls ? (
            /* Auto-remediation: show progress instead of manual button */
            <div className="flex items-center gap-2 text-xs text-muted" data-testid="ollama-auto-starting">
              <LoadingSpinner testId="ollama-auto-start-spinner" />
              <span>Starting Ollama automatically...</span>
            </div>
          ) : (
            <>
              <p className="text-sm text-foreground">
                Ollama is installed but not running.
              </p>
              <button
                type="button"
                onClick={handleStartClick}
                disabled={disabled || effectiveStarting}
                className={pullButtonClass}
                data-testid="ollama-start-button"
              >
                {effectiveStarting
                  ? `Starting Ollama… ${startElapsedSec}s`
                  : "Start Ollama"}
              </button>
              {effectiveStarting && (
                <div
                  className="flex items-center gap-2 text-xs text-muted"
                  data-testid="ollama-start-progress"
                >
                  <LoadingSpinner testId="ollama-start-spinner" />
                  <span>Waiting for the local Ollama daemon to come online.</span>
                </div>
              )}
              {startError && !effectiveStarting && (
                <div
                  className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700"
                  data-testid="ollama-start-error"
                >
                  {startError.length > 240
                    ? `${startError.slice(0, 240)}…`
                    : startError}
                  <div className="mt-2 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={handleStartClick}
                      disabled={disabled}
                      className="rounded-lg border border-red-300 bg-white px-3 py-1 text-xs font-medium text-red-700 hover:border-red-500 disabled:opacity-50"
                      data-testid="ollama-start-retry"
                    >
                      Try again
                    </button>
                    {probe?.startCommand && (
                      <button
                        type="button"
                        onClick={() =>
                          handleCopy("start", probe.startCommand ?? "")
                        }
                        disabled={disabled}
                        className="rounded-lg border border-border bg-white px-3 py-1 text-xs font-medium text-foreground hover:border-accent hover:text-accent disabled:opacity-50"
                      >
                        {copiedKey === "start"
                          ? "Copied start command"
                          : "Copy manual start command"}
                      </button>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {derived === "running-missing-model" && (
        <div
          className="mt-4 space-y-3"
          data-testid="ollama-running-missing-model"
        >
          {renderConfiguredModelCard()}
          {hideManualControls ? (
            /* Auto-remediation: show download progress instead of manual button */
            <div className="flex items-center gap-2 text-xs text-muted" data-testid="ollama-auto-pulling">
              <LoadingSpinner testId="ollama-auto-pull-spinner" />
              <span>Downloading {targetModel} automatically...</span>
            </div>
          ) : (
            <>
              <p className="text-sm text-foreground">
                Ollama is running. Pull the recommended model to finish setup:
              </p>
              <button
                type="button"
                onClick={handlePullClick}
                disabled={disabled || pulling}
                className={pullButtonClass}
                data-testid="ollama-pull-button"
              >
                {pulling ? `Pulling ${targetModel}…` : `Pull ${targetModel}`}
              </button>
              {pulling && (
                <div
                  className="flex items-center gap-2 text-xs text-muted"
                  data-testid="ollama-pull-progress"
                >
                  <LoadingSpinner testId="ollama-pull-spinner" />
                  <span>This can take a few minutes depending on your connection.</span>
                </div>
              )}
              {pullError && !pulling && (
                <div
                  className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700"
                  data-testid="ollama-pull-error"
                >
                  {pullError.length > 240
                    ? `${pullError.slice(0, 240)}…`
                    : pullError}
                  <div>
                    <button
                      type="button"
                      onClick={handlePullClick}
                      disabled={disabled}
                      className="mt-2 rounded-lg border border-red-300 bg-white px-3 py-1 text-xs font-medium text-red-700 hover:border-red-500 disabled:opacity-50"
                      data-testid="ollama-pull-retry"
                    >
                      Try again
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {derived === "ready" && (
        <div className="mt-4 space-y-3">
          <div
            className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
            data-testid="ollama-ready"
          >
            <span aria-hidden="true" className="text-base">
              ✓
            </span>
            <span className="font-medium">
              {selectedInstalledModel ?? targetModel} ready
            </span>
          </div>
          {renderConfiguredModelCard()}
        </div>
      )}
    </section>
  );
}
