import { describe, it, expect, beforeEach } from "vitest";

import {
  runJob,
  checkJob,
  loadDefinitionFromFs,
  type JobDeps,
  type OpenHandsTransport,
} from "@/lib/jobs/run-job";
import {
  __setJobStoreOverride,
  type JobStore,
} from "@/lib/jobs/job-store";

class InMemoryStore implements JobStore {
  records = new Map<string, import("@/lib/jobs/job-store").JobRecord>();
  register(record: import("@/lib/jobs/job-store").JobRecord): void {
    this.records.set(record.handle, record);
  }
  find(handle: string) {
    return this.records.get(handle) ?? null;
  }
  update(handle: string, patch: Partial<import("@/lib/jobs/job-store").JobRecord>) {
    const current = this.records.get(handle);
    if (!current) return null;
    const next = {
      ...current,
      ...patch,
      handle,
      updated_at: new Date().toISOString(),
    } as import("@/lib/jobs/job-store").JobRecord;
    this.records.set(handle, next);
    return next;
  }
  list() {
    return Array.from(this.records.values());
  }
  remove(handle: string) {
    this.records.delete(handle);
  }
}

function makeTransport(finalMessage: string | null, status: "finished" | "failed" | "timed_out" = "finished"): OpenHandsTransport {
  return {
    async startConversation(prompt) {
      expect(prompt).toContain("gbrain slug");
      return { conversationId: "conv_123" };
    },
    async waitForFinish() {
      return { status, finalMessage, errorMessage: status !== "finished" ? "simulated" : undefined };
    },
  };
}

function buildDeps(transport: OpenHandsTransport, store: JobStore): JobDeps {
  return {
    openhands: transport,
    store,
    loadDefinition: async () =>
      "Work on gbrain slug {{paper}} and plan {{plan}} and critique {{critique}}.",
    now: () => new Date("2026-04-15T01:00:00Z"),
  };
}

let store: InMemoryStore;

beforeEach(() => {
  store = new InMemoryStore();
  __setJobStoreOverride(store);
});

describe("runJob + checkJob", () => {
  it("registers a handle and returns a running status immediately", async () => {
    const transport = makeTransport(
      '```json\n{"slugs": ["hubble-1929-revision"], "files": ["sha256:abc"]}\n```',
    );
    const deps = buildDeps(transport, store);
    const result = await runJob(deps, {
      kind: "revise_paper",
      input_refs: {
        paper: "hubble-1929",
        plan: "hubble-1929-revision-plan",
        critique: "hubble-1929-critique",
      },
      expected_artifacts: ["revision"],
    });
    expect(result.handle).toMatch(/^job_/);
    expect(result.status).toBe("running");
    expect(result.conversation_id).toBe("conv_123");
    expect(store.records.size).toBe(1);
  });

  it("parses the fenced footer when the job finishes", async () => {
    const transport = makeTransport(
      '```json\n{"slugs": ["hubble-1929-revision"], "files": ["sha256:abc"]}\n```',
    );
    const deps = buildDeps(transport, store);
    const { handle } = await runJob(deps, {
      kind: "revise_paper",
      input_refs: {
        paper: "hubble-1929",
        plan: "hubble-1929-revision-plan",
        critique: "hubble-1929-critique",
      },
    });
    // Allow the fire-and-forget wait loop to settle.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const record = store.find(handle);
    expect(record?.status).toBe("finished");
    expect(record?.final?.slugs).toEqual(["hubble-1929-revision"]);
  });

  it("marks the job failed when the transport reports failed status", async () => {
    const transport = makeTransport(null, "failed");
    const deps = buildDeps(transport, store);
    const { handle } = await runJob(deps, {
      kind: "revise_paper",
      input_refs: { paper: "hubble-1929" },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(store.find(handle)?.status).toBe("failed");
    expect(store.find(handle)?.error).toContain("simulated");
  });

  it("marks the job timed_out when the transport reports a timeout", async () => {
    const transport = makeTransport(null, "timed_out");
    const deps = buildDeps(transport, store);
    const { handle } = await runJob(deps, {
      kind: "revise_paper",
      input_refs: { paper: "hubble-1929" },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(store.find(handle)?.status).toBe("timed_out");
  });

  it("checkJob reports elapsed_s and final artifact slugs", async () => {
    const transport = makeTransport(
      '```json\n{"slugs": ["hubble-1929-revision"]}\n```',
    );
    const deps = {
      ...buildDeps(transport, store),
      now: () => new Date("2026-04-15T01:00:42Z"),
    };
    const { handle } = await runJob(deps, {
      kind: "revise_paper",
      input_refs: { paper: "hubble-1929" },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const status = checkJob(deps, handle);
    expect(status.handle).toBe(handle);
    expect(status.status).toBe("finished");
    expect(status.final_artifacts).toEqual(["hubble-1929-revision"]);
  });

  it("checkJob throws on unknown handle", () => {
    const deps = buildDeps(makeTransport(null), store);
    expect(() => checkJob(deps, "missing")).toThrow(/no handle/);
  });

  it("maps OH 1.6 'cancelled' status through to the store", async () => {
    const transport = makeTransport(null, "cancelled" as "failed");
    const deps = buildDeps(transport, store);
    const { handle } = await runJob(deps, {
      kind: "revise_paper",
      input_refs: { paper: "hubble-1929" },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(store.find(handle)?.status).toBe("cancelled");
  });

  it("run_job rejects missing kind or input_refs", async () => {
    const deps = buildDeps(makeTransport(null), store);
    await expect(
      runJob(deps, { kind: "", input_refs: { paper: "x" } }),
    ).rejects.toThrow(/kind is required/);
    await expect(
      runJob(deps, {
        kind: "revise_paper",
        input_refs: null as unknown as Record<string, string>,
      }),
    ).rejects.toThrow(/input_refs must be an object/);
  });

  it("renderPrompt substitutes {{refs}} from input_refs", async () => {
    let capturedPrompt = "";
    const transport: OpenHandsTransport = {
      async startConversation(prompt) {
        capturedPrompt = prompt;
        return { conversationId: "conv_1" };
      },
      async waitForFinish() {
        return { status: "finished", finalMessage: null };
      },
    };
    const deps = buildDeps(transport, store);
    await runJob(deps, {
      kind: "revise_paper",
      input_refs: {
        paper: "hubble-1929",
        plan: "hubble-1929-revision-plan",
        critique: "hubble-1929-critique",
      },
    });
    expect(capturedPrompt).toContain("hubble-1929");
    expect(capturedPrompt).toContain("hubble-1929-revision-plan");
    expect(capturedPrompt).toContain("hubble-1929-critique");
    expect(capturedPrompt).not.toContain("{{paper}}");
  });

  it("loads all documented job definitions and rejects invalid kind strings", async () => {
    await expect(loadDefinitionFromFs("revise_paper")).resolves.toContain("{{paper}}");
    await expect(loadDefinitionFromFs("write_cover_letter")).resolves.toContain("{{revision}}");
    await expect(loadDefinitionFromFs("rerun_stats_and_regenerate_figure")).resolves.toContain("{{data}}");
    await expect(loadDefinitionFromFs("translate_paper")).resolves.toContain("{{target_lang}}");
    await expect(loadDefinitionFromFs("../../x")).rejects.toThrow(/invalid kind/);
    await expect(loadDefinitionFromFs("unknown_job")).rejects.toThrow(/unknown kind/);
  });
});
