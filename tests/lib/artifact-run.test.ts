import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtifactContextBundle } from "@/lib/artifacts/context-bundle";

const {
  getConversation,
  getEvents,
  getStartTaskStatus,
  sendPendingMessage,
  startConversation,
} = vi.hoisted(() => ({
  getConversation: vi.fn(),
  getEvents: vi.fn(),
  getStartTaskStatus: vi.fn(),
  sendPendingMessage: vi.fn(),
  startConversation: vi.fn(),
}));

vi.mock("@/lib/openhands", async (importOriginal) => {
  // Import the real module so we get the real `extractAgentMessageText`
  // helper — artifact-run relies on it to normalize OH 1.5 and 1.6
  // agent message shapes. Mocking it away would hide version
  // regressions exactly like the one this test suite is supposed
  // to catch.
  const actual = (await importOriginal()) as typeof import("@/lib/openhands");
  return {
    ...actual,
    getConversation,
    getEvents,
    getStartTaskStatus,
    sendPendingMessage,
    startConversation,
  };
});

import { runArtifact } from "@/lib/artifacts/run-artifact";

function runArtifactWithoutPollingDelay(
  input: Parameters<typeof runArtifact>[0],
): ReturnType<typeof runArtifact> {
  return runArtifact(input, { pollIntervalMs: 0 });
}

const bundle: ArtifactContextBundle = {
  request: {
    project: "Project Alpha",
    projectSlug: "project-alpha",
    artifactType: "memo",
    intent: "Create a memo summarizing the primer design tradeoffs from the latest discussion.",
    messageIds: [],
    idempotencyKey: "key-1",
  },
  project: "Project Alpha",
  projectSlug: "project-alpha",
  projectTitle: "Project Alpha",
  artifactType: "memo",
  intent: "Create a memo summarizing the primer design tradeoffs from the latest discussion.",
  projectPagePath: "wiki/projects/project-alpha.md",
  manifest: {
    version: 1,
    projectId: "project-alpha",
    slug: "project-alpha",
    title: "Project Alpha",
    privacy: "execution-ok",
    status: "active",
    projectPagePath: "wiki/projects/project-alpha.md",
    sourceRefs: [],
    decisionPaths: [],
    taskPaths: [],
    artifactPaths: [],
    frontierPaths: [],
    activeThreads: [],
    dedupeKeys: [],
    updatedAt: "2026-04-08T00:00:00.000Z",
  },
  brainRoot: "/tmp/brain",
  stateRoot: "/tmp/brain/state",
  projectPage: null,
  decisions: [],
  tasks: [],
  artifacts: [],
  prompt: "Generate the artifact.",
  sourceRefs: [],
  privacy: "execution-ok",
};

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("runArtifact", () => {
  it("lets startConversation resolve the runtime model for new artifact runs", async () => {
    startConversation.mockResolvedValue({
      id: "task-1",
      status: "READY",
      app_conversation_id: "conv-started",
    });
    getEvents.mockResolvedValue([
      {
        id: 1,
        source: "agent",
        message: [
          "```json",
          JSON.stringify({
            title: "Started Memo",
            fileName: "started-memo.md",
            content: "# Started\n\nArtifact body.",
          }),
          "```",
        ].join("\n"),
      },
    ]);
    getConversation.mockResolvedValue({ execution_status: "finished" });

    await runArtifactWithoutPollingDelay(bundle);

    expect(startConversation).toHaveBeenCalledWith({
      message: "Generate the artifact.",
    });
  });

  it("fails clearly when OpenHands returns an empty task status list", async () => {
    startConversation.mockResolvedValue({
      id: "task-1",
      status: "PENDING",
    });
    getStartTaskStatus.mockResolvedValue([]);

    await expect(runArtifactWithoutPollingDelay(bundle)).rejects.toThrow(
      "OpenHands returned an empty task status list",
    );
  });

  it("requests a larger event page so long conversations still capture the agent response", async () => {
    sendPendingMessage.mockResolvedValue(undefined);
    getEvents
      .mockResolvedValueOnce([])
      .mockResolvedValue([
        {
          id: 1,
          source: "agent",
          message: [
            "```json",
            JSON.stringify({
              title: "Primer Design Memo",
              fileName: "primer-design-memo.md",
              content: "# Memo\n\nDraft memo body.",
            }),
            "```",
          ].join("\n"),
        },
      ]);
    getConversation.mockResolvedValue({ execution_status: "finished" });

    const result = await runArtifactWithoutPollingDelay({
      ...bundle,
      request: {
        ...bundle.request,
        conversationId: "conv-1",
      },
    });

    expect(getEvents).toHaveBeenCalledWith("conv-1", 100);
    expect(result.title).toBe("Primer Design Memo");
  });

  it("ignores prior agent messages when continuing an existing conversation", async () => {
    sendPendingMessage.mockResolvedValue(undefined);
    getEvents
      .mockResolvedValueOnce([
        {
          id: "event-1",
          source: "agent",
          message: "previous response",
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "event-1",
          source: "agent",
          message: "previous response",
        },
        {
          id: "event-2",
          source: "agent",
          message: [
            "```json",
            JSON.stringify({
              title: "New Memo",
              fileName: "new-memo.md",
              content: "# New Memo\n\nUpdated content.",
            }),
            "```",
          ].join("\n"),
        },
      ]);
    getConversation.mockResolvedValue({ execution_status: "finished" });

    const result = await runArtifactWithoutPollingDelay({
      ...bundle,
      request: {
        ...bundle.request,
        conversationId: "conv-1",
      },
    });

    expect(result.title).toBe("New Memo");
    expect(result.rawResponse).toContain("Updated content.");
  });

  it("extracts agent text from OH 1.6 MessageEvent shape (llm_message.content[].text)", async () => {
    // Regression guard for the OH 1.5 → 1.6 event shape change. Before
    // `extractAgentMessageText`, run-artifact filtered events by
    // `event.source === "agent" && event.message` which silently
    // dropped every OH 1.6 message and threw "Artifact execution
    // completed without a usable agent response".
    sendPendingMessage.mockResolvedValue(undefined);
    getEvents
      .mockResolvedValueOnce([])
      .mockResolvedValue([
        {
          id: "msg-1",
          kind: "MessageEvent",
          source: "agent",
          llm_message: {
            role: "assistant",
            content: [
              {
                type: "text",
                text: [
                  "```json",
                  JSON.stringify({
                    title: "OH16 Memo",
                    fileName: "oh16-memo.md",
                    content: "# OH16\n\nBody from the 1.6 shape.",
                  }),
                  "```",
                ].join("\n"),
              },
            ],
          },
        },
      ]);
    getConversation.mockResolvedValue({ execution_status: "finished" });

    const result = await runArtifactWithoutPollingDelay({
      ...bundle,
      request: {
        ...bundle.request,
        conversationId: "conv-oh16",
      },
    });

    expect(result.title).toBe("OH16 Memo");
    expect(result.fileName).toBe("oh16-memo.md");
    expect(result.content).toContain("Body from the 1.6 shape.");
  });
});
