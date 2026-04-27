import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();

async function readRepoFile(relativePath: string): Promise<string> {
  return readFile(path.join(repoRoot, relativePath), "utf-8");
}

async function collectMarkdownFiles(relativePath: string): Promise<string[]> {
  const absolutePath = path.join(repoRoot, relativePath);
  const entries = await readdir(absolutePath, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const childPath = path.join(relativePath, entry.name);
      if (entry.isDirectory()) return collectMarkdownFiles(childPath);
      return childPath.endsWith(".md") || entry.name === "SKILL.md"
        ? [childPath]
        : [];
    }),
  );
  return files.flat();
}

describe("Study ontology cutover guardrails", () => {
  it("keeps canonical study surfaces off legacy project routes and APIs", async () => {
    const canonicalSurfaceFiles = [
      "src/app/dashboard/page.tsx",
      "src/app/dashboard/study/page.tsx",
      "src/app/dashboard/reasoning/page.tsx",
      "src/components/research/study-list.tsx",
      "src/app/dashboard/routines/page.tsx",
      "src/app/dashboard/settings/page.tsx",
      "src/components/settings/frontier-watch-composer.tsx",
    ];

    for (const relativePath of canonicalSurfaceFiles) {
      const source = await readRepoFile(relativePath);
      expect(source, relativePath).not.toContain("/dashboard/project");
      expect(source, relativePath).not.toContain("/api/projects");
      expect(source, relativePath).not.toMatch(/\bProject\b/);
      expect(source, relativePath).not.toMatch(/\bproject (workspace|page|pages|chat|brief|evidence)\b/i);
      expect(source, relativePath).not.toMatch(/\bthis project\b/i);
    }
  });

  it("writes canonical Study frontmatter for new study-scoped pages", async () => {
    const canonicalWriters = [
      "src/lib/import/commit-import.ts",
      "src/brain/coldstart/writer.ts",
      "src/brain/compile-affected.ts",
      "src/lib/capture/materialize-memory.ts",
      "src/lib/state/project-manifests.ts",
    ];

    for (const relativePath of canonicalWriters) {
      const source = await readRepoFile(relativePath);
      expect(source, relativePath).not.toContain("type: project");
      expect(source, relativePath).not.toContain('type: "project"');
      expect(source, relativePath).not.toContain("type: 'project'");
    }

    const studyRepository = await readRepoFile("src/lib/studies/study-repository.ts");
    expect(studyRepository).toContain('type: "study"');

    const importCommit = await readRepoFile("src/lib/import/commit-import.ts");
    expect(importCommit).toContain("type: study");
    expect(importCommit).toContain("study_slug:");
  });

  it("limits the legacy project dashboard page to a redirect wrapper", async () => {
    const source = await readRepoFile("src/app/dashboard/project/page.tsx");
    expect(source).toContain("/dashboard/study");
    expect(source).not.toContain("ProjectList");
    expect(source).not.toContain("ProjectPageContent");
  });

  it("keeps scientist-facing docs and skills on Study terminology", async () => {
    const files = [
      ...(await collectMarkdownFiles("docs/tutorials")),
      ...(await collectMarkdownFiles("skills")),
      ...(await collectMarkdownFiles(".openclaw/skills")),
      "src/components/research/health-dashboard.tsx",
      "src/components/research/import-dialog.tsx",
      "src/components/resizable-layout.tsx",
      "src/components/setup/openclaw-section.tsx",
      "src/components/setup/warm-start-section.tsx",
      "src/lib/openclaw/slash-commands.ts",
    ];
    const staleStudyCopyPatterns = [
      /\bproject UI\b/i,
      /\bproject chat\b/i,
      /\bactive projects?\b/i,
      /\bcurrent project folder\b/i,
      /\bimported project folder\b/i,
      /\bproject artifact\b/i,
      /\bproject-scoped\b/i,
      /\bCreate the Project\b/,
      /\bcreate a project\b/i,
      /\bOpen the project\b/i,
      /\bproject context\b/i,
      /\bproject dashboard\b/i,
      /\bproject files\b/i,
      /\bproject page\b/i,
      /\bproject results\b/i,
      /\bproject summary\b/i,
      /\bproject workspace\b/i,
      /\bScienceSwarm project workspace\b/i,
      /\bany project it was linked to\b/i,
      /\bEnsure projects exist\b/i,
    ];

    for (const relativePath of files) {
      const source = await readRepoFile(relativePath);
      for (const pattern of staleStudyCopyPatterns) {
        expect(source, `${relativePath} should not contain ${pattern}`).not.toMatch(pattern);
      }
    }
  });
});
