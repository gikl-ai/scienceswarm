import { describe, expect, it } from "vitest";

import { createCodexRuntimeHostAdapter } from "@/lib/runtime-hosts/adapters/codex";
import {
  RuntimeHostRouter,
  computeTurnPreview,
  createRuntimeEventStore,
  createRuntimeSessionStore,
  requireRuntimeHostProfile,
  type RuntimeSessionRecord,
} from "@/lib/runtime-hosts";
import type {
  CliTransport,
  CliTransportRunRequest,
  CliTransportRunResult,
} from "@/lib/runtime-hosts/transport/cli";
import { normalizeCliOutput } from "@/lib/runtime-hosts/transport/output-normalizer";

class ContractFakeTransport implements CliTransport {
  constructor(private readonly output: string) {}

  async run(request: CliTransportRunRequest): Promise<CliTransportRunResult> {
    return {
      command: request.command,
      args: request.args ?? [],
      exitCode: 0,
      signal: null,
      output: normalizeCliOutput({ stdout: this.output }),
    };
  }
}

describe("runtime hosts fake adapter contract", () => {
  it("dispatches an approved fake CLI adapter through the runtime router", async () => {
    const sessionStore = createRuntimeSessionStore({
      idGenerator: () => "session-1",
      now: () => new Date("2026-04-22T10:00:00.000Z"),
    });
    const router = new RuntimeHostRouter({
      sessionStore,
      adapters: [
        createCodexRuntimeHostAdapter({
          transport: new ContractFakeTransport("{\"message\":\"contract ok\"}"),
        }),
      ],
    });

    const result = await router.dispatchTurn({
      hostId: "codex",
      projectPolicy: "cloud-ok",
      projectId: "project-alpha",
      conversationId: "conversation-alpha",
      mode: "chat",
      prompt: "Review project-alpha notes.",
      approvalState: "approved",
    });

    expect(result.result).toMatchObject({
      hostId: "codex",
      message: "contract ok",
    });
    expect(sessionStore.getSession(result.session.id)).toMatchObject({
      status: "completed",
      hostId: "codex",
    });
  });

  it("keeps duplicate and stale fake adapter events from corrupting session state", () => {
    const sessions = createRuntimeSessionStore();
    const session = sessions.createSession({
      id: "codex-child-session",
      hostId: "codex",
      projectId: "project-alpha",
      conversationId: "conversation-alpha",
      mode: "compare",
      status: "completed",
      updatedAt: "2026-04-22T10:05:00.000Z",
    });
    const events = createRuntimeEventStore({ sessions });

    const first = events.appendEvent({
      id: "codex-event-1",
      sessionId: session.id,
      hostId: "codex",
      type: "text",
      createdAt: "2026-04-22T10:01:00.000Z",
      payload: { text: "first replay" },
    });
    const duplicate = events.appendEvent({
      id: "codex-event-1",
      sessionId: session.id,
      hostId: "codex",
      type: "text",
      createdAt: "2026-04-22T10:02:00.000Z",
      payload: { text: "duplicate replay" },
    });
    const stale = events.appendEvent({
      id: "codex-event-2",
      sessionId: session.id,
      hostId: "codex",
      type: "status",
      createdAt: "2026-04-22T10:00:00.000Z",
      payload: { status: "running" },
    });

    expect(first.stale).toBe(true);
    expect(duplicate).toMatchObject({ appended: false, duplicate: true });
    expect(stale).toMatchObject({
      stale: true,
      event: {
        payload: {
          runtimeEventStale: true,
        },
      },
    });
    expect(sessions.getSession(session.id)?.status).toBe("completed");
  });

  it("models partial compare child failure without blocking successful child records", () => {
    const store = createRuntimeSessionStore({
      now: () => new Date("2026-04-22T10:00:00.000Z"),
    });
    const openclaw = requireRuntimeHostProfile("openclaw");
    const codex = requireRuntimeHostProfile("codex");
    const preview = computeTurnPreview({
      projectPolicy: "cloud-ok",
      host: openclaw,
      selectedHosts: [openclaw, codex],
      mode: "compare",
      dataIncluded: [{ kind: "prompt", label: "project-alpha prompt", bytes: 10 }],
    });

    const successful = store.createSession({
      id: "compare-child-openclaw",
      hostId: "openclaw",
      projectId: "project-alpha",
      mode: "compare",
      status: "completed",
      preview,
    });
    const failed = store.createSession({
      id: "compare-child-codex",
      hostId: "codex",
      projectId: "project-alpha",
      mode: "compare",
      status: "failed",
      preview,
      errorCode: "RUNTIME_TRANSPORT_ERROR",
    });

    const children: RuntimeSessionRecord[] = store.listSessions({
      projectId: "project-alpha",
    });

    expect(preview).toMatchObject({
      allowed: true,
      accountDisclosure: {
        compareFanOutCount: 2,
      },
    });
    expect(children).toEqual([successful, failed]);
    expect(children.map((child) => child.status)).toEqual(["completed", "failed"]);
  });
});
