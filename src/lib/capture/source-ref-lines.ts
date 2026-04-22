import type { SourceRef } from "@/brain/types";

function formatSourceRefLabel(ref: SourceRef): string | null {
  const value = ref.hash ? `${ref.ref} (${ref.hash})` : ref.ref;
  if (!value.trim()) {
    return null;
  }

  switch (ref.kind) {
    case "external":
      return value;
    case "artifact":
      return `artifact:${value}`;
    case "import":
      return `import:${value}`;
    case "conversation":
      return `conversation:${value}`;
    case "capture":
      return `capture:${value}`;
    default:
      return value;
  }
}

export function buildSourceRefCitationLines(sourceRefs: SourceRef[]): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();

  for (const ref of sourceRefs) {
    const label = formatSourceRefLabel(ref);
    if (!label) continue;
    const key = `${ref.kind}:${label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`[Source: ${label}]`);
  }

  return lines;
}

export function buildSourceRefEvidenceLines(sourceRefs: SourceRef[]): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();

  for (const ref of sourceRefs) {
    const label = formatSourceRefLabel(ref);
    if (!label) continue;
    const key = `${ref.kind}:${label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`- ${label}`);
  }

  return lines;
}
