import {
  getRuntimeApiServices,
  runtimeErrorResponse,
} from "../../../_shared";

export async function GET(
  _request: Request,
  context: { params: Promise<{ sessionId: string }> },
): Promise<Response> {
  try {
    const { sessionId } = await context.params;
    const services = getRuntimeApiServices();
    services.sessionStore.requireSession(sessionId);
    return Response.json({
      sessionId,
      events: services.eventStore.listEvents(sessionId),
    });
  } catch (error) {
    return runtimeErrorResponse(error);
  }
}
