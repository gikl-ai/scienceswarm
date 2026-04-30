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
    expect(workflow).toMatch(/^permissions:\n\s+contents: read$/m);
    expect(workflow).toContain("contents: write");
    expect(workflow.indexOf("contents: write")).toBeGreaterThan(
      workflow.indexOf("jobs:\n  package:"),
    );
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

  it("publishes installer assets to a draft GitHub Release on version tags", () => {
    const releaseStep = workflowTailFrom("name: Upload installer asset to GitHub Release");
    expect(releaseStep).toContain("startsWith(github.ref, 'refs/tags/v')");
    expect(releaseStep).toContain("GH_TOKEN: ${{ github.token }}");
    expect(releaseStep).toContain(
      "SCIENCESWARM_ALLOW_PUBLISHED_RELEASE_UPLOADS: ${{ vars.SCIENCESWARM_ALLOW_PUBLISHED_RELEASE_UPLOADS || '0' }}",
    );
    expect(releaseStep).toContain('gh release view "$tag" --json isDraft');
    expect(releaseStep).toContain('gh release create "$tag"');
    expect(releaseStep).toContain("--verify-tag");
    expect(releaseStep).toContain("--draft");
    expect(releaseStep).toContain("Draft release already exists");
    expect(releaseStep).toContain("SCIENCESWARM_ALLOW_PUBLISHED_RELEASE_UPLOADS=1");
    expect(releaseStep).toContain(
      'checksum_asset="dist/SHA256SUMS-${SCIENCESWARM_DESKTOP_ARTIFACT_PLATFORM}.txt"',
    );
    expect(releaseStep).toContain('cp dist/SHA256SUMS.txt "$checksum_asset"');
    expect(releaseStep).toContain('gh release upload "$tag" "${assets[@]}" --clobber');
    const assetsBlock = releaseStep.match(/assets=\(\n(?<block>[\s\S]*?)\n\s*\)/)?.groups?.block;
    expect(assetsBlock, "missing release upload assets array").toBeDefined();
    expect(assetsBlock).toContain('"$checksum_asset"');
    expect(assetsBlock).not.toContain("dist/SHA256SUMS.txt");
    expect(releaseStep).toContain("dist/*.dmg");
    expect(releaseStep).toContain("dist/*.exe");
    expect(releaseStep).toContain("dist/*.AppImage");
  });
});
