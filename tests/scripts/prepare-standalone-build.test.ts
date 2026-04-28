import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  copyStandaloneBuildDir,
  prepareStandaloneBuild,
} from "../../scripts/prepare-standalone-build.mjs";

describe("prepare-standalone-build", () => {
  it("copies static and public assets into the standalone tree", () => {
    const root = mkdtempSync(path.join(tmpdir(), "scienceswarm-standalone-"));
    try {
      mkdirSync(path.join(root, ".next", "static", "chunks"), { recursive: true });
      mkdirSync(path.join(root, "public"), { recursive: true });
      writeFileSync(path.join(root, ".next", "static", "chunks", "app.js"), "console.log('ok');");
      writeFileSync(path.join(root, "public", "favicon.ico"), "icon");

      const result = prepareStandaloneBuild(root);

      expect(result.staticPath).toBe(path.join(root, ".next", "standalone", ".next", "static"));
      expect(result.publicPath).toBe(path.join(root, ".next", "standalone", "public"));
      expect(readFileSync(
        path.join(root, ".next", "standalone", ".next", "static", "chunks", "app.js"),
        "utf8",
      )).toBe("console.log('ok');");
      expect(readFileSync(
        path.join(root, ".next", "standalone", "public", "favicon.ico"),
        "utf8",
      )).toBe("icon");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("skips absent source directories", () => {
    const root = mkdtempSync(path.join(tmpdir(), "scienceswarm-standalone-"));
    try {
      expect(copyStandaloneBuildDir(root, "missing", "target")).toBeNull();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
