// GET /api/doi?id=<doi>
//
// Thin proxy over CrossRef's Works API. We take the DOI via query string
// rather than as a path segment because App Router path params don't play
// well with the slash baked into every DOI ("10.1145/362384.362685") —
// catch-all routes force awkward encoding on the client and still break
// on some edge cases. Keeping it a query param sidesteps the whole issue.
//
// Contract:
//   400 — missing `id` or invalid DOI format
//   404 — CrossRef says the DOI doesn't exist
//   502 — CrossRef returned a non-OK status or the request failed entirely
//   200 — DoiMetadata JSON payload

import {
  DoiNotFoundError,
  InvalidDoiError,
  fetchDoiMetadata,
} from "@/lib/doi-client";

export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const doi = searchParams.get("id");

  if (!doi) {
    return Response.json(
      { error: "Missing required query parameter: id", status: 400 },
      { status: 400 },
    );
  }

  try {
    const metadata = await fetchDoiMetadata(doi);
    return Response.json(metadata);
  } catch (err) {
    // Dispatch on typed error classes rather than string-matching the
    // message; the client owns the contract via exported error types.
    if (err instanceof InvalidDoiError) {
      return Response.json({ error: err.message, status: 400 }, { status: 400 });
    }
    if (err instanceof DoiNotFoundError) {
      return Response.json({ error: err.message, status: 404 }, { status: 404 });
    }

    const message = err instanceof Error ? err.message : String(err);
    return Response.json(
      { error: `Upstream CrossRef failure: ${message}`, status: 502 },
      { status: 502 },
    );
  }
}
