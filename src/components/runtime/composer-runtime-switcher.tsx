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

const ASSISTANT_ORDER = ["openclaw", "claude-code", "codex", "gemini-cli"];

const ASSISTANT_COPY: Record<
  string,
  { description: string; unavailable: string }
> = {
  openclaw: {
    description: "Private local assistant for ScienceSwarm.",
    unavailable: "Unavailable",
  },
  "claude-code": {
    description: "Uses your signed-in Claude account.",
    unavailable: "Sign in in Settings",
  },
  codex: {
    description: "Uses your signed-in Codex account.",
    unavailable: "Sign in in Settings",
  },
  "gemini-cli": {
    description: "Uses your signed-in Gemini account.",
    unavailable: "Sign in in Settings",
  },
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

function requiredPolicyFor(host: RuntimeHealthHost): RuntimeProjectPolicy {
  return host.profile.accountDisclosure.requiresProjectPrivacy ?? (
    host.profile.privacyClass === "hosted" ? "cloud-ok" : "local-only"
  );
}

function assistantCopy(host: RuntimeHealthHost) {
  return ASSISTANT_COPY[host.profile.id] ?? {
    description: host.profile.privacyClass === "hosted"
      ? `Uses your signed-in ${host.profile.label} account.`
      : "Runs through your local ScienceSwarm setup.",
    unavailable: "Unavailable",
  };
}

function assistantIcon(host: RuntimeHealthHost | null, loading: boolean) {
  if (loading && !host) {
    return <CircleNotch size={15} className="animate-spin text-dim" />;
  }
  if (host?.profile.id === "claude-code") {
    return <Lightning size={15} className="text-dim" />;
  }
  if (host?.profile.privacyClass === "hosted") {
    return <Cloud size={15} className="text-dim" />;
  }
  return <Cpu size={15} className="text-dim" />;
}

function assistantSort(left: RuntimeHealthHost, right: RuntimeHealthHost): number {
  const leftIndex = ASSISTANT_ORDER.indexOf(left.profile.id);
  const rightIndex = ASSISTANT_ORDER.indexOf(right.profile.id);
  return (
    (leftIndex === -1 ? ASSISTANT_ORDER.length : leftIndex)
    - (rightIndex === -1 ? ASSISTANT_ORDER.length : rightIndex)
  );
}

export function ComposerRuntimeSwitcher({
  hosts,
  selectedHostId,
  projectPolicy,
  loading = false,
  error = null,
  open,
  onOpenChange,
  onSelectedHostIdChange,
  onProjectPolicyChange,
  onModeChange,
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
  const visibleHosts = useMemo(() => {
    const selected = selectedHost ? [selectedHost] : [];
    const preferred = hosts.filter((host) =>
      ASSISTANT_ORDER.includes(host.profile.id)
      && host.profile.capabilities.includes("chat")
    );
    const readyChatHosts = hosts.filter((host) =>
      hostReady(host)
      && host.profile.capabilities.includes("chat")
      && !preferred.some((preferredHost) => preferredHost.profile.id === host.profile.id)
    );
    const byId = new Map(
      [...preferred, ...selected, ...readyChatHosts].map((host) => [
        host.profile.id,
        host,
      ]),
    );
    return Array.from(byId.values()).sort(assistantSort);
  }, [hosts, selectedHost]);

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

  const selectAssistant = (host: RuntimeHealthHost) => {
    const requiredPolicy = requiredPolicyFor(host);
    if (projectPolicy !== requiredPolicy) {
      onProjectPolicyChange(requiredPolicy);
    }
    onModeChange("chat");
    onSelectedHostIdChange(host.profile.id);
    onOpenChange(false);
  };

  const runtimePanel = (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Choose assistant"
      data-testid="runtime-switcher-panel"
      className="fixed inset-x-3 bottom-24 z-50 mx-auto max-h-[min(32rem,calc(100vh-7rem))] w-[min(28rem,calc(100vw-1.5rem))] overflow-hidden rounded-2xl border border-rule bg-raised text-sm shadow-[0_24px_70px_rgba(0,0,0,0.24)]"
      onKeyDown={(event) => {
        if (event.key === "Escape") onOpenChange(false);
      }}
    >
      <div className="flex items-center justify-between gap-3 border-b border-rule-soft px-4 py-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-strong">
            Choose assistant
          </p>
        </div>
        <button
          type="button"
          className="inline-flex h-8 w-8 items-center justify-center rounded-full text-dim transition-colors hover:bg-surface-hover hover:text-strong focus:outline-none focus:ring-2 focus:ring-accent/30"
          aria-label="Close assistant picker"
          onClick={() => onOpenChange(false)}
        >
          <X size={14} />
        </button>
      </div>

      <div className="max-h-[calc(100vh-11rem)] overflow-y-auto p-2">
        <div className="space-y-1">
          {visibleHosts.map((host) => {
            const copy = assistantCopy(host);
            const disabledReason = runtimeHostDisabledReason({
              host,
              policy: requiredPolicyFor(host),
              mode: "chat",
            });
            const disabled = Boolean(disabledReason) || !hostReady(host);
            const isSelected = host.profile.id === selectedHostId;
            return (
              <button
                key={host.profile.id}
                type="button"
                className={`flex min-h-[4.25rem] w-full items-center gap-3 rounded-xl px-3 py-3 text-left transition-colors ${
                  isSelected
                    ? "bg-accent-faint text-strong"
                    : disabled
                      ? "cursor-not-allowed text-muted"
                      : "text-strong hover:bg-surface-hover"
                }`}
                disabled={disabled}
                onClick={() => selectAssistant(host)}
              >
                <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-rule bg-sunk">
                  {assistantIcon(host, false)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-sm font-semibold">
                      {host.profile.label}
                    </span>
                    {isSelected && <Check size={14} className="shrink-0 text-accent" />}
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-muted">
                    {disabled ? copy.unavailable : copy.description}
                  </span>
                </span>
              </button>
            );
          })}
        </div>

        {error && (
          <p className="mt-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
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
        className="inline-flex min-h-11 max-w-[14rem] items-center gap-2.5 rounded-full border border-rule bg-sunk/70 px-3 py-2 text-left shadow-sm transition-colors hover:border-rule-soft hover:bg-raised focus:outline-none focus:ring-2 focus:ring-accent/30 disabled:cursor-not-allowed disabled:opacity-60"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Change assistant"
        disabled={loading && hosts.length === 0}
        onClick={() => onOpenChange(!open)}
      >
        <span className="inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full border border-rule bg-raised">
          {assistantIcon(selectedHost, loading && hosts.length === 0)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold leading-5 text-strong">
            {selectedHost?.profile.label ?? "Assistant"}
          </span>
        </span>
        <CaretDown size={13} className="flex-shrink-0 text-dim" />
      </button>

      {open && portalTarget ? createPortal(runtimePanel, portalTarget) : null}
    </div>
  );
}
