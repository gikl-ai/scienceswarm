#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_INSTALLER_ARTIFACT_SUFFIXES,
  isInstallerArtifactPath,
  normalizeChecksumPath,
  resolveChecksumCliDistDir,
  resolveProjectChecksumDistDir,
  sha256File,
} from "./write-artifact-checksums.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

export const PRIMARY_INSTALLER_ARTIFACT_SUFFIXES = [".dmg", ".exe", ".AppImage"];
export const DESKTOP_PLATFORM_INSTALLER_SUFFIXES = {
  linux: [".AppImage"],
  macos: [".dmg"],
  windows: [".exe"],
};

export function parseChecksumManifest(manifest) {
  return manifest
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^([a-fA-F0-9]{64})\s{2}(.+)$/);
      if (!match) {
        throw new Error(`Invalid checksum manifest line: ${line}`);
      }
      return {
        sha256: match[1].toLowerCase(),
        relativePath: normalizeChecksumPath(match[2]),
      };
    });
}

export { sha256File };

export function isPrimaryInstallerArtifactPath(filePath) {
  const basename = path.basename(filePath);
  return PRIMARY_INSTALLER_ARTIFACT_SUFFIXES.some((suffix) => basename.endsWith(suffix));
}

export function normalizeDesktopArtifactPlatform(platform) {
  const normalized = platform?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "mac" || normalized === "darwin") {
    return "macos";
  }
  if (normalized === "win" || normalized === "win32") {
    return "windows";
  }
  if (normalized in DESKTOP_PLATFORM_INSTALLER_SUFFIXES) {
    return normalized;
  }

  throw new Error(`Unsupported desktop artifact platform: ${platform}`);
}

export function isInstallerArtifactForPlatform(filePath, platform) {
  const normalizedPlatform = normalizeDesktopArtifactPlatform(platform);
  if (!normalizedPlatform) {
    return false;
  }

  const basename = path.basename(filePath);
  return DESKTOP_PLATFORM_INSTALLER_SUFFIXES[normalizedPlatform]
    .some((suffix) => basename.endsWith(suffix));
}

export function resolveDesktopArtifactManifestPath(distDir) {
  return path.join(distDir, "SHA256SUMS.txt");
}

export async function verifyDesktopArtifacts(options = {}) {
  const distDir = path.resolve(options.root ?? projectRoot, options.distDir ?? "dist");
  const manifestPath = options.manifestPath
    ? path.resolve(options.root ?? projectRoot, options.manifestPath)
    : resolveDesktopArtifactManifestPath(distDir);

  if (!existsSync(distDir)) {
    throw new Error(`Desktop installer output directory does not exist: ${distDir}`);
  }
  if (!existsSync(manifestPath)) {
    throw new Error(`Desktop installer checksum manifest does not exist: ${manifestPath}`);
  }

  const entries = parseChecksumManifest(readFileSync(manifestPath, "utf-8"));
  if (entries.length === 0) {
    throw new Error(`Desktop installer checksum manifest is empty: ${manifestPath}`);
  }

  const expectedPlatform = normalizeDesktopArtifactPlatform(options.expectedPlatform);
  let primaryArtifactCount = 0;
  let expectedPlatformArtifactCount = 0;
  for (const entry of entries) {
    const pathSegments = entry.relativePath.split("/");
    if (
      path.isAbsolute(entry.relativePath)
      || /^[A-Za-z]:/.test(entry.relativePath)
      || entry.relativePath.includes("\\")
      || pathSegments.includes("..")
    ) {
      throw new Error(`Unsafe checksum manifest path: ${entry.relativePath}`);
    }

    if (!isInstallerArtifactPath(entry.relativePath)) {
      throw new Error(`Checksum manifest contains a non-installer artifact: ${entry.relativePath}`);
    }

    const artifactPath = path.join(distDir, entry.relativePath);
    if (!existsSync(artifactPath)) {
      throw new Error(`Checksum manifest references a missing artifact: ${entry.relativePath}`);
    }

    const actualSha256 = await sha256File(artifactPath);
    if (actualSha256 !== entry.sha256) {
      throw new Error(`Checksum mismatch for ${entry.relativePath}`);
    }

    const isPrimaryArtifact = isPrimaryInstallerArtifactPath(entry.relativePath);
    if (isPrimaryArtifact) {
      primaryArtifactCount += 1;
      if (expectedPlatform && !isInstallerArtifactForPlatform(entry.relativePath, expectedPlatform)) {
        throw new Error(
          `Unexpected desktop installer artifact for ${expectedPlatform}: ${entry.relativePath}`,
        );
      }
      if (expectedPlatform) {
        expectedPlatformArtifactCount += 1;
      }
    }
  }

  if (primaryArtifactCount === 0) {
    throw new Error("No primary desktop installer artifact was listed in SHA256SUMS.txt.");
  }

  return {
    artifactCount: entries.length,
    expectedPlatform,
    expectedPlatformArtifactCount,
    manifestPath,
    primaryArtifactCount,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const distDir = process.argv[2]
    ? resolveChecksumCliDistDir(process.argv[2])
    : resolveProjectChecksumDistDir(process.env.SCIENCESWARM_DESKTOP_DIST_DIR || "dist");
  const result = await verifyDesktopArtifacts({
    distDir,
    expectedPlatform: process.env.SCIENCESWARM_DESKTOP_ARTIFACT_PLATFORM,
  });
  console.log(
    `Verified ${result.artifactCount} desktop installer artifacts from ${result.manifestPath}`,
  );
}
