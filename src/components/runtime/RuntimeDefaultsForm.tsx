import type { RuntimeHealthHost } from "./RuntimeHostMatrix";
import {
  runtimeHostBlockedByPolicy,
  runtimeHostSelectableForDefault,
} from "./RuntimeHostMatrix";

export type RuntimeSettingsPolicy = "local-only" | "cloud-ok" | "execution-ok";

const POLICY_LABELS: Record<RuntimeSettingsPolicy, string> = {
  "local-only": "Local only",
  "cloud-ok": "Cloud ok",
  "execution-ok": "Execution ok",
};

const POLICY_COPY: Record<RuntimeSettingsPolicy, string> = {
  "local-only": "Hosted and external hosts are blocked.",
  "cloud-ok": "Hosted chat hosts are allowed after preview approval.",
  "execution-ok": "Task-capable execution hosts can be selected.",
};

function optionDisabledReason(
  host: RuntimeHealthHost,
  policy: RuntimeSettingsPolicy,
): string | null {
  if (runtimeHostBlockedByPolicy(host, policy)) {
    return "Blocked by current policy";
  }
  if (host.health.status !== "ready") {
    return host.health.status === "misconfigured"
      ? "Misconfigured"
      : "Install or start required";
  }
  if (host.auth.status === "missing" || host.auth.status === "invalid") {
    return "Login or .env setup required";
  }
  return null;
}

export function RuntimeDefaultsForm({
  hosts,
  selectedHostId,
  policy,
  onSelectedHostIdChange,
  onPolicyChange,
}: {
  hosts: RuntimeHealthHost[];
  selectedHostId: string;
  policy: RuntimeSettingsPolicy;
  onSelectedHostIdChange: (hostId: string) => void;
  onPolicyChange: (policy: RuntimeSettingsPolicy) => void;
}) {
  const selectedHost = hosts.find((host) => host.profile.id === selectedHostId);
  const selectedBlocked = selectedHost
    ? !runtimeHostSelectableForDefault(selectedHost, policy)
    : false;

  return (
    <section
      className="space-y-4 rounded-lg border-2 border-border bg-surface p-6"
      data-testid="runtime-defaults-form"
    >
      <div>
        <h2 className="text-lg font-semibold">Runtime defaults</h2>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          Draft defaults are local to this settings view until runtime default
          persistence lands. Project send surfaces still show the selected
          runtime before any hosted request.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <label className="space-y-2">
          <span className="text-sm font-medium text-foreground">
            Project policy
          </span>
          <select
            className="w-full rounded-lg border-2 border-border bg-background px-3 py-2 text-sm focus:border-accent focus:outline-none"
            value={policy}
            onChange={(event) => onPolicyChange(event.currentTarget.value as RuntimeSettingsPolicy)}
            data-testid="runtime-policy-select"
          >
            {Object.entries(POLICY_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <p className="text-xs text-muted">{POLICY_COPY[policy]}</p>
        </label>

        <label className="space-y-2">
          <span className="text-sm font-medium text-foreground">
            Default host
          </span>
          <select
            className="w-full rounded-lg border-2 border-border bg-background px-3 py-2 text-sm focus:border-accent focus:outline-none"
            value={selectedHostId}
            onChange={(event) => onSelectedHostIdChange(event.currentTarget.value)}
            data-testid="runtime-default-host-select"
          >
            {hosts.map((host) => {
              const disabledReason = optionDisabledReason(host, policy);
              return (
                <option
                  key={`${host.profile.id}-${host.profile.label}-${host.profile.authMode}`}
                  value={host.profile.id}
                  disabled={Boolean(disabledReason)}
                >
                  {host.profile.label}
                  {disabledReason ? ` - ${disabledReason}` : ""}
                </option>
              );
            })}
          </select>
          <p className="text-xs text-muted">
            {selectedBlocked
              ? "The current policy blocks this host; OpenClaw local remains the fallback."
              : "Only ready hosts allowed by policy can become the draft default."}
          </p>
        </label>
      </div>
    </section>
  );
}
