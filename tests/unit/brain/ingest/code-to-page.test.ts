import { describe, it, expect } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ingestCodeContent,
  ingestCodeFile,
  resolveLanguageFromFileName,
} from "@/brain/ingest/code-to-page";

async function withTempCode(
  content: string,
  fn: (path: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "scienceswarm-code-ingest-"));
  try {
    const path = join(dir, "input.py");
    await writeFile(path, content, "utf-8");
    await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("resolveLanguageFromFileName", () => {
  it.each([
    ["chisq.py", "python"],
    ["analysis.R", "r"],
    ["hook.ts", "typescript"],
    ["component.tsx", "tsx"],
    ["plot.jl", "julia"],
    ["run.sh", "bash"],
    ["schema.sql", "sql"],
    ["main.rs", "rust"],
  ])("maps %s → %s", (name, lang) => {
    expect(resolveLanguageFromFileName(name)).toBe(lang);
  });

  it("falls back to text for unknown extensions", () => {
    expect(resolveLanguageFromFileName("README.md")).toBe("text");
    expect(resolveLanguageFromFileName("data.txt")).toBe("text");
    expect(resolveLanguageFromFileName("Makefile")).toBe("text");
  });

  it("falls back to text when the extension is empty", () => {
    expect(resolveLanguageFromFileName("no-extension")).toBe("text");
    expect(resolveLanguageFromFileName("trailing-dot.")).toBe("text");
  });
});

describe("ingestCodeContent", () => {
  it("wraps the body in a fenced block tagged with the inferred language", () => {
    const result = ingestCodeContent("print('hello')\nprint('world')\n", "greet.py");
    expect(result.language).toBe("python");
    expect(result.lineCount).toBe(3); // two LF → three lines including trailing
    expect(result.markdown).toBe(
      "```python\nprint('hello')\nprint('world')\n\n```",
    );
  });

  it("normalises CRLF to LF inside the fenced block", () => {
    const result = ingestCodeContent("a\r\nb\r\n", "a.py");
    expect(result.markdown.includes("\r")).toBe(false);
  });

  it("emits a text-fenced block for unknown extensions", () => {
    const result = ingestCodeContent("hello", "notes");
    expect(result.language).toBe("text");
    expect(result.markdown).toBe("```text\nhello\n```");
  });

  it("counts line breaks from CR, LF, and CRLF styles", () => {
    expect(ingestCodeContent("a\nb\nc", "x.py").lineCount).toBe(3);
    expect(ingestCodeContent("a\rb\rc", "x.py").lineCount).toBe(3);
    expect(ingestCodeContent("a\r\nb\r\nc", "x.py").lineCount).toBe(3);
  });

  it("matches content parsing for file-backed code input", async () => {
    const content = "print('hello')\r\nprint('world')\r\n";
    await withTempCode(content, async (path) => {
      const fromContent = ingestCodeContent(content, "input.py");
      const fromFile = await ingestCodeFile(path, "input.py");
      expect(fromFile).toEqual(fromContent);
    });
  });

  it("bounds large code page previews while preserving full line counts", async () => {
    const content = "first line\nsecond line\nthird line\n";
    await withTempCode(content, async (path) => {
      const result = await ingestCodeFile(path, "input.py", {
        maxMarkdownBytes: 12,
      });
      expect(result.lineCount).toBe(4);
      expect(result.markdown).toContain("Source preview truncated");
      expect(result.markdown).not.toContain("third line");
    });
  });
});
