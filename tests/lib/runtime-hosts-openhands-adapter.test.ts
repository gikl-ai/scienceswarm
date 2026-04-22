import { describe, expect, it } from "vitest";

import { RuntimeHostCapabilityUnsupported } from "@/lib/runtime-hosts";
import { createOpenHandsRuntimeHostAdapter } from "@/lib/runtime-hosts/adapters/openhands";

const preview = {
  allowed: true,
  projectPolicy: "execution-ok" as const,
  hostId: "openhands" as const,
  mode: "task" as const,
  effectivePrivacyClass: "local-network" as const,
  destinations: [
    {
      hostId: "openhands" as const,
      label: "OpenHands",
      privacyClass: "local-network" as const,
    },
  ],
  dataIncluded: [{ kind: "prompt" as const, label: "User prompt", bytes: 10 }],
  proof: {
    projectGatePassed: true,
    operationPrivacyClass: "local-network" as const,
    adapterProof: "declared-local" as const,
  },
  blockReason: null,
  requiresUserApproval: false,
  accountDisclosure: {
    authMode: "local" as const,
    provider: "openhands" as const,
    billingClass: "local-compute" as const,
    accountSource: "openhands" as const,
    costCopyRequired: false,
  },
};

describe("OpenHands runtime host adapter", () => {
  it("reports local-network privacy and local OpenHands auth", async () => {
    const adapter = createOpenHandsRuntimeHostAdapter({
      client: {
        async healthCheck() {
          return { status: "ready", detail: "OpenHands test service" };
        },
      },
    });

    await expect(adapter.health()).resolves.toMatchObject({
      status: "ready",
      detail: "OpenHands test service",
    });
    await expect(adapter.authStatus()).resolves.toMatchObject({
      status: "not-required",
      authMode: "local",
      provider: "openhands",
    });
    await expect(adapter.privacyProfile()).resolves.toMatchObject({
      privacyClass: "local-network",
      adapterProof: "declared-local",
    });
  });

  it("starts OpenHands tasks through the existing client boundary and queues the prompt", async () => {
    const calls: string[] = [];
    const adapter = createOpenHandsRuntimeHostAdapter({
      idGenerator: () => "wrapper-session",
      now: () => new Date("2026-04-22T10:00:00.000Z"),
      client: {
        async startConversation(request) {
          calls.push(`start:${request.message}`);
          return { id: "fe6bdb1c701c4123a77552803603c522" };
        },
        async queuePendingMessage(taskOrConversationId, message) {
          calls.push(`queue:${taskOrConversationId}:${message}`);
        },
      },
    });

    const session = await adapter.executeTask({
      hostId: "openhands",
      projectId: "project-alpha",
      conversationId: null,
      mode: "task",
      prompt: "Create a results summary",
      inputFileRefs: [],
      dataIncluded: preview.dataIncluded,
      approvalState: "approved",
      preview,
    });

    expect(calls).toEqual([
      "start:",
      "queue:fe6bdb1c701c4123a77552803603c522:Create a results summary",
    ]);
    expect(session).toMatchObject({
      id: "openhands-fe6bdb1c701c4123a77552803603c522",
      hostId: "openhands",
      projectId: "project-alpha",
      conversationId: "fe6bdb1c701c4123a77552803603c522",
      mode: "task",
      status: "running",
    });
  });

  it("normalizes OpenHands events without requiring a live OpenHands service", async () => {
    const adapter = createOpenHandsRuntimeHostAdapter({
      now: () => new Date("2026-04-22T10:00:00.000Z"),
      client: {
        async getEvents() {
          return [
            {
              id: 7,
              source: "agent",
              kind: "MessageEvent",
              llm_message: {
                content: [{ type: "text", text: "Done" }],
              },
            },
            {
              id: "artifact-1",
              kind: "FileEditObservation",
              path: "/workspace/project-alpha/results/summary.md",
            },
          ];
        },
        extractAgentMessageText(event) {
          if (
            event
            && typeof event === "object"
            && (event as { source?: unknown }).source === "agent"
          ) {
            return "Done";
          }
          return null;
        },
      },
    });

    const events = [];
    for await (const event of adapter.streamEvents("conversation-1")) {
      events.push(event);
    }

    expect(events).toEqual([
      expect.objectContaining({
        id: "openhands-conversation-1-7",
        type: "message",
        payload: { text: "Done" },
      }),
      expect.objectContaining({
        id: "openhands-conversation-1-artifact-1",
        type: "artifact",
        payload: {
          path: "/workspace/project-alpha/results/summary.md",
        },
      }),
    ]);
  });

  it("does not treat incidental path fields as artifacts", async () => {
    const adapter = createOpenHandsRuntimeHostAdapter({
      now: () => new Date("2026-04-22T10:00:00.000Z"),
      client: {
        async getEvents() {
          return [
            {
              id: "navigation-1",
              kind: "NavigationEvent",
              path: "/workspace/project-alpha/results/summary.md",
            },
          ];
        },
      },
    });

    const events = [];
    for await (const event of adapter.streamEvents("conversation-1")) {
      events.push(event);
    }

    expect(events).toEqual([]);
  });

  it("resolves runtime session ids to OpenHands conversation ids for control APIs", async () => {
    const calls: string[] = [];
    const adapter = createOpenHandsRuntimeHostAdapter({
      client: {
        async startConversation() {
          return { id: "native-conversation-1" };
        },
        async queuePendingMessage() {},
        async cancelConversation(conversationId) {
          calls.push(`cancel:${conversationId}`);
          return { sessionId: conversationId, cancelled: true };
        },
        async getEvents(conversationId) {
          calls.push(`events:${conversationId}`);
          return [];
        },
        async listFiles(conversationId) {
          calls.push(`files:${conversationId}`);
          return [];
        },
      },
    });

    const session = await adapter.executeTask({
      hostId: "openhands",
      projectId: "project-alpha",
      conversationId: null,
      mode: "task",
      prompt: "Create a results summary",
      inputFileRefs: [],
      dataIncluded: preview.dataIncluded,
      approvalState: "approved",
      preview,
    });

    await expect(adapter.cancel(session.id)).resolves.toEqual({
      sessionId: session.id,
      cancelled: true,
    });
    for await (const _event of adapter.streamEvents(session.id)) {
      // Exhaust the iterable to force the client call.
    }
    await adapter.artifactImportHints(session.id);

    expect(calls).toEqual([
      "cancel:native-conversation-1",
      "events:native-conversation-1",
      "files:native-conversation-1",
    ]);
  });

  it("returns artifact import hints for files under the OpenHands workspace root", async () => {
    const adapter = createOpenHandsRuntimeHostAdapter({
      projectId: "project-alpha",
      projectRoot: "/Users/your-username/project-alpha",
      hostWorkspaceRoot: "/workspace/project-alpha",
      client: {
        async listFiles(_conversationId, requestedPath) {
          expect(requestedPath).toBe("/workspace/project-alpha");
          return [
            {
              path: "/workspace/project-alpha/results/summary.md",
              type: "file",
            },
            {
              path: "/workspace/project-alpha/results",
              type: "directory",
            },
          ];
        },
      },
    });

    await expect(adapter.artifactImportHints("conversation-1")).resolves.toEqual([
      {
        sessionId: "conversation-1",
        hostId: "openhands",
        sourcePath: "/workspace/project-alpha/results/summary.md",
        sourceNamespace: "host-native",
        targetPath: "results/summary.md",
        provenance: {
          generatedByHostId: "openhands",
          runtimeSessionId: "conversation-1",
          privacyClass: "local-network",
        },
      },
    ]);
  });

  it("does not expose OpenHands as a direct chat host", async () => {
    const adapter = createOpenHandsRuntimeHostAdapter();

    await expect(
      adapter.sendTurn({
        hostId: "openhands",
        projectId: "project-alpha",
        conversationId: null,
        mode: "chat",
        prompt: "hello",
        inputFileRefs: [],
        dataIncluded: preview.dataIncluded,
        approvalState: "approved",
        preview: { ...preview, mode: "chat" },
      }),
    ).rejects.toThrow(RuntimeHostCapabilityUnsupported);
  });
});
