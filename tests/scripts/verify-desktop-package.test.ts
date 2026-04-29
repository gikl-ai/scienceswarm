import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  findDesktopPackageProblems,
  REQUIRED_DESKTOP_PACKAGE_PATHS,
  verifyDesktopPackage,
} from "../../scripts/verify-desktop-package.mjs";

function writeRequiredPackageFiles(packageDir: string) {
  for (const requiredPath of REQUIRED_DESKTOP_PACKAGE_PATHS) {
    const absolutePath = path.join(packageDir, requiredPath);
    mkdirSync(path.dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, requiredPath);
  }
}

describe("verify-desktop-package", () => {
  it("accepts a complete staged desktop package", () => {
    const root = path.join(tmpdir(), `scienceswarm-desktop-package-verify-${Date.now()}`);
    const packageDir = path.join(root, ".desktop-package", "app");
    try {
      writeRequiredPackageFiles(packageDir);

      expect(verifyDesktopPackage({ root })).toMatchObject({
        packageDir,
        requiredPathCount: REQUIRED_DESKTOP_PACKAGE_PATHS.length,
      });
      expect(findDesktopPackageProblems({ root })).toEqual([]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("rejects missing required package files", () => {
    const root = path.join(tmpdir(), `scienceswarm-desktop-package-verify-${Date.now()}`);
    const packageDir = path.join(root, ".desktop-package", "app");
    try {
      writeRequiredPackageFiles(packageDir);
      rmSync(path.join(packageDir, "scripts", "install-runtime-prereqs.sh"));

      expect(() => verifyDesktopPackage({ root })).toThrow(
        "Missing required desktop package path: scripts/install-runtime-prereqs.sh",
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("rejects model and runtime cache payloads", () => {
    const root = path.join(tmpdir(), `scienceswarm-desktop-package-verify-${Date.now()}`);
    const packageDir = path.join(root, ".desktop-package", "app");
    try {
      writeRequiredPackageFiles(packageDir);
      mkdirSync(path.join(packageDir, "desktop", "ollama-models"), { recursive: true });
      writeFileSync(path.join(packageDir, "desktop", "ollama-models", "model.gguf"), "weights");
      mkdirSync(path.join(packageDir, "desktop", "cache", "blobs"), { recursive: true });
      writeFileSync(path.join(packageDir, "desktop", "cache", "blobs", "sha256"), "blob");

      expect(findDesktopPackageProblems({ root })).toEqual(
        expect.arrayContaining([
          "Forbidden desktop package payload path: desktop/ollama-models",
          "Forbidden desktop package payload path: desktop/ollama-models/model.gguf",
          "Forbidden desktop package payload path: desktop/cache/blobs",
          "Forbidden desktop package payload path: desktop/cache/blobs/sha256",
        ]),
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
