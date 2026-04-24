"use client";

import { useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import {
  CaretDown,
  Check,
  CircleNotch,
  Cloud,
  Cpu,
  Lightning,
  X,
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
  "cloud-ok": "Cloud allowed",
  "execution-ok": "Execution allowed",
};

const POLICY_SHORT_LABELS: Record<RuntimeProjectPolicy, string> = {
  "local-only": "Local",
  "cloud-ok": "Cloud",
  "execution-ok": "Execution",
};

const MODE_LABELS: Record<RuntimeComposerMode, string> = {
  chat: "Ask",
  task: "Task",
  compare: "Compare",
};

const MODE_HINTS: Record<RuntimeComposerMode, string> = {
  chat: "Reply in chat",
  task: "Longer work",
  compare: "Multiple hosts",
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
  if (requiredPolicy) return `Switch to ${POLICY_SHORT_LABELS[requiredPolicy]}`;
  if (reason) return reason;
  if (host.profile.authMode === "subscription-native") {
    return host.auth.status === "unknown" ? "CLI owns login" : "Native CLI ready";
  }
  return "Ready";
}

function summaryLabel(input: {
  host: RuntimeHealthHost | null;
  mode: RuntimeComposerMode;
  compareHostIds: string[];
}): string {
  if (input.mode === "compare") {
    return `Compare ${Math.max(1, input.compareHostIds.length)} hosts`;
  }
  return `${MODE_LABELS[input.mode]} with ${input.host?.profile.label ?? "Runtime"}`;
}

function statusTone(reason: string | null): "ok" | "warn" | "neutral" {
  if (!reason) return "ok";
  return policyBlockedReason(reason) ? "neutral" : "warn";
}

function hostDotClass(input: {
  host: RuntimeHealthHost;
  reason: string | null;
  canAutoSwitchPolicy: boolean;
}): string {
  if (input.reason && !input.canAutoSwitchPolicy) return "bg-warn";
  if (input.host.health.status === "ready") return "bg-ok";
  return "bg-dim";
}

function runtimeIcon(host: RuntimeHealthHost | null, loading: boolean) {
  if (loading && !host) {
    return <CircleNotch size={15} className="animate-spin text-dim" />;
  }
  if (host?.profile.privacyClass === "hosted") {
    return <Cloud size={15} className="text-dim" />;
  }
  if (host?.profile.id === "claude-code") {
    return <Lightning size={15} className="text-dim" />;
  }
  return <Cpu size={15} className="text-dim" />;
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
  const panelRef = useRef<HTMLDivElement | null>(null);
  const portalTarget = typeof document === "undefined" ? null : document.body;
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
      const target = event.target as Node;
      if (
        !rootRef.current?.contains(target)
        && !panelRef.current?.contains(target)
      ) {
        onOpenChange(false);
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [onOpenChange, open]);

  const runtimePanel = (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Runtime switcher"
      data-testid="runtime-switcher-panel"
      className="fixed inset-x-3 bottom-28 z-50 mx-auto flex max-h-[calc(100vh-8.5rem)] w-[min(42rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-lg border border-rule bg-raised text-sm shadow-[0_28px_90px_rgba(0,0,0,0.38)]"
      onKeyDown={(event) => {
        if (event.key === "Escape") onOpenChange(false);
      }}
    >
      <div className="flex items-start justify-between gap-3 border-b border-rule-soft px-4 py-3">
        <div className="min-w-0">
          <p className="text-xs font-medium text-muted">This turn</p>
          <p className="mt-0.5 truncate text-base font-semibold text-strong">
            {currentSummary}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <RuntimeStatusChip
            label={
              selectedHost
                ? hostStatusCopy(selectedHost, selectedReason)
                : "Runtime unavailable"
            }
            tone={statusTone(selectedReason)}
          />
          <button
            type="button"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-rule bg-sunk text-dim transition-colors hover:bg-surface-hover hover:text-strong focus:outline-none focus:ring-2 focus:ring-accent/30"
            aria-label="Close runtime switcher"
            onClick={() => onOpenChange(false)}
          >
            <X size={14} />
          </button>
        </div>
      </div>

      <div className="min-h-0 overflow-y-auto p-4">
        <section>
          <p className="mb-2 text-xs font-medium text-muted">Work type</p>
          <div className="grid grid-cols-3 gap-1 rounded-lg border border-rule bg-sunk p-1">
            {(Object.keys(MODE_LABELS) as RuntimeComposerMode[]).map((nextMode) => (
              <button
                key={nextMode}
                type="button"
                className={`min-h-12 rounded-md px-2.5 py-2 text-left transition-colors ${
                  mode === nextMode
                    ? "bg-raised text-strong shadow-sm"
                    : "text-muted hover:bg-surface-hover hover:text-strong"
                }`}
                onClick={() => {
                  onModeChange(nextMode);
                  if (nextMode === "compare") {
                    onCompareHostIdsChange(compareHostIdsForPolicy(projectPolicy));
                  }
                }}
                aria-pressed={mode === nextMode}
              >
                <span className="block text-sm font-semibold">
                  {MODE_LABELS[nextMode]}
                </span>
                <span className="block truncate text-[11px] text-muted">
                  {MODE_HINTS[nextMode]}
                </span>
              </button>
            ))}
          </div>
        </section>

        <section className="mt-4">
          <p className="mb-2 text-xs font-medium text-muted">Data boundary</p>
          <div className="grid grid-cols-3 gap-1 rounded-lg border border-rule bg-sunk p-1">
            {(Object.keys(POLICY_LABELS) as RuntimeProjectPolicy[]).map((policy) => (
              <button
                key={policy}
                type="button"
                className={`min-h-10 rounded-md px-2 text-xs font-semibold transition-colors ${
                  projectPolicy === policy
                    ? "bg-raised text-strong shadow-sm"
                    : "text-muted hover:bg-surface-hover hover:text-strong"
                }`}
                onClick={() => {
                  onProjectPolicyChange(policy);
                  if (mode === "compare") {
                    onCompareHostIdsChange(compareHostIdsForPolicy(policy));
                  }
                }}
                aria-pressed={projectPolicy === policy}
                title={POLICY_LABELS[policy]}
              >
                {POLICY_SHORT_LABELS[policy]}
              </button>
            ))}
          </div>
        </section>

        <section className="mt-4">
          <p className="mb-2 text-xs font-medium text-muted">Runtime</p>
          <div className="space-y-1.5">
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
                  className={`flex min-h-14 w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors ${
                    isSelected
                      ? "border-accent/50 bg-accent-faint text-strong"
                      : disabled
                        ? "cursor-not-allowed border-rule bg-sunk/60 text-muted"
                        : "border-rule bg-raised text-strong hover:bg-surface-hover"
                  }`}
                  disabled={disabled}
                  onClick={() => {
                    if (requiredPolicy) onProjectPolicyChange(requiredPolicy);
                    onSelectedHostIdChange(host.profile.id);
                    if (mode !== "compare") onOpenChange(false);
                  }}
                >
                  <span
                    className={`h-2.5 w-2.5 flex-shrink-0 rounded-full ${hostDotClass({
                      host,
                      reason,
                      canAutoSwitchPolicy,
                    })}`}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-sm font-semibold">
                        {host.profile.label}
                      </span>
                      {isSelected && <Check size={14} className="shrink-0 text-accent" />}
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-muted">
                      {hostStatusCopy(host, reason)}
                    </span>
                  </span>
                  <RuntimePrivacyChip privacyClass={host.profile.privacyClass} />
                </button>
              );
            })}
          </div>
        </section>

        {mode === "compare" && (
          <section className="mt-4">
            <p className="mb-2 text-xs font-medium text-muted">Compare hosts</p>
            <div className="flex flex-wrap gap-2">
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
                      className="inline-flex min-h-9 max-w-full items-center gap-2 rounded-md border border-rule bg-sunk px-3 text-xs font-semibold text-strong"
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
          </section>
        )}

        {error && (
          <p className="mt-4 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
            {error}
          </p>
        )}
      </div>
    </div>
  );

  return (
    <div
      ref={rootRef}
      className="flex-shrink-0"
      data-testid="composer-runtime-switcher"
    >
      <button
        type="button"
        className="inline-flex min-h-11 max-w-[16rem] items-center gap-3 rounded-full border border-rule bg-sunk/80 px-3 py-2 text-left shadow-sm transition-colors hover:border-rule-soft hover:bg-raised focus:outline-none focus:ring-2 focus:ring-accent/30 disabled:cursor-not-allowed disabled:opacity-60"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Change runtime"
        disabled={loading && hosts.length === 0}
        onClick={() => onOpenChange(!open)}
      >
        <span className="inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full border border-rule bg-raised text-dim">
          {runtimeIcon(selectedHost, loading && hosts.length === 0)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[11px] font-medium leading-4 text-muted">
            Run with
          </span>
          <span className="block truncate text-sm font-semibold leading-5 text-strong">
            {selectedHost?.profile.label ?? "Runtime"}
          </span>
        </span>
        <CaretDown size={13} className="flex-shrink-0 text-dim" />
      </button>

      {open && portalTarget ? createPortal(runtimePanel, portalTarget) : null}
    </div>
  );
}
