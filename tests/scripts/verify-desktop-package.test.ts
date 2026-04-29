import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
      mkdirSync(path.join(packageDir, "desktop", "cache", "manifests"), { recursive: true });
      writeFileSync(path.join(packageDir, "desktop", "cache", "manifests", "model"), "manifest");

      expect(findDesktopPackageProblems({ root })).toEqual(
        expect.arrayContaining([
          "Forbidden desktop package payload path: desktop/ollama-models",
          "Forbidden desktop package payload path: desktop/ollama-models/model.gguf",
          "Forbidden desktop package payload path: desktop/cache/blobs",
          "Forbidden desktop package payload path: desktop/cache/blobs/sha256",
          "Forbidden desktop package payload path: desktop/cache/manifests",
          "Forbidden desktop package payload path: desktop/cache/manifests/model",
        ]),
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("rejects local state, private docs, and agent worktree payloads", () => {
    const root = path.join(tmpdir(), `scienceswarm-desktop-package-verify-${Date.now()}`);
    const packageDir = path.join(root, ".desktop-package", "app");
    try {
      writeRequiredPackageFiles(packageDir);
      mkdirSync(path.join(packageDir, ".next", "standalone", ".local", "private-docs"), { recursive: true });
      writeFileSync(path.join(packageDir, ".next", "standalone", ".local", "private-docs", "plan.md"), "private");
      mkdirSync(path.join(packageDir, ".next", "standalone", ".worktrees", "old-branch"), { recursive: true });
      writeFileSync(path.join(packageDir, ".next", "standalone", ".worktrees", "old-branch", "x"), "x");
      mkdirSync(path.join(packageDir, ".next", "standalone", ".git"), { recursive: true });
      writeFileSync(path.join(packageDir, ".next", "standalone", ".git", "HEAD"), "ref");
      mkdirSync(path.join(packageDir, ".next", "standalone", ".github"), { recursive: true });
      writeFileSync(path.join(packageDir, ".next", "standalone", ".github", "pull_request_template.md"), "template");
      writeFileSync(path.join(packageDir, ".next", "standalone", ".env"), "SECRET=value");
      writeFileSync(path.join(packageDir, ".next", "standalone", "CHAT_TIMING_FIX_ENG_PLAN.md"), "plan");

      expect(findDesktopPackageProblems({ root })).toEqual(
        expect.arrayContaining([
          "Forbidden desktop package payload path: .next/standalone/.local",
          "Forbidden desktop package payload path: .next/standalone/.local/private-docs",
          "Forbidden desktop package payload path: .next/standalone/.local/private-docs/plan.md",
          "Forbidden desktop package payload path: .next/standalone/.worktrees",
          "Forbidden desktop package payload path: .next/standalone/.worktrees/old-branch",
          "Forbidden desktop package payload path: .next/standalone/.worktrees/old-branch/x",
          "Forbidden desktop package payload path: .next/standalone/.git",
          "Forbidden desktop package payload path: .next/standalone/.git/HEAD",
          "Forbidden desktop package payload path: .next/standalone/.github",
          "Forbidden desktop package payload path: .next/standalone/.github/pull_request_template.md",
          "Forbidden desktop package payload path: .next/standalone/.env",
          "Forbidden desktop package payload path: .next/standalone/CHAT_TIMING_FIX_ENG_PLAN.md",
        ]),
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("does not follow symlinked directories while scanning package payloads", () => {
    const root = path.join(tmpdir(), `scienceswarm-desktop-package-verify-${Date.now()}`);
    const packageDir = path.join(root, ".desktop-package", "app");
    try {
      writeRequiredPackageFiles(packageDir);
      symlinkSync(packageDir, path.join(packageDir, "desktop", "loop"), "dir");

      expect(findDesktopPackageProblems({ root })).toEqual([]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
