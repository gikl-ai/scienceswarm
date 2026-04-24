"use client";

import { useEffect, useMemo, useRef } from "react";
import {
  CaretDown,
  Check,
  CircleNotch,
  Cloud,
  Cpu,
  Lightning,
} from "@phosphor-icons/react";
import type { RuntimeProjectPolicy } from "@/lib/runtime-hosts/contracts";
import type { RuntimeHealthHost } from "@/components/runtime/RuntimeHostMatrix";
import {
  type RuntimeComposerMode,
  runtimeHostDisabledReason,
} from "@/hooks/use-runtime-hosts";
import { RuntimePrivacyChip, RuntimeStatusChip } from "./runtime-status-chip";

const POLICY_LABELS: Record<RuntimeProjectPolicy, string> = {
  "local-only": "Local only",
  "cloud-ok": "Cloud ok",
  "execution-ok": "Execution ok",
};

const MODE_LABELS: Record<RuntimeComposerMode, string> = {
  chat: "Chat",
  task: "Task",
  compare: "Compare",
};

function hostById(hosts: RuntimeHealthHost[], hostId: string): RuntimeHealthHost | null {
  return hosts.find((host) => host.profile.id === hostId) ?? null;
}

function hostReady(host: RuntimeHealthHost): boolean {
  return host.health.status === "ready"
    && (
      host.auth.status === "authenticated"
      || host.auth.status === "not-required"
      || (
        host.profile.authMode === "subscription-native"
        && host.auth.status === "unknown"
      )
    );
}

function policyBlockedReason(reason: string | null): RuntimeProjectPolicy | null {
  if (!reason?.startsWith("Requires ")) return null;
  const required = reason.replace(/^Requires\s+/, "").trim();
  return required === "local-only"
    || required === "cloud-ok"
    || required === "execution-ok"
    ? required
    : null;
}

function hostStatusCopy(host: RuntimeHealthHost, reason: string | null): string {
  const requiredPolicy = policyBlockedReason(reason);
  if (requiredPolicy) return `Switch to ${POLICY_LABELS[requiredPolicy]}`;
  if (reason) return reason;
  if (host.profile.authMode === "subscription-native") {
    return host.auth.status === "unknown" ? "CLI owns login" : "Native CLI ready";
  }
  return "Ready";
}

function setupCopy(host: RuntimeHealthHost): string | null {
  if (host.profile.id !== "claude-code") return null;
  if (host.health.status !== "ready") {
    return "Install: npm install -g @anthropic-ai/claude-code";
  }
  if (host.auth.status === "missing" || host.auth.status === "invalid") {
    return "Sign in: claude auth login";
  }
  return "Check: claude auth status";
}

function summaryLabel(input: {
  host: RuntimeHealthHost | null;
  mode: RuntimeComposerMode;
  compareHostIds: string[];
}): string {
  if (input.mode === "compare") {
    return `Compare · ${Math.max(1, input.compareHostIds.length)} hosts`;
  }
  return `${MODE_LABELS[input.mode]} · ${input.host?.profile.label ?? "Runtime"}`;
}

function statusTone(reason: string | null): "ok" | "warn" | "neutral" {
  if (!reason) return "ok";
  return policyBlockedReason(reason) ? "neutral" : "warn";
}

export function ComposerRuntimeSwitcher({
  hosts,
  selectedHostId,
  projectPolicy,
  mode,
  compareHostIds,
  loading = false,
  error = null,
  open,
  onOpenChange,
  onSelectedHostIdChange,
  onProjectPolicyChange,
  onModeChange,
  onCompareHostIdsChange,
}: {
  hosts: RuntimeHealthHost[];
  selectedHostId: string;
  projectPolicy: RuntimeProjectPolicy;
  mode: RuntimeComposerMode;
  compareHostIds: string[];
  loading?: boolean;
  error?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectedHostIdChange: (hostId: string) => void;
  onProjectPolicyChange: (policy: RuntimeProjectPolicy) => void;
  onModeChange: (mode: RuntimeComposerMode) => void;
  onCompareHostIdsChange: (hostIds: string[]) => void;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const selectedHost = hostById(hosts, selectedHostId);
  const selectedReason = selectedHost
    ? runtimeHostDisabledReason({ host: selectedHost, policy: projectPolicy, mode })
    : "Runtime host unavailable";
  const currentSummary = summaryLabel({ host: selectedHost, mode, compareHostIds });
  const visibleHosts = useMemo(
    () =>
      [...hosts].sort((left, right) => {
        const order = ["claude-code", "openclaw", "codex", "gemini-cli", "openhands"];
        const leftIndex = order.indexOf(left.profile.id);
        const rightIndex = order.indexOf(right.profile.id);
        return (
          (leftIndex === -1 ? order.length : leftIndex)
          - (rightIndex === -1 ? order.length : rightIndex)
        );
      }),
    [hosts],
  );
  const compareHostIdsForPolicy = (policy: RuntimeProjectPolicy): string[] => {
    const allowedIds = visibleHosts
      .filter((host) =>
        runtimeHostDisabledReason({ host, policy, mode: "compare" }) === null
      )
      .map((host) => host.profile.id);
    const allowed = new Set(allowedIds);
    const next = compareHostIds.filter((hostId) => allowed.has(hostId));
    return next.length > 0 ? next : allowedIds.slice(0, 1);
  };

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        onOpenChange(false);
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [onOpenChange, open]);

  return (
    <div
      ref={rootRef}
      className="relative flex-shrink-0"
      data-testid="composer-runtime-switcher"
    >
      <button
        type="button"
        className="inline-flex h-11 max-w-[13rem] items-center gap-2 rounded-xl border border-border bg-surface px-3 text-sm font-semibold text-foreground transition-colors hover:border-accent hover:bg-white focus:outline-none focus:ring-2 focus:ring-accent/25 disabled:cursor-not-allowed disabled:opacity-60"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Change runtime"
        disabled={loading && hosts.length === 0}
        onClick={() => onOpenChange(!open)}
      >
        {loading && hosts.length === 0 ? (
          <CircleNotch size={15} className="animate-spin text-muted" />
        ) : selectedHost?.profile.privacyClass === "hosted" ? (
          <Cloud size={15} className="text-muted" />
        ) : selectedHost?.profile.id === "claude-code" ? (
          <Lightning size={15} className="text-muted" />
        ) : (
          <Cpu size={15} className="text-muted" />
        )}
        <span className="truncate">{currentSummary}</span>
        <CaretDown size={13} className="text-muted" />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Runtime switcher"
          className="absolute bottom-full right-0 z-40 mb-2 w-[min(24rem,calc(100vw-2rem))] rounded-lg border border-border bg-white p-2 text-sm shadow-2xl"
          onKeyDown={(event) => {
            if (event.key === "Escape") onOpenChange(false);
          }}
        >
          <div className="flex items-center justify-between gap-3 px-2 py-1.5">
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase text-muted">Runtime</p>
              <p className="truncate text-sm font-semibold text-foreground">
                {currentSummary}
              </p>
            </div>
            <RuntimeStatusChip
              label={
                selectedHost
                  ? hostStatusCopy(selectedHost, selectedReason)
                  : "Runtime unavailable"
              }
              tone={statusTone(selectedReason)}
            />
          </div>

          <div className="mt-2 grid grid-cols-3 overflow-hidden rounded border border-border bg-surface">
            {(Object.keys(MODE_LABELS) as RuntimeComposerMode[]).map((nextMode) => (
              <button
                key={nextMode}
                type="button"
                className={`min-h-9 px-2 text-xs font-semibold transition-colors ${
                  mode === nextMode
                    ? "bg-foreground text-white"
                    : "text-muted hover:bg-white hover:text-foreground"
                }`}
                onClick={() => onModeChange(nextMode)}
                aria-pressed={mode === nextMode}
              >
                {MODE_LABELS[nextMode]}
              </button>
            ))}
          </div>

          <div className="mt-2 grid grid-cols-3 overflow-hidden rounded border border-border bg-surface">
            {(Object.keys(POLICY_LABELS) as RuntimeProjectPolicy[]).map((policy) => (
              <button
                key={policy}
                type="button"
                className={`min-h-9 px-2 text-xs font-semibold transition-colors ${
                  projectPolicy === policy
                    ? "bg-accent text-white"
                    : "text-muted hover:bg-white hover:text-foreground"
                }`}
                onClick={() => {
                  onProjectPolicyChange(policy);
                  if (mode === "compare") {
                    onCompareHostIdsChange(compareHostIdsForPolicy(policy));
                  }
                }}
                aria-pressed={projectPolicy === policy}
              >
                {POLICY_LABELS[policy]}
              </button>
            ))}
          </div>

          <div className="mt-2 max-h-[18rem] overflow-y-auto rounded border border-border">
            {visibleHosts.map((host) => {
              const reason = runtimeHostDisabledReason({
                host,
                policy: projectPolicy,
                mode: mode === "compare" ? "chat" : mode,
              });
              const requiredPolicy = policyBlockedReason(reason);
              const canAutoSwitchPolicy = Boolean(requiredPolicy) && hostReady(host);
              const disabled = Boolean(reason) && !canAutoSwitchPolicy;
              const isSelected = host.profile.id === selectedHostId;
              return (
                <button
                  key={host.profile.id}
                  type="button"
                  className={`flex min-h-14 w-full items-start gap-2 border-b border-border px-3 py-2 text-left last:border-b-0 transition-colors ${
                    disabled
                      ? "cursor-not-allowed bg-surface text-muted"
                      : "bg-white text-foreground hover:bg-surface"
                  }`}
                  disabled={disabled}
                  onClick={() => {
                    if (requiredPolicy) onProjectPolicyChange(requiredPolicy);
                    onSelectedHostIdChange(host.profile.id);
                    if (mode !== "compare") onOpenChange(false);
                  }}
                >
                  <span
                    className={`mt-1 h-2.5 w-2.5 rounded-full ${
                      reason && !canAutoSwitchPolicy
                        ? "bg-amber-500"
                        : host.health.status === "ready"
                          ? "bg-emerald-500"
                          : "bg-zinc-400"
                    }`}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate font-semibold">{host.profile.label}</span>
                      {isSelected && <Check size={14} className="text-accent" />}
                    </span>
                    <span className="mt-0.5 block text-xs text-muted">
                      {hostStatusCopy(host, reason)}
                    </span>
                    {setupCopy(host) && (
                      <code className="mt-1 block truncate font-mono text-[11px] text-muted">
                        {setupCopy(host)}
                      </code>
                    )}
                  </span>
                  <RuntimePrivacyChip privacyClass={host.profile.privacyClass} />
                </button>
              );
            })}
          </div>

          {mode === "compare" && (
            <div className="mt-2 rounded border border-border bg-surface p-2">
              <p className="text-xs font-semibold uppercase text-muted">Compare hosts</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {visibleHosts
                  .filter((host) =>
                    runtimeHostDisabledReason({
                      host,
                      policy: projectPolicy,
                      mode: "compare",
                    }) === null
                  )
                  .map((host) => {
                    const checked = compareHostIds.includes(host.profile.id);
                    return (
                      <label
                        key={host.profile.id}
                        className="inline-flex min-h-8 max-w-full items-center gap-2 rounded border border-border bg-white px-2 text-xs font-semibold"
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(event) => {
                            const next = event.currentTarget.checked
                              ? Array.from(new Set([...compareHostIds, host.profile.id]))
                              : compareHostIds.filter((id) => id !== host.profile.id);
                            onCompareHostIdsChange(next.length > 0 ? next : [host.profile.id]);
                          }}
                        />
                        <span className="truncate">{host.profile.label}</span>
                      </label>
                    );
                  })}
              </div>
            </div>
          )}

          {error && (
            <p className="mt-2 rounded border border-red-200 bg-red-50 px-2 py-1.5 text-xs text-red-700">
              {error}
            </p>
          )}

          <p className="px-2 pt-2 text-xs text-muted">
            Advanced sessions and diagnostics remain in Settings.
          </p>
        </div>
      )}
    </div>
  );
}
