import {
  getRuntimeApiServices,
  runtimeAdapterForApi,
  runtimeErrorResponse,
} from "../../../_shared";

export async function POST(
  _request: Request,
  context: { params: Promise<{ sessionId: string }> },
): Promise<Response> {
  try {
    const { sessionId } = await context.params;
    const services = getRuntimeApiServices();
    const session = services.sessionStore.requireSession(sessionId);
    const adapter = runtimeAdapterForApi(session.hostId, services);
    const profile = adapter?.profile();
    const result = adapter
      ? await adapter.cancel(sessionId)
      : {
          sessionId,
          cancelled: false,
          detail: "No runtime adapter is registered for this historical session.",
        };
    const cancelSemantics =
      profile?.lifecycle.cancelSemantics
      ?? (session.readOnly ? "none" : "kill-wrapper-process");

    if (result.cancelled) {
      services.sessionStore.trySetSessionStatus({
        sessionId,
        status: "cancelled",
      });
      services.eventStore.appendEvent({
        id: `${sessionId}:runtime-cancelled`,
        sessionId,
        hostId: session.hostId,
        type: "status",
        payload: {
          status: "cancelled",
          cancelSemantics,
        },
      });
    }

    return Response.json({
      sessionId,
      hostId: session.hostId,
      cancelSemantics,
      result,
      session: services.sessionStore.getSession(sessionId),
    });
  } catch (error) {
    return runtimeErrorResponse(error);
  }
}
