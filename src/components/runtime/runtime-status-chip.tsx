import type { RuntimePrivacyClass } from "@/lib/runtime-hosts/contracts";

type ChipTone = "ok" | "warn" | "danger" | "neutral";

const PRIVACY_LABELS: Record<RuntimePrivacyClass, string> = {
  "local-only": "Local only",
  "local-network": "Local network",
  hosted: "Hosted",
  "external-network": "External network",
};

function toneClass(tone: ChipTone): string {
  switch (tone) {
    case "ok":
      return "border-emerald-200 bg-emerald-50 text-emerald-700";
    case "warn":
      return "border-amber-200 bg-amber-50 text-amber-700";
    case "danger":
      return "border-red-200 bg-red-50 text-red-700";
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
