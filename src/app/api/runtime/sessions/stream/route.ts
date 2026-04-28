import {
  approvalStateFromBody,
  assertPreviewAllowed,
  assertRuntimeApiLocalRequest,
  buildRuntimeTurnRequest,
  computeRuntimeApiPreview,
  dataIncludedFromBodyWithRuntimeContext,
  expandRuntimeSlashCommandPrompt,
  getRuntimeApiServices,
  optionalStringArrayField,
  optionalStringField,
  parseJsonObject,
  projectPolicyFromBody,
  requireSafeProjectId,
  requireStringField,
  runtimeAdapterForApi,
  runtimeErrorResponse,
  runtimeHostHistoryForSession,
  runtimeInvalidRequest,
  studyScopedIdFromBody,
  turnModeFromBody,
} from "../../_shared";
import { RuntimeHostError } from "@/lib/runtime-hosts/errors";
import type { RuntimeEvent } from "@/lib/runtime-hosts/contracts";

function enrichedSession(session: ReturnType<
  ReturnType<typeof getRuntimeApiServices>["sessionStore"]["getSession"]
>) {
  if (!session) return null;
  return {
    ...session,
    host: runtimeHostHistoryForSession(session.hostId),
  };
}

function runtimeEventInput(event: RuntimeEvent, sessionId: string): RuntimeEvent {
  return {
    ...event,
    sessionId,
  };
}

function isMessageTextEvent(event: RuntimeEvent): boolean {
  return event.type === "message" && typeof event.payload.text === "string";
}

function sseFrame(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

export async function POST(request: Request): Promise<Response> {
  let sessionId: string | null = null;
  try {
    const appOrigin = await assertRuntimeApiLocalRequest(request);
    const body = await parseJsonObject(request);
    const services = getRuntimeApiServices();
    const mode = turnModeFromBody(body, "chat");
    if (mode === "compare" || mode === "mcp-tool" || mode === "artifact-import") {
      throw runtimeInvalidRequest(
        "Use the dedicated runtime endpoint for this mode.",
        { mode },
      );
    }

    const hostId = requireStringField(body, "hostId");
    const prompt = await expandRuntimeSlashCommandPrompt(
      requireStringField(body, "prompt"),
      hostId,
    );
    const projectId = requireSafeProjectId(studyScopedIdFromBody(body));
    const conversationId = optionalStringField(body, "conversationId") ?? null;
    const approvalState = approvalStateFromBody(body);
    const inputFileRefs = optionalStringArrayField(body, "inputFileRefs") ?? [];
    const dataIncluded = dataIncludedFromBodyWithRuntimeContext({
      services,
      body,
      projectId,
      hostId,
    });
    const preview = computeRuntimeApiPreview({
      services,
      hostId,
      projectPolicy: projectPolicyFromBody(body),
      mode,
      dataIncluded,
    });
    assertPreviewAllowed(preview, approvalState);

    const session = services.sessionStore.createSession({
      hostId,
      projectId,
      conversationId,
      mode,
      status: "running",
      preview,
    });
    sessionId = session.id;

    const stream = new TransformStream<Uint8Array, Uint8Array>();
    const writer = stream.writable.getWriter();
    const encoder = new TextEncoder();
    let writeChain = Promise.resolve();
    const enqueue = (payload: unknown) => {
      writeChain = writeChain
        .then(() => writer.write(encoder.encode(sseFrame(payload))))
        .catch(() => undefined);
    };
    const enqueueDone = () => {
      writeChain = writeChain
        .then(() => writer.write(encoder.encode("data: [DONE]\n\n")))
        .catch(() => undefined);
    };
    let streamedMessageEvent = false;
    const appendEvent = (event: RuntimeEvent) => {
      const result = services.eventStore.appendEvent(runtimeEventInput(event, session.id));
      if (isMessageTextEvent(result.event)) streamedMessageEvent = true;
      if (result.appended) enqueue({ event: result.event });
      return result.event;
    };
    const appendInputEvent = (
      input: Parameters<typeof services.eventStore.appendEvent>[0],
    ) => {
      const result = services.eventStore.appendEvent(input);
      if (isMessageTextEvent(result.event)) streamedMessageEvent = true;
      if (result.appended) enqueue({ event: result.event });
      return result.event;
    };

    appendInputEvent({
      id: `${session.id}:runtime-started`,
      sessionId: session.id,
      hostId,
      type: "status",
      payload: {
        status: "running",
        mode,
        conversationId,
      },
    });

    const activeAdapter = runtimeAdapterForApi(hostId, services);
    let abortHandled = false;
    const cancelActiveRuntime = () => {
      if (abortHandled) return;
      abortHandled = true;
      try {
        services.sessionStore.updateSession(session.id, { status: "cancelled" });
      } catch {
        // A terminal completion/failure won the race; keep that final state.
      }
      void activeAdapter?.cancel(session.id).catch(() => undefined);
    };
    request.signal.addEventListener("abort", cancelActiveRuntime, { once: true });

    void (async () => {
      try {
        if (!activeAdapter) {
          throw runtimeInvalidRequest("No runtime adapter is registered for host.", {
            hostId,
          });
        }

        const turnRequest = buildRuntimeTurnRequest({
          hostId,
          runtimeSessionId: session.id,
          projectId,
          conversationId,
          mode,
          prompt,
          promptHash: optionalStringField(body, "promptHash"),
          inputFileRefs,
          approvalState,
          preview,
          appOrigin,
          onEvent: appendEvent,
        });
        const result = mode === "task"
          ? await activeAdapter.executeTask(turnRequest)
          : await activeAdapter.sendTurn(turnRequest);

        if ("message" in result) {
          for (const event of result.events ?? []) {
            appendEvent(event);
          }
          if (!streamedMessageEvent) {
            appendInputEvent({
              id: `${session.id}:runtime-message`,
              sessionId: session.id,
              hostId,
              type: "message",
              payload: {
                text: result.message,
                nativeSessionId: result.sessionId,
              },
            });
          }
          for (const [index, artifact] of (result.artifacts ?? []).entries()) {
            appendInputEvent({
              id: `${session.id}:artifact:${index}:${artifact.sourcePath}`,
              sessionId: session.id,
              hostId,
              type: "artifact",
              payload: artifact as unknown as Record<string, unknown>,
            });
          }
          services.sessionStore.updateSession(session.id, {
            status: "completed",
            conversationId: result.sessionId,
          });
          appendInputEvent({
            id: `${session.id}:runtime-completed`,
            sessionId: session.id,
            hostId,
            type: "done",
            payload: {
              status: "completed",
            },
          });
        } else {
          for (const event of result.events ?? []) {
            appendEvent(event);
          }
          services.sessionStore.updateSession(session.id, {
            status: result.status,
            conversationId: result.conversationId,
          });
          appendInputEvent({
            id: `${session.id}:runtime-${result.status}`,
            sessionId: session.id,
            hostId,
            type: result.status === "completed"
              ? "done"
              : result.status === "failed"
                ? "error"
                : "status",
            payload: {
              status: result.status,
              nativeSessionId: result.conversationId ?? result.id,
            },
          });
        }

        enqueue({
          session: enrichedSession(services.sessionStore.getSession(session.id)),
        });
      } catch (error) {
        if (
          abortHandled
          || services.sessionStore.getSession(session.id)?.status === "cancelled"
        ) {
          enqueue({
            session: enrichedSession(services.sessionStore.getSession(session.id)),
          });
          return;
        }
        services.sessionStore.trySetSessionStatus({
          sessionId: session.id,
          status: "failed",
          errorCode: error instanceof RuntimeHostError
            ? error.code
            : "RUNTIME_TRANSPORT_ERROR",
        });
        appendInputEvent({
          id: `${session.id}:runtime-failed`,
          sessionId: session.id,
          hostId: services.sessionStore.getSession(session.id)?.hostId ?? "unknown",
          type: "error",
          payload: {
            code: error instanceof RuntimeHostError
              ? error.code
              : "RUNTIME_TRANSPORT_ERROR",
            error: error instanceof Error
              ? error.message
              : "Runtime session failed.",
          },
        });
        enqueue({
          error: error instanceof RuntimeHostError
            ? error.userMessage
            : error instanceof Error
              ? error.message
              : "Runtime session failed.",
        });
      } finally {
        request.signal.removeEventListener("abort", cancelActiveRuntime);
        enqueueDone();
        await writeChain;
        await writer.close().catch(() => undefined);
      }
    })();

    return new Response(stream.readable, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    if (sessionId) {
      const services = getRuntimeApiServices();
      services.sessionStore.trySetSessionStatus({
        sessionId,
        status: "failed",
        errorCode: error instanceof RuntimeHostError
          ? error.code
          : "RUNTIME_TRANSPORT_ERROR",
      });
    }
    return runtimeErrorResponse(error);
  }
}
