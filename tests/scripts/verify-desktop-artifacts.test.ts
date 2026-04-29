import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  isInstallerArtifactForPlatform,
  normalizeDesktopArtifactPlatform,
  parseChecksumManifest,
  verifyDesktopArtifacts,
} from "../../scripts/verify-desktop-artifacts.mjs";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function writeArtifact(distDir: string, relativePath: string, content: string): string {
  const artifactPath = path.join(distDir, relativePath);
  mkdirSync(path.dirname(artifactPath), { recursive: true });
  writeFileSync(artifactPath, content);
  return artifactPath;
}

describe("verify-desktop-artifacts", () => {
  it("verifies installer artifacts against SHA256SUMS.txt", async () => {
    const root = path.join(tmpdir(), `scienceswarm-verify-artifacts-${Date.now()}`);
    const distDir = path.join(root, "dist");
    try {
      mkdirSync(distDir, { recursive: true });
      writeArtifact(distDir, "ScienceSwarm-0.1.0-linux-x64.AppImage", "appimage");
      writeArtifact(distDir, "ScienceSwarm-0.1.0-linux-x64.AppImage.zsync", "zsync");
      writeFileSync(
        path.join(distDir, "SHA256SUMS.txt"),
        [
          `${sha256("appimage")}  ScienceSwarm-0.1.0-linux-x64.AppImage`,
          `${sha256("zsync")}  ScienceSwarm-0.1.0-linux-x64.AppImage.zsync`,
          "",
        ].join("\n"),
      );

      await expect(verifyDesktopArtifacts({ root })).resolves.toMatchObject({
        artifactCount: 2,
        primaryArtifactCount: 1,
      });
      await expect(verifyDesktopArtifacts({
        expectedPlatform: "linux",
        root,
      })).resolves.toMatchObject({
        expectedPlatform: "linux",
        expectedPlatformArtifactCount: 1,
      });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("rejects primary installer artifacts for the wrong platform", async () => {
    const root = path.join(tmpdir(), `scienceswarm-verify-artifacts-${Date.now()}`);
    const distDir = path.join(root, "dist");
    try {
      mkdirSync(distDir, { recursive: true });
      writeArtifact(distDir, "ScienceSwarm-0.1.0-mac-arm64.dmg", "dmg");
      writeFileSync(
        path.join(distDir, "SHA256SUMS.txt"),
        `${sha256("dmg")}  ScienceSwarm-0.1.0-mac-arm64.dmg\n`,
      );

      await expect(verifyDesktopArtifacts({
        expectedPlatform: "linux",
        root,
      })).rejects.toThrow("Unexpected desktop installer artifact for linux");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("rejects checksum mismatches", async () => {
    const root = path.join(tmpdir(), `scienceswarm-verify-artifacts-${Date.now()}`);
    const distDir = path.join(root, "dist");
    try {
      mkdirSync(distDir, { recursive: true });
      writeArtifact(distDir, "ScienceSwarm-0.1.0-mac-arm64.dmg", "changed");
      writeFileSync(
        path.join(distDir, "SHA256SUMS.txt"),
        `${sha256("original")}  ScienceSwarm-0.1.0-mac-arm64.dmg\n`,
      );

      await expect(verifyDesktopArtifacts({ root })).rejects.toThrow(
        "Checksum mismatch",
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("rejects manifests without a primary installer", async () => {
    const root = path.join(tmpdir(), `scienceswarm-verify-artifacts-${Date.now()}`);
    const distDir = path.join(root, "dist");
    try {
      mkdirSync(distDir, { recursive: true });
      writeArtifact(distDir, "ScienceSwarm-0.1.0-windows-x64.exe.blockmap", "blockmap");
      writeFileSync(
        path.join(distDir, "SHA256SUMS.txt"),
        `${sha256("blockmap")}  ScienceSwarm-0.1.0-windows-x64.exe.blockmap\n`,
      );

      await expect(verifyDesktopArtifacts({ root })).rejects.toThrow(
        "No primary desktop installer artifact",
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("parses two-space checksum manifest entries", () => {
    expect(parseChecksumManifest(`${"a".repeat(64)}  installer.dmg\n`)).toEqual([
      {
        relativePath: "installer.dmg",
        sha256: "a".repeat(64),
      },
    ]);
    expect(() => parseChecksumManifest(`${"a".repeat(64)} installer.dmg\n`))
      .toThrow("Invalid checksum manifest line");
  });

  it("normalizes platform aliases for installer verification", () => {
    expect(normalizeDesktopArtifactPlatform("mac")).toBe("macos");
    expect(normalizeDesktopArtifactPlatform("win32")).toBe("windows");
    expect(normalizeDesktopArtifactPlatform("linux")).toBe("linux");
    expect(isInstallerArtifactForPlatform("ScienceSwarm.dmg", "darwin")).toBe(true);
    expect(isInstallerArtifactForPlatform("ScienceSwarm.exe", "windows")).toBe(true);
    expect(isInstallerArtifactForPlatform("ScienceSwarm.AppImage", "linux")).toBe(true);
    expect(isInstallerArtifactForPlatform("ScienceSwarm.dmg", "linux")).toBe(false);
    expect(() => normalizeDesktopArtifactPlatform("solaris")).toThrow(
      "Unsupported desktop artifact platform",
    );
  });
});
