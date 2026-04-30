import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  createDesktopPackageBuildConfig,
  createDesktopPackageManifest,
  DESKTOP_PACKAGE_RUNTIME_DEPENDENCIES,
  DESKTOP_PACKAGE_SCRIPT_INPUTS,
  prepareDesktopPackage,
  resolveDesktopPackageAppDir,
  shouldCopyDesktopShellPath,
  shouldCopyRuntimeDependencyPath,
  shouldCopyStandalonePackagePath,
  shouldMarkDesktopPackageScriptExecutable,
} from "../../scripts/prepare-desktop-package.mjs";

describe("prepare-desktop-package", () => {
  it("stages only the standalone app and desktop shell inputs", () => {
    const root = path.join(tmpdir(), `scienceswarm-desktop-package-${Date.now()}`);
    try {
      mkdirSync(path.join(root, ".next", "standalone", "node_modules", "next"), {
        recursive: true,
      });
      mkdirSync(path.join(root, "node_modules", "gbrain", "src"), { recursive: true });
      mkdirSync(path.join(root, "node_modules", "gbrain", ".github"), { recursive: true });
      mkdirSync(path.join(root, "node_modules", "gbrain", "test"), { recursive: true });
      mkdirSync(path.join(root, "node_modules", "gbrain", "node_modules", ".bin"), { recursive: true });
      mkdirSync(path.join(root, "node_modules", "gbrain", "node_modules", "openai"), { recursive: true });
      mkdirSync(path.join(root, ".next", "standalone", ".local", "private-docs"), {
        recursive: true,
      });
      mkdirSync(path.join(root, ".next", "standalone", ".worktrees", "old-branch"), {
        recursive: true,
      });
      mkdirSync(path.join(root, ".next", "standalone", ".git"), { recursive: true });
      mkdirSync(path.join(root, ".next", "standalone", ".github"), { recursive: true });
      mkdirSync(path.join(root, ".next", "standalone", "docs"), { recursive: true });
      mkdirSync(path.join(root, "desktop", "ollama-models"), { recursive: true });
      mkdirSync(path.join(root, "desktop", "cache", "blobs"), { recursive: true });
      mkdirSync(path.join(root, "desktop", "cache", "manifests"), { recursive: true });
      mkdirSync(path.join(root, "scripts"), { recursive: true });

      writeFileSync(path.join(root, ".next", "standalone", "server.js"), "server");
      writeFileSync(path.join(root, ".next", "standalone", "node_modules", "next", "index.js"), "next");
      writeFileSync(path.join(root, "package-lock.json"), JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "node_modules/gbrain": {
            version: "0.21.0",
            resolved: "git+https://github.com/garrytan/gbrain.git#f718c595b3a382b2a9a6a1f6553448ad047b5e94",
          },
        },
      }));
      writeFileSync(
        path.join(root, "node_modules", "gbrain", "package.json"),
        JSON.stringify({ name: "gbrain", version: "0.21.0", bin: { gbrain: "src/cli.ts" } }),
      );
      writeFileSync(path.join(root, "node_modules", "gbrain", "src", "cli.ts"), "#!/usr/bin/env bun\n");
      writeFileSync(path.join(root, "node_modules", "gbrain", ".github", "workflow.yml"), "ci");
      writeFileSync(path.join(root, "node_modules", "gbrain", "test", "fixture.ts"), "test");
      writeFileSync(path.join(root, "node_modules", "gbrain", "node_modules", ".bin", "openai"), "bin");
      writeFileSync(path.join(root, "node_modules", "gbrain", "node_modules", "openai", "package.json"), "{}");
      writeFileSync(
        path.join(root, ".next", "standalone", ".local", "private-docs", "plan.md"),
        "private",
      );
      writeFileSync(path.join(root, ".next", "standalone", ".worktrees", "old-branch", "x"), "x");
      writeFileSync(path.join(root, ".next", "standalone", ".git", "HEAD"), "ref");
      writeFileSync(path.join(root, ".next", "standalone", ".github", "pull_request_template.md"), "template");
      writeFileSync(path.join(root, ".next", "standalone", ".env"), "SECRET=value");
      writeFileSync(path.join(root, ".next", "standalone", "CHAT_TIMING_FIX_ENG_PLAN.md"), "plan");
      writeFileSync(path.join(root, ".next", "standalone", "README.md"), "readme");
      writeFileSync(path.join(root, ".next", "standalone", "docs", "desktop-installers.md"), "public docs");
      writeFileSync(path.join(root, "desktop", "main.mjs"), "main");
      writeFileSync(path.join(root, "desktop", "preload.cjs"), "preload");
      writeFileSync(path.join(root, "desktop", "ollama-models", "model.gguf"), "weights");
      writeFileSync(path.join(root, "desktop", "cache", "blobs", "sha256"), "blob");
      writeFileSync(path.join(root, "desktop", "cache", "manifests", "model"), "manifest");
      for (const scriptName of DESKTOP_PACKAGE_SCRIPT_INPUTS) {
        writeFileSync(path.join(root, "scripts", scriptName), scriptName);
      }
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
          extraResources: [{
            from: ".next/standalone/node_modules",
            to: "app.asar.unpacked/.next/standalone/node_modules",
            filter: ["**/*"],
          }],
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
      expect(existsSync(path.join(packageDir, ".next", "standalone", "package-lock.json"))).toBe(true);
      expect(DESKTOP_PACKAGE_RUNTIME_DEPENDENCIES).toContain("gbrain");
      expect(existsSync(path.join(packageDir, ".next", "standalone", "node_modules", "gbrain", "package.json"))).toBe(true);
      expect(existsSync(path.join(packageDir, ".next", "standalone", "node_modules", "gbrain", "src", "cli.ts"))).toBe(true);
      expect(existsSync(path.join(packageDir, ".next", "standalone", "node_modules", ".bin", "gbrain"))).toBe(true);
      expect(existsSync(path.join(packageDir, ".next", "standalone", "node_modules", ".bin", "gbrain.cmd"))).toBe(true);
      expect(
        readFileSync(
          path.join(packageDir, ".next", "standalone", "node_modules", ".bin", "gbrain.cmd"),
          "utf-8",
        ),
      ).toContain('bun "%~dp0\\..\\gbrain\\src\\cli.ts" %*');
      expect(existsSync(path.join(packageDir, ".next", "standalone", "node_modules", "gbrain", ".github"))).toBe(false);
      expect(existsSync(path.join(packageDir, ".next", "standalone", "node_modules", "gbrain", "test"))).toBe(false);
      expect(existsSync(path.join(packageDir, ".next", "standalone", "node_modules", "gbrain", "node_modules", ".bin"))).toBe(false);
      expect(existsSync(path.join(packageDir, ".next", "standalone", "node_modules", "gbrain", "node_modules", "openai", "package.json"))).toBe(true);
      expect(existsSync(path.join(packageDir, ".next", "standalone", ".local"))).toBe(false);
      expect(existsSync(path.join(packageDir, ".next", "standalone", ".worktrees"))).toBe(false);
      expect(existsSync(path.join(packageDir, ".next", "standalone", ".git"))).toBe(false);
      expect(existsSync(path.join(packageDir, ".next", "standalone", ".github"))).toBe(false);
      expect(existsSync(path.join(packageDir, ".next", "standalone", ".env"))).toBe(false);
      expect(existsSync(path.join(packageDir, ".next", "standalone", "CHAT_TIMING_FIX_ENG_PLAN.md"))).toBe(false);
      expect(existsSync(path.join(packageDir, ".next", "standalone", "README.md"))).toBe(false);
      expect(existsSync(path.join(packageDir, ".next", "standalone", "docs", "desktop-installers.md"))).toBe(true);
      expect(existsSync(path.join(packageDir, "desktop", "main.mjs"))).toBe(true);
      expect(existsSync(path.join(packageDir, "desktop", "preload.cjs"))).toBe(true);
      for (const scriptName of DESKTOP_PACKAGE_SCRIPT_INPUTS) {
        expect(existsSync(path.join(packageDir, "scripts", scriptName))).toBe(true);
        if (shouldMarkDesktopPackageScriptExecutable(scriptName)) {
          expect(statSync(path.join(packageDir, "scripts", scriptName)).mode & 0o111).not.toBe(0);
        }
      }
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
          extraResources: [{
            from: ".next/standalone/node_modules",
            to: "app.asar.unpacked/.next/standalone/node_modules",
            filter: ["**/*"],
          }],
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

  it("filters local state and agent worktrees from the standalone payload", () => {
    const root = path.join("/tmp", "standalone");

    expect(shouldCopyStandalonePackagePath(path.join(root, "server.js"), root)).toBe(true);
    expect(shouldCopyStandalonePackagePath(path.join(root, ".local", "private-docs", "plan.md"), root)).toBe(false);
    expect(shouldCopyStandalonePackagePath(path.join(root, ".worktrees", "branch", "file"), root)).toBe(false);
    expect(shouldCopyStandalonePackagePath(path.join(root, ".git", "HEAD"), root)).toBe(false);
    expect(shouldCopyStandalonePackagePath(path.join(root, ".github", "pull_request_template.md"), root)).toBe(false);
    expect(shouldCopyStandalonePackagePath(path.join(root, ".env"), root)).toBe(false);
    expect(shouldCopyStandalonePackagePath(path.join(root, "CHAT_TIMING_ANALYSIS.md"), root)).toBe(false);
    expect(shouldCopyStandalonePackagePath(path.join(root, "README.md"), root)).toBe(false);
    expect(shouldCopyStandalonePackagePath(path.join(root, "docs", "desktop-installers.md"), root)).toBe(true);
    expect(shouldCopyStandalonePackagePath(path.join(root, "desktop", "model.gguf"), root)).toBe(false);
  });

  it("filters nested dependency bin shims from manually staged runtime dependencies", () => {
    const root = path.join("/tmp", "node_modules", "gbrain");

    expect(shouldCopyRuntimeDependencyPath(path.join(root, "package.json"), root)).toBe(true);
    expect(shouldCopyRuntimeDependencyPath(path.join(root, "node_modules", "openai", "package.json"), root)).toBe(true);
    expect(shouldCopyRuntimeDependencyPath(path.join(root, "node_modules", ".bin"), root)).toBe(false);
    expect(shouldCopyRuntimeDependencyPath(path.join(root, "node_modules", ".bin", "openai"), root)).toBe(false);
  });

  it("marks only packaged shell scripts as executable", () => {
    expect(shouldMarkDesktopPackageScriptExecutable("install-runtime-prereqs.sh")).toBe(true);
    expect(shouldMarkDesktopPackageScriptExecutable("install-desktop-runtime-prereqs.sh")).toBe(true);
    expect(shouldMarkDesktopPackageScriptExecutable("start-standalone.mjs")).toBe(false);
  });
});
