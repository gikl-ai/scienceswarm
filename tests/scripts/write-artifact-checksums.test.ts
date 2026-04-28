import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  collectInstallerArtifactFiles,
  createChecksumManifest,
  isInstallerArtifactPath,
  normalizeChecksumPath,
  resolveChecksumCliDistDir,
  sha256File,
  writeArtifactChecksums,
} from "../../scripts/write-artifact-checksums.mjs";

describe("write-artifact-checksums", () => {
  it("collects installer artifacts and ignores unpacked app outputs", () => {
    const root = path.join(tmpdir(), `scienceswarm-checksums-${Date.now()}`);
    const dist = path.join(root, "dist");
    try {
      mkdirSync(path.join(dist, "mac", "ScienceSwarm.app"), { recursive: true });
      writeFileSync(path.join(dist, "ScienceSwarm-0.1.0.dmg"), "dmg");
      writeFileSync(path.join(dist, "ScienceSwarm-0.1.0.dmg.blockmap"), "blockmap");
      writeFileSync(path.join(dist, "ScienceSwarm-0.1.0.exe"), "exe");
      writeFileSync(path.join(dist, "ScienceSwarm-0.1.0.AppImage"), "appimage");
      writeFileSync(path.join(dist, "latest-mac.yml"), "metadata");
      writeFileSync(path.join(dist, "mac", "ScienceSwarm.app", "Info.plist"), "plist");

      expect(collectInstallerArtifactFiles(dist).map((filePath) =>
        normalizeChecksumPath(path.relative(dist, filePath)),
      )).toEqual([
        "ScienceSwarm-0.1.0.AppImage",
        "ScienceSwarm-0.1.0.dmg",
        "ScienceSwarm-0.1.0.dmg.blockmap",
        "ScienceSwarm-0.1.0.exe",
      ]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("writes deterministic SHA-256 checksum manifests", async () => {
    const root = path.join(tmpdir(), `scienceswarm-checksums-${Date.now()}`);
    const dist = path.join(root, "dist");
    try {
      mkdirSync(dist, { recursive: true });
      const dmgPath = path.join(dist, "ScienceSwarm.dmg");
      const exePath = path.join(dist, "ScienceSwarm.exe");
      writeFileSync(dmgPath, "alpha");
      writeFileSync(exePath, "beta");

      const result = await writeArtifactChecksums({ root });
      const manifest = readFileSync(result.outputFile, "utf-8");

      expect(result.artifactCount).toBe(2);
      expect(manifest).toBe([
        `${await sha256File(dmgPath)}  ScienceSwarm.dmg`,
        `${await sha256File(exePath)}  ScienceSwarm.exe`,
        "",
      ].join("\n"));
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("fails clearly when no installer artifacts exist", async () => {
    const root = path.join(tmpdir(), `scienceswarm-checksums-${Date.now()}`);
    const dist = path.join(root, "dist");
    try {
      mkdirSync(dist, { recursive: true });
      writeFileSync(path.join(dist, "latest-linux.yml"), "metadata");

      await expect(writeArtifactChecksums({ root })).rejects.toThrow(
        "No desktop installer artifacts found",
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("identifies only installer artifact paths", () => {
    expect(isInstallerArtifactPath("ScienceSwarm.dmg")).toBe(true);
    expect(isInstallerArtifactPath("ScienceSwarm.dmg.blockmap")).toBe(true);
    expect(isInstallerArtifactPath("ScienceSwarm.exe")).toBe(true);
    expect(isInstallerArtifactPath("ScienceSwarm.AppImage.zsync")).toBe(true);
    expect(isInstallerArtifactPath("latest-linux.yml")).toBe(false);
    expect(isInstallerArtifactPath("ScienceSwarm.app/Contents/Info.plist")).toBe(false);
  });

  it("formats checksum paths with forward slashes", () => {
    expect(normalizeChecksumPath(["nested", "ScienceSwarm.dmg"].join(path.sep))).toBe(
      "nested/ScienceSwarm.dmg",
    );
  });

  it("resolves direct CLI dist paths relative to the caller cwd", () => {
    expect(resolveChecksumCliDistDir("../other-dist", "/tmp/scienceswarm")).toBe(
      path.resolve("/tmp/scienceswarm", "../other-dist"),
    );
    expect(resolveChecksumCliDistDir("/tmp/absolute-dist", "/tmp/scienceswarm")).toBe(
      "/tmp/absolute-dist",
    );
  });

  it("builds a manifest from an explicit file list", async () => {
    const root = path.join(tmpdir(), `scienceswarm-checksums-${Date.now()}`);
    try {
      const artifactPath = path.join(root, "dist", "ScienceSwarm.dmg");
      mkdirSync(path.dirname(artifactPath), { recursive: true });
      writeFileSync(artifactPath, "payload");

      await expect(createChecksumManifest([artifactPath], path.join(root, "dist"))).resolves.toBe(
        `${await sha256File(artifactPath)}  ScienceSwarm.dmg\n`,
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
