// GET /api/arxiv/[...id]
// Thin proxy over the ArXiv Atom API. See src/lib/arxiv-client.ts for the
// parser + upstream contract. The route is intentionally tiny: it translates
// client-side errors into 400, "not found" into 404, and every other upstream
// failure into 502 so the frontend can distinguish "bad input" from
// "arxiv.org is flaky".

import {
  ArxivInvalidIdError,
  ArxivNotFoundError,
  fetchArxivMetadata,
} from "@/lib/arxiv-client";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string[] }> },
): Promise<Response> {
  const { id: segments } = await params;
  const id = segments.join("/");

  try {
    const metadata = await fetchArxivMetadata(id);
    return Response.json(metadata);
  } catch (err) {
    // Discriminate by error type, not by message text: the previous
    // string-matching approach would silently degrade to 502 if the client's
    // error wording ever drifted.
    if (err instanceof ArxivInvalidIdError) {
      return Response.json({ error: err.message }, { status: 400 });
    }
    if (err instanceof ArxivNotFoundError) {
      return Response.json({ error: err.message }, { status: 404 });
    }
    // Everything else — ArxivUpstreamError, network errors, parse failures —
    // collapses to a single upstream-failure status so the frontend doesn't
    // have to care why arxiv.org gave up.
    const message = err instanceof Error ? err.message : "Unknown error";
    return Response.json(
      { error: `Upstream failure: ${message}` },
      { status: 502 },
    );
  }
}
