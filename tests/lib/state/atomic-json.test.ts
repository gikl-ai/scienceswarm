import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { atomicJsonFs, readJsonFile, updateJsonFile, writeJsonFile } from "@/lib/state/atomic-json";

const ROOT = join(tmpdir(), "scienceswarm-state-atomic-json");
const FILE = join(ROOT, "manifest.json");

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(ROOT, { recursive: true, force: true });
});

describe("atomic-json", () => {
  it("writes and reads json atomically", async () => {
    await writeJsonFile(FILE, { version: 1, value: "ok" });

    const data = await readJsonFile<{ version: number; value: string }>(FILE);
    expect(data).toEqual({ version: 1, value: "ok" });
    expect(readFileSync(FILE, "utf-8")).toContain('"value": "ok"');
  });

  it("preserves the old file if rename fails mid-write", async () => {
    await writeJsonFile(FILE, { version: 1, value: "original" });

    const renameSpy = vi.spyOn(atomicJsonFs, "rename").mockRejectedValueOnce(
      new Error("rename failed"),
    );

    await expect(writeJsonFile(FILE, { version: 1, value: "new" })).rejects.toThrow("rename failed");
    expect(renameSpy).toHaveBeenCalledOnce();

    const data = await readJsonFile<{ version: number; value: string }>(FILE);
    expect(data).toEqual({ version: 1, value: "original" });
  });

  it("serializes concurrent updates per file path", async () => {
    await writeJsonFile(FILE, { counter: 0 });

    const originalReadFile = atomicJsonFs.readFile;
    let releaseFirstRead: (() => void) | undefined;
    const firstReadPending = new Promise<void>((resolve) => {
      releaseFirstRead = resolve;
    });

    const readSpy = vi.spyOn(atomicJsonFs, "readFile").mockImplementationOnce(async (...args) => {
      await firstReadPending;
      return originalReadFile(...args);
    });

    const firstUpdate = updateJsonFile<{ counter: number }>(FILE, (current) => ({
      counter: (current?.counter ?? 0) + 1,
    }));
    const secondUpdate = updateJsonFile<{ counter: number }>(FILE, (current) => ({
      counter: (current?.counter ?? 0) + 1,
    }));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(readSpy).toHaveBeenCalledTimes(1);

    releaseFirstRead?.();

    await Promise.all([firstUpdate, secondUpdate]);

    const data = await readJsonFile<{ counter: number }>(FILE);
    expect(data).toEqual({ counter: 2 });
  });
});
