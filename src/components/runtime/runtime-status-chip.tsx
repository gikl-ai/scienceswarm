import type { RuntimePrivacyClass } from "@/lib/runtime-hosts/contracts";

type ChipTone = "ok" | "warn" | "danger" | "neutral";

const PRIVACY_LABELS: Record<RuntimePrivacyClass, string> = {
  "local-only": "Local only",
  "local-network": "Local network",
  hosted: "Third party",
  "external-network": "External network",
};

function toneClass(tone: ChipTone): string {
  switch (tone) {
    case "ok":
      return "border-ok/30 bg-ok/10 text-ok";
    case "warn":
      return "border-warn/30 bg-warn/10 text-warn";
    case "danger":
      return "border-danger/30 bg-danger/10 text-danger";
    default:
      return "border-border bg-surface text-muted";
  }
}

export function RuntimeStatusChip({
  label,
  tone = "neutral",
  title,
}: {
  label: string;
  tone?: ChipTone;
  title?: string;
}) {
  return (
    <span
      className={`inline-flex min-h-7 max-w-full items-center rounded border px-2 text-xs font-medium ${toneClass(tone)}`}
      title={title ?? label}
    >
      <span className="truncate">{label}</span>
    </span>
  );
}

export function RuntimePrivacyChip({
  privacyClass,
}: {
  privacyClass: RuntimePrivacyClass;
}) {
  const tone: ChipTone =
    privacyClass === "local-only" || privacyClass === "local-network"
      ? "ok"
      : privacyClass === "hosted"
        ? "warn"
        : "danger";

  return <RuntimeStatusChip label={PRIVACY_LABELS[privacyClass]} tone={tone} />;
}
