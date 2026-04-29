#!/usr/bin/env node

import { existsSync, lstatSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

export const REQUIRED_DESKTOP_PACKAGE_PATHS = [
  ".next/standalone/server.js",
  "desktop/main.mjs",
  "desktop/preload.cjs",
  "scripts/start-standalone.mjs",
  "scripts/install-runtime-prereqs.sh",
  "scripts/install-desktop-runtime-prereqs.sh",
  "package.json",
];
export const FORBIDDEN_DESKTOP_PACKAGE_SEGMENTS = new Set([
  ".claude",
  ".codex",
  ".gemini",
  ".git",
  ".github",
  ".local",
  ".worktrees",
  "blobs",
  "manifests",
  "ollama-models",
  "tests",
]);

export function resolveDesktopPackageDir(root = projectRoot, packageDir = ".desktop-package/app") {
  return path.resolve(root, packageDir);
}

function walkPackagePaths(packageDir) {
  if (!existsSync(packageDir)) {
    return [];
  }

  const entries = [];
  const pending = [packageDir];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) {
      continue;
    }

    entries.push(current);
    const stats = lstatSync(current);
    if (!stats.isDirectory()) {
      continue;
    }

    for (const entry of readdirSync(current)) {
      pending.push(path.join(current, entry));
    }
  }
  return entries;
}

export function isForbiddenDesktopPackagePath(filePath, packageDir) {
  const relativePath = path.relative(packageDir, filePath).split(path.sep).join("/");
  const segments = relativePath.split("/");
  const basename = segments.at(-1) ?? "";
  const standalonePrefix = ".next/standalone/";
  const standaloneRelativePath = relativePath.startsWith(standalonePrefix)
    ? relativePath.slice(standalonePrefix.length)
    : null;
  return (
    relativePath.endsWith(".gguf")
    || basename === ".env"
    || basename.startsWith(".env.")
    || (
      standaloneRelativePath != null
      && !standaloneRelativePath.includes("/")
      && standaloneRelativePath.endsWith(".md")
    )
    || segments.some((segment) => FORBIDDEN_DESKTOP_PACKAGE_SEGMENTS.has(segment))
  );
}

export function findDesktopPackageProblems(options = {}) {
  const packageDir = resolveDesktopPackageDir(options.root, options.packageDir);
  const problems = [];
  if (!existsSync(packageDir)) {
    return [`Desktop package directory does not exist: ${packageDir}`];
  }

  for (const requiredPath of REQUIRED_DESKTOP_PACKAGE_PATHS) {
    const absolutePath = path.join(packageDir, requiredPath);
    if (!existsSync(absolutePath)) {
      problems.push(`Missing required desktop package path: ${requiredPath}`);
    }
  }

  for (const entryPath of walkPackagePaths(packageDir)) {
    if (entryPath === packageDir) {
      continue;
    }
    if (isForbiddenDesktopPackagePath(entryPath, packageDir)) {
      problems.push(
        `Forbidden desktop package payload path: ${path.relative(packageDir, entryPath)}`,
      );
    }
  }

  return problems;
}

export function verifyDesktopPackage(options = {}) {
  const packageDir = resolveDesktopPackageDir(options.root, options.packageDir);
  const problems = findDesktopPackageProblems(options);
  if (problems.length > 0) {
    throw new Error(`Desktop package verification failed:\n- ${problems.join("\n- ")}`);
  }

  return {
    packageDir,
    requiredPathCount: REQUIRED_DESKTOP_PACKAGE_PATHS.length,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = verifyDesktopPackage({
    packageDir: process.env.SCIENCESWARM_DESKTOP_PACKAGE_DIR || ".desktop-package/app",
  });
  console.log(
    `Verified desktop package at ${result.packageDir} with ${result.requiredPathCount} required paths`,
  );
}
