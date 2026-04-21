import { describe, expect, it } from "vitest";

import { POST } from "@/app/api/md-diff/route";

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/md-diff", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/md-diff", () => {
  it("happy path: returns a DiffResult with hunks and unified output", async () => {
    const res = await POST(
      makeRequest({ old: "alpha\nbeta\ngamma", new: "alpha\nBETA\ngamma" }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("hunks");
    expect(body).toHaveProperty("unified");
    expect(body).toHaveProperty("addedLines");
    expect(body).toHaveProperty("removedLines");
    expect(body.addedLines).toBe(1);
    expect(body.removedLines).toBe(1);
    expect(Array.isArray(body.hunks)).toBe(true);
    expect(typeof body.unified).toBe("string");
    expect(body.unified).toContain("@@");
    expect(body.unified).toContain("-beta");
    expect(body.unified).toContain("+BETA");
  });

  it("missing 'old' field returns 400", async () => {
    const res = await POST(makeRequest({ new: "some text" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/old/);
  });

  it("missing 'new' field returns 400", async () => {
    const res = await POST(makeRequest({ old: "some text" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/new/);
  });

  it("non-string field returns 400", async () => {
    const res = await POST(makeRequest({ old: "ok", new: 42 }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/new/);
  });

  it("non-string 'old' field returns 400", async () => {
    const res = await POST(makeRequest({ old: ["not", "a", "string"], new: "ok" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/old/);
  });

  it("both empty strings returns 200 with zero added/removed lines", async () => {
    const res = await POST(makeRequest({ old: "", new: "" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.addedLines).toBe(0);
    expect(body.removedLines).toBe(0);
    expect(body.unified).toBe("");
    // "" is normalised to [], so there are no hunks at all.
    expect(Array.isArray(body.hunks)).toBe(true);
    expect(body.hunks.length).toBe(0);
  });

  it("empty 'old' with non-empty 'new' reports pure additions", async () => {
    const res = await POST(makeRequest({ old: "", new: "alpha\nbeta" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.addedLines).toBe(2);
    expect(body.removedLines).toBe(0);
    expect(body.hunks.length).toBe(1);
    expect(body.hunks[0].type).toBe("add");
  });

  it("invalid JSON body returns 400", async () => {
    const res = await POST(makeRequest("not-json-at-all"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/JSON/i);
  });

  it("oversized 'old' field returns 413 without running the diff", async () => {
    const huge = "x".repeat(500_001);
    const res = await POST(makeRequest({ old: huge, new: "ok" }));
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error).toMatch(/too large/i);
  });

  it("oversized 'new' field returns 413 without running the diff", async () => {
    const huge = "y".repeat(500_001);
    const res = await POST(makeRequest({ old: "ok", new: huge }));
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error).toMatch(/too large/i);
  });

  it("rejects inputs with too many lines even when character counts are small", async () => {
    const tooManyLines = Array.from({ length: 10_001 }, () => "x").join("\n");
    const res = await POST(makeRequest({ old: tooManyLines, new: "ok" }));
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error).toMatch(/too large/i);
  });

  it("rejects inputs whose LCS matrix would be too large", async () => {
    const oldText = Array.from({ length: 2500 }, (_, i) => `old-${i}`).join("\n");
    const newText = Array.from({ length: 2500 }, (_, i) => `new-${i}`).join("\n");
    const res = await POST(makeRequest({ old: oldText, new: newText }));
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error).toMatch(/too large/i);
  });
});
