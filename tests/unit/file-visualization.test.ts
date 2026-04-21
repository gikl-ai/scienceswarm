import { describe, expect, it } from "vitest";
import {
  classifyFile,
  getShikiLanguageForPath,
  isRawRenderableKind,
  shouldLoadAsText,
} from "@/lib/file-visualization";

describe("file visualization classifier", () => {
  it("maps common research file extensions to visualizer kinds", () => {
    expect(classifyFile("papers/hubble.pdf")).toBe("pdf");
    expect(classifyFile("figures/result.png")).toBe("image");
    expect(classifyFile("notes/summary.md")).toBe("markdown");
    expect(classifyFile("paper/main.tex")).toBe("latex");
    expect(classifyFile("paper/refs.bib")).toBe("latex");
    expect(classifyFile("notebooks/run.ipynb")).toBe("notebook");
    expect(classifyFile("reports/index.html")).toBe("html");
    expect(classifyFile("data/table.csv")).toBe("data");
    expect(classifyFile("data/table.tsv")).toBe("data");
    expect(classifyFile("data/results.json")).toBe("data");
    expect(classifyFile("src/main.py")).toBe("source-code");
    expect(classifyFile("figures/generated.svg")).toBe("source-code");
    expect(classifyFile("archive/model.pkl")).toBe("unknown");
  });

  it("uses MIME when present", () => {
    expect(classifyFile("download", "application/pdf")).toBe("pdf");
    expect(classifyFile("download", "image/jpeg")).toBe("image");
    expect(classifyFile("download", "image/svg+xml")).toBe("unknown");
    expect(classifyFile("download", "text/html")).toBe("html");
    expect(classifyFile("download", "application/json")).toBe("data");
  });

  it("maps source paths to Shiki languages", () => {
    expect(getShikiLanguageForPath("main.py")).toBe("python");
    expect(getShikiLanguageForPath("analysis.R")).toBe("r");
    expect(getShikiLanguageForPath("src/model.cpp")).toBe("cpp");
    expect(getShikiLanguageForPath("ui/page.tsx")).toBe("tsx");
    expect(getShikiLanguageForPath("notes.md")).toBe("markdown");
    expect(getShikiLanguageForPath("main.tex")).toBe("latex");
    expect(getShikiLanguageForPath("index.html")).toBe("html");
    expect(getShikiLanguageForPath("unknown.bin")).toBe("text");
  });

  it("separates raw media from text-source loading", () => {
    expect(isRawRenderableKind(classifyFile("paper.pdf"))).toBe(true);
    expect(isRawRenderableKind(classifyFile("figure.webp"))).toBe(true);
    expect(shouldLoadAsText(classifyFile("notebook.ipynb"))).toBe(true);
    expect(shouldLoadAsText(classifyFile("figure.svg"))).toBe(true);
    expect(shouldLoadAsText(classifyFile("paper.pdf"))).toBe(false);
  });
});

