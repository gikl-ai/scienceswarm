import { describe, expect, it } from "vitest";
import {
  parseRenameTemplate,
  renderRenameTemplate,
  sanitizePathSegment,
} from "@/lib/paper-library/templates";

describe("paper-library templates", () => {
  it("parses Phase 1 variables and rejects Phase 4 variables until enabled", () => {
    expect(parseRenameTemplate("{year} - {first_author} - {title}.pdf")).toMatchObject({
      ok: true,
      variables: ["year", "first_author", "title"],
    });

    expect(parseRenameTemplate("{topic}/{year}/{title}.pdf")).toMatchObject({
      ok: false,
      problems: [expect.objectContaining({ code: "unknown_variable", variable: "topic" })],
    });

    expect(parseRenameTemplate("{topic}/{year}/{title}.pdf", { enablePhase4Variables: true })).toMatchObject({
      ok: true,
    });
  });

  it("renders sanitized paths and blocks missing fields", () => {
    const rendered = renderRenameTemplate("{year} - {first_author} - {title}.pdf", {
      year: 2024,
      first_author: "Smith",
      title: "A/B: C? D",
    });

    expect(rendered).toEqual({
      ok: true,
      relativePath: "2024 - Smith - A B C D.pdf",
    });

    expect(renderRenameTemplate("{year} - {venue} - {title}.pdf", { year: 2024, title: "Paper" })).toMatchObject({
      ok: false,
      problems: [expect.objectContaining({ code: "missing_required_field", variable: "venue" })],
    });
  });

  it("blocks long paths and case-folded collisions", () => {
    const longTitle = "x".repeat(130);
    expect(renderRenameTemplate("{title}.pdf", { title: longTitle })).toMatchObject({
      ok: false,
      problems: [expect.objectContaining({ code: "segment_too_long" })],
    });

    expect(
      renderRenameTemplate("{title}.pdf", { title: "Paper" }, { existingDestinations: ["paper.pdf"] }),
    ).toMatchObject({
      ok: false,
      problems: [expect.objectContaining({ code: "case_collision" })],
    });
  });

  it("sanitizes reserved and empty segments", () => {
    expect(sanitizePathSegment("CON")).toBe("CON-paper");
    expect(sanitizePathSegment("../")).toBe("untitled");
  });
});

