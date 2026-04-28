#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

export const DEFAULT_INSTALLER_ARTIFACT_SUFFIXES = [
  ".dmg",
  ".dmg.blockmap",
  ".exe",
  ".exe.blockmap",
  ".AppImage",
  ".AppImage.zsync",
];

export function normalizeChecksumPath(filePath) {
  return filePath.split(path.sep).join("/");
}

export function isInstallerArtifactPath(filePath) {
  const basename = path.basename(filePath);
  return DEFAULT_INSTALLER_ARTIFACT_SUFFIXES.some((suffix) => basename.endsWith(suffix));
}

export function collectInstallerArtifactFiles(distDir) {
  if (!existsSync(distDir)) {
    throw new Error(`Desktop installer output directory does not exist: ${distDir}`);
  }

  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(entryPath);
        continue;
      }
      if (entry.isFile() && isInstallerArtifactPath(entryPath)) {
        files.push(entryPath);
      }
    }
  };

  walk(distDir);
  return files.sort((left, right) =>
    normalizeChecksumPath(path.relative(distDir, left)).localeCompare(
      normalizeChecksumPath(path.relative(distDir, right)),
    ));
}

export function sha256File(filePath) {
  const hash = createHash("sha256");
  hash.update(readFileSync(filePath));
  return hash.digest("hex");
}

export function createChecksumManifest(files, distDir) {
  if (files.length === 0) {
    throw new Error(`No desktop installer artifacts found in ${distDir}.`);
  }

  return `${files.map((filePath) => {
    const relativePath = normalizeChecksumPath(path.relative(distDir, filePath));
    return `${sha256File(filePath)}  ${relativePath}`;
  }).join("\n")}\n`;
}

export function writeArtifactChecksums(options = {}) {
  const distDir = path.resolve(options.root ?? projectRoot, options.distDir ?? "dist");
  const outputFile = path.resolve(
    options.root ?? projectRoot,
    options.outputFile ?? path.join("dist", "SHA256SUMS.txt"),
  );
  const artifactFiles = collectInstallerArtifactFiles(distDir);
  const manifest = createChecksumManifest(artifactFiles, distDir);

  mkdirSync(path.dirname(outputFile), { recursive: true });
  writeFileSync(outputFile, manifest);

  return {
    artifactCount: artifactFiles.length,
    outputFile,
    sizeBytes: statSync(outputFile).size,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const distDir = process.argv[2] || process.env.SCIENCESWARM_DESKTOP_DIST_DIR || "dist";
  const result = writeArtifactChecksums({ distDir });
  console.log(
    `Wrote ${result.artifactCount} desktop installer checksums to ${result.outputFile}`,
  );
}
