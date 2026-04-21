import { describe, it, expect, beforeEach } from "vitest";
import {
  __setJobStoreOverride,
  generateJobHandle,
  getJobStore,
  type JobRecord,
} from "@/lib/jobs/job-store";

function makeRecord(handle: string, overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    handle,
    kind: "revise_paper",
    input_refs: { paper: "hubble-1929" },
    expected_artifacts: ["revision"],
    started_at: "2026-04-15T01:00:00Z",
    updated_at: "2026-04-15T01:00:00Z",
    status: "running",
    ...overrides,
  };
}

beforeEach(() => {
  __setJobStoreOverride(null);
});

describe("job store", () => {
  it("registers and finds a record by handle", () => {
    const store = getJobStore();
    store.register(makeRecord("job_abc"));
    expect(store.find("job_abc")?.handle).toBe("job_abc");
    expect(store.find("missing")).toBeNull();
  });

  it("updates an existing record with patch semantics", () => {
    const store = getJobStore();
    store.register(makeRecord("job_xyz", { status: "running" }));
    const patched = store.update("job_xyz", {
      status: "finished",
      finished_at: "2026-04-15T01:05:00Z",
    });
    expect(patched?.status).toBe("finished");
    expect(patched?.finished_at).toBe("2026-04-15T01:05:00Z");
    // updated_at must refresh automatically.
    expect(patched?.updated_at).not.toBe("2026-04-15T01:00:00Z");
  });

  it("returns null on update for an unknown handle", () => {
    const store = getJobStore();
    const result = store.update("ghost", { status: "finished" });
    expect(result).toBeNull();
  });

  it("lists every registered record", () => {
    const store = getJobStore();
    store.register(makeRecord("job_a"));
    store.register(makeRecord("job_b"));
    expect(store.list().map((r) => r.handle).sort()).toEqual([
      "job_a",
      "job_b",
    ]);
  });

  it("removes a record by handle", () => {
    const store = getJobStore();
    store.register(makeRecord("job_rm"));
    store.remove("job_rm");
    expect(store.find("job_rm")).toBeNull();
  });
});

describe("generateJobHandle", () => {
  it("returns a string prefixed with job_ and has a hex suffix", () => {
    const handle = generateJobHandle();
    expect(handle).toMatch(/^job_[0-9a-f]{8}$/);
  });

  it("returns distinct handles across calls", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      seen.add(generateJobHandle());
    }
    expect(seen.size).toBe(50);
  });
});
