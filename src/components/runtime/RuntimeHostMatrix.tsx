import type {
  RuntimeAuthMode,
  RuntimeAuthProvider,
  RuntimeHostCapability,
  RuntimeHostHealth,
  RuntimeHostPrivacyProof,
  RuntimePrivacyClass,
} from "@/lib/runtime-hosts/contracts";

type StatusDotState = "ok" | "warn" | "off";

type RuntimeHealthPrivacy =
  | RuntimePrivacyClass
  | RuntimeHostPrivacyProof;

export interface RuntimeHealthHost {
  profile: {
    id: string;
    label: string;
    authMode: RuntimeAuthMode;
    authProvider: RuntimeAuthProvider;
    privacyClass: RuntimePrivacyClass;
    transport: {
      kind: string;
      protocol: string;
      command?: string;
      endpoint?: string;
    };
    capabilities: RuntimeHostCapability[];
    lifecycle: {
      canStream: boolean;
      canCancel: boolean;
      canResumeNativeSession: boolean;
      canListNativeSessions: boolean;
      cancelSemantics: "none" | "kill-wrapper-process" | "host-api-cancel";
      resumeSemantics:
        | "none"
        | "open-native-session"
        | "scienceSwarm-wrapper-session";
    };
    accountDisclosure: {
      storesTokensInScienceSwarm: false | "api-key-only";
      requiresProjectPrivacy: "local-only" | "cloud-ok" | "execution-ok";
    };
    mcpTools: string[];
  };
  health: RuntimeHostHealth;
  auth: {
    status: "not-required" | "authenticated" | "missing" | "invalid" | "unknown";
    authMode: RuntimeAuthMode;
    provider: RuntimeAuthProvider;
    accountLabel?: string;
    detail?: string;
  };
  privacy: RuntimeHealthPrivacy;
}

export interface RuntimeHealthResponse {
  hosts: RuntimeHealthHost[];
  checkedAt: string;
}

const PRIVACY_LABELS: Record<RuntimePrivacyClass, string> = {
  "local-only": "Local only",
  "local-network": "Local network",
  hosted: "Hosted",
  "external-network": "External network",
};

const AUTH_MODE_LABELS: Record<RuntimeAuthMode, string> = {
  local: "Local runtime",
  "subscription-native": "Native CLI login",
  "api-key": ".env API key",
};

const PROVIDER_LABELS: Record<RuntimeAuthProvider, string> = {
  openclaw: "OpenClaw",
  anthropic: "Anthropic",
  openai: "OpenAI",
  "google-ai": "Google AI",
  "vertex-ai": "Vertex AI",
  ollama: "Ollama",
  openhands: "OpenHands",
};

const CAPABILITY_COLUMNS: Array<{
  key: string;
  label: string;
  supported: (host: RuntimeHealthHost) => boolean;
  unavailableLabel: string;
}> = [
  {
    key: "chat",
    label: "Chat",
    supported: (host) => host.profile.capabilities.includes("chat"),
    unavailableLabel: "No chat",
  },
  {
    key: "task",
    label: "Task",
    supported: (host) => host.profile.capabilities.includes("task"),
    unavailableLabel: "No task",
  },
  {
    key: "compare",
    label: "Compare",
    supported: (host) => runtimeHostSupportsCompare(host),
    unavailableLabel: "No compare",
  },
  {
    key: "mcp-tools",
    label: "MCP tools",
    supported: (host) => host.profile.capabilities.includes("mcp-tools"),
    unavailableLabel: "No MCP",
  },
  {
    key: "artifact-import",
    label: "Artifacts",
    supported: (host) => host.profile.capabilities.includes("artifact-import"),
    unavailableLabel: "No import",
  },
  {
    key: "cancel",
    label: "Cancel",
    supported: (host) => host.profile.lifecycle.canCancel,
    unavailableLabel: "No cancel",
  },
  {
    key: "resume",
    label: "Resume",
    supported: (host) => host.profile.lifecycle.canResumeNativeSession,
    unavailableLabel: "No resume",
  },
  {
    key: "list-sessions",
    label: "Sessions",
    supported: (host) => host.profile.lifecycle.canListNativeSessions,
    unavailableLabel: "No list",
  },
];

export function runtimeHostSupportsCompare(host: RuntimeHealthHost): boolean {
  // Compare fan-out uses the runtime host chat capability in the policy layer.
  return host.profile.capabilities.includes("chat");
}

function StatusDot({ status }: { status: StatusDotState }) {
  const color =
    status === "ok"
      ? "bg-emerald-500"
      : status === "warn"
        ? "bg-amber-500"
        : "bg-zinc-400";
  return <span className={`inline-block h-2.5 w-2.5 rounded-full ${color}`} />;
}

function healthDot(host: RuntimeHealthHost): StatusDotState {
  if (host.health.status === "ready" && authReady(host)) return "ok";
  if (host.health.status === "unavailable") return "off";
  return "warn";
}

export function authReady(host: RuntimeHealthHost): boolean {
  return host.auth.status === "not-required" || host.auth.status === "authenticated";
}

export function runtimeHostBlockedByPolicy(
  host: RuntimeHealthHost,
  policy: "local-only" | "cloud-ok" | "execution-ok",
): boolean {
  if (policy === "execution-ok") return false;
  if (policy === "cloud-ok") {
    return host.profile.accountDisclosure.requiresProjectPrivacy === "execution-ok";
  }
  return host.profile.privacyClass === "hosted"
    || host.profile.privacyClass === "external-network"
    || host.profile.accountDisclosure.requiresProjectPrivacy !== "local-only";
}

export function runtimeHostSelectableForDefault(
  host: RuntimeHealthHost,
  policy: "local-only" | "cloud-ok" | "execution-ok",
): boolean {
  return !runtimeHostBlockedByPolicy(host, policy)
    && host.health.status === "ready"
    && authReady(host);
}

function privacyClassFromHealth(host: RuntimeHealthHost): RuntimePrivacyClass {
  return typeof host.privacy === "string"
    ? host.privacy
    : host.privacy.privacyClass;
}

function billingLabel(host: RuntimeHealthHost): string {
  if (host.profile.authMode === "api-key") return "API-key billing";
  if (host.profile.authMode === "subscription-native") return "Subscription-native account";
  if (host.profile.authProvider === "openhands") return "Local OpenHands";
  return "Local compute";
}

function accountSource(host: RuntimeHealthHost): string {
  if (host.profile.authMode === "api-key") {
    return ".env source; key value hidden";
  }
  if (host.profile.authMode === "subscription-native") {
    return "Uses native CLI login; ScienceSwarm stores no subscription tokens";
  }
  if (host.profile.authProvider === "openhands") {
    return "OpenHands local service";
  }
  return "Local ScienceSwarm/OpenClaw service";
}

function authStateLabel(host: RuntimeHealthHost): string {
  if (host.profile.authMode === "subscription-native") {
    if (host.auth.status === "authenticated") return "Native CLI authenticated";
    if (host.auth.status === "missing") return "Native CLI login required";
    if (host.auth.status === "invalid") return "Native CLI auth invalid";
    return "Uses native CLI login";
  }
  if (host.profile.authMode === "api-key") {
    if (host.auth.status === "authenticated") return "Configured in .env";
    if (host.auth.status === "missing") return "Missing .env key";
    if (host.auth.status === "invalid") return "Invalid .env key";
    return ".env key status unknown";
  }
  return host.auth.status === "not-required" ? "No credential required" : host.auth.status;
}

function lifecycleCopy(host: RuntimeHealthHost): string {
  const cancel =
    host.profile.lifecycle.cancelSemantics === "host-api-cancel"
      ? "host API cancel"
      : host.profile.lifecycle.cancelSemantics === "kill-wrapper-process"
        ? "wrapper process stop"
        : "no cancel";
  const resume =
    host.profile.lifecycle.resumeSemantics === "open-native-session"
      ? "native session resume"
      : host.profile.lifecycle.resumeSemantics === "scienceSwarm-wrapper-session"
        ? "ScienceSwarm wrapper resume"
        : "no resume";
  return `${cancel}; ${resume}`;
}

function formatCheckedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function CapabilityMark({
  supported,
  supportedLabel,
  unavailableLabel,
}: {
  supported: boolean;
  supportedLabel: string;
  unavailableLabel: string;
}) {
  return (
    <span
      className={`inline-flex min-h-7 w-full items-center justify-center rounded border px-2 text-xs font-medium ${
        supported
          ? "border-emerald-200 bg-emerald-50 text-emerald-700"
          : "border-zinc-200 bg-zinc-50 text-zinc-500"
      }`}
      title={supported ? supportedLabel : unavailableLabel}
    >
      {supported ? "Yes" : "No"}
    </span>
  );
}

export function RuntimeHostMatrix({
  runtimeHealth,
}: {
  runtimeHealth: RuntimeHealthResponse | null;
}) {
  return (
    <section
      className="space-y-4 rounded-lg border-2 border-border bg-surface p-6"
      data-testid="runtime-host-matrix"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Runtime hosts</h2>
          <p className="mt-1 max-w-3xl text-sm text-muted">
            Installed host state comes from /api/runtime/health, including auth
            mode, privacy class, capabilities, and lifecycle support.
          </p>
        </div>
        <span className="rounded border border-border bg-background px-2.5 py-1 text-xs text-muted">
          {runtimeHealth ? `Checked ${formatCheckedAt(runtimeHealth.checkedAt)}` : "Checking"}
        </span>
      </div>

      {runtimeHealth ? (
        <div className="overflow-x-auto">
          <table className="min-w-[980px] w-full border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-border text-xs uppercase text-muted">
                <th className="w-64 py-3 pr-4 font-medium">Host</th>
                <th className="w-64 px-3 py-3 font-medium">Auth and account</th>
                <th className="w-44 px-3 py-3 font-medium">Privacy</th>
                {CAPABILITY_COLUMNS.map((column) => (
                  <th key={column.key} className="w-24 px-2 py-3 text-center font-medium">
                    {column.label}
                  </th>
                ))}
                <th className="w-56 pl-3 py-3 font-medium">Lifecycle truth</th>
              </tr>
            </thead>
            <tbody>
              {runtimeHealth.hosts.map((host) => (
                <tr
                  key={`${host.profile.id}-${host.profile.label}-${host.profile.authMode}`}
                  className="border-b border-border align-top last:border-0"
                >
                  <td className="py-4 pr-4">
                    <div className="flex items-start gap-2">
                      <span className="mt-1">
                        <StatusDot status={healthDot(host)} />
                      </span>
                      <div className="min-w-0">
                        <p className="break-words font-medium text-foreground">
                          {host.profile.label}
                        </p>
                        <p className="mt-1 break-all font-mono text-xs text-muted">
                          {host.profile.id}
                        </p>
                        <p className="mt-1 text-xs text-muted">
                          {host.health.status === "ready"
                            ? "Ready"
                            : host.health.detail || "Unavailable"}
                        </p>
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-4">
                    <div className="space-y-1">
                      <p className="font-medium text-foreground">
                        {authStateLabel(host)}
                      </p>
                      <p className="text-xs text-muted">
                        {AUTH_MODE_LABELS[host.profile.authMode]} /{" "}
                        {PROVIDER_LABELS[host.profile.authProvider]}
                      </p>
                      <p className="text-xs text-muted">{billingLabel(host)}</p>
                      <p className="text-xs text-muted">{accountSource(host)}</p>
                    </div>
                  </td>
                  <td className="px-3 py-4">
                    <p className="font-medium text-foreground">
                      {PRIVACY_LABELS[privacyClassFromHealth(host)]}
                    </p>
                    <p className="mt-1 text-xs text-muted">
                      Requires {host.profile.accountDisclosure.requiresProjectPrivacy}
                    </p>
                  </td>
                  {CAPABILITY_COLUMNS.map((column) => (
                    <td key={column.key} className="px-2 py-4">
                      <CapabilityMark
                        supported={column.supported(host)}
                        supportedLabel={`${host.profile.label} supports ${column.label}`}
                        unavailableLabel={column.unavailableLabel}
                      />
                    </td>
                  ))}
                  <td className="pl-3 py-4">
                    <p className="text-xs text-muted">{lifecycleCopy(host)}</p>
                    <p className="mt-1 text-xs text-muted">
                      {host.profile.mcpTools.length} MCP tools exposed
                    </p>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-sm text-muted">Loading runtime host health...</p>
      )}
    </section>
  );
}
