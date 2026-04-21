/**
 * Unit tests for `src/brain/coldstart/scanner.ts`.
 *
 * Verifies the directory walking, hashing, title extraction, and keyword
 * extraction primitives in isolation from the rest of the coldstart pipeline.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync, chmodSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  walkDirectory,
  hashFileHead,
  extractFileTitle,
  normalizeTitle,
  extractKeywords,
  SCIENCE_EXTENSIONS,
  MAX_FILE_SIZE,
  STOP_WORDS,
} from "@/brain/coldstart/scanner";

const FIXTURES = join(__dirname, "..", "..", "fixtures", "coldstart");

let tempDir: string;

beforeEach(() => {
  tempDir = join(
    tmpdir(),
    `scanner-unit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(tempDir)) {
    try {
      // Restore perms in case a test made something unreadable
      chmodSync(tempDir, 0o755);
    } catch {
      // ignore
    }
    rmSync(tempDir, { recursive: true, force: true });
  }
});

function touch(rel: string, content = ""): string {
  const abs = join(tempDir, rel);
  const dir = abs.replace(/\/[^/]+$/, "");
  mkdirSync(dir, { recursive: true });
  writeFileSync(abs, content);
  return abs;
}

describe("walkDirectory", () => {
  it("walks an empty directory without invoking the callback", () => {
    const seen: string[] = [];
    walkDirectory(tempDir, (p) => seen.push(p));
    expect(seen).toEqual([]);
  });

  it("visits every file recursively", () => {
    touch("a.md", "# A");
    touch("nested/b.md", "# B");
    touch("nested/deep/c.md", "# C");

    const seen: string[] = [];
    walkDirectory(tempDir, (p) => seen.push(p));

    expect(seen.length).toBe(3);
    expect(seen.some((p) => p.endsWith("a.md"))).toBe(true);
    expect(seen.some((p) => p.endsWith("b.md"))).toBe(true);
    expect(seen.some((p) => p.endsWith("c.md"))).toBe(true);
  });

  it("skips hidden directories, node_modules, and __pycache__", () => {
    touch(".hidden/secret.md", "# Secret");
    touch("node_modules/pkg/index.md", "# Pkg");
    touch("__pycache__/foo.pyc", "binary");
    touch("visible/note.md", "# Note");

    const seen: string[] = [];
    walkDirectory(tempDir, (p) => seen.push(p));

    expect(seen.length).toBe(1);
    expect(seen[0]).toContain("visible/note.md");
  });

  it("returns silently for nonexistent directories", () => {
    expect(() => walkDirectory("/no/such/dir/xyz123", () => {})).not.toThrow();
  });

  it("walks the shared coldstart fixtures dir and finds known files", () => {
    const seen: string[] = [];
    walkDirectory(FIXTURES, (p) => seen.push(p));
    expect(seen.some((p) => p.endsWith("notes.md"))).toBe(true);
    expect(seen.some((p) => p.endsWith("attention.pdf"))).toBe(true);
    expect(seen.some((p) => p.endsWith("experiment.ipynb"))).toBe(true);
    expect(seen.some((p) => p.endsWith("data.json"))).toBe(true);
  });

  it("tolerates inaccessible files mid-walk", () => {
    touch("ok.md", "# ok");
    const bad = touch("bad.md", "# bad");
    try {
      chmodSync(bad, 0o000);
    } catch {
      // chmod may fail on some filesystems; the test still verifies the path
    }
    expect(() => walkDirectory(tempDir, () => {})).not.toThrow();
  });
});

describe("hashFileHead", () => {
  it("returns the same hash for identical content", () => {
    const a = touch("a.txt", "hello world");
    const b = touch("b.txt", "hello world");
    expect(hashFileHead(a)).toBe(hashFileHead(b));
  });

  it("returns different hashes for different content", () => {
    const a = touch("a.txt", "hello");
    const b = touch("b.txt", "world");
    expect(hashFileHead(a)).not.toBe(hashFileHead(b));
  });

  it("returns empty string for missing files", () => {
    expect(hashFileHead(join(tempDir, "missing.txt"))).toBe("");
  });

  it("produces a fixed-length hex prefix", () => {
    const p = touch("x.txt", "x");
    const h = hashFileHead(p);
    expect(h).toMatch(/^[a-f0-9]{16}$/);
  });
});

describe("extractFileTitle", () => {
  it("uses filename for PDFs", () => {
    expect(extractFileTitle("/some/dir/Attention_Is_All_You_Need.pdf", ".pdf"))
      .toBe("Attention Is All You Need");
  });

  it("uses the first H1 from a markdown file", () => {
    const p = touch("title.md", "Some preamble\n\n# The Title\n\nbody");
    expect(extractFileTitle(p, ".md")).toBe("The Title");
  });

  it("returns null for a markdown file without an H1", () => {
    const p = touch("notitle.md", "just a body, no heading");
    expect(extractFileTitle(p, ".md")).toBeNull();
  });

  it("falls back to filename for unknown extensions", () => {
    expect(extractFileTitle("/dir/some-data-file.xyz", ".xyz"))
      .toBe("some data file");
  });
});

describe("normalizeTitle", () => {
  it("lowercases, strips punctuation, and collapses whitespace", () => {
    expect(normalizeTitle("  Attention Is All You Need! "))
      .toBe("attention is all you need");
  });

  it("treats different separators identically", () => {
    expect(normalizeTitle("foo_bar-baz")).toBe(normalizeTitle("foo bar baz"));
  });
});

describe("extractKeywords", () => {
  it("pulls keywords from path segments", () => {
    const p = touch("transformer-attention/notes.md", "# Notes");
    const kws = extractKeywords(p, ".md");
    expect(kws).toContain("transformer");
    expect(kws).toContain("attention");
  });

  it("pulls top frequency words from text content", () => {
    const text = "transformer transformer transformer architecture architecture model";
    const p = touch("doc.md", text);
    const kws = extractKeywords(p, ".md");
    expect(kws).toContain("transformer");
    expect(kws).toContain("architecture");
  });

  it("does not crash on binary-like extensions", () => {
    const p = touch("data.parquet", "binary");
    expect(() => extractKeywords(p, ".parquet")).not.toThrow();
  });

  it("dedupes keywords", () => {
    const p = touch("foo/foo/foo.md", "foo foo foo bar bar bar");
    const kws = extractKeywords(p, ".md");
    expect(kws.length).toBe(new Set(kws).size);
  });
});

describe("SCIENCE_EXTENSIONS", () => {
  it("maps PDFs to paper, ipynb to experiment, csv to data", () => {
    expect(SCIENCE_EXTENSIONS[".pdf"]).toBe("paper");
    expect(SCIENCE_EXTENSIONS[".ipynb"]).toBe("experiment");
    expect(SCIENCE_EXTENSIONS[".csv"]).toBe("data");
  });

  it("does not include unknown extensions like .xyz", () => {
    expect(SCIENCE_EXTENSIONS[".xyz"]).toBeUndefined();
  });
});

describe("constants", () => {
  it("MAX_FILE_SIZE is 100MB", () => {
    expect(MAX_FILE_SIZE).toBe(100 * 1024 * 1024);
  });

  it("STOP_WORDS includes common code/english words", () => {
    expect(STOP_WORDS.has("function")).toBe(true);
    expect(STOP_WORDS.has("return")).toBe(true);
    expect(STOP_WORDS.has("about")).toBe(true);
  });
});
