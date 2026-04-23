import {
  approvalStateFromBody,
  assertPreviewAllowed,
  buildRuntimeTurnRequest,
  computeRuntimeApiPreview,
  dataIncludedFromBody,
  getRuntimeApiServices,
  optionalSafeProjectId,
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
  turnModeFromBody,
} from "../_shared";
import type { RuntimeSessionStatus } from "@/lib/runtime-hosts/sessions";

function enrichedSession(session: ReturnType<
  ReturnType<typeof getRuntimeApiServices>["sessionStore"]["getSession"]
>) {
  if (!session) return null;
  return {
    ...session,
    host: runtimeHostHistoryForSession(session.hostId),
  };
}

export async function GET(request: Request): Promise<Response> {
  try {
    const services = getRuntimeApiServices();
    const url = new URL(request.url);
    const projectId = url.searchParams.has("projectId")
      ? optionalSafeProjectId(url.searchParams.get("projectId"))
      : undefined;
    const hostId = url.searchParams.get("hostId") ?? undefined;
    const status = url.searchParams.get("status") as RuntimeSessionStatus | null;
    const sessions = services.sessionStore.listSessions({
      projectId,
      hostId,
      status: status ?? undefined,
    });

    return Response.json({
      sessions: sessions.map((session) => ({
        ...session,
        host: runtimeHostHistoryForSession(session.hostId),
      })),
    });
  } catch (error) {
    return runtimeErrorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  let sessionId: string | null = null;
  try {
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
    const prompt = requireStringField(body, "prompt");
    const projectId = requireSafeProjectId(body.projectId);
    const conversationId = optionalStringField(body, "conversationId") ?? null;
    const approvalState = approvalStateFromBody(body);
    const inputFileRefs = optionalStringArrayField(body, "inputFileRefs") ?? [];
    const preview = computeRuntimeApiPreview({
      services,
      hostId,
      projectPolicy: projectPolicyFromBody(body),
      mode,
      dataIncluded: dataIncludedFromBody(body),
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
    services.eventStore.appendEvent({
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

    const adapter = runtimeAdapterForApi(hostId, services);
    if (!adapter) {
      throw runtimeInvalidRequest("No runtime adapter is registered for host.", {
        hostId,
      });
    }

    const turnRequest = buildRuntimeTurnRequest({
      hostId,
      projectId,
      conversationId: conversationId ?? session.id,
      mode,
      prompt,
      promptHash: optionalStringField(body, "promptHash"),
      inputFileRefs,
      approvalState,
      preview,
    });
    const result = mode === "task"
      ? await adapter.executeTask(turnRequest)
      : await adapter.sendTurn(turnRequest);

    if ("message" in result) {
      for (const event of result.events ?? []) {
        services.eventStore.appendEvent({
          ...event,
          sessionId: session.id,
        });
      }
      services.eventStore.appendEvent({
        id: `${session.id}:runtime-message`,
        sessionId: session.id,
        hostId,
        type: "message",
        payload: {
          text: result.message,
          nativeSessionId: result.sessionId,
        },
      });
      for (const artifact of result.artifacts ?? []) {
        services.eventStore.appendEvent({
          id: `${session.id}:artifact:${artifact.sourcePath}`,
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
    } else {
      services.sessionStore.updateSession(session.id, {
        status: result.status,
        conversationId: result.conversationId,
      });
      services.eventStore.appendEvent({
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
          nativeSessionId: result.id,
        },
      });
    }

    if ("message" in result) {
      services.eventStore.appendEvent({
        id: `${session.id}:runtime-completed`,
        sessionId: session.id,
        hostId,
        type: "done",
        payload: {
          status: "completed",
        },
      });
    }

    return Response.json({
      session: enrichedSession(services.sessionStore.getSession(session.id)),
      events: services.eventStore.listEvents(session.id),
    });
  } catch (error) {
    if (sessionId) {
      const services = getRuntimeApiServices();
      services.sessionStore.trySetSessionStatus({
        sessionId,
        status: "failed",
        errorCode: error instanceof Error ? error.name : "RUNTIME_TRANSPORT_ERROR",
      });
      services.eventStore.appendEvent({
        id: `${sessionId}:runtime-failed`,
        sessionId,
        hostId: services.sessionStore.getSession(sessionId)?.hostId ?? "unknown",
        type: "error",
        payload: {
          code: error instanceof Error ? error.name : "RUNTIME_TRANSPORT_ERROR",
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
    return runtimeErrorResponse(error);
  }
}
