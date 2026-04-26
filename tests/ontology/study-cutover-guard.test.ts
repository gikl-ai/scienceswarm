import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();

async function readRepoFile(relativePath: string): Promise<string> {
  return readFile(path.join(repoRoot, relativePath), "utf-8");
}

describe("Study ontology cutover guardrails", () => {
  it("keeps canonical study surfaces off legacy project routes and APIs", async () => {
    const canonicalSurfaceFiles = [
      "src/app/dashboard/page.tsx",
      "src/app/dashboard/study/page.tsx",
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
});
