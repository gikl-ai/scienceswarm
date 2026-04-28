#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function copyStandaloneBuildDir(root, sourceRelativePath, targetRelativePath) {
  const sourcePath = path.join(root, sourceRelativePath);
  if (!existsSync(sourcePath)) {
    return null;
  }

  const targetPath = path.join(root, targetRelativePath);
  rmSync(targetPath, { force: true, recursive: true });
  mkdirSync(path.dirname(targetPath), { recursive: true });
  cpSync(sourcePath, targetPath, { recursive: true });
  return targetPath;
}

export function prepareStandaloneBuild(root = process.cwd()) {
  return {
    staticPath: copyStandaloneBuildDir(
      root,
      path.join(".next", "static"),
      path.join(".next", "standalone", ".next", "static"),
    ),
    publicPath: copyStandaloneBuildDir(
      root,
      "public",
      path.join(".next", "standalone", "public"),
    ),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareStandaloneBuild();
}
