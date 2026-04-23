import { describe, expect, it } from "vitest";

import mendelFixture from "../fixtures/audit-revise/descartes-cached/mendel-1866-textlayer.professional.json";
import {
  buildCritiqueDisplayModel,
  parseMarkdownSections,
  type MarkdownSection,
} from "@/lib/structured-critique-display";
import { normalizeStructuredCritiqueResultPayload } from "@/lib/structured-critique-schema";

function flattenSectionTitles(sections: MarkdownSection[]): string[] {
  return sections.flatMap((section) => [
    section.title,
    ...flattenSectionTitles(section.children),
  ]);
}

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

  it("matches semantic markdown headings through normalized aliases", () => {
    const result = normalizeStructuredCritiqueResultPayload({
      title: "Alias audit",
      findings: [],
      report_markdown: [
        "# Alias audit",
        "",
        "## Section-by-section Feedback",
        "",
        "### Methods",
        "",
        "The methods section needs a clearer sampling frame.",
      ].join("\n"),
    });

    const model = buildCritiqueDisplayModel(result);

    expect(model.sectionFeedback).toEqual([
      {
        title: "Methods",
        bodyMarkdown: "The methods section needs a clearer sampling frame.",
      },
    ]);
  });

  it("ignores markdown headings inside backtick and tilde fences", () => {
    const sections = parseMarkdownSections(
      [
        "## Summary",
        "",
        "Visible summary.",
        "",
        "~~~",
        "# Not a tilde heading",
        "~~~",
        "",
        "```",
        "## Not a backtick heading",
        "```",
        "",
        "## Top Issues",
        "",
        "Visible issues.",
      ].join("\n"),
    );

    expect(flattenSectionTitles(sections)).toEqual(["Summary", "Top Issues"]);
  });

  it("removes consumed nested markdown sections from unclassified sections", () => {
    const result = normalizeStructuredCritiqueResultPayload({
      title: "Nested audit",
      findings: [],
      report_markdown: [
        "# Nested audit",
        "",
        "## Review Details",
        "",
        "Context that can remain unclassified.",
        "",
        "### Section-by-section Feedback",
        "",
        "#### Methods",
        "",
        "The methods section needs calibration detail.",
        "",
        "### Other Notes",
        "",
        "A separate note remains available for fallback display.",
      ].join("\n"),
    });

    const model = buildCritiqueDisplayModel(result);
    const titles = flattenSectionTitles(model.unclassifiedSections);

    expect(model.sectionFeedback).toEqual([
      {
        title: "Methods",
        bodyMarkdown: "The methods section needs calibration detail.",
      },
    ]);
    expect(titles).toContain("Review Details");
    expect(titles).toContain("Other Notes");
    expect(titles).not.toContain("Section-by-section Feedback");
    expect(titles).not.toContain("Methods");
  });
});
