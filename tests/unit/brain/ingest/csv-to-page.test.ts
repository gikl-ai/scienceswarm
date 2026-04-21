import { describe, it, expect } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ingestCsvContent, ingestCsvFile } from "@/brain/ingest/csv-to-page";

async function withTempCsv(
  content: string,
  fn: (path: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "scienceswarm-csv-ingest-"));
  try {
    const path = join(dir, "input.csv");
    await writeFile(path, content, "utf-8");
    await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("ingestCsvContent", () => {
  it("parses a simple header + body", () => {
    const result = ingestCsvContent(
      [
        "seed,color,count",
        "round,yellow,315",
        "round,green,101",
        "wrinkled,yellow,108",
        "wrinkled,green,32",
      ].join("\n"),
    );
    expect(result.columns).toEqual(["seed", "color", "count"]);
    expect(result.rowCount).toBe(4);
    expect(result.columnDtypes).toEqual(["string", "string", "integer"]);
    expect(result.truncated).toBe(false);
    expect(result.markdown).toContain("| seed | color | count |");
    expect(result.markdown).toContain("| round | yellow | 315 |");
    expect(result.markdown).toContain("**Rows parsed:** 4");
    expect(result.markdown).toContain("`count` (integer)");
  });

  it("infers number dtype for decimal columns", () => {
    const result = ingestCsvContent(
      "temp,pressure\n23.5,1.013\n-0.5,0.998\n",
    );
    expect(result.columnDtypes).toEqual(["number", "number"]);
  });

  it("infers boolean dtype for true/false columns", () => {
    const result = ingestCsvContent("flag\ntrue\nfalse\nTrue\nFALSE\n");
    expect(result.columnDtypes).toEqual(["boolean"]);
  });

  it("treats a numeric-looking header row as strings (header metadata only)", () => {
    const result = ingestCsvContent("id,value\n1,foo\n2,bar\n");
    expect(result.columns).toEqual(["id", "value"]);
    expect(result.columnDtypes).toEqual(["integer", "string"]);
  });

  it("handles quoted cells that contain the delimiter", () => {
    const result = ingestCsvContent('a,b\n"hello, world",2\n');
    expect(result.rowCount).toBe(1);
    expect(result.markdown).toContain("hello, world");
  });

  it("normalises Windows CRLF line endings", () => {
    const result = ingestCsvContent("a,b\r\n1,2\r\n3,4\r\n");
    expect(result.columns).toEqual(["a", "b"]);
    expect(result.rowCount).toBe(2);
  });

  it("caps parsing at maxRows and sets truncated when the source is larger", () => {
    const lines = ["x"];
    for (let i = 0; i < 30; i += 1) lines.push(String(i));
    const result = ingestCsvContent(lines.join("\n"), { maxRows: 10 });
    expect(result.rowCount).toBe(10);
    expect(result.truncated).toBe(true);
  });

  it("renders only previewRows data rows even when more are parsed", () => {
    const lines = ["x"];
    for (let i = 0; i < 30; i += 1) lines.push(String(i));
    const result = ingestCsvContent(lines.join("\n"), { previewRows: 5 });
    const previewLines = result.markdown
      .split("\n")
      .filter((line) => line.startsWith("| ") && !line.startsWith("| x |") && !line.startsWith("| ---"));
    // 5 preview rows after the header + divider.
    expect(previewLines.length).toBe(5);
    expect(result.rowCount).toBe(30);
  });

  it("skips blank trailing lines without counting them", () => {
    const result = ingestCsvContent("a\n1\n\n\n2\n");
    expect(result.rowCount).toBe(2);
  });

  it("handles a completely empty input", () => {
    const result = ingestCsvContent("");
    expect(result.columns).toEqual([]);
    expect(result.rowCount).toBe(0);
    expect(result.markdown).toContain("empty CSV");
  });

  it("supports a tab delimiter", () => {
    const result = ingestCsvContent("a\tb\n1\t2\n3\t4\n", { delimiter: "\t" });
    expect(result.columns).toEqual(["a", "b"]);
    expect(result.rowCount).toBe(2);
  });

  it("matches content parsing for file-backed CSV input", async () => {
    const content = "seed,color,count\r\nround,yellow,315\r\nround,green,101\r\n";
    await withTempCsv(content, async (path) => {
      const fromContent = ingestCsvContent(content);
      const fromFile = await ingestCsvFile(path);
      expect(fromFile).toEqual(fromContent);
    });
  });

  it("caps file-backed CSV parsing at maxRows and detects truncation", async () => {
    const lines = ["x"];
    for (let i = 0; i < 30; i += 1) lines.push(String(i));

    await withTempCsv(lines.join("\n"), async (path) => {
      const result = await ingestCsvFile(path, { maxRows: 10 });
      expect(result.rowCount).toBe(10);
      expect(result.truncated).toBe(true);
      expect(result.markdown).toContain("**Truncated:** yes");
    });
  });
});
