import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ROOT = join(tmpdir(), "scienceswarm-legacy-import-repair");
const ORIGINAL_SCIENCESWARM_DIR = process.env.SCIENCESWARM_DIR;

function writeLegacyImportPage(input: {
  legacyBrainRoot?: string;
  legacySlug: string;
  fileName: string;
  relativePath: string;
  content: string;
}) {
  const directory = join(
    input.legacyBrainRoot ?? join(ROOT, "brain"),
    "wiki",
    "entities",
    "artifacts",
    "imports",
    input.legacySlug,
  );
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, input.fileName),
    [
      "---",
      "date: 2026-04-12",
      `title: ${JSON.stringify(input.fileName.replace(/-[a-f0-9]+\.md$/, ".py"))}`,
      "type: artifact",
      "para: resources",
      'tags: ["import","code"]',
      `project: ${JSON.stringify(input.legacySlug)}`,
      `source_refs: [{"kind":"import","ref":${JSON.stringify(input.relativePath)},"hash":"hash-${input.fileName}"}]`,
      "status: active",
      'import_classification: "code"',
      'format: "py"',
      "---",
      "",
      `# ${input.fileName}`,
      "",
      "## Imported Content",
      "",
      input.content,
      "",
    ].join("\n"),
    "utf-8",
  );
}

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  process.env.SCIENCESWARM_DIR = ROOT;
});

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  if (ORIGINAL_SCIENCESWARM_DIR !== undefined) {
    process.env.SCIENCESWARM_DIR = ORIGINAL_SCIENCESWARM_DIR;
  } else {
    delete process.env.SCIENCESWARM_DIR;
  }
  vi.resetModules();
  vi.doUnmock("@/lib/import/commit-import");
});

describe("legacy-import-repair", () => {
  it("repairs a normalized-slug legacy import into the canonical project root", async () => {
    const canonicalSlug = "project-alpha";
    const legacySlug = "projectalpha";
    const projectRoot = join(ROOT, "projects", canonicalSlug);

    mkdirSync(join(projectRoot, "code", "tests"), { recursive: true });
    mkdirSync(join(projectRoot, ".brain", "state"), { recursive: true });
    writeFileSync(join(projectRoot, "project.json"), JSON.stringify({ name: "Project Alpha" }), "utf-8");

    mkdirSync(join(ROOT, "brain", "state", "projects", legacySlug), { recursive: true });
    writeFileSync(
      join(ROOT, "brain", "state", "projects", legacySlug, "import-summary.json"),
      JSON.stringify({
        project: legacySlug,
        lastImport: {
          name: "Project Alpha",
          preparedFiles: 2,
          detectedItems: 2,
          detectedBytes: 128,
          duplicateGroups: 0,
          generatedAt: "2026-04-12T00:00:00.000Z",
          source: "background-local-import",
        },
      }, null, 2),
      "utf-8",
    );

    writeLegacyImportPage({
      legacySlug,
      fileName: "code-main.py-a1b2c3d4.md",
      relativePath: "code/main.py",
      content: "print('hello from repair')",
    });
    writeLegacyImportPage({
      legacySlug,
      fileName: "docs-notes.py-b2c3d4e5.md",
      relativePath: "docs/notes.md",
      content: "# Notes\n\nRecovered locally.\n",
    });

    const { repairLegacyImportedProject } = await import("@/lib/state/legacy-import-repair");
    const result = await repairLegacyImportedProject(canonicalSlug);

    expect(result).toMatchObject({
      project: canonicalSlug,
      legacyProject: legacySlug,
      importedPages: 2,
      recoveredWorkspaceFiles: 2,
      skippedWorkspaceFiles: 0,
    });

    expect(readFileSync(join(projectRoot, "code", "main.py"), "utf-8")).toContain("hello from repair");
    expect(readFileSync(join(projectRoot, "docs", "notes.md"), "utf-8")).toContain("Recovered locally");

    const canonicalImportSummaryPath = join(projectRoot, ".brain", "state", "import-summary.json");
    expect(existsSync(canonicalImportSummaryPath)).toBe(true);
    expect(readFileSync(canonicalImportSummaryPath, "utf-8")).toContain('"source": "legacy-import-repair"');
    expect(readFileSync(canonicalImportSummaryPath, "utf-8")).toContain('"preparedFiles": 2');

    const canonicalImportPage = join(
      projectRoot,
      ".brain",
      "wiki",
      "entities",
      "artifacts",
      "imports",
      canonicalSlug,
      "code-main.py-a1b2c3d4.md",
    );
    expect(existsSync(canonicalImportPage)).toBe(true);
    expect(readFileSync(canonicalImportPage, "utf-8")).toContain(`project: ${canonicalSlug}`);
  });

  it("does nothing when the canonical workspace already has visible files", async () => {
    const canonicalSlug = "project-alpha";
    const legacySlug = "projectalpha";
    const projectRoot = join(ROOT, "projects", canonicalSlug);

    mkdirSync(join(projectRoot, "code"), { recursive: true });
    writeFileSync(join(projectRoot, "code", "existing.py"), "print('canonical')", "utf-8");

    mkdirSync(join(ROOT, "brain", "state", "projects", legacySlug), { recursive: true });
    writeFileSync(
      join(ROOT, "brain", "state", "projects", legacySlug, "import-summary.json"),
      JSON.stringify({
        project: legacySlug,
        lastImport: {
          name: "Project Alpha",
          preparedFiles: 1,
          generatedAt: "2026-04-12T00:00:00.000Z",
          source: "background-local-import",
        },
      }, null, 2),
      "utf-8",
    );
    writeLegacyImportPage({
      legacySlug,
      fileName: "code-main.py-a1b2c3d4.md",
      relativePath: "code/main.py",
      content: "print('legacy')",
    });

    const { repairLegacyImportedProject } = await import("@/lib/state/legacy-import-repair");
    const result = await repairLegacyImportedProject(canonicalSlug);

    expect(result).toBeNull();
    expect(readFileSync(join(projectRoot, "code", "existing.py"), "utf-8")).toContain("canonical");
    expect(existsSync(join(projectRoot, "code", "main.py"))).toBe(false);
  });

  it("treats nested project.json files as visible workspace content", async () => {
    const canonicalSlug = "project-alpha";
    const legacySlug = "projectalpha";
    const projectRoot = join(ROOT, "projects", canonicalSlug);

    mkdirSync(join(projectRoot, "code"), { recursive: true });
    writeFileSync(join(projectRoot, "project.json"), JSON.stringify({ name: "Project Alpha" }), "utf-8");
    writeFileSync(join(projectRoot, "code", "project.json"), JSON.stringify({ nested: true }), "utf-8");

    mkdirSync(join(ROOT, "brain", "state", "projects", legacySlug), { recursive: true });
    writeFileSync(
      join(ROOT, "brain", "state", "projects", legacySlug, "import-summary.json"),
      JSON.stringify({
        project: legacySlug,
        lastImport: {
          name: "Project Alpha",
          preparedFiles: 1,
          generatedAt: "2026-04-12T00:00:00.000Z",
          source: "background-local-import",
        },
      }, null, 2),
      "utf-8",
    );
    writeLegacyImportPage({
      legacySlug,
      fileName: "code-main.py-a1b2c3d4.md",
      relativePath: "code/main.py",
      content: "print('legacy')",
    });

    const { repairLegacyImportedProject } = await import("@/lib/state/legacy-import-repair");
    const result = await repairLegacyImportedProject(canonicalSlug);

    expect(result).toBeNull();
    expect(readFileSync(join(projectRoot, "code", "project.json"), "utf-8")).toContain('"nested":true');
    expect(existsSync(join(projectRoot, "code", "main.py"))).toBe(false);
  });

  it("writes repaired state into explicit custom roots", async () => {
    const canonicalSlug = "project-alpha";
    const legacySlug = "projectalpha";
    const customProjectsRoot = join(ROOT, "custom-projects");
    const customLegacyBrainRoot = join(ROOT, "custom-brain");
    const projectRoot = join(customProjectsRoot, canonicalSlug);

    mkdirSync(join(projectRoot, ".brain", "state"), { recursive: true });
    writeFileSync(join(projectRoot, "project.json"), JSON.stringify({ name: "Project Alpha" }), "utf-8");

    mkdirSync(join(customLegacyBrainRoot, "state", "projects", legacySlug), { recursive: true });
    writeFileSync(
      join(customLegacyBrainRoot, "state", "projects", legacySlug, "import-summary.json"),
      JSON.stringify({
        project: legacySlug,
        lastImport: {
          name: "Project Alpha",
          preparedFiles: 1,
          detectedItems: 1,
          generatedAt: "2026-04-12T00:00:00.000Z",
          source: "background-local-import",
        },
      }, null, 2),
      "utf-8",
    );
    writeLegacyImportPage({
      legacyBrainRoot: customLegacyBrainRoot,
      legacySlug,
      fileName: "code-main.py-a1b2c3d4.md",
      relativePath: "code/main.py",
      content: "print('custom root repair')",
    });

    const { repairLegacyImportedProject } = await import("@/lib/state/legacy-import-repair");
    const result = await repairLegacyImportedProject(canonicalSlug, {
      projectsRoot: customProjectsRoot,
      legacyBrainRoot: customLegacyBrainRoot,
    });

    expect(result).toMatchObject({
      project: canonicalSlug,
      legacyProject: legacySlug,
      importedPages: 1,
      recoveredWorkspaceFiles: 1,
    });
    expect(readFileSync(join(projectRoot, "code", "main.py"), "utf-8")).toContain("custom root repair");
    expect(existsSync(join(projectRoot, ".brain", "state", "import-summary.json"))).toBe(true);
    expect(existsSync(join(projectRoot, ".brain", "state", "manifest.json"))).toBe(true);
  });

  it("retries a partial repair after finalize fails instead of getting stuck behind restored files", async () => {
    const canonicalSlug = "project-alpha";
    const legacySlug = "projectalpha";
    const projectRoot = join(ROOT, "projects", canonicalSlug);
    const finalizeImportedProject = vi.fn()
      .mockRejectedValueOnce(new Error("finalize failed"))
      .mockResolvedValue(undefined);

    vi.doMock("@/lib/import/commit-import", async () => {
      const actual = await vi.importActual<typeof import("@/lib/import/commit-import")>(
        "@/lib/import/commit-import",
      );
      return {
        ...actual,
        finalizeImportedProject,
      };
    });

    mkdirSync(join(projectRoot, ".brain", "state"), { recursive: true });
    writeFileSync(join(projectRoot, "project.json"), JSON.stringify({ name: "Project Alpha" }), "utf-8");

    mkdirSync(join(ROOT, "brain", "state", "projects", legacySlug), { recursive: true });
    writeFileSync(
      join(ROOT, "brain", "state", "projects", legacySlug, "import-summary.json"),
      JSON.stringify({
        project: legacySlug,
        lastImport: {
          name: "Project Alpha",
          preparedFiles: 1,
          detectedItems: 1,
          generatedAt: "2026-04-12T00:00:00.000Z",
          source: "background-local-import",
        },
      }, null, 2),
      "utf-8",
    );
    writeLegacyImportPage({
      legacySlug,
      fileName: "code-main.py-a1b2c3d4.md",
      relativePath: "code/main.py",
      content: "print('retry me')",
    });

    const { repairLegacyImportedProject } = await import("@/lib/state/legacy-import-repair");

    await expect(repairLegacyImportedProject(canonicalSlug)).rejects.toThrow("finalize failed");
    expect(readFileSync(join(projectRoot, "code", "main.py"), "utf-8")).toContain("retry me");

    const secondAttempt = await repairLegacyImportedProject(canonicalSlug);

    expect(secondAttempt).toMatchObject({
      project: canonicalSlug,
      legacyProject: legacySlug,
      recoveredWorkspaceFiles: 1,
    });
    expect(finalizeImportedProject).toHaveBeenCalledTimes(2);
  });
});
