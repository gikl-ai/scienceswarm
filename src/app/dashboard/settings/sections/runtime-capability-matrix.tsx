import type {
  RuntimeCapability,
  RuntimeCapabilityContract,
  RuntimeCapabilityStatus,
  RuntimePrivacyClass,
  RuntimeSummaryState,
} from "@/lib/runtime";
import { Section, StatusDot } from "./_primitives";

const STATUS_STYLES: Record<RuntimeCapabilityStatus, string> = {
  ready: "border-ok/30 bg-ok/10 text-ok",
  unavailable: "border-rule bg-sunk text-dim",
  misconfigured: "border-warn/30 bg-warn/10 text-warn",
  blocked: "border-danger/30 bg-danger/10 text-danger",
};

const PRIVACY_LABELS: Record<RuntimePrivacyClass, string> = {
  "local-only": "Local only",
  "local-network": "Local network",
  hosted: "Third party",
  "external-network": "External network",
};

const SUMMARY_DOT: Record<RuntimeSummaryState, "ok" | "warn" | "off"> = {
  ready: "ok",
  attention: "warn",
  blocked: "warn",
};

function statusDot(status: RuntimeCapabilityStatus): "ok" | "warn" | "off" {
  if (status === "ready") return "ok";
  if (status === "unavailable") return "off";
  return "warn";
}

function formatGeneratedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function CapabilityRow({ capability }: { capability: RuntimeCapability }) {
  const evidence = capability.evidence.slice(0, 3);
  const metadata = [capability.provider, capability.model, capability.endpoint]
    .filter((item): item is string => Boolean(item && item.trim()));

  return (
    <li className="grid gap-3 border-t border-border py-4 md:grid-cols-[minmax(0,1.25fr)_minmax(0,0.7fr)_minmax(0,1.35fr)_minmax(0,1fr)] md:items-start">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <StatusDot status={statusDot(capability.status)} />
          <p className="min-w-0 break-words text-sm font-medium text-foreground">
            {capability.label}
          </p>
        </div>
        <p className="mt-1 break-all font-mono text-xs text-muted">
          {capability.capabilityId}
        </p>
        {metadata.length > 0 && (
          <p className="mt-1 break-all text-xs text-muted">
            {metadata.join(" / ")}
          </p>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <span
          className={`inline-flex min-h-7 items-center rounded-full border px-2.5 text-xs font-medium ${STATUS_STYLES[capability.status]}`}
        >
          {capability.status}
        </span>
        <span className="inline-flex min-h-7 items-center rounded-full border border-border bg-background px-2.5 text-xs font-medium text-foreground">
          {PRIVACY_LABELS[capability.privacy]}
        </span>
      </div>

      <div className="min-w-0 space-y-1">
        {evidence.length > 0 ? (
          evidence.map((item) => (
            <div
              key={`${capability.capabilityId}-${item.label}-${item.value ?? ""}`}
              className="min-w-0 break-words text-xs text-muted"
            >
              <span className="font-medium text-foreground">{item.label}</span>
              {item.value ? `: ${item.value}` : null}
              {item.stale ? " (stale)" : null}
            </div>
          ))
        ) : (
          <p className="text-xs text-muted">No evidence reported</p>
        )}
      </div>

      <p className="min-w-0 break-words text-xs text-muted">
        {capability.nextAction || "Ready"}
      </p>
    </li>
  );
}

export function RuntimeCapabilityMatrix({
  contract,
}: {
  contract: RuntimeCapabilityContract | null;
}) {
  return (
    <Section title="Capability matrix">
      {contract ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <StatusDot status={SUMMARY_DOT[contract.summary.state]} />
                <p className="text-sm font-medium text-foreground">
                  {contract.summary.title}
                </p>
              </div>
              <p className="mt-1 max-w-3xl text-sm text-muted">
                {contract.summary.detail}
              </p>
            </div>
            <div className="flex flex-wrap gap-2 text-xs">
              <span className="rounded-full border border-border bg-background px-2.5 py-1 text-foreground">
                {contract.strictLocalOnly ? "Strict local-only" : "Standard mode"}
              </span>
              <span className="rounded-full border border-border bg-background px-2.5 py-1 text-foreground">
                {contract.llmProvider} / {contract.configuredLocalModel}
              </span>
              <span className="rounded-full border border-border bg-background px-2.5 py-1 text-muted">
                {formatGeneratedAt(contract.generatedAt)}
              </span>
            </div>
          </div>

          <div className="hidden grid-cols-[minmax(0,1.25fr)_minmax(0,0.7fr)_minmax(0,1.35fr)_minmax(0,1fr)] gap-3 text-xs font-medium uppercase text-muted md:grid">
            <span>Capability</span>
            <span>Status</span>
            <span>Evidence</span>
            <span>Next action</span>
          </div>
          <ul>
            {contract.capabilities.map((capability) => (
              <CapabilityRow
                key={capability.capabilityId}
                capability={capability}
              />
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-sm text-muted">Loading runtime contract...</p>
      )}
    </Section>
  );
}
