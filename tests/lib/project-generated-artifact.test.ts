import path from "node:path";
import matter from "gray-matter";
import { describe, expect, it } from "vitest";
import {
  buildArtifactPageMarkdown,
  resolveBrainMirrorPath,
} from "@/lib/project-generated-artifact";

describe("resolveBrainMirrorPath", () => {
  it("allows generated relative paths inside the brain root", () => {
    const root = path.join(process.cwd(), ".tmp", "brain");

    expect(resolveBrainMirrorPath(root, "wiki/entities/artifacts/example.md")).toBe(
      path.join(root, "wiki", "entities", "artifacts", "example.md"),
    );
  });

  it("rejects traversal and absolute paths", () => {
    const root = path.join(process.cwd(), ".tmp", "brain");

    expect(() => resolveBrainMirrorPath(root, "../escape.md")).toThrow(
      /inside the configured brain root/,
    );
    expect(() => resolveBrainMirrorPath(root, path.resolve(root, "escape.md"))).toThrow(
      /inside the configured brain root/,
    );
  });
});

describe("buildArtifactPageMarkdown", () => {
  it("keeps generated artifact frontmatter authoritative", () => {
    const markdown = buildArtifactPageMarkdown({
      title: "Next Plan",
      content: [
        "---",
        "type: note",
        "project: wrong-project",
        "artifact_type: wrong-type",
        "workspace_path: wrong/path.md",
        "---",
        "Plan body.",
      ].join("\n"),
      projectSlug: "project-alpha",
      artifactType: "next-experiment-plan",
      savePath: "artifacts/next-experiment-plan/plan.md",
      sourceRefs: [],
      tags: [],
      date: "2026-04-22",
      uploadedBy: "researcher",
    });

    const parsed = matter(markdown);

    expect(parsed.data).toMatchObject({
      type: "artifact",
      project: "project-alpha",
      artifact_type: "next-experiment-plan",
      workspace_path: "artifacts/next-experiment-plan/plan.md",
    });
  });
});
