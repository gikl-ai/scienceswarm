import { describe, expect, it } from "vitest";
import { extractFirstJsonObject } from "@/brain/next-experiment-planner";

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
