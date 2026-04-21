/**
 * Legacy /api/chat endpoint — redirects to unified endpoint.
 * No direct OpenAI calls. Everything goes through OpenClaw → OpenHands.
 */

export async function POST(request: Request) {
  // Redirect to the unified endpoint
  const body = await request.json();
  const message = body.messages?.[body.messages.length - 1]?.content || "";

  const res = await fetch(new URL("/api/chat/unified", request.url), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, files: body.files, projectId: body.projectId }),
  });

  return res;
}
