import {
  assertRuntimeApiLocalRequest,
  getRuntimeApiServices,
  runtimeErrorResponse,
} from "../../../_shared";

export async function GET(
  request: Request,
  context: { params: Promise<{ sessionId: string }> },
): Promise<Response> {
  try {
    await assertRuntimeApiLocalRequest(request);
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
