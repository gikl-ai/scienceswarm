import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const workflowPath = path.join(process.cwd(), ".github", "workflows", "desktop-installers.yml");
const workflow = readFileSync(workflowPath, "utf8");

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function expectMatrixEntry(entry: {
  artifactName: string;
  artifactPlatform: string;
  artifactPaths: string[];
  name: string;
  os: string;
  packageScript: string;
}) {
  const headerPattern = new RegExp([
    `- name: ${escapeRegex(entry.name)}`,
    `\\s+os: ${escapeRegex(entry.os)}`,
    `\\s+package-script: ${escapeRegex(entry.packageScript)}`,
    `\\s+artifact-platform: ${escapeRegex(entry.artifactPlatform)}`,
    `\\s+artifact-name: ${escapeRegex(entry.artifactName)}`,
    "\\s+artifact-path: \\|",
  ].join(""));

  expect(workflow).toMatch(headerPattern);
  for (const artifactPath of entry.artifactPaths) {
    expect(workflow).toContain(`              ${artifactPath}`);
  }
}

describe("desktop installers workflow", () => {
  it("can be run manually or from version tags", () => {
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain('- "v*"');
  });

  it("packages and uploads every supported desktop platform", () => {
    expectMatrixEntry({
      artifactName: "scienceswarm-macos-dmg",
      artifactPaths: ["dist/*.dmg", "dist/*.dmg.blockmap", "dist/SHA256SUMS.txt"],
      artifactPlatform: "macos",
      name: "macOS DMG",
      os: "macos-latest",
      packageScript: "desktop:pack:mac",
    });
    expectMatrixEntry({
      artifactName: "scienceswarm-windows-nsis",
      artifactPaths: ["dist/*.exe", "dist/*.exe.blockmap", "dist/SHA256SUMS.txt"],
      artifactPlatform: "windows",
      name: "Windows NSIS",
      os: "windows-latest",
      packageScript: "desktop:pack:win",
    });
    expectMatrixEntry({
      artifactName: "scienceswarm-linux-appimage",
      artifactPaths: ["dist/*.AppImage", "dist/*.AppImage.zsync", "dist/SHA256SUMS.txt"],
      artifactPlatform: "linux",
      name: "Linux AppImage",
      os: "ubuntu-latest",
      packageScript: "desktop:pack:linux",
    });
  });

  it("runs the release smoke checks before upload", () => {
    expect(workflow).toContain("fail-fast: false");
    expect(workflow).toContain("SCIENCESWARM_DESKTOP_ARTIFACT_PLATFORM: ${{ matrix.artifact-platform }}");
    expect(workflow).toContain("run: npm run build:standalone");
    expect(workflow).toContain("run: npm run desktop:check-signing-env");
    expect(workflow).toContain("run: npm run ${{ matrix.package-script }}");
    expect(workflow).toContain("run: npm run desktop:checksums");
    expect(workflow).toContain("run: npm run desktop:verify-artifacts");
    expect(workflow).toContain("if-no-files-found: error");
    expect(workflow).toContain("retention-days: 14");
  });
});
