import type { RuntimeHealthHost } from "./RuntimeHostMatrix";
import { runtimeCliSetupAction } from "./RuntimeAccountSetupGuide";

function setupAction(host: RuntimeHealthHost): string {
  if (host.profile.authMode === "subscription-native") {
    return runtimeCliSetupAction(host);
  }

  if (host.profile.authMode === "api-key") {
    return "Add the provider API key to .env; key values stay hidden.";
  }

  if (host.profile.authProvider === "openhands") {
    return "Install and start the local OpenHands service.";
  }

  return "Start the local ScienceSwarm runtime.";
}

function needsSetup(host: RuntimeHealthHost): boolean {
  return host.health.status !== "ready"
    || host.auth.status === "missing"
    || host.auth.status === "invalid"
    || host.auth.status === "unknown";
}

function statusCopy(host: RuntimeHealthHost): string {
  if (host.health.status !== "ready") {
    return host.health.detail || "Host is not ready.";
  }
  if (host.auth.status === "missing") return "Authentication is missing.";
  if (host.auth.status === "invalid") return "Authentication is invalid.";
  if (host.auth.status === "unknown") return "Authentication status is unknown.";
  return "Ready.";
}

export function RuntimeSetupCallouts({
  hosts,
}: {
  hosts: RuntimeHealthHost[];
}) {
  const setupHosts = hosts.filter(needsSetup);

  return (
    <section
      className="space-y-4 rounded-lg border-2 border-border bg-surface p-6"
      data-testid="runtime-setup-callouts"
    >
      <div>
        <h2 className="text-lg font-semibold">Runtime setup</h2>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          Recovery actions reflect install and auth state from the runtime
          health check; unavailable hosts are not shown as ready.
        </p>
      </div>

      {setupHosts.length > 0 ? (
        <ul className="divide-y divide-border">
          {setupHosts.map((host) => (
            <li
              key={`${host.profile.id}-${host.profile.label}-${host.profile.authMode}`}
              className="grid gap-3 py-4 md:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)_minmax(0,1fr)] md:items-start"
            >
              <div className="min-w-0">
                <p className="break-words text-sm font-medium text-foreground">
                  {host.profile.label}
                </p>
                <p className="mt-1 break-all font-mono text-xs text-muted">
                  {host.profile.id}
                </p>
              </div>
              <p className="text-sm text-muted">{statusCopy(host)}</p>
              <p className="text-sm text-foreground">{setupAction(host)}</p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">
          Runtime hosts reported ready setup state.
        </p>
      )}
    </section>
  );
}
