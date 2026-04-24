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

function triggerSubtitle(input: {
  mode: RuntimeComposerMode;
  projectPolicy: RuntimeProjectPolicy;
  compareHostIds: string[];
}): string {
  if (input.mode === "compare") {
    return `Compare ${Math.max(1, input.compareHostIds.length)} hosts · ${POLICY_LABELS[input.projectPolicy]}`;
  }
  return `${MODE_LABELS[input.mode]} mode · ${POLICY_LABELS[input.projectPolicy]}`;
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
  const triggerCopy = triggerSubtitle({ mode, projectPolicy, compareHostIds });
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
        className="inline-flex min-h-11 max-w-[15rem] items-center gap-3 rounded-full border border-slate-200 bg-slate-50/85 px-3.5 py-2 text-left transition-colors hover:border-accent/60 hover:bg-white focus:outline-none focus:ring-2 focus:ring-accent/20 disabled:cursor-not-allowed disabled:opacity-60"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Change runtime"
        disabled={loading && hosts.length === 0}
        onClick={() => onOpenChange(!open)}
      >
        <span className="inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-500 shadow-sm">
          {loading && hosts.length === 0 ? (
            <CircleNotch size={15} className="animate-spin text-muted" />
          ) : selectedHost?.profile.privacyClass === "hosted" ? (
            <Cloud size={15} className="text-muted" />
          ) : selectedHost?.profile.id === "claude-code" ? (
            <Lightning size={15} className="text-muted" />
          ) : (
            <Cpu size={15} className="text-muted" />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-slate-900">
            {selectedHost?.profile.label ?? "Runtime"}
          </span>
          <span className="block truncate text-[11px] font-medium text-slate-500">
            {triggerCopy}
          </span>
        </span>
        <CaretDown size={13} className="flex-shrink-0 text-muted" />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Runtime switcher"
          className="absolute bottom-full right-0 z-40 mb-2 w-[min(26rem,calc(100vw-1.5rem))] rounded-[26px] border border-slate-200 bg-white p-3 text-sm shadow-[0_24px_80px_rgba(15,23,42,0.18)]"
          onKeyDown={(event) => {
            if (event.key === "Escape") onOpenChange(false);
          }}
        >
          <div className="flex items-start justify-between gap-3 px-2 py-2">
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">
                Runtime For This Turn
              </p>
              <p className="mt-1 truncate text-base font-semibold text-foreground">
                {currentSummary}
              </p>
              <p className="mt-1 text-xs leading-5 text-muted">
                Choose the runtime, mode, and privacy gate before this prompt leaves the composer.
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

          <div className="mt-3 space-y-3">
            <section className="rounded-2xl border border-border/80 bg-surface/40 p-2.5">
              <p className="px-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-muted">
                Mode
              </p>
              <div className="mt-2 grid grid-cols-3 overflow-hidden rounded-2xl border border-border bg-white">
                {(Object.keys(MODE_LABELS) as RuntimeComposerMode[]).map((nextMode) => (
                  <button
                    key={nextMode}
                    type="button"
                    className={`min-h-10 px-2 text-xs font-semibold transition-colors ${
                      mode === nextMode
                        ? "bg-foreground text-white"
                        : "text-muted hover:bg-slate-50 hover:text-foreground"
                    }`}
                    onClick={() => onModeChange(nextMode)}
                    aria-pressed={mode === nextMode}
                  >
                    {MODE_LABELS[nextMode]}
                  </button>
                ))}
              </div>
            </section>

            <section className="rounded-2xl border border-border/80 bg-surface/40 p-2.5">
              <p className="px-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-muted">
                Project Privacy
              </p>
              <div className="mt-2 grid grid-cols-3 overflow-hidden rounded-2xl border border-border bg-white">
                {(Object.keys(POLICY_LABELS) as RuntimeProjectPolicy[]).map((policy) => (
                  <button
                    key={policy}
                    type="button"
                    className={`min-h-10 px-2 text-xs font-semibold transition-colors ${
                      projectPolicy === policy
                        ? "bg-accent text-white"
                        : "text-muted hover:bg-slate-50 hover:text-foreground"
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
            </section>
          </div>

          <div className="mt-3">
            <p className="px-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-muted">
              Runtime Hosts
            </p>
          </div>
          <div className="mt-2 max-h-[18rem] space-y-2 overflow-y-auto">
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
                  className={`flex min-h-16 w-full items-start gap-3 rounded-2xl border px-3 py-3 text-left transition-colors ${
                    disabled
                      ? "cursor-not-allowed border-border bg-surface text-muted"
                      : "border-slate-200 bg-white text-foreground hover:border-accent/40 hover:bg-slate-50"
                  }`}
                  disabled={disabled}
                  onClick={() => {
                    if (requiredPolicy) onProjectPolicyChange(requiredPolicy);
                    onSelectedHostIdChange(host.profile.id);
                    if (mode !== "compare") onOpenChange(false);
                  }}
                >
                  <span
                    className={`mt-1.5 h-2.5 w-2.5 flex-shrink-0 rounded-full ${
                      reason && !canAutoSwitchPolicy
                        ? "bg-amber-500"
                        : host.health.status === "ready"
                          ? "bg-emerald-500"
                          : "bg-zinc-400"
                    }`}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="truncate font-semibold">{host.profile.label}</span>
                      {isSelected && <Check size={14} className="text-accent" />}
                      <RuntimePrivacyChip privacyClass={host.profile.privacyClass} />
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
                </button>
              );
            })}
          </div>

          {mode === "compare" && (
            <div className="mt-3 rounded-2xl border border-border/80 bg-surface/40 p-2.5">
              <p className="px-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-muted">
                Compare Hosts
              </p>
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
                        className="inline-flex min-h-8 max-w-full items-center gap-2 rounded-full border border-border bg-white px-3 text-xs font-semibold"
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
            <p className="mt-3 rounded-2xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              {error}
            </p>
          )}

          <p className="px-2 pt-3 text-xs leading-5 text-muted">
            Advanced sessions and diagnostics remain in Settings.
          </p>
        </div>
      )}
    </div>
  );
}
