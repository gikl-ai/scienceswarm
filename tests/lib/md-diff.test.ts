import { describe, expect, it } from "vitest";

import { diffMarkdown, type DiffHunk } from "@/lib/md-diff";

function typesOf(hunks: DiffHunk[]): string[] {
  return hunks.map((h) => h.type);
}

describe("diffMarkdown", () => {
  it("identical inputs produce no changes and a single equal hunk", () => {
    const text = "alpha\nbeta\ngamma";
    const result = diffMarkdown(text, text);
    expect(result.addedLines).toBe(0);
    expect(result.removedLines).toBe(0);
    expect(typesOf(result.hunks)).toEqual(["equal"]);
    expect(result.hunks[0]!.lines).toEqual(["alpha", "beta", "gamma"]);
    // No change => empty unified output.
    expect(result.unified).toBe("");
  });

  it("pure addition (empty old) marks everything as add", () => {
    const result = diffMarkdown("", "one\ntwo\nthree");
    // Empty `old` is normalised to [] (not [""]), so the result is three
    // pure additions with no phantom removal.
    expect(result.addedLines).toBe(3);
    expect(result.removedLines).toBe(0);
    expect(typesOf(result.hunks)).toEqual(["add"]);
    expect(result.hunks[0]!.lines).toEqual(["one", "two", "three"]);
  });

  it("pure removal (empty new) marks everything as remove", () => {
    const result = diffMarkdown("one\ntwo\nthree", "");
    expect(result.addedLines).toBe(0);
    expect(result.removedLines).toBe(3);
    expect(typesOf(result.hunks)).toEqual(["remove"]);
    expect(result.hunks[0]!.lines).toEqual(["one", "two", "three"]);
  });

  it("pure addition when old is a prefix of new", () => {
    const result = diffMarkdown("alpha", "alpha\nbeta\ngamma");
    expect(result.addedLines).toBe(2);
    expect(result.removedLines).toBe(0);
    expect(typesOf(result.hunks)).toEqual(["equal", "add"]);
    expect(result.hunks[0]!.lines).toEqual(["alpha"]);
    expect(result.hunks[1]!.lines).toEqual(["beta", "gamma"]);
  });

  it("pure removal when new is a prefix of old", () => {
    const result = diffMarkdown("alpha\nbeta\ngamma", "alpha");
    expect(result.addedLines).toBe(0);
    expect(result.removedLines).toBe(2);
    expect(typesOf(result.hunks)).toEqual(["equal", "remove"]);
    expect(result.hunks[1]!.lines).toEqual(["beta", "gamma"]);
  });

  it("single-line change in the middle of a larger doc", () => {
    const oldText = ["a", "b", "c", "d", "e", "f", "g"].join("\n");
    const newText = ["a", "b", "c", "D", "e", "f", "g"].join("\n");
    const result = diffMarkdown(oldText, newText);
    expect(result.addedLines).toBe(1);
    expect(result.removedLines).toBe(1);
    // Hunks: equal[a,b,c], remove[d], add[D], equal[e,f,g]
    expect(typesOf(result.hunks)).toEqual(["equal", "remove", "add", "equal"]);
    expect(result.hunks[1]!.lines).toEqual(["d"]);
    expect(result.hunks[2]!.lines).toEqual(["D"]);
    // Unified output should have exactly one @@ header.
    const headerCount = (result.unified.match(/^@@/gm) ?? []).length;
    expect(headerCount).toBe(1);
  });

  it("multiple disjoint changes produce multiple unified hunks", () => {
    // Lots of context between the two changes so they can't merge.
    const oldLines = [
      "h1",
      "h2",
      "h3",
      "old1",
      "h4",
      "h5",
      "h6",
      "h7",
      "h8",
      "h9",
      "h10",
      "old2",
      "h11",
      "h12",
      "h13",
    ];
    const newLines = [
      "h1",
      "h2",
      "h3",
      "new1",
      "h4",
      "h5",
      "h6",
      "h7",
      "h8",
      "h9",
      "h10",
      "new2",
      "h11",
      "h12",
      "h13",
    ];
    const result = diffMarkdown(oldLines.join("\n"), newLines.join("\n"));
    expect(result.addedLines).toBe(2);
    expect(result.removedLines).toBe(2);
    const headerCount = (result.unified.match(/^@@/gm) ?? []).length;
    expect(headerCount).toBe(2);
  });

  it("consecutive add-remove pairs produce separate hunks (removes then adds)", () => {
    const result = diffMarkdown("a\nb\nc", "X\nY\nZ");
    // Common prefix/suffix both empty; backtrack yields remove(a,b,c) then add(X,Y,Z).
    expect(result.addedLines).toBe(3);
    expect(result.removedLines).toBe(3);
    expect(typesOf(result.hunks)).toEqual(["remove", "add"]);
    expect(result.hunks[0]!.lines).toEqual(["a", "b", "c"]);
    expect(result.hunks[1]!.lines).toEqual(["X", "Y", "Z"]);
  });

  it("line counts are exact for mixed changes", () => {
    const oldText = "a\nb\nc\nd\ne";
    const newText = "a\nX\nc\nY\nZ\ne";
    const result = diffMarkdown(oldText, newText);
    // Walk the structured hunks and count.
    let added = 0;
    let removed = 0;
    for (const h of result.hunks) {
      if (h.type === "add") added += h.lines.length;
      else if (h.type === "remove") removed += h.lines.length;
    }
    expect(added).toBe(result.addedLines);
    expect(removed).toBe(result.removedLines);
  });

  it("unified output lines use one of ' ', '+', '-' prefixes and round-trip via a simple parser", () => {
    const oldText = "a\nb\nc\nd\ne";
    const newText = "a\nb\nC\nd\ne";
    const result = diffMarkdown(oldText, newText);

    // Simple parser: split unified, skip @@ headers, rebuild old and new.
    const rebuiltOld: string[] = [];
    const rebuiltNew: string[] = [];
    for (const line of result.unified.split("\n")) {
      if (line.startsWith("@@")) continue;
      const prefix = line[0];
      const content = line.slice(1);
      if (prefix === " ") {
        rebuiltOld.push(content);
        rebuiltNew.push(content);
      } else if (prefix === "-") {
        rebuiltOld.push(content);
      } else if (prefix === "+") {
        rebuiltNew.push(content);
      } else {
        throw new Error(`unexpected unified prefix: ${JSON.stringify(line)}`);
      }
    }
    // With 3 context lines on each side and only 5 total lines, the hunk
    // covers the entire document — so rebuilt arrays match the originals
    // exactly.
    expect(rebuiltOld).toEqual(oldText.split("\n"));
    expect(rebuiltNew).toEqual(newText.split("\n"));
  });

  it("trailing newline difference is surfaced (old ends with \\n, new doesn't)", () => {
    const oldText = "line\n";
    const newText = "line";
    const result = diffMarkdown(oldText, newText);
    // oldText.split("\n") => ["line", ""], newText.split("\n") => ["line"]
    // So we expect a removal of the empty trailing line.
    expect(result.removedLines).toBe(1);
    expect(result.addedLines).toBe(0);
    expect(result.hunks.some((h) => h.type === "remove")).toBe(true);
  });

  it("very large input (5k lines) with one change does not time out", () => {
    const base: string[] = [];
    for (let i = 0; i < 5000; i += 1) base.push(`line ${i}`);
    const oldText = base.join("\n");
    const modified = base.slice();
    modified[2500] = "line 2500 modified";
    const newText = modified.join("\n");

    const start = Date.now();
    const result = diffMarkdown(oldText, newText);
    const elapsedMs = Date.now() - start;

    expect(elapsedMs).toBeLessThan(5000);
    expect(result.addedLines).toBe(1);
    expect(result.removedLines).toBe(1);
  });

  it("throws before allocating an oversized LCS table", () => {
    const oldText = Array.from({ length: 2500 }, (_, i) => `old-${i}`).join("\n");
    const newText = Array.from({ length: 2500 }, (_, i) => `new-${i}`).join("\n");

    expect(() => diffMarkdown(oldText, newText)).toThrow(/too large/i);
  });

  it("both empty strings produce no hunks and no changes", () => {
    const result = diffMarkdown("", "");
    expect(result.addedLines).toBe(0);
    expect(result.removedLines).toBe(0);
    // Both sides normalise to [], so there's nothing to emit at all.
    expect(result.hunks).toEqual([]);
    expect(result.unified).toBe("");
  });

  it("unified output groups adjacent changes with up to 3 context lines on each side", () => {
    const oldText = [
      "ctx1",
      "ctx2",
      "ctx3",
      "ctx4",
      "old",
      "ctx5",
      "ctx6",
      "ctx7",
      "ctx8",
    ].join("\n");
    const newText = [
      "ctx1",
      "ctx2",
      "ctx3",
      "ctx4",
      "new",
      "ctx5",
      "ctx6",
      "ctx7",
      "ctx8",
    ].join("\n");
    const result = diffMarkdown(oldText, newText);
    const lines = result.unified.split("\n");
    // Header + 3 context + remove + add + 3 context = 9 lines.
    expect(lines.length).toBe(9);
    expect(lines[0]).toMatch(/^@@ -.*\+.*@@$/);
    // Count context lines (prefix ' ').
    const contextCount = lines.filter((l) => l.startsWith(" ")).length;
    expect(contextCount).toBe(6);
  });
});
