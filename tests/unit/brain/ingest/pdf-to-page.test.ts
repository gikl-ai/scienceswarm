import { describe, it, expect } from "vitest";
import { join } from "path";
import { derivePdfTitleForIngest, ingestPdfFromPath } from "@/brain/ingest/pdf-to-page";

const FIXTURES = join(process.cwd(), "tests/fixtures/audit-revise");

describe("ingestPdfFromPath — Hubble fixture", () => {
  it("returns a markdown body + counts and passes the text-layer check", async () => {
    const result = await ingestPdfFromPath({
      pdfPath: join(FIXTURES, "hubble-1929.pdf"),
      fileName: "hubble-1929.pdf",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pageCount).toBeGreaterThan(0);
    expect(result.wordCount).toBeGreaterThan(0);
    expect(result.markdown).toContain("# ");
    expect(result.markdown).toContain("filename: hubble-1929.pdf");
    expect(result.markdown.length).toBeGreaterThan(500);
  });
});

describe("ingestPdfFromPath — Mendel text-bearing fixture", () => {
  it("passes the text-layer check for the Bateson translation", async () => {
    const result = await ingestPdfFromPath({
      pdfPath: join(FIXTURES, "mendel-1866-textlayer.pdf"),
      fileName: "mendel-1866-textlayer.pdf",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pageCount).toBeGreaterThan(0);
    expect(result.wordCount).toBeGreaterThan(0);
    // A real paper runs 300-600 words/page; the Bateson translation
    // comfortably exceeds the 200 w/p floor.
    expect(result.wordCount / result.pageCount).toBeGreaterThanOrEqual(200);
  });
});

describe("ingestPdfFromPath — missing file", () => {
  it("returns a not_found error (no throw)", async () => {
    const result = await ingestPdfFromPath({
      pdfPath: "/tmp/definitely-not-a-real-pdf.pdf",
      fileName: "definitely-not-a-real-pdf.pdf",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("not_found");
    expect(result.message).toContain("definitely-not-a-real-pdf.pdf");
  });
});

describe("derivePdfTitleForIngest", () => {
  it("skips page numbers before the real title", () => {
    expect(
      derivePdfTitleForIngest(
        "1\n\nBrain inspired graph multi-agent system for biological discovery\nAuthors",
        "Hao 2026 - Brain inspired graph multi agent system.pdf",
      ),
    ).toBe("Brain inspired graph multi-agent system for biological discovery");
  });

  it("falls back to the filename when extracted lines are only page markers", () => {
    expect(
      derivePdfTitleForIngest(
        "1\n\n2\n\n3",
        "Hao 2026 - Brain inspired graph multi agent system.pdf",
      ),
    ).toBe("Hao 2026 - Brain inspired graph multi agent system");
  });

  it("does not pick title candidates deep in the document body", () => {
    expect(
      derivePdfTitleForIngest(
        `${Array.from({ length: 85 }, () => "1").join("\n")}\nA Late Body Heading`,
        "Hao 2026 - Brain inspired graph multi agent system.pdf",
      ),
    ).toBe("Hao 2026 - Brain inspired graph multi agent system");
  });
});
