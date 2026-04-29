import { readFileSync } from "node:fs";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

const workflowPath = path.join(process.cwd(), ".github", "workflows", "desktop-installers.yml");
let workflow = "";

beforeAll(() => {
  workflow = readFileSync(workflowPath, "utf8");
});

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matrixEntryBlock(name: string) {
  const pattern = new RegExp(
    `^\\s*- name: ${escapeRegex(name)}\\n(?<block>[\\s\\S]*?)(?=^\\s*- name:|^\\s*env:|^\\s*steps:)`,
    "m",
  );
  const match = workflow.match(pattern);
  expect(match?.groups?.block, `missing matrix entry for ${name}`).toBeDefined();
  return match?.groups?.block ?? "";
}

function expectWorkflowLine(block: string, line: string) {
  expect(block).toMatch(new RegExp(`^\\s*${escapeRegex(line)}$`, "m"));
}

function expectWorkflowOrder(lines: string[]) {
  let previousIndex = -1;
  for (const line of lines) {
    const index = workflow.indexOf(line);
    expect(index, `missing workflow line: ${line}`).toBeGreaterThanOrEqual(0);
    expect(index, `workflow line is out of order: ${line}`).toBeGreaterThan(previousIndex);
    previousIndex = index;
  }
}

function workflowTailFrom(line: string) {
  const index = workflow.indexOf(line);
  expect(index, `missing workflow section: ${line}`).toBeGreaterThanOrEqual(0);
  return workflow.slice(index);
}

function expectMatrixEntry(entry: {
  artifactName: string;
  artifactPlatform: string;
  artifactPaths: string[];
  name: string;
  os: string;
  packageScript: string;
}) {
  const block = matrixEntryBlock(entry.name);

  expectWorkflowLine(block, `os: ${entry.os}`);
  expectWorkflowLine(block, `package-script: ${entry.packageScript}`);
  expectWorkflowLine(block, `artifact-platform: ${entry.artifactPlatform}`);
  expectWorkflowLine(block, `artifact-name: ${entry.artifactName}`);
  expectWorkflowLine(block, "artifact-path: |");
  for (const artifactPath of entry.artifactPaths) {
    expectWorkflowLine(block, artifactPath);
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
    expect(workflow).toContain('CSC_IDENTITY_AUTO_DISCOVERY: "false"');
    expect(workflow).toContain("SCIENCESWARM_DESKTOP_ARTIFACT_PLATFORM: ${{ matrix.artifact-platform }}");
    expectWorkflowOrder([
      "run: npm run build:standalone",
      "run: npm run desktop:check-signing-env",
      "run: npm run ${{ matrix.package-script }}",
      "run: npm run desktop:checksums",
      "run: npm run desktop:verify-artifacts",
      "name: Upload installer artifact",
    ]);

    const uploadStep = workflowTailFrom("name: Upload installer artifact");
    expect(uploadStep).toContain("if-no-files-found: error");
    expect(uploadStep).toContain("retention-days: 14");
  });
});
