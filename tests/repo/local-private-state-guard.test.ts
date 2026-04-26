// @vitest-environment node

import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function listTrackedFiles(): string[] {
  return execFileSync("git", ["ls-files", "-z"], {
    cwd: repoRoot,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
}

describe("repo local-state guard", () => {
  it("does not track local-only private state directories", () => {
    const trackedLocalState = listTrackedFiles().filter(
      (file) => file === ".local" || file.startsWith(".local/"),
    );

    expect(trackedLocalState).toEqual([]);
  });

  it("does not track local environment override files", () => {
    const trackedLocalEnvFiles = listTrackedFiles().filter((file) =>
      /^\.env(\.[^/]+)?\.local$/.test(file),
    );

    expect(trackedLocalEnvFiles).toEqual([]);
  });
});
