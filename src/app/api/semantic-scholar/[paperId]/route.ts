import { fetchSemanticScholarPaper } from "@/lib/semantic-scholar-client";

/**
 * GET /api/semantic-scholar/[paperId]
 *
 * Proxies the Semantic Scholar Graph API through the local Node runtime
 * so clients don't need to worry about CORS or the upstream User-Agent
 * requirement. Distinguishes invalid (400), not-found (404),
 * rate-limited (429), and upstream failures (502).
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ paperId: string }> },
): Promise<Response> {
  const { paperId: encoded } = await params;

  let paperId: string;
  try {
    paperId = decodeURIComponent(encoded);
  } catch {
    return Response.json({ error: "Invalid paper identifier" }, { status: 400 });
  }

  try {
    const paper = await fetchSemanticScholarPaper(paperId);
    return Response.json(paper);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";

    if (message === "Invalid paper identifier") {
      return Response.json({ error: message }, { status: 400 });
    }
    if (message.startsWith("Semantic Scholar paper ") && message.endsWith(" not found")) {
      return Response.json({ error: message }, { status: 404 });
    }
    if (message === "Semantic Scholar rate limit hit") {
      return Response.json({ error: message }, { status: 429 });
    }
    return Response.json({ error: message }, { status: 502 });
  }
}
