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

function authLabel(host: RuntimeHealthHost): string {
  if (host.auth.status === "not-required") return "No login required";
  if (host.auth.status === "authenticated") return "Authenticated";
  if (host.auth.status === "missing") return "Login required";
  if (host.auth.status === "invalid") return "Invalid auth";
  return "Auth unknown";
}

function hostById(hosts: RuntimeHealthHost[], hostId: string): RuntimeHealthHost | null {
  return hosts.find((host) => host.profile.id === hostId) ?? null;
}

export function RuntimePicker({
  hosts,
  selectedHostId,
  projectPolicy,
  mode,
  compareHostIds,
  loading = false,
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
  onSelectedHostIdChange: (hostId: string) => void;
  onProjectPolicyChange: (policy: RuntimeProjectPolicy) => void;
  onModeChange: (mode: RuntimeComposerMode) => void;
  onCompareHostIdsChange: (hostIds: string[]) => void;
}) {
  const selectedHost = hostById(hosts, selectedHostId);
  const selectedReason = selectedHost
    ? runtimeHostDisabledReason({ host: selectedHost, policy: projectPolicy, mode })
    : "Runtime host unavailable";
  const compareHosts = hosts.filter((host) =>
    runtimeHostDisabledReason({ host, policy: projectPolicy, mode: "compare" }) === null
  );

  return (
    <section
      className="space-y-3 border-b border-border bg-white px-4 py-3"
      data-testid="runtime-picker"
      aria-label="Runtime controls"
    >
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,1.2fr)]">
        <label className="min-w-0 space-y-1">
          <span className="text-xs font-semibold text-muted">Project policy</span>
          <select
            className="min-h-11 w-full rounded border border-border bg-surface px-3 text-sm focus:border-accent focus:outline-none"
            value={projectPolicy}
            onChange={(event) =>
              onProjectPolicyChange(event.currentTarget.value as RuntimeProjectPolicy)
            }
            data-testid="runtime-project-policy"
          >
            {Object.entries(POLICY_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>

        <fieldset className="min-w-0 space-y-1">
          <legend className="text-xs font-semibold text-muted">Mode</legend>
          <div className="grid grid-cols-3 overflow-hidden rounded border border-border bg-surface">
            {(Object.keys(MODE_LABELS) as RuntimeComposerMode[]).map((value) => (
              <button
                key={value}
                type="button"
                className={`min-h-11 px-2 text-sm font-medium transition-colors ${
                  mode === value
                    ? "bg-accent text-white"
                    : "text-foreground hover:bg-surface-hover"
                }`}
                onClick={() => onModeChange(value)}
                aria-pressed={mode === value}
                data-testid={`runtime-mode-${value}`}
              >
                {MODE_LABELS[value]}
              </button>
            ))}
          </div>
        </fieldset>

        <label className="min-w-0 space-y-1">
          <span className="text-xs font-semibold text-muted">
            {mode === "compare" ? "Synthesis host" : "Runtime host"}
          </span>
          <select
            className="min-h-11 w-full rounded border border-border bg-surface px-3 text-sm focus:border-accent focus:outline-none"
            value={selectedHostId}
            onChange={(event) => onSelectedHostIdChange(event.currentTarget.value)}
            disabled={loading}
            data-testid="runtime-host-select"
          >
            {hosts.map((host) => {
              const disabledReason = runtimeHostDisabledReason({
                host,
                policy: projectPolicy,
                mode: mode === "compare" ? "chat" : mode,
              });
              return (
                <option
                  key={host.profile.id}
                  value={host.profile.id}
                  disabled={Boolean(disabledReason)}
                >
                  {host.profile.label}
                  {disabledReason ? ` - ${disabledReason}` : ""}
                </option>
              );
            })}
          </select>
        </label>
      </div>

      {mode === "compare" && (
        <fieldset className="space-y-2" data-testid="runtime-compare-hosts">
          <legend className="text-xs font-semibold text-muted">Compare hosts</legend>
          <div className="flex flex-wrap gap-2">
            {hosts.map((host) => {
              const disabledReason = runtimeHostDisabledReason({
                host,
                policy: projectPolicy,
                mode: "compare",
              });
              const checked = compareHostIds.includes(host.profile.id);
              return (
                <label
                  key={host.profile.id}
                  className={`inline-flex min-h-11 max-w-full items-center gap-2 rounded border px-3 text-sm ${
                    disabledReason
                      ? "border-border bg-surface text-muted"
                      : "border-border bg-white text-foreground"
                  }`}
                  title={disabledReason ?? host.profile.label}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={Boolean(disabledReason)}
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
            {compareHosts.length === 0 && (
              <span className="text-sm text-muted">No compare-capable hosts under this policy.</span>
            )}
          </div>
        </fieldset>
      )}

      <div
        className="flex flex-wrap items-center gap-2 text-sm"
        data-testid="runtime-selected-summary"
      >
        <span className="font-semibold text-foreground">
          {selectedHost?.profile.label ?? "Runtime unavailable"}
        </span>
        {selectedHost && <RuntimePrivacyChip privacyClass={selectedHost.profile.privacyClass} />}
        {selectedHost && (
          <RuntimeStatusChip
            label={authLabel(selectedHost)}
            tone={selectedHost.auth.status === "authenticated" || selectedHost.auth.status === "not-required" ? "ok" : "warn"}
          />
        )}
        {selectedReason ? (
          <RuntimeStatusChip label={selectedReason} tone="warn" />
        ) : (
          <RuntimeStatusChip label="Ready for preview" tone="ok" />
        )}
      </div>
    </section>
  );
}
