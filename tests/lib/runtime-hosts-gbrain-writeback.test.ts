import { describe, expect, it } from "vitest";

import type { GbrainClient } from "@/brain/gbrain-client";
import {
  createRuntimeEventStore,
  createRuntimeSessionStore,
} from "@/lib/runtime-hosts";
import {
  runtimeSessionSupportsNativeWritebackStatuses,
  writeRuntimeArtifactsToGbrain,
  type RuntimeArtifactRecord,
} from "@/lib/runtime-hosts/gbrain-writeback";

const artifact: RuntimeArtifactRecord = {
  artifactId: "artifact-1",
  projectId: "project-alpha",
  sourceHostId: "openhands",
  sourceSessionId: "session-1",
  sourcePath: "/workspace/project-alpha/results/summary.md",
  workspacePath: "results/summary.md",
  gbrainSlug: null,
  provenance: {
    promptHash: "prompt-hash-1",
    inputFileRefs: ["gbrain:wiki/notes/assay-summary"],
    generatedAt: "2026-04-22T10:00:00.000Z",
    importedBy: "@tester",
    approvalState: "approved",
  },
};

describe("runtime gbrain writeback", () => {
  it("writes approved artifact metadata with RuntimeGbrainProvenance and no raw transcript", async () => {
    const writes: Array<{ slug: string; content: string }> = [];
    const gbrain: GbrainClient = {
      async putPage(slug, content) {
        writes.push({ slug, content });
        return { stdout: "ok", stderr: "" };
      },
      async linkPages() {
        return { stdout: "ok", stderr: "" };
      },
    };

    const result = await writeRuntimeArtifactsToGbrain({
      projectId: "project-alpha",
      runtimeSessionId: "session-1",
      hostId: "openhands",
      uploadedBy: "@tester",
      artifacts: [artifact],
      approvedSummary: "Runtime produced an approved summary artifact.",
      provenance: {
        runtimeSessionId: "session-1",
        hostId: "openhands",
        sourceArtifactId: "artifact-1",
        promptHash: "prompt-hash-1",
        inputFileRefs: ["gbrain:wiki/notes/assay-summary"],
        approvalState: "approved",
      },
      gbrain,
      now: () => new Date("2026-04-22T10:01:00.000Z"),
    });

    expect(result.phaseStatus).toBe("gbrain-writeback-complete");
    expect(result.sessionStatus).toBe("completed");
    expect(result.created).toEqual([
      {
        artifactId: "artifact-1",
        slug: "runtime-openhands-session-1-results-summary-md",
      },
    ]);
    expect(writes[0].content).toContain("runtime_gbrain_provenance:");
    expect(writes[0].content).toContain("runtimeSessionId: session-1");
    expect(writes[0].content).toContain("hostId: openhands");
    expect(writes[0].content).toContain(
      "Runtime produced an approved summary artifact.",
    );
    expect(writes[0].content).not.toContain("raw_transcript");
  });

  it("marks writeback failure as gbrain-writeback-failed instead of completed", async () => {
    const sessions = createRuntimeSessionStore();
    sessions.createSession({
      id: "session-1",
      hostId: "openhands",
      projectId: "project-alpha",
      mode: "task",
      status: "running",
    });
    const events = createRuntimeEventStore({ sessions });
    const gbrain: GbrainClient = {
      async putPage() {
        throw new Error("gbrain unavailable");
      },
      async linkPages() {
        return { stdout: "ok", stderr: "" };
      },
    };

    const result = await writeRuntimeArtifactsToGbrain({
      projectId: "project-alpha",
      runtimeSessionId: "session-1",
      hostId: "openhands",
      uploadedBy: "@tester",
      artifacts: [artifact],
      provenance: {
        runtimeSessionId: "session-1",
        hostId: "openhands",
        sourceArtifactId: "artifact-1",
        promptHash: "prompt-hash-1",
        inputFileRefs: [],
        approvalState: "approved",
      },
      gbrain,
      sessionStore: sessions,
      eventStore: events,
    });

    expect(result).toMatchObject({
      phaseStatus: "gbrain-writeback-failed",
      sessionStatus: "failed",
      errors: [
        {
          artifactId: "artifact-1",
          message: "gbrain unavailable",
        },
      ],
    });
    expect(sessions.getSession("session-1")?.status).toBe("failed");
    expect(events.listEvents("session-1")).toEqual([
      expect.objectContaining({
        type: "status",
        payload: expect.objectContaining({
          phaseStatus: "gbrain-writeback-pending",
          status: "running",
        }),
      }),
      expect.objectContaining({
        type: "error",
        payload: expect.objectContaining({
          phaseStatus: "gbrain-writeback-failed",
          status: "failed",
        }),
      }),
    ]);
  });

  it("documents that Track 1 session statuses do not yet carry literal writeback states", () => {
    expect(runtimeSessionSupportsNativeWritebackStatuses()).toBe(false);
  });
});
