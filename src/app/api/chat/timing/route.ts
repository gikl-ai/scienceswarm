import {
  CHAT_TIMING_ARTIFACT_LIMIT,
  getRecentChatTimingArtifacts,
  isChatTimingTelemetryEnabled,
} from "@/lib/chat-timing-telemetry";

export function GET(): Response {
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
