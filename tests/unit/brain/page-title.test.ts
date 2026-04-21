import { describe, expect, it } from "vitest";
import { displayTitleForBrainPage, titleFromFilename } from "@/brain/page-title";

describe("titleFromFilename", () => {
  it("uses a readable basename without the extension", () => {
    expect(titleFromFilename("papers/Hao 2026 - Brain inspired graph multi agent system.pdf"))
      .toBe("Hao 2026 - Brain inspired graph multi agent system");
  });

  it("falls back to the basename when the readable title is empty", () => {
    expect(titleFromFilename("papers/.pdf")).toBe(".pdf");
  });
});

describe("displayTitleForBrainPage", () => {
  it("falls back to the source filename when the stored page title is only a page marker", () => {
    expect(displayTitleForBrainPage({
      title: "1",
      path: "wiki/entities/papers/imports/project-alpha/hao-2026.md",
      frontmatter: {
        source_filename: "Hao 2026 - Brain inspired graph multi agent system.pdf",
      },
    })).toBe("Hao 2026 - Brain inspired graph multi agent system");
  });

  it("keeps useful stored titles", () => {
    expect(displayTitleForBrainPage({
      title: "Deep Think with Confidence",
      path: "wiki/entities/papers/imports/project-alpha/deep-think.md",
      frontmatter: {
        source_filename: "Fu 2025 - Deep Think with Confidence.pdf",
      },
    })).toBe("Deep Think with Confidence");
  });
});
