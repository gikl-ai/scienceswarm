import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  compareSnapshot,
  computeQuickFileFingerprint,
  isPathInsideRoot,
  snapshotFile,
  validateRelativeDestination,
} from "@/lib/paper-library/fs-safety";

const ROOT = path.join(tmpdir(), "scienceswarm-paper-library-fs-safety");

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(path.join(ROOT, "papers"), { recursive: true });
});

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe("paper-library fs safety", () => {
  it("validates root containment", () => {
    expect(isPathInsideRoot("/tmp/root", "/tmp/root/a/b.pdf")).toBe(true);
    expect(isPathInsideRoot("/tmp/root", "/tmp/rootish/b.pdf")).toBe(false);
  });

  it("rejects unsafe destinations and case collisions", () => {
    expect(validateRelativeDestination("../escape.pdf")).toMatchObject({
      ok: false,
      problems: [expect.objectContaining({ code: "unsafe_path" })],
    });
    expect(validateRelativeDestination("Paper.pdf", { existingDestinations: ["paper.pdf"] })).toMatchObject({
      ok: false,
      problems: [expect.objectContaining({ code: "case_collision" })],
    });
  });

  it("uses quick fingerprints for large files", async () => {
    const filePath = path.join(ROOT, "papers", "large.pdf");
    writeFileSync(filePath, Buffer.concat([
      Buffer.alloc(80 * 1024, "a"),
      Buffer.alloc(80 * 1024, "b"),
      Buffer.alloc(80 * 1024, "c"),
      Buffer.alloc(80 * 1024, "d"),
    ]));

    const result = await computeQuickFileFingerprint(filePath, 320 * 1024, 16 * 1024);
    expect(result.strength).toBe("quick");
    expect(result.fingerprint).toHaveLength(64);
  });

  it("snapshots files and detects changed sources", async () => {
    const filePath = path.join(ROOT, "papers", "a.pdf");
    writeFileSync(filePath, "one");
    const first = await snapshotFile(ROOT, filePath);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("expected snapshot");

    writeFileSync(filePath, "two");
    const second = await snapshotFile(ROOT, filePath);
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("expected snapshot");

    expect(compareSnapshot(first.snapshot, second.snapshot)).toMatchObject({
      ok: false,
      problems: expect.arrayContaining([expect.objectContaining({ code: "source_changed_since_approval" })]),
    });
  });

  it("rejects symlink escapes during snapshot", async () => {
    const outside = path.join(tmpdir(), "scienceswarm-paper-library-outside.pdf");
    writeFileSync(outside, "outside");
    const link = path.join(ROOT, "papers", "outside.pdf");
    symlinkSync(outside, link);

    const result = await snapshotFile(ROOT, link);
    expect(result).toMatchObject({
      ok: false,
      problems: [expect.objectContaining({ code: "unsafe_path" })],
    });
  });
});
