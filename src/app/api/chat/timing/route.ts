import {
  CHAT_TIMING_ARTIFACT_LIMIT,
  getRecentChatTimingArtifacts,
  isChatTimingTelemetryEnabled,
} from "@/lib/chat-timing-telemetry";
import { isLocalRequest } from "@/lib/local-guard";

export async function GET(request: Request): Promise<Response> {
  if (!(await isLocalRequest(request))) {
    return new Response(null, { status: 404 });
  }

  if (!isChatTimingTelemetryEnabled()) {
    return new Response(null, { status: 404 });
  }

  return Response.json(
    {
      maxEntries: CHAT_TIMING_ARTIFACT_LIMIT,
      timings: getRecentChatTimingArtifacts(),
    },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}
