import { sanitizeExternalText, type DbEntity } from "./db-base";

export interface AdapterOptions {
  persist?: boolean;
  client?: import("@/brain/in-process-gbrain-client").InProcessGbrainClient;
  brainRoot?: string;
  now?: Date;
  project?: string;
  maxQueueWaitMs?: number;
}

export function clampPageSize(value: number | undefined): number {
  return Math.min(200, Math.max(1, value ?? 25));
}

export function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => readString(entry))
    .filter((entry): entry is string => Boolean(entry));
}

export function compactRecord(input: Record<string, string | undefined | null>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(input).filter((entry): entry is [string, string] => Boolean(entry[1])),
  );
}

export function normalizeDoi(doi: string): string {
  return doi.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").toLowerCase();
}

export function parseYear(value: unknown): number | null {
  const match = String(value ?? "").match(/\b(18|19|20|21)\d{2}\b/);
  return match ? Number(match[0]) : null;
}

export function text(value: unknown, maxLength = 500): string | null {
  return sanitizeExternalText(value, { maxLength });
}

export function paperEntity(input: {
  sourceDb: string;
  ids: Record<string, string>;
  primaryId: { scheme: string; id: string };
  sourceUri: string;
  fetchedAt: string;
  title: string;
  authors?: Array<{ name: string; orcid?: string }>;
  venueName?: string;
  venueType?: string;
  year?: number | null;
  abstract?: string | null;
  retractionStatus?: "active" | "retracted" | "concern" | "withdrawn" | null;
}): DbEntity {
  return {
    type: "paper",
    ids: input.ids,
    primary_id: input.primaryId,
    source_db: [input.sourceDb],
    source_uri: input.sourceUri,
    fetched_at: input.fetchedAt,
    raw_summary: sanitizeExternalText(
      `${input.title}\n${input.abstract ?? ""}`,
      { maxLength: 10_000 },
    ),
    payload: {
      title: input.title,
      authors: input.authors ?? [],
      venue: {
        name: input.venueName ?? input.sourceDb,
        type: input.venueType ?? "database",
      },
      year: input.year ?? null,
      abstract: input.abstract ?? undefined,
      retraction_status: input.retractionStatus ?? "active",
    },
  };
}
