import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  createDesktopPackageBuildConfig,
  createDesktopPackageManifest,
  prepareDesktopPackage,
  resolveDesktopPackageAppDir,
  shouldCopyDesktopShellPath,
} from "../../scripts/prepare-desktop-package.mjs";

describe("prepare-desktop-package", () => {
  it("stages only the standalone app and desktop shell inputs", () => {
    const root = path.join(tmpdir(), `scienceswarm-desktop-package-${Date.now()}`);
    try {
      mkdirSync(path.join(root, ".next", "standalone", "node_modules", "next"), {
        recursive: true,
      });
      mkdirSync(path.join(root, "desktop", "ollama-models"), { recursive: true });
      mkdirSync(path.join(root, "desktop", "cache", "blobs"), { recursive: true });
      mkdirSync(path.join(root, "desktop", "cache", "manifests"), { recursive: true });
      mkdirSync(path.join(root, "scripts"), { recursive: true });

      writeFileSync(path.join(root, ".next", "standalone", "server.js"), "server");
      writeFileSync(path.join(root, ".next", "standalone", "node_modules", "next", "index.js"), "next");
      writeFileSync(path.join(root, "desktop", "main.mjs"), "main");
      writeFileSync(path.join(root, "desktop", "preload.mjs"), "preload");
      writeFileSync(path.join(root, "desktop", "ollama-models", "model.gguf"), "weights");
      writeFileSync(path.join(root, "desktop", "cache", "blobs", "sha256"), "blob");
      writeFileSync(path.join(root, "desktop", "cache", "manifests", "model"), "manifest");
      writeFileSync(path.join(root, "scripts", "start-standalone.mjs"), "start");
      writeFileSync(path.join(root, "package.json"), JSON.stringify({
        name: "scienceswarm",
        version: "0.1.0",
        description: "ScienceSwarm",
        license: "MIT",
        author: "ScienceSwarm contributors",
        dependencies: {
          gbrain: "file:../gbrain",
        },
        scripts: {
          dev: "next dev",
        },
        build: {
          appId: "ai.scienceswarm.desktop",
          asar: true,
          asarUnpack: [".next/standalone/**"],
          npmRebuild: false,
          files: ["**/*"],
          directories: {
            app: ".desktop-package/app",
            buildResources: "desktop/build",
          },
        },
      }));

      const { packageDir } = prepareDesktopPackage(root);
      const stagedPackage = JSON.parse(
        readFileSync(path.join(packageDir, "package.json"), "utf-8"),
      );

      expect(packageDir).toBe(resolveDesktopPackageAppDir(root));
      expect(existsSync(path.join(packageDir, ".next", "standalone", "server.js"))).toBe(true);
      expect(existsSync(path.join(packageDir, "desktop", "main.mjs"))).toBe(true);
      expect(existsSync(path.join(packageDir, "scripts", "start-standalone.mjs"))).toBe(true);
      expect(existsSync(path.join(packageDir, "desktop", "ollama-models", "model.gguf"))).toBe(false);
      expect(existsSync(path.join(packageDir, "desktop", "cache", "blobs", "sha256"))).toBe(false);
      expect(existsSync(path.join(packageDir, "desktop", "cache", "manifests", "model"))).toBe(false);
      expect(stagedPackage).toEqual({
        name: "scienceswarm",
        version: "0.1.0",
        description: "ScienceSwarm",
        license: "MIT",
        author: "ScienceSwarm contributors",
        main: "desktop/main.mjs",
        build: {
          appId: "ai.scienceswarm.desktop",
          asar: true,
          asarUnpack: [".next/standalone/**"],
          npmRebuild: false,
          files: ["**/*"],
          directories: {
            buildResources: "../../desktop/build",
            output: "../../dist",
          },
        },
      });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("keeps the staged package manifest dependency-free", () => {
    expect(createDesktopPackageManifest({
      name: "scienceswarm",
      version: "0.1.0",
      description: "ScienceSwarm",
      license: "MIT",
      author: "ScienceSwarm contributors",
      dependencies: {
        react: "^19",
      },
    })).not.toHaveProperty("dependencies");
  });

  it("rewrites electron-builder directories for the staged project root", () => {
    expect(createDesktopPackageBuildConfig({
      appId: "ai.scienceswarm.desktop",
      directories: {
        app: ".desktop-package/app",
        buildResources: "desktop/build",
      },
    })).toEqual({
      appId: "ai.scienceswarm.desktop",
      directories: {
        buildResources: "../../desktop/build",
        output: "../../dist",
      },
    });
  });

  it("filters downloaded model blobs from the desktop shell", () => {
    const root = path.join("/tmp", "desktop");

    expect(shouldCopyDesktopShellPath(path.join(root, "main.mjs"), root)).toBe(true);
    expect(shouldCopyDesktopShellPath(path.join(root, "ollama-models", "model.gguf"), root)).toBe(false);
    expect(shouldCopyDesktopShellPath(path.join(root, "cache", "blobs", "sha256"), root)).toBe(false);
    expect(shouldCopyDesktopShellPath(path.join(root, "cache", "manifests", "model"), root)).toBe(false);
  });
});
