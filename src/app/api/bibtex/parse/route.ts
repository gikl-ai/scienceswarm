import { parseBibtex } from "@/lib/bibtex-parser";

export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  if (
    !payload ||
    typeof payload !== "object" ||
    !("text" in payload) ||
    typeof (payload as { text: unknown }).text !== "string"
  ) {
    return Response.json({ error: "text field required" }, { status: 400 });
  }

  const { text } = payload as { text: string };

  // Guard against accidental or deliberate resource exhaustion: the
  // parser runs synchronously on the Node.js event loop, so cap the
  // input at 5 MB before handing it over.
  const MAX_BYTES = 5 * 1024 * 1024;
  if (Buffer.byteLength(text, "utf8") > MAX_BYTES) {
    return Response.json(
      { error: "text exceeds maximum allowed size" },
      { status: 413 },
    );
  }

  try {
    const { entries, errors } = parseBibtex(text);
    return Response.json({ entries, errors });
  } catch (err) {
    const message = err instanceof Error ? err.message : "BibTeX parse error";
    console.error("BibTeX parse error:", message);
    return Response.json({ error: message }, { status: 500 });
  }
}
