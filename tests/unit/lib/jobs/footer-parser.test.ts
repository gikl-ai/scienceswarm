import { describe, it, expect } from "vitest";
import { parseJobFooter } from "@/lib/jobs/footer-parser";

describe("parseJobFooter", () => {
  it("extracts slugs and files from a single fenced block", () => {
    const content = [
      "Done.",
      "",
      "```json",
      '{"slugs": ["hubble-1929-revision"], "files": ["sha256:abc"]}',
      "```",
      "",
    ].join("\n");
    const footer = parseJobFooter(content);
    expect(footer.slugs).toEqual(["hubble-1929-revision"]);
    expect(footer.files).toEqual(["sha256:abc"]);
    expect(footer.warnings).toEqual([]);
  });

  it("uses the last fenced block when multiple are present", () => {
    const content = [
      "Intermediate dump:",
      "```json",
      '{"slugs": ["debug-slug"]}',
      "```",
      "Final answer:",
      "```json",
      '{"slugs": ["real-slug"], "files": ["sha256:def"]}',
      "```",
    ].join("\n");
    const footer = parseJobFooter(content);
    expect(footer.slugs).toEqual(["real-slug"]);
    expect(footer.files).toEqual(["sha256:def"]);
    expect(footer.warnings.some((w) => w.includes("2 fenced blocks"))).toBe(
      true,
    );
  });

  it("returns empty lists + a warning when no fenced block is present", () => {
    const footer = parseJobFooter("Here is the result, but no footer.");
    expect(footer.slugs).toEqual([]);
    expect(footer.files).toEqual([]);
    expect(footer.warnings[0]).toContain("no fenced JSON footer");
  });

  it("returns empty lists + a warning when the JSON is malformed", () => {
    const footer = parseJobFooter(
      "```json\n{this is not valid json}\n```",
    );
    expect(footer.slugs).toEqual([]);
    expect(footer.warnings[0]).toContain("failed to parse JSON footer");
  });

  it("handles a footer with only slugs or only files", () => {
    const slugsOnly = parseJobFooter(
      '```json\n{"slugs": ["a", "b"]}\n```',
    );
    expect(slugsOnly.slugs).toEqual(["a", "b"]);
    expect(slugsOnly.files).toEqual([]);

    const filesOnly = parseJobFooter('```json\n{"files": ["sha256:c"]}\n```');
    expect(filesOnly.slugs).toEqual([]);
    expect(filesOnly.files).toEqual(["sha256:c"]);
  });

  it("returns empty lists + a warning when content is missing", () => {
    const footer = parseJobFooter(null);
    expect(footer.slugs).toEqual([]);
    expect(footer.warnings[0]).toContain("missing content");
  });

  it("filters out non-string entries in slugs/files", () => {
    const footer = parseJobFooter(
      '```json\n{"slugs": ["real", 42, null], "files": [123, "sha256:x"]}\n```',
    );
    expect(footer.slugs).toEqual(["real"]);
    expect(footer.files).toEqual(["sha256:x"]);
  });

  it("reports a warning when slugs and files are both empty", () => {
    const footer = parseJobFooter('```json\n{}\n```');
    expect(footer.slugs).toEqual([]);
    expect(footer.files).toEqual([]);
    expect(footer.warnings.some((w) => w.includes("no slugs or files"))).toBe(
      true,
    );
  });
});
