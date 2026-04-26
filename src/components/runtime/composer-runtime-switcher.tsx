"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { CaretDown, Check, CircleNotch } from "@phosphor-icons/react";
import type { RuntimeProjectPolicy } from "@/lib/runtime-hosts/contracts";
import type { RuntimeHealthHost } from "@/components/runtime/RuntimeHostMatrix";
import {
  type RuntimeComposerMode,
  runtimeHostDisabledReason,
} from "@/hooks/use-runtime-hosts";

const ASSISTANT_ORDER = ["openclaw", "claude-code", "codex", "gemini-cli"];
const ASSISTANT_LABELS: Record<string, string> = {
  openclaw: "OpenClaw",
  "claude-code": "Claude Code",
  codex: "Codex",
  "gemini-cli": "Gemini CLI",
  openhands: "OpenHands",
};
const MENU_WIDTH = 292;
const VIEWPORT_MARGIN = 12;
const MENU_GAP = 8;
const subscribeToPortalTarget = () => () => undefined;
const getPortalTarget = () => document.body;
const getServerPortalTarget = () => null;

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
  mode?: RuntimeComposerMode;
  compareHostIds?: string[];
  loading?: boolean;
  error?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectedHostIdChange: (hostId: string) => void;
  onProjectPolicyChange: (policy: RuntimeProjectPolicy) => void;
  onModeChange: (mode: RuntimeComposerMode) => void;
  onCompareHostIdsChange?: (hostIds: string[]) => void;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const portalTarget = useSyncExternalStore(
    subscribeToPortalTarget,
    getPortalTarget,
    getServerPortalTarget,
  );
  const [panelPosition, setPanelPosition] = useState({
    bottom: 96,
    left: VIEWPORT_MARGIN,
    width: MENU_WIDTH,
  });
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

    function updatePanelPosition() {
      const triggerRect = rootRef.current?.getBoundingClientRect();
      const width = Math.min(MENU_WIDTH, window.innerWidth - VIEWPORT_MARGIN * 2);
      if (!triggerRect) {
        setPanelPosition({
          bottom: 96,
          left: VIEWPORT_MARGIN,
          width,
        });
        return;
      }

      setPanelPosition({
        bottom: Math.max(
          VIEWPORT_MARGIN,
          window.innerHeight - triggerRect.top + MENU_GAP,
        ),
        left: Math.min(
          Math.max(VIEWPORT_MARGIN, triggerRect.left),
          window.innerWidth - width - VIEWPORT_MARGIN,
        ),
        width,
      });
    }

    updatePanelPosition();
    window.addEventListener("resize", updatePanelPosition);
    window.addEventListener("scroll", updatePanelPosition, true);
    return () => {
      window.removeEventListener("resize", updatePanelPosition);
      window.removeEventListener("scroll", updatePanelPosition, true);
    };
  }, [open]);

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
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onOpenChange(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
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
      aria-label="Assistant"
      data-testid="runtime-switcher-panel"
      className="fixed z-50 max-h-[min(22rem,calc(100vh-7rem))] overflow-y-auto rounded-[24px] border border-rule bg-raised p-2 text-[15px] shadow-[0_18px_50px_rgba(0,0,0,0.18)] backdrop-blur-sm"
      style={panelPosition}
    >
      <div className="px-2.5 pb-2 pt-1.5">
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted">
          Assistant
        </p>
        <p className="mt-1 text-[13px] leading-5 text-muted">
          Choose who answers this turn.
        </p>
      </div>
      <div className="space-y-1">
        {visibleHosts.map((host) => {
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
              aria-pressed={isSelected}
              className={`flex h-11 w-full items-center justify-between gap-3 rounded-[18px] px-3.5 text-left transition-colors ${
                isSelected
                  ? "bg-sunk text-strong"
                  : disabled
                    ? "cursor-not-allowed text-dim"
                    : "text-strong hover:bg-sunk/70"
              }`}
              disabled={disabled}
              onClick={() => selectAssistant(host)}
            >
              <span className="truncate">{host.profile.label}</span>
              {isSelected && <Check size={15} className="shrink-0 text-strong" />}
            </button>
          );
        })}
      </div>

      {error && (
        <p className="mx-2 mt-1 rounded-md border border-danger/30 bg-danger/10 px-2.5 py-2 text-xs text-danger">
          {error}
        </p>
      )}
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
        data-testid="composer-runtime-trigger"
        className="inline-flex min-h-11 max-w-[13.5rem] items-center gap-2 rounded-[20px] border border-rule bg-sunk/75 px-3 py-2 text-left shadow-sm transition-colors hover:border-rule-soft hover:bg-raised focus:outline-none focus:ring-2 focus:ring-accent/25 disabled:cursor-not-allowed disabled:opacity-60"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Change assistant"
        disabled={loading && hosts.length === 0}
        onClick={() => onOpenChange(!open)}
      >
        {loading && hosts.length === 0 && (
          <CircleNotch size={13} className="shrink-0 animate-spin text-dim" />
        )}
        <span className="min-w-0 flex-1">
          <span className="block text-[10px] font-semibold uppercase tracking-[0.14em] text-quiet">
            Assistant
          </span>
          <span className="block truncate text-sm font-semibold text-strong">
            {selectedHost?.profile.label ?? ASSISTANT_LABELS[selectedHostId] ?? "Assistant"}
          </span>
        </span>
        <CaretDown size={12} className="shrink-0 text-dim" />
      </button>

      {open && portalTarget ? createPortal(runtimePanel, portalTarget) : null}
    </div>
  );
}
