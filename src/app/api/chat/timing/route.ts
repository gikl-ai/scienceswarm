import {
  CHAT_TIMING_ARTIFACT_LIMIT,
  getRecentChatTimingArtifacts,
  isChatTimingTelemetryEnabled,
  summarizeChatTimingArtifact,
} from "@/lib/chat-timing-telemetry";
import { isLocalRequest } from "@/lib/local-guard";

export async function GET(request: Request): Promise<Response> {
  if (!(await isLocalRequest(request))) {
    return new Response(null, { status: 404 });
  }

  if (!isChatTimingTelemetryEnabled()) {
    return new Response(null, { status: 404 });
  }

  const timings = getRecentChatTimingArtifacts();

  return Response.json(
    {
      maxEntries: CHAT_TIMING_ARTIFACT_LIMIT,
      timings,
      summaries: timings.map((timing) => summarizeChatTimingArtifact(timing)),
    },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}
