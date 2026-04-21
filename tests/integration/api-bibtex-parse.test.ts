import { describe, expect, it } from "vitest";
import { POST } from "@/app/api/bibtex/parse/route";

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/api/bibtex/parse", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/bibtex/parse", () => {
  it("returns parsed entries on a happy-path POST", async () => {
    const text = `
      @article{knuth1984,
        author = {Knuth, Donald E.},
        title = {Literate Programming},
        journal = {The Computer Journal},
        year = {1984}
      }
    `;
    const res = await POST(jsonRequest({ text }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.errors).toEqual([]);
    expect(Array.isArray(body.entries)).toBe(true);
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].key).toBe("knuth1984");
    expect(body.entries[0].title).toBe("Literate Programming");
    expect(body.entries[0].authors).toEqual(["Knuth, Donald E."]);
  });

  it("returns 400 when the `text` field is missing", async () => {
    const res = await POST(jsonRequest({}));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("text field required");
  });

  it("returns 400 when `text` is a non-string value", async () => {
    const res = await POST(jsonRequest({ text: 42 }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("text field required");
  });

  it("returns 400 with a distinct error when the body is not valid JSON", async () => {
    const res = await POST(
      new Request("http://localhost/api/bibtex/parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not json",
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid JSON body");
  });

  it("returns 413 when `text` exceeds the maximum allowed size", async () => {
    // 5 MB + 1 byte of ASCII payload.
    const oversize = "a".repeat(5 * 1024 * 1024 + 1);
    const res = await POST(jsonRequest({ text: oversize }));
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error).toBe("text exceeds maximum allowed size");
  });

  it("returns 200 with empty arrays for empty-string input", async () => {
    const res = await POST(jsonRequest({ text: "" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ entries: [], errors: [] });
  });

  it("returns 200 with entries:[] and populated errors on malformed BibTeX", async () => {
    const text = `
      @article{broken,
        author = {Nobody},
        title = {Unterminated
    `;
    const res = await POST(jsonRequest({ text }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.entries).toEqual([]);
    expect(Array.isArray(body.errors)).toBe(true);
    expect(body.errors.length).toBeGreaterThan(0);
  });
});
