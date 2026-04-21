import * as fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { isProjectLocalStateRoot } from "@/lib/state/project-storage";

/**
 * Reading-progress tracker: per-project persistence of per-paper reading
 * status and free-form notes. Backed by a JSON file under
 * `<stateRoot>/projects/<slug>/reading-progress.json` for legacy roots or
 * `<project>/.brain/state/reading-progress.json` for canonical project-local
 * roots.
 *
 * This module assumes the caller has already validated `slug` (e.g. via
 * `assertSafeProjectSlug`). The route layer is responsible for that check —
 * the lib stays framework-agnostic and never throws on untrusted slugs.
 */

export type ReadingStatus = "unread" | "reading" | "done";

export interface ReadingEntry {
  /** Relative path or filename identifying the paper within the project. */
  paperId: string;
  status: ReadingStatus;
  /** Optional free-form notes. */
  notes?: string;
  /** ISO timestamp of the most recent upsert. */
  updatedAt: string;
}

export interface ReadingProgressStore {
  version: 1;
  entries: Record<string, ReadingEntry>;
}

const VALID_STATUSES: readonly ReadingStatus[] = ["unread", "reading", "done"];
const writeQueues = new Map<string, Promise<void>>();

function isValidStatus(value: unknown): value is ReadingStatus {
  return typeof value === "string" && (VALID_STATUSES as readonly string[]).includes(value);
}

function assertValidStatus(status: unknown): asserts status is ReadingStatus {
  if (!isValidStatus(status)) {
    throw new Error(`Invalid status: ${String(status)}`);
  }
}

function emptyStore(): ReadingProgressStore {
  return { version: 1, entries: {} };
}

/** Resolve the per-project storage file path. */
export function getReadingProgressPath(stateRoot: string, slug: string): string {
  if (isProjectLocalStateRoot(slug, stateRoot)) {
    return path.join(stateRoot, "reading-progress.json");
  }
  return path.join(stateRoot, "projects", slug, "reading-progress.json");
}

/**
 * Read the store for a project. Returns an empty store (not null) when the
 * file doesn't exist — callers shouldn't have to branch on "first write".
 */
export async function loadReadingProgress(
  stateRoot: string,
  slug: string,
): Promise<ReadingProgressStore> {
  const filePath = getReadingProgressPath(stateRoot, slug);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return emptyStore();
    throw error;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<ReadingProgressStore> | null;
    if (!parsed || typeof parsed !== "object" || !parsed.entries) {
      return emptyStore();
    }
    return { version: 1, entries: { ...parsed.entries } };
  } catch {
    // Corrupt JSON: fall back to empty store rather than leaving the user
    // unable to ever write again. Atomic writes make this scenario rare.
    return emptyStore();
  }
}

async function atomicWriteStore(
  filePath: string,
  store: ReadingProgressStore,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  const payload = `${JSON.stringify(store, null, 2)}\n`;
  try {
    await fs.writeFile(tempPath, payload, "utf-8");
    await fs.rename(tempPath, filePath);
  } catch (error) {
    // Best-effort cleanup of the tmp sidecar; swallow cleanup failures so the
    // original error is what bubbles up to the caller.
    try {
      await fs.rm(tempPath, { force: true });
    } catch {
      /* noop */
    }
    throw error;
  }
}

async function withProjectWriteLock<T>(
  filePath: string,
  work: () => Promise<T>,
): Promise<T> {
  const previous = writeQueues.get(filePath);
  let releaseCurrent: (() => void) | undefined;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  writeQueues.set(filePath, current);

  await previous?.catch(() => {});

  try {
    return await work();
  } finally {
    releaseCurrent?.();
    if (writeQueues.get(filePath) === current) {
      writeQueues.delete(filePath);
    }
  }
}

/**
 * Insert or update an entry. Validates status, stamps `updatedAt`, and
 * atomically writes the merged store. Returns the stored entry.
 */
export async function upsertReadingEntry(
  stateRoot: string,
  slug: string,
  entry: Omit<ReadingEntry, "updatedAt">,
): Promise<ReadingEntry> {
  if (typeof entry.paperId !== "string" || entry.paperId.trim() === "") {
    throw new Error("Invalid paperId: must be a non-empty string");
  }
  assertValidStatus(entry.status);

  const filePath = getReadingProgressPath(stateRoot, slug);
  return await withProjectWriteLock(filePath, async () => {
    const store = await loadReadingProgress(stateRoot, slug);
    const stored: ReadingEntry = {
      paperId: entry.paperId,
      status: entry.status,
      ...(entry.notes !== undefined ? { notes: entry.notes } : {}),
      updatedAt: new Date().toISOString(),
    };

    store.entries[entry.paperId] = stored;
    await atomicWriteStore(filePath, store);
    return stored;
  });
}

/**
 * Remove an entry. Returns `true` if one was removed, `false` if the id was
 * not present. Only writes to disk when the store actually changes.
 */
export async function deleteReadingEntry(
  stateRoot: string,
  slug: string,
  paperId: string,
): Promise<boolean> {
  if (typeof paperId !== "string" || paperId.trim() === "") {
    return false;
  }

  const filePath = getReadingProgressPath(stateRoot, slug);
  return await withProjectWriteLock(filePath, async () => {
    const store = await loadReadingProgress(stateRoot, slug);
    if (!(paperId in store.entries)) {
      return false;
    }

    delete store.entries[paperId];
    await atomicWriteStore(filePath, store);
    return true;
  });
}
