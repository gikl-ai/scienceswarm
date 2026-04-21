import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  mergeEnvValues,
  parseEnvFile,
  serializeEnvDocument,
  writeEnvFileAtomic,
} from "@/lib/setup/env-writer";

describe("parseEnvFile", () => {
  it("parses a simple KEY=value entry", () => {
    const doc = parseEnvFile("FOO=bar");
    expect(doc.lines).toHaveLength(1);
    const line = doc.lines[0]!;
    expect(line.type).toBe("entry");
    if (line.type === "entry") {
      expect(line.key).toBe("FOO");
      expect(line.value).toBe("bar");
      expect(line.raw).toBe("FOO=bar");
    }
  });

  it("parses double-quoted values and strips outer quotes", () => {
    const doc = parseEnvFile('FOO="hello world"');
    const line = doc.lines[0]!;
    expect(line.type).toBe("entry");
    if (line.type === "entry") {
      expect(line.key).toBe("FOO");
      expect(line.value).toBe("hello world");
    }
  });

  it("parses single-quoted values and strips outer quotes", () => {
    const doc = parseEnvFile("FOO='hello world'");
    const line = doc.lines[0]!;
    expect(line.type).toBe("entry");
    if (line.type === "entry") {
      expect(line.value).toBe("hello world");
    }
  });

  it("honours minimal escapes inside double-quoted values", () => {
    const doc = parseEnvFile('FOO="she said \\"hi\\""');
    const line = doc.lines[0]!;
    if (line.type !== "entry") throw new Error("expected entry");
    expect(line.value).toBe('she said "hi"');
  });

  it("preserves comment lines verbatim", () => {
    const doc = parseEnvFile("# a comment\nFOO=bar");
    expect(doc.lines[0]!.type).toBe("comment");
    expect(doc.lines[0]!.raw).toBe("# a comment");
  });

  it("preserves blank lines", () => {
    const doc = parseEnvFile("FOO=bar\n\nBAZ=qux");
    expect(doc.lines.map((l) => l.type)).toEqual([
      "entry",
      "blank",
      "entry",
    ]);
  });

  it("accepts Windows line endings and records the newline style", () => {
    const doc = parseEnvFile("FOO=bar\r\nBAZ=qux\r\n");
    expect(doc.newline).toBe("\r\n");
    expect(doc.lines.map((l) => l.type)).toEqual(["entry", "entry"]);
  });

  it("preserves order across comment/entry/blank mixtures", () => {
    const input = [
      "# top comment",
      "FIRST=1",
      "",
      "# group header",
      "SECOND=two",
      "THIRD=3",
    ].join("\n");
    const doc = parseEnvFile(input);
    expect(doc.lines.map((l) => l.type)).toEqual([
      "comment",
      "entry",
      "blank",
      "comment",
      "entry",
      "entry",
    ]);
  });

  it("records unrecognised syntax as an invalid preserved line", () => {
    // `export FOO=bar` is not matched by our narrow regex, but we
    // must not silently drop it — round-trip must preserve bytes and
    // callers should be able to surface the line number.
    const doc = parseEnvFile("export FOO=bar");
    expect(doc.lines).toHaveLength(1);
    expect(doc.lines[0]!.type).toBe("invalid");
    expect(doc.lines[0]!.raw).toBe("export FOO=bar");
  });

  it("records unterminated quoted values as invalid lines", () => {
    const doc = parseEnvFile('FOO="unterminated');
    expect(doc.lines).toHaveLength(1);
    expect(doc.lines[0]!.type).toBe("invalid");
  });

  it("records a single dangling quote as an invalid line", () => {
    const doc = parseEnvFile('FOO="');
    expect(doc.lines).toHaveLength(1);
    expect(doc.lines[0]!.type).toBe("invalid");
  });

  it("returns an empty document for empty input", () => {
    const doc = parseEnvFile("");
    expect(doc.lines).toEqual([]);
  });
});

describe("serializeEnvDocument", () => {
  it("round-trips a realistic .env.example-style input", () => {
    const input = [
      "# Required",
      "OPENAI_API_KEY=sk-your-key-here",
      "",
      "# Optional — model selection",
      "LLM_MODEL=gpt-5.4",
      "OPENAI_WEB_SEARCH_MODEL=",
      "",
      "# Optional — OpenHands agent",
      "OPENHANDS_URL=http://localhost:3000",
    ].join("\n");
    const doc = parseEnvFile(input);
    expect(serializeEnvDocument(doc)).toBe(input);
  });

  it("round-trips CRLF input with CRLF preserved between lines", () => {
    const input = "FOO=bar\r\nBAZ=qux";
    const doc = parseEnvFile(input);
    expect(serializeEnvDocument(doc)).toBe(input);
  });

  it("round-trips a single-line input without a trailing newline", () => {
    const input = "FOO=bar";
    expect(serializeEnvDocument(parseEnvFile(input))).toBe(input);
  });

  it("round-trips blank-only documents", () => {
    const input = "\n\n";
    // Input has a trailing newline we strip once, then split on
    // `\n` — so we end up with two blank lines, which re-serialise
    // to a single `\n`. Round-trip is not byte-identical for
    // pathological whitespace-only inputs; verify the structural
    // round-trip below instead.
    const doc = parseEnvFile(input);
    const out = serializeEnvDocument(doc);
    expect(parseEnvFile(out).lines).toEqual(doc.lines);
  });
});

describe("mergeEnvValues", () => {
  it("updates an existing key in place without disturbing comments", () => {
    const input = [
      "# header",
      "FOO=old",
      "# another",
      "BAR=keep",
    ].join("\n");
    const doc = parseEnvFile(input);
    const updated = mergeEnvValues(doc, { FOO: "new" });
    const out = serializeEnvDocument(updated);
    expect(out).toBe(
      ["# header", "FOO=new", "# another", "BAR=keep"].join("\n"),
    );
  });

  it("appends a new key at the end with a blank-line separator", () => {
    const input = "FOO=bar";
    const doc = parseEnvFile(input);
    const updated = mergeEnvValues(doc, { NEW_KEY: "new_value" });
    const out = serializeEnvDocument(updated);
    expect(out).toBe("FOO=bar\n\nNEW_KEY=new_value");
  });

  it("does not insert a blank line if the last line is already blank", () => {
    // Two-line input: entry + explicit blank (the file has a
    // double newline at the end). Appending a new key must not
    // double up the blank separator.
    const input = "FOO=bar\n\n";
    const doc = parseEnvFile(input);
    expect(doc.lines.map((l) => l.type)).toEqual(["entry", "blank"]);
    const updated = mergeEnvValues(doc, { NEW_KEY: "x" });
    const out = serializeEnvDocument(updated);
    expect(out).toBe("FOO=bar\n\nNEW_KEY=x\n");
  });

  it("removes a key when the value is null", () => {
    const input = ["FOO=bar", "BAZ=qux", "ZOT=zing"].join("\n");
    const doc = parseEnvFile(input);
    const updated = mergeEnvValues(doc, { BAZ: null });
    expect(serializeEnvDocument(updated)).toBe("FOO=bar\nZOT=zing");
  });

  it("removes a key when the value is empty string", () => {
    const input = ["FOO=bar", "BAZ=qux"].join("\n");
    const doc = parseEnvFile(input);
    const updated = mergeEnvValues(doc, { BAZ: "" });
    expect(serializeEnvDocument(updated)).toBe("FOO=bar");
  });

  it("keeps surrounding comments when removing an entry", () => {
    // Be conservative: comments above an entry may describe a whole
    // group of keys. We only touch the entry itself.
    const input = [
      "# top comment",
      "FOO=remove_me",
      "# trailing comment",
    ].join("\n");
    const doc = parseEnvFile(input);
    const updated = mergeEnvValues(doc, { FOO: null });
    expect(serializeEnvDocument(updated)).toBe(
      "# top comment\n# trailing comment",
    );
  });

  it("is a no-op when asked to remove a key that isn't present", () => {
    const input = "FOO=bar";
    const doc = parseEnvFile(input);
    const updated = mergeEnvValues(doc, { MISSING: null });
    expect(serializeEnvDocument(updated)).toBe("FOO=bar");
  });

  it("quotes values that contain whitespace, hash, or quotes", () => {
    const input = "FOO=old";
    const doc = parseEnvFile(input);
    expect(
      serializeEnvDocument(
        mergeEnvValues(doc, { FOO: "hello world" }),
      ),
    ).toBe('FOO="hello world"');
    expect(
      serializeEnvDocument(
        mergeEnvValues(doc, { FOO: "has#hash" }),
      ),
    ).toBe('FOO="has#hash"');
    expect(
      serializeEnvDocument(
        mergeEnvValues(doc, { FOO: 'has"quote' }),
      ),
    ).toBe('FOO="has\\"quote"');
  });

  it("leaves plain values unquoted", () => {
    const input = "FOO=old";
    const doc = parseEnvFile(input);
    expect(
      serializeEnvDocument(
        mergeEnvValues(doc, { FOO: "plainvalue123" }),
      ),
    ).toBe("FOO=plainvalue123");
  });

  it("does not mutate the input document", () => {
    const input = "FOO=bar";
    const doc = parseEnvFile(input);
    mergeEnvValues(doc, { FOO: "new", NEW_KEY: "x" });
    // Original doc is unchanged.
    expect(serializeEnvDocument(doc)).toBe("FOO=bar");
  });

  it("handles multiple updates in a single call", () => {
    const input = ["FOO=old", "BAR=old"].join("\n");
    const doc = parseEnvFile(input);
    const updated = mergeEnvValues(doc, {
      FOO: "newfoo",
      BAR: "newbar",
      FRESH: "yes",
    });
    const out = serializeEnvDocument(updated);
    expect(out).toBe("FOO=newfoo\nBAR=newbar\n\nFRESH=yes");
  });

  it("updates the first occurrence and removes later duplicate lines", () => {
    // Duplicate keys in `.env` are rare but legal and sometimes
    // happen when users manually combine two files. If we only
    // rewrote the first occurrence, the trailing duplicate would
    // shadow our value under loaders that take the last-wins
    // semantics (and at minimum it would confuse a user who opens
    // the file and sees two conflicting assignments). Keep the first
    // line's position (so comment groupings aren't disturbed) but
    // strip the rest.
    const input = [
      "# header",
      "FOO=old1",
      "BAR=keep",
      "FOO=old2",
      "FOO=old3",
    ].join("\n");
    const doc = parseEnvFile(input);
    const updated = mergeEnvValues(doc, { FOO: "new" });
    expect(serializeEnvDocument(updated)).toBe(
      ["# header", "FOO=new", "BAR=keep"].join("\n"),
    );
  });

  it("removes every duplicate when clearing a key with null", () => {
    const input = ["FOO=one", "BAR=keep", "FOO=two", "FOO=three"].join("\n");
    const doc = parseEnvFile(input);
    const updated = mergeEnvValues(doc, { FOO: null });
    expect(serializeEnvDocument(updated)).toBe("BAR=keep");
  });

  it("removes every duplicate when clearing a key with empty string", () => {
    const input = ["FOO=one", "BAR=keep", "FOO=two"].join("\n");
    const doc = parseEnvFile(input);
    const updated = mergeEnvValues(doc, { FOO: "" });
    expect(serializeEnvDocument(updated)).toBe("BAR=keep");
  });
});

describe("writeEnvFileAtomic", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "scienceswarm-envwriter-"),
    );
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("writes contents to the target path", async () => {
    const target = path.join(tmpDir, ".env");
    await writeEnvFileAtomic(target, "FOO=bar\n");
    const result = await fs.readFile(target, "utf8");
    expect(result).toBe("FOO=bar\n");
  });

  it("creates the file with mode 0600", async () => {
    // Secrets live in .env. Defensively constrain perms so we
    // don't leave keys readable by other users on shared boxes.
    const target = path.join(tmpDir, ".env");
    await writeEnvFileAtomic(target, "OPENAI_API_KEY=sk-live-abc\n");
    const stat = await fs.stat(target);
    // On POSIX, check the low 9 bits.
    // Skip on Windows — `fs.stat` mode semantics differ.
    if (process.platform !== "win32") {
      expect(stat.mode & 0o777).toBe(0o600);
    }
  });

  it("overwrites an existing file atomically", async () => {
    const target = path.join(tmpDir, ".env");
    await fs.writeFile(target, "OLD=1\n", "utf8");
    await writeEnvFileAtomic(target, "NEW=2\n");
    expect(await fs.readFile(target, "utf8")).toBe("NEW=2\n");
  });

  it("cleans up the temp file when rename fails", async () => {
    const target = path.join(tmpDir, ".env");

    // Force `fs.rename` to fail so we exercise the cleanup branch.
    // We use `vi.spyOn` against the module's bound `fs.rename`.
    const renameSpy = vi
      .spyOn(fs, "rename")
      .mockRejectedValueOnce(new Error("simulated rename failure"));

    await expect(
      writeEnvFileAtomic(target, "FOO=bar\n"),
    ).rejects.toThrow("simulated rename failure");

    // Target was never created.
    await expect(fs.access(target)).rejects.toThrow();

    // No lingering temp files in the directory.
    const remaining = await fs.readdir(tmpDir);
    expect(remaining).toEqual([]);

    renameSpy.mockRestore();
  });

  it("propagates write errors and cleans up", async () => {
    const target = path.join(tmpDir, ".env");

    const writeSpy = vi
      .spyOn(fs, "writeFile")
      .mockRejectedValueOnce(new Error("simulated write failure"));

    await expect(
      writeEnvFileAtomic(target, "FOO=bar\n"),
    ).rejects.toThrow("simulated write failure");

    // Directory is clean (cleanup helper swallows ENOENT on unlink).
    const remaining = await fs.readdir(tmpDir);
    expect(remaining).toEqual([]);

    writeSpy.mockRestore();
  });

  it("uses a temp filename that includes pid, timestamp, and random suffix", async () => {
    // Regression guard: sibling temp name must be unique across
    // concurrent setup runs. Capture the temp path by intercepting
    // writeFile.
    const target = path.join(tmpDir, ".env");
    const observed: string[] = [];
    const writeSpy = vi
      .spyOn(fs, "writeFile")
      .mockImplementationOnce(async (p) => {
        observed.push(String(p));
      });
    const renameSpy = vi
      .spyOn(fs, "rename")
      .mockImplementationOnce(async () => {});

    await writeEnvFileAtomic(target, "FOO=bar\n");

    expect(observed).toHaveLength(1);
    const tempPath = observed[0]!;
    expect(tempPath.startsWith(path.join(tmpDir, ".env.tmp-"))).toBe(
      true,
    );
    // Shape: `.tmp-<pid>-<ms>-<hex>`. The hex suffix prevents
    // collisions when two concurrent saves land in the same
    // millisecond inside the same process.
    expect(tempPath).toMatch(/\.tmp-\d+-\d+-[0-9a-f]{8,}$/);

    writeSpy.mockRestore();
    renameSpy.mockRestore();
  });

  it("generates unique temp filenames across concurrent calls", async () => {
    // Two near-simultaneous saves must not collide on the temp
    // filename — without the random suffix, two calls on the same
    // millisecond in the same process would produce the same temp
    // path and one of the writes would clobber the other's tempfile.
    const target = path.join(tmpDir, ".env");
    const observed: string[] = [];
    const writeSpy = vi
      .spyOn(fs, "writeFile")
      .mockImplementation(async (p) => {
        observed.push(String(p));
      });
    const renameSpy = vi
      .spyOn(fs, "rename")
      .mockImplementation(async () => {});

    await Promise.all([
      writeEnvFileAtomic(target, "FOO=bar\n"),
      writeEnvFileAtomic(target, "FOO=baz\n"),
      writeEnvFileAtomic(target, "FOO=qux\n"),
    ]);

    expect(observed).toHaveLength(3);
    expect(new Set(observed).size).toBe(3);

    writeSpy.mockRestore();
    renameSpy.mockRestore();
  });
});
