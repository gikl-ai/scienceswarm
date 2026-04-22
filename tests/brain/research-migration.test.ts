import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  applyResearchLayoutBridge,
  previewResearchLayoutMigration,
} from "@/brain/research-migration";

let root: string;

describe("research layout migration", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "scienceswarm-research-layout-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("groups legacy homes under canonical research-first bridges and flags unmapped homes", () => {
    mkdirSync(join(root, "concepts"), { recursive: true });
    mkdirSync(join(root, "wiki", "entities", "papers"), { recursive: true });
    mkdirSync(join(root, "wiki", "protocols"), { recursive: true });
    mkdirSync(join(root, "wiki", "experiments"), { recursive: true });
    mkdirSync(join(root, "topics"), { recursive: true });

    writeFileSync(join(root, "concepts", "rlhf.md"), "# RLHF\n", "utf-8");
    writeFileSync(join(root, "wiki", "entities", "papers", "paper-a.md"), "# Paper A\n", "utf-8");
    writeFileSync(join(root, "wiki", "protocols", "assay.md"), "# Assay\n", "utf-8");
    writeFileSync(join(root, "wiki", "experiments", "run-1.md"), "# Run 1\n", "utf-8");

    const preview = previewResearchLayoutMigration(root);

    expect(preview).toMatchObject({
      legacyHomesDetected: 4,
      legacyPagesDetected: 4,
      bridgeableHomes: 3,
    });
    expect(preview.homes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          canonicalHome: "methods",
          legacyPageCount: 1,
          proposedAction: "create_readme",
        }),
        expect.objectContaining({
          canonicalHome: "papers",
          legacyPageCount: 1,
          proposedAction: "create_readme",
        }),
        expect.objectContaining({
          canonicalHome: "topics",
          legacyPageCount: 1,
          canonicalHomeExists: true,
          proposedAction: "create_readme",
        }),
      ]),
    );
    expect(preview.unmappedLegacyHomes).toEqual([
      expect.objectContaining({
        legacyHome: "wiki/experiments",
        pageCount: 1,
      }),
    ]);
    expect(preview.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("topics/ already exists"),
        expect.stringContaining("wiki/experiments has no first-class research-first bridge yet"),
      ]),
    );
  });

  it("creates missing README bridges without overwriting existing canonical READMEs", () => {
    mkdirSync(join(root, "concepts"), { recursive: true });
    mkdirSync(join(root, "wiki", "entities", "papers"), { recursive: true });
    mkdirSync(join(root, "papers"), { recursive: true });

    writeFileSync(join(root, "concepts", "rlhf.md"), "# RLHF\n", "utf-8");
    writeFileSync(join(root, "wiki", "entities", "papers", "paper-a.md"), "# Paper A\n", "utf-8");
    writeFileSync(join(root, "papers", "README.md"), "existing README\n", "utf-8");

    const preview = previewResearchLayoutMigration(root);
    const result = applyResearchLayoutBridge(root, preview);

    expect(result.createdPaths).toContain("topics/README.md");
    expect(result.skippedPaths).toContain("papers/README.md");
    expect(result.createdReadmes).toBe(1);
    expect(existsSync(join(root, "topics", "README.md"))).toBe(true);
    expect(readFileSync(join(root, "papers", "README.md"), "utf-8")).toBe("existing README\n");
    expect(readFileSync(join(root, "topics", "README.md"), "utf-8")).toContain(
      "No files were moved.",
    );
    expect(readFileSync(join(root, "topics", "README.md"), "utf-8")).toContain(
      "Use `topics/` for new research-first pages.",
    );
  });
});
