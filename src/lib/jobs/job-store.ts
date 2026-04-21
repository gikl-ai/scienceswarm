/**
 * In-memory job handle store.
 *
 * v1 uses a plain Map; v2 upgrades to a gbrain page per job
 * (type: job_run). The interface stays small so the v2 upgrade is a
 * drop-in replacement: consumers see {register, find, update, list,
 * remove}, and the in-memory map is the only module that touches
 * the data structure.
 */

import type { JobFooter } from "./footer-parser";

export type JobStatus =
  | "pending"
  | "running"
  | "finished"
  | "failed"
  | "cancelled"
  | "timed_out";

export interface JobRecord {
  handle: string;
  kind: string;
  project?: string;
  input_refs: Record<string, string>;
  expected_artifacts: string[];
  started_at: string;
  updated_at: string;
  finished_at?: string;
  conversation_id?: string;
  status: JobStatus;
  final?: JobFooter;
  error?: string;
}

export interface JobStore {
  register(record: JobRecord): void;
  find(handle: string): JobRecord | null;
  update(handle: string, patch: Partial<Omit<JobRecord, "handle">>): JobRecord | null;
  list(): JobRecord[];
  remove(handle: string): void;
}

class InMemoryJobStore implements JobStore {
  private records = new Map<string, JobRecord>();

  register(record: JobRecord): void {
    this.records.set(record.handle, record);
  }
  find(handle: string): JobRecord | null {
    return this.records.get(handle) ?? null;
  }
  update(handle: string, patch: Partial<Omit<JobRecord, "handle">>): JobRecord | null {
    const current = this.records.get(handle);
    if (!current) return null;
    const next: JobRecord = {
      ...current,
      ...patch,
      handle,
      updated_at: new Date().toISOString(),
    };
    this.records.set(handle, next);
    return next;
  }
  list(): JobRecord[] {
    return Array.from(this.records.values());
  }
  remove(handle: string): void {
    this.records.delete(handle);
  }
}

let _instance: JobStore | null = null;

export function getJobStore(): JobStore {
  if (!_instance) _instance = new InMemoryJobStore();
  return _instance;
}

export function __setJobStoreOverride(store: JobStore | null): void {
  _instance = store;
}

export function generateJobHandle(): string {
  // job_<8 random hex> — short enough for chat, wide enough to avoid
  // collision inside a single overnight session.
  const buf = new Uint8Array(4);
  crypto.getRandomValues(buf);
  const hex = Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
  return `job_${hex}`;
}
