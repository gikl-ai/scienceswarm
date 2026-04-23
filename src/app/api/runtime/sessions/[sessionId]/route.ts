import {
  getRuntimeApiServices,
  runtimeErrorResponse,
  runtimeHostHistoryForSession,
} from "../../_shared";

export async function GET(
  _request: Request,
  context: { params: Promise<{ sessionId: string }> },
): Promise<Response> {
  try {
    const { sessionId } = await context.params;
    const services = getRuntimeApiServices();
    const session = services.sessionStore.requireSession(sessionId);
    return Response.json({
      session: {
        ...session,
        host: runtimeHostHistoryForSession(session.hostId),
      },
    });
  } catch (error) {
    return runtimeErrorResponse(error);
  }
}
