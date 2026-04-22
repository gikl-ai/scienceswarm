import { describe, expect, it } from "vitest";
import {
  extractFirstJsonObject,
  findProjectScopedPage,
} from "@/brain/next-experiment-planner";
import type { BrainPage } from "@/brain/store";

describe("extractFirstJsonObject", () => {
  it("extracts one balanced JSON object without swallowing later text", () => {
    const extracted = extractFirstJsonObject(
      [
        "Here is the plan:",
        '{"summary":"one","recommendations":[{"title":"A","metadata":{"brace":"} in string"}}]}',
        "A later object should not be included: {\"summary\":\"two\"}",
      ].join("\n"),
    );

    expect(extracted).toBe(
      '{"summary":"one","recommendations":[{"title":"A","metadata":{"brace":"} in string"}}]}',
    );
    expect(JSON.parse(extracted ?? "{}")).toMatchObject({ summary: "one" });
  });

  it("prefers fenced JSON when the response includes surrounding prose", () => {
    const extracted = extractFirstJsonObject(
      [
        "draft:",
        "```json",
        '{"summary":"fenced","recommendations":[]}',
        "```",
        '{"summary":"unfenced"}',
      ].join("\n"),
    );

    expect(JSON.parse(extracted ?? "{}")).toMatchObject({ summary: "fenced" });
  });
});

describe("findProjectScopedPage", () => {
  it("resolves only pages that are already in the active project page set", () => {
    const projectPages: BrainPage[] = [
      {
        path: "wiki/entities/artifacts/project-alpha-plan",
        title: "Project alpha plan",
        type: "artifact",
        content: "Project-local plan.",
        frontmatter: { project: "project-alpha" },
      },
    ];

    expect(
      findProjectScopedPage(projectPages, "gbrain:wiki/entities/artifacts/project-alpha-plan.md"),
    ).toMatchObject({
      path: "wiki/entities/artifacts/project-alpha-plan",
    });
    expect(
      findProjectScopedPage(projectPages, "wiki/entities/artifacts/other-project-plan"),
    ).toBeNull();
  });
});
