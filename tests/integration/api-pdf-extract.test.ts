import path from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ROOT = path.join(tmpdir(), "scienceswarm-api-pdf-extract");
const PROJECT_ID = "project-alpha";
const PROJECT_DIR = path.join(ROOT, "projects", PROJECT_ID);
const PAPERS_DIR = path.join(PROJECT_DIR, "papers");
const PDF_REL = "papers/sample.pdf";
const PDF_ABS = path.join(PROJECT_DIR, PDF_REL);
const CORRUPT_REL = "papers/corrupt.pdf";
const CORRUPT_ABS = path.join(PROJECT_DIR, CORRUPT_REL);

const ORIGINAL_SCIENCESWARM_DIR = process.env.SCIENCESWARM_DIR;

function minimalPdfBuffer(text = "Hello World"): Buffer {
  const pdf = [
    "%PDF-1.0",
    "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj",
    "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj",
    "3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj",
    `4 0 obj<</Length ${32 + text.length}>>stream`,
    `BT /F1 12 Tf 100 700 Td (${text}) Tj ET`,
    "endstream endobj",
    "5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj",
    "xref",
    "0 6",
    "0000000000 65535 f ",
    "0000000009 00000 n ",
    "0000000058 00000 n ",
    "0000000115 00000 n ",
    "0000000266 00000 n ",
    "0000000360 00000 n ",
    "trailer<</Size 6/Root 1 0 R>>",
    "startxref",
    "430",
    "%%EOF",
  ].join("\n");
  return Buffer.from(pdf);
}

beforeEach(() => {
  vi.resetModules();
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(PAPERS_DIR, { recursive: true });
  writeFileSync(PDF_ABS, minimalPdfBuffer("Abstract Body"));
  writeFileSync(CORRUPT_ABS, "%PDF-1.4 broken");
  process.env.SCIENCESWARM_DIR = ROOT;
});

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  vi.restoreAllMocks();
  if (ORIGINAL_SCIENCESWARM_DIR !== undefined) {
    process.env.SCIENCESWARM_DIR = ORIGINAL_SCIENCESWARM_DIR;
  } else {
    delete process.env.SCIENCESWARM_DIR;
  }
});

async function importRoute() {
  return await import("@/app/api/pdf-extract/route");
}

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/api/pdf-extract", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/pdf-extract", () => {
  it("returns the extracted PDF summary for a valid request", async () => {
    const { POST } = await importRoute();
    const res = await POST(jsonRequest({ projectId: PROJECT_ID, path: PDF_REL }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.text).toContain("Abstract Body");
    expect(body.pageCount).toBe(1);
    expect(body.wordCount).toBeGreaterThan(0);
    expect(body.firstSentence).toBe("Abstract Body");
    expect(body.info).toMatchObject({ PDFFormatVersion: "1.0" });
  });

  it("rejects an invalid slug with 400", async () => {
    const { POST } = await importRoute();
    const res = await POST(jsonRequest({ projectId: "Bad Slug!", path: PDF_REL }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/slug/i);
  });

  it("rejects path traversal with 400", async () => {
    const { POST } = await importRoute();
    const res = await POST(
      jsonRequest({ projectId: PROJECT_ID, path: "../../etc/passwd" }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/invalid file path/i);
  });

  it("rejects the project root path itself with 400", async () => {
    const { POST } = await importRoute();
    const res = await POST(jsonRequest({ projectId: PROJECT_ID, path: "." }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/invalid file path/i);
  });

  it("returns 404 when the file does not exist inside the project", async () => {
    const { POST } = await importRoute();
    const res = await POST(
      jsonRequest({ projectId: PROJECT_ID, path: "papers/missing.pdf" }),
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("PDF file not found");
    expect(body.error).not.toContain(PROJECT_DIR);
  });

  it("returns 400 for a malformed JSON body", async () => {
    const { POST } = await importRoute();
    const req = new Request("http://localhost/api/pdf-extract", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json{",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/invalid json/i);
  });

  it("returns 400 for a corrupt PDF without leaking filesystem details", async () => {
    const { POST } = await importRoute();
    const res = await POST(jsonRequest({ projectId: PROJECT_ID, path: CORRUPT_REL }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid PDF");
    expect(body.error).not.toContain(PROJECT_DIR);
  });

  it("returns a generic 500 for unexpected extractor failures", async () => {
    const { POST } = await importRoute();
    const extractModule = await import("@/lib/pdf-text-extractor");
    const spy = vi.spyOn(extractModule, "extractPdfText").mockRejectedValueOnce(
      new Error(`boom ${PROJECT_DIR}`),
    );

    const res = await POST(jsonRequest({ projectId: PROJECT_ID, path: PDF_REL }));

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("PDF extract error");
    expect(body.error).not.toContain(PROJECT_DIR);
    spy.mockRestore();
  });
});
