#!/usr/bin/env node

import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isForbiddenDesktopPackageRelativePath } from "./desktop-package-policy.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

export const DESKTOP_PACKAGE_APP_DIR = ".desktop-package/app";
export const DESKTOP_PACKAGE_SCRIPT_INPUTS = [
  "start-standalone.mjs",
  "install-runtime-prereqs.sh",
  "install-desktop-runtime-prereqs.sh",
];
export const DESKTOP_PACKAGE_RUNTIME_DEPENDENCIES = ["gbrain"];

export function shouldMarkDesktopPackageScriptExecutable(scriptName) {
  return scriptName.endsWith(".sh");
}

export function resolveDesktopPackageAppDir(root = projectRoot) {
  return path.join(root, DESKTOP_PACKAGE_APP_DIR);
}

export function createDesktopPackageManifest(rootPackage) {
  return {
    name: rootPackage.name,
    version: rootPackage.version,
    description: rootPackage.description,
    license: rootPackage.license,
    author: rootPackage.author,
    main: "desktop/main.mjs",
    build: createDesktopPackageBuildConfig(rootPackage.build),
  };
}

export function createDesktopPackageBuildConfig(rootBuild = {}) {
  const { directories = {}, ...buildConfig } = rootBuild;
  const { app: _app, ...safeDirectories } = directories;

  return {
    ...buildConfig,
    directories: {
      ...safeDirectories,
      buildResources: "../../desktop/build",
      output: "../../dist",
    },
  };
}

function copyTree(sourcePath, destinationPath, options = {}) {
  if (!existsSync(sourcePath)) {
    throw new Error(`Required desktop package input is missing: ${sourcePath}`);
  }

  mkdirSync(path.dirname(destinationPath), { recursive: true });
  cpSync(sourcePath, destinationPath, {
    recursive: true,
    force: true,
    filter: options.filter,
  });
}

export function shouldCopyRuntimeDependencyPath(sourcePath, dependencyRoot) {
  const relativePath = path.relative(dependencyRoot, sourcePath).split(path.sep).join("/");
  if (!relativePath || relativePath === ".") {
    return true;
  }
  return !(
    relativePath === "node_modules/.bin"
    || relativePath.startsWith("node_modules/.bin/")
    || relativePath.includes("/node_modules/.bin/")
  );
}

function stageRuntimeDependency(root, packageDir, packageName) {
  const sourcePath = path.join(root, "node_modules", packageName);
  const standaloneRoot = path.join(packageDir, ".next", "standalone");
  const dependencyRoot = sourcePath;
  const destinationPath = path.join(standaloneRoot, "node_modules", packageName);
  copyTree(sourcePath, destinationPath, {
    filter: (sourcePath) =>
      shouldCopyRuntimeDependencyPath(sourcePath, dependencyRoot)
      && shouldCopyStandalonePackagePath(sourcePath, standaloneRoot),
  });

  const packageJsonPath = path.join(destinationPath, "package.json");
  const dependencyPackage = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
  const binEntries = typeof dependencyPackage.bin === "string"
    ? { [packageName]: dependencyPackage.bin }
    : dependencyPackage.bin ?? {};
  const binDir = path.join(standaloneRoot, "node_modules", ".bin");
  mkdirSync(binDir, { recursive: true });
  for (const [binName, binTarget] of Object.entries(binEntries)) {
    if (typeof binTarget !== "string" || !binName) {
      continue;
    }
    const binPath = path.join(binDir, binName);
    rmSync(binPath, { force: true });
    writeFileSync(
      binPath,
      `#!/bin/sh\nexec "$(dirname "$0")/../${packageName}/${binTarget}" "$@"\n`,
    );
    chmodSync(binPath, 0o755);
  }
}

export function shouldCopyDesktopShellPath(sourcePath, desktopRoot) {
  const relativePath = path.relative(desktopRoot, sourcePath).split(path.sep).join("/");
  if (!relativePath || relativePath === ".") {
    return true;
  }

  return !(
    relativePath === "ollama-models"
    || relativePath.startsWith("ollama-models/")
    || relativePath.endsWith(".gguf")
    || relativePath.includes("/blobs/")
    || relativePath.includes("/manifests/")
  );
}

export function shouldCopyStandalonePackagePath(sourcePath, standaloneRoot) {
  const relativePath = path.relative(standaloneRoot, sourcePath).split(path.sep).join("/");
  if (!relativePath || relativePath === ".") {
    return true;
  }

  return !isForbiddenDesktopPackageRelativePath(relativePath, { standaloneRoot: true });
}

export function prepareDesktopPackage(root = projectRoot) {
  const packageDir = resolveDesktopPackageAppDir(root);
  const desktopRoot = path.join(root, "desktop");
  const rootPackagePath = path.join(root, "package.json");
  const rootPackage = JSON.parse(readFileSync(rootPackagePath, "utf-8"));

  rmSync(packageDir, { force: true, recursive: true });
  mkdirSync(packageDir, { recursive: true });

  copyTree(
    path.join(root, ".next", "standalone"),
    path.join(packageDir, ".next", "standalone"),
    {
      filter: (sourcePath) => shouldCopyStandalonePackagePath(
        sourcePath,
        path.join(root, ".next", "standalone"),
      ),
    },
  );
  copyTree(
    path.join(root, "package-lock.json"),
    path.join(packageDir, ".next", "standalone", "package-lock.json"),
  );
  copyTree(desktopRoot, path.join(packageDir, "desktop"), {
    filter: (sourcePath) => shouldCopyDesktopShellPath(sourcePath, desktopRoot),
  });
  for (const packageName of DESKTOP_PACKAGE_RUNTIME_DEPENDENCIES) {
    stageRuntimeDependency(root, packageDir, packageName);
  }
  for (const scriptName of DESKTOP_PACKAGE_SCRIPT_INPUTS) {
    const stagedScriptPath = path.join(packageDir, "scripts", scriptName);
    copyTree(
      path.join(root, "scripts", scriptName),
      stagedScriptPath,
    );
    if (shouldMarkDesktopPackageScriptExecutable(scriptName)) {
      chmodSync(stagedScriptPath, 0o755);
    }
  }

  writeFileSync(
    path.join(packageDir, "package.json"),
    `${JSON.stringify(createDesktopPackageManifest(rootPackage), null, 2)}\n`,
  );

  return { packageDir };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { packageDir } = prepareDesktopPackage();
  console.log(`Prepared desktop package app at ${packageDir}`);
}
