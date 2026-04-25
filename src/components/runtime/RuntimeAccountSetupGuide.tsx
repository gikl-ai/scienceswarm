import type { RuntimeHealthHost } from "./RuntimeHostMatrix";
import { RuntimeStatusChip } from "./runtime-status-chip";

interface RuntimeCliConnectionGuide {
  installCommand: string;
  signInCommand: string;
  checkCommand: string;
  signInCopy: string;
  checkCopy: string;
}

const CLI_CONNECTION_GUIDES: Record<string, RuntimeCliConnectionGuide> = {
  "claude-code": {
    installCommand: "npm install -g @anthropic-ai/claude-code",
    signInCommand: "claude auth login",
    checkCommand: "claude auth status",
    signInCopy: "Sign in with your Claude.ai or Anthropic Console account.",
    checkCopy: "ScienceSwarm checks this command before enabling confirmed Claude Code sends.",
  },
  codex: {
    installCommand: "npm install -g @openai/codex",
    signInCommand: "codex login",
    checkCommand: "codex login status",
    signInCopy: "Sign in with ChatGPT or an OpenAI API key managed by Codex.",
    checkCopy: "ScienceSwarm checks this command before enabling confirmed Codex sends.",
  },
  "gemini-cli": {
    installCommand: "npm install -g @google/gemini-cli",
    signInCommand: "gemini",
    checkCommand: "gemini",
    signInCopy: "Choose Login with Google when Gemini asks how to authenticate.",
    checkCopy: "If Gemini opens without asking for an auth method, its native CLI session is usable.",
  },
};

function cliGuideFor(host: RuntimeHealthHost): RuntimeCliConnectionGuide | null {
  return CLI_CONNECTION_GUIDES[host.profile.id] ?? null;
}

function statusTone(host: RuntimeHealthHost): "ok" | "warn" | "neutral" {
  if (host.health.status !== "ready") return "warn";
  if (host.auth.status === "authenticated") return "ok";
  if (host.auth.status === "not-required") return "ok";
  if (
    host.profile.authMode === "subscription-native"
    && host.auth.status === "unknown"
  ) {
    return "neutral";
  }
  return "warn";
}

function statusLabel(host: RuntimeHealthHost): string {
  if (host.health.status !== "ready") return "Install required";
  if (host.auth.status === "authenticated") return "Signed in";
  if (host.auth.status === "missing") return "Sign-in required";
  if (host.auth.status === "invalid") return "Sign-in invalid";
  if (host.auth.status === "unknown") return "CLI owns sign-in";
  return "Ready";
}

export function subscriptionCliHosts(hosts: RuntimeHealthHost[]): RuntimeHealthHost[] {
  return hosts.filter((host) =>
    host.profile.authMode === "subscription-native" && cliGuideFor(host)
  );
}

export function runtimeCliSetupAction(host: RuntimeHealthHost): string {
  const guide = cliGuideFor(host);
  if (!guide) {
    const command = host.profile.transport.command;
    return command
      ? `Install ${command}, then sign in with its native CLI.`
      : "Install the native CLI, then sign in there.";
  }

  if (host.health.status !== "ready") {
    return `Install with ${guide.installCommand}, then run ${guide.signInCommand}.`;
  }
  if (host.auth.status === "missing" || host.auth.status === "invalid") {
    return `Run ${guide.signInCommand}, then refresh Settings.`;
  }
  if (host.auth.status === "unknown") {
    return `Run ${guide.signInCommand} if needed; ScienceSwarm will use the CLI session.`;
  }
  return `Connected through ${host.profile.transport.command ?? "the native CLI"}.`;
}

export function RuntimeAccountSetupGuide({
  hosts,
}: {
  hosts: RuntimeHealthHost[];
}) {
  const subscriptionHosts = subscriptionCliHosts(hosts);

  if (subscriptionHosts.length === 0) return null;

  return (
    <section
      className="rounded-lg border border-border bg-background p-4"
      data-testid="runtime-account-setup-guide"
      aria-label="Subscription CLI account setup"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">
            Connect subscription CLIs
          </h3>
          <p className="mt-1 max-w-3xl text-sm text-muted">
            ScienceSwarm does not connect Claude, Codex, or Gemini accounts directly.
            Install each provider CLI, sign in there, then choose Cloud ok before selecting
            a third-party destination.
          </p>
        </div>
        <RuntimeStatusChip label="No tokens stored" tone="ok" />
      </div>

      <ol className="mt-4 grid gap-3 md:grid-cols-3">
        {subscriptionHosts.map((host) => {
          const guide = cliGuideFor(host);
          if (!guide) return null;

          return (
            <li
              key={host.profile.id}
              className="min-w-0 rounded border border-border bg-surface p-3"
            >
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <p className="break-words text-sm font-semibold text-foreground">
                    {host.profile.label}
                  </p>
                  <p className="mt-1 text-xs text-muted">
                    {guide.signInCopy}
                  </p>
                </div>
                <RuntimeStatusChip label={statusLabel(host)} tone={statusTone(host)} />
              </div>

              <div className="mt-3 space-y-2">
                <div>
                  <p className="text-xs font-semibold uppercase text-muted">Install</p>
                  <code className="mt-1 block overflow-x-auto whitespace-nowrap rounded border border-border bg-white px-2 py-1 font-mono text-xs text-foreground">
                    {guide.installCommand}
                  </code>
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase text-muted">Sign in</p>
                  <code className="mt-1 block overflow-x-auto whitespace-nowrap rounded border border-border bg-white px-2 py-1 font-mono text-xs text-foreground">
                    {guide.signInCommand}
                  </code>
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase text-muted">Check</p>
                  <code className="mt-1 block overflow-x-auto whitespace-nowrap rounded border border-border bg-white px-2 py-1 font-mono text-xs text-foreground">
                    {guide.checkCommand}
                  </code>
                  <p className="mt-1 text-xs text-muted">{guide.checkCopy}</p>
                </div>
              </div>
            </li>
          );
        })}
      </ol>

      <p className="mt-3 text-xs text-muted">
        After sign-in, use Project policy: Cloud ok. Third-party sends still show a preview
        before any prompt or project context leaves the local workspace.
      </p>
    </section>
  );
}
