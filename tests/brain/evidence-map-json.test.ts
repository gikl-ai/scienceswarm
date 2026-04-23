import { describe, expect, it } from "vitest";

import { parseEvidenceMapModelJson } from "@/lib/evidence-map-json";

describe("parseEvidenceMapModelJson", () => {
  it("parses direct JSON objects", () => {
    const result = parseEvidenceMapModelJson('{"claims":[],"tensions":[]}');

    expect(result.candidateFound).toBe(true);
    expect(result.parsed).toMatchObject({ claims: [], tensions: [] });
  });

  it("parses fenced JSON objects", () => {
    const result = parseEvidenceMapModelJson([
      "```json",
      '{"focused_question":"What changed?","claims":[]}',
      "```",
    ].join("\n"));

    expect(result.candidateFound).toBe(true);
    expect(result.parsed).toMatchObject({
      focused_question: "What changed?",
      claims: [],
    });
  });

  it("skips malformed brace blocks before the valid JSON object", () => {
    const result = parseEvidenceMapModelJson([
      "Here is the schema I used: { focused_question: string }",
      '{"focused_question":"What is supported?","claims":[],"tensions":[]}',
    ].join("\n"));

    expect(result.candidateFound).toBe(true);
    expect(result.parsed).toMatchObject({
      focused_question: "What is supported?",
      claims: [],
      tensions: [],
    });
  });
});
