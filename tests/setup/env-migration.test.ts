import { promises as fs, mkdtempSync, readdirSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { migrateEnvLocalOnce } from "@/lib/setup/env-migration";

describe("migrateEnvLocalOnce", () => {
  let tmpDir: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "scienceswarm-envmig-"));
    // Suppress expected warnings from successful migrations so test
    // output stays clean. Tests that want to assert on warn behaviour
    // read `warnSpy.mock.calls` directly.
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(async () => {
    warnSpy.mockRestore();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  /**
   * Helper: find the single `.env.local.migrated-*` sentinel in
   * `tmpDir`. Throws if zero or many. Tests that expect no sentinel
   * should use `sentinelEntries` and assert length.
   */
  function sentinelEntries(): string[] {
    return readdirSync(tmpDir).filter((entry) =>
      entry.startsWith(".env.local.migrated-"),
    );
  }

  it("is a no-op when only `.env` exists", async () => {
    const envPath = path.join(tmpDir, ".env");
    await fs.writeFile(envPath, "FOO=bar\n", "utf8");

    const result = await migrateEnvLocalOnce(tmpDir);

    expect(result).toEqual({ status: "no-op", reason: "no-local-file" });

    // `.env` untouched.
    expect(await fs.readFile(envPath, "utf8")).toBe("FOO=bar\n");
    // No sentinel was created.
    expect(sentinelEntries()).toEqual([]);
    // No warn was logged on a no-op path.
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("promotes `.env.local` to `.env` when no `.env` exists", async () => {
    const localPath = path.join(tmpDir, ".env.local");
    const envPath = path.join(tmpDir, ".env");
    const contents = "# header\nFOO=bar\nBAZ=qux\n";
    await fs.writeFile(localPath, contents, "utf8");

    const result = await migrateEnvLocalOnce(tmpDir);

    expect(result.status).toBe("promoted");

    // `.env` has identical content.
    expect(await fs.readFile(envPath, "utf8")).toBe(contents);

    // `.env.local` is gone.
    await expect(fs.access(localPath)).rejects.toThrow();

    // Exactly one sentinel was created.
    const sentinels = sentinelEntries();
    expect(sentinels).toHaveLength(1);

    // One warn was logged, and it mentions the sentinel path.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const warnArg = String(warnSpy.mock.calls[0]?.[0] ?? "");
    expect(warnArg).toContain(sentinels[0]!);
  });

  it("merges disjoint keys when both files exist", async () => {
    const localPath = path.join(tmpDir, ".env.local");
    const envPath = path.join(tmpDir, ".env");
    await fs.writeFile(envPath, "A=1\nB=2\n", "utf8");
    await fs.writeFile(localPath, "C=3\nD=4\n", "utf8");

    const result = await migrateEnvLocalOnce(tmpDir);

    expect(result.status).toBe("merged");
    if (result.status === "merged") {
      // Disjoint keys: nothing was overwritten, so `mergedKeys` is
      // empty. The fact that C and D are new-from-local is visible
      // in the file contents, not in `mergedKeys`.
      expect(result.mergedKeys).toEqual([]);
    }

    const envAfter = await fs.readFile(envPath, "utf8");
    // All four keys are present.
    expect(envAfter).toMatch(/^A=1$/m);
    expect(envAfter).toMatch(/^B=2$/m);
    expect(envAfter).toMatch(/^C=3$/m);
    expect(envAfter).toMatch(/^D=4$/m);

    // Sentinel exists; local gone.
    expect(sentinelEntries()).toHaveLength(1);
    await expect(fs.access(localPath)).rejects.toThrow();
  });

  it("lets `.env.local` values win when keys conflict", async () => {
    const localPath = path.join(tmpDir, ".env.local");
    const envPath = path.join(tmpDir, ".env");
    await fs.writeFile(envPath, "A=env\nB=env\n", "utf8");
    await fs.writeFile(localPath, "A=local\nC=local\n", "utf8");

    const result = await migrateEnvLocalOnce(tmpDir);

    expect(result.status).toBe("merged");
    if (result.status === "merged") {
      // Only A was in both files; C is new-from-local, so only A is
      // reported as an overwrite.
      expect(result.mergedKeys).toEqual(["A"]);
    }

    const envAfter = await fs.readFile(envPath, "utf8");
    expect(envAfter).toMatch(/^A=local$/m);
    expect(envAfter).toMatch(/^B=env$/m);
    expect(envAfter).toMatch(/^C=local$/m);
    // A=env no longer appears.
    expect(envAfter).not.toMatch(/^A=env$/m);
  });

  it("is a no-op when a sentinel is already present", async () => {
    const localPath = path.join(tmpDir, ".env.local");
    const envPath = path.join(tmpDir, ".env");
    const sentinelPath = path.join(
      tmpDir,
      ".env.local.migrated-2026-01-01T00-00-00.000Z",
    );
    await fs.writeFile(envPath, "X=1\n", "utf8");
    await fs.writeFile(localPath, "Y=2\n", "utf8");
    await fs.writeFile(sentinelPath, "previous-backup\n", "utf8");

    const result = await migrateEnvLocalOnce(tmpDir);

    expect(result).toEqual({ status: "already-migrated" });

    // Nothing was touched.
    expect(await fs.readFile(envPath, "utf8")).toBe("X=1\n");
    expect(await fs.readFile(localPath, "utf8")).toBe("Y=2\n");
    expect(await fs.readFile(sentinelPath, "utf8")).toBe("previous-backup\n");

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("is idempotent when called twice in a row", async () => {
    const localPath = path.join(tmpDir, ".env.local");
    await fs.writeFile(localPath, "FOO=bar\n", "utf8");

    const first = await migrateEnvLocalOnce(tmpDir);
    expect(first.status).toBe("promoted");

    const second = await migrateEnvLocalOnce(tmpDir);
    expect(second).toEqual({ status: "already-migrated" });

    // Still exactly one sentinel (the one created by the first call).
    expect(sentinelEntries()).toHaveLength(1);

    // Only the first call logged a warn.
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("preserves comments and formatting verbatim on the promote path", async () => {
    const localPath = path.join(tmpDir, ".env.local");
    const envPath = path.join(tmpDir, ".env");
    // Deliberately non-trivial formatting: multiple comment blocks,
    // blank line separators, quoted value. The promote path is a
    // pure byte copy, so all of this should survive verbatim.
    const contents = [
      "# top comment",
      "# another line",
      "",
      "FOO=bar",
      "",
      "# group header",
      'BAZ="quoted value"',
      "",
    ].join("\n");
    await fs.writeFile(localPath, contents, "utf8");

    const result = await migrateEnvLocalOnce(tmpDir);

    expect(result.status).toBe("promoted");
    expect(await fs.readFile(envPath, "utf8")).toBe(contents);
  });

  it("propagates non-ENOENT stat errors as `{ status: 'error' }`", async () => {
    // Simulate a permission error (EACCES) on the `.env.local` stat check.
    // Previously the `exists()` helper swallowed every non-ENOENT error and
    // returned false, so a permission problem looked like "no local file".
    const localPath = path.join(tmpDir, ".env.local");
    await fs.writeFile(localPath, "FOO=bar\n", "utf8");

    const realStat = fs.stat.bind(fs);
    const statSpy = vi.spyOn(fs, "stat").mockImplementation(
      async (p: Parameters<typeof fs.stat>[0], ...rest) => {
        if (typeof p === "string" && p.endsWith(".env.local")) {
          const err = new Error(
            "EACCES: permission denied, stat '.env.local'",
          ) as NodeJS.ErrnoException;
          err.code = "EACCES";
          throw err;
        }
        return realStat(p, ...rest);
      },
    );

    try {
      const result = await migrateEnvLocalOnce(tmpDir);

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error).toMatch(/EACCES/);
      }
      // `.env.local` is still there; we didn't create a sentinel or do anything.
      expect(sentinelEntries()).toEqual([]);
      expect(await fs.readFile(localPath, "utf8")).toBe("FOO=bar\n");
    } finally {
      statSpy.mockRestore();
    }
  });
});
