import { describe, expect, it } from "vitest";

import mendelFixture from "../fixtures/audit-revise/descartes-cached/mendel-1866-textlayer.professional.json";
import { buildCritiqueDisplayModel } from "@/lib/structured-critique-display";
import { normalizeStructuredCritiqueResultPayload } from "@/lib/structured-critique-schema";

describe("structured critique display model", () => {
  it("promotes existing Descartes-style author feedback fields", () => {
    const result = normalizeStructuredCritiqueResultPayload(mendelFixture);
    const model = buildCritiqueDisplayModel(result);

    expect(model.summaryMarkdown).toContain("three systemic concerns");
    expect(model.atAGlance).toContain("52 concrete issues");
    expect(model.topIssues[0]).toMatchObject({
      title: "Absence of formal statistical testing throughout the evidential chain",
    });
    expect(model.sectionFeedback[0]).toMatchObject({
      title: "body",
      findingIds: expect.arrayContaining(["F001", "F052"]),
    });
    expect(model.sectionFeedback[0]?.bodyMarkdown).toContain(
      "Statistical rigor",
    );
    expect(model.questionsForAuthors[0]?.title).toMatch(
      /formal goodness-of-fit analysis/,
    );
    expect(model.referencesFeedbackMarkdown).toContain(
      "methodological references",
    );
  });

  it("falls back to semantic markdown headings when structured fields are absent", () => {
    const result = normalizeStructuredCritiqueResultPayload({
      title: "Markdown-only audit",
      findings: [],
      report_markdown: [
        "# Markdown-only audit",
        "",
        "## Executive Summary",
        "",
        "The paper has a concise summary that should be visible.",
        "",
        "**At a glance:** 2 issues, 1 section.",
        "",
        "## Priority Issues",
        "",
        "### Scope exceeds evidence",
        "",
        "The conclusion is broader than the experiment supports.",
        "",
        "## Manuscript Sections",
        "",
        "### Methods",
        "",
        "The methods section needs stronger controls.",
        "",
        "## Author Questions",
        "",
        "### Can you add the missing control?",
        "",
        "The control is needed to interpret the main comparison.",
        "",
        "## Reference Feedback",
        "",
        "No broken references were found.",
      ].join("\n"),
    });

    const model = buildCritiqueDisplayModel(result);

    expect(model.summaryMarkdown).toBe(
      "The paper has a concise summary that should be visible.",
    );
    expect(model.atAGlance).toBe("2 issues, 1 section.");
    expect(model.topIssues).toMatchObject([
      {
        title: "Scope exceeds evidence",
        bodyMarkdown: "The conclusion is broader than the experiment supports.",
      },
    ]);
    expect(model.sectionFeedback).toMatchObject([
      {
        title: "Methods",
        bodyMarkdown: "The methods section needs stronger controls.",
      },
    ]);
    expect(model.questionsForAuthors[0]?.title).toBe(
      "Can you add the missing control?",
    );
    expect(model.referencesFeedbackMarkdown).toBe("No broken references were found.");
  });

  it("prefers a future versioned display contract when present", () => {
    const result = normalizeStructuredCritiqueResultPayload({
      title: "Display contract audit",
      findings: [],
      report_markdown: "# Display contract audit\n\nRaw markdown fallback.",
      display: {
        contract_version: "structured-critique-display.v1",
        summary: { body_markdown: "Contract summary." },
        sections: [
          {
            role: "section_feedback",
            title: "Section feedback",
            items: [
              {
                title: "Results",
                body_markdown: "The results section needs calibration details.",
                finding_ids: ["F010"],
              },
            ],
          },
        ],
      },
    });

    const model = buildCritiqueDisplayModel(result);

    expect(model.summaryMarkdown).toBe("Contract summary.");
    expect(model.sectionFeedback).toEqual([
      {
        title: "Results",
        bodyMarkdown: "The results section needs calibration details.",
        findingIds: ["F010"],
      },
    ]);
  });
});
