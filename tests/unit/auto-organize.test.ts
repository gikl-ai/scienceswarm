import { describe, expect, it } from "vitest";
import {
  organizeFiles,
  isAlreadyOrganized,
  organizeSummary,
} from "@/lib/auto-organize";

describe("auto-organize", () => {
  // ── Extension-based routing ────────────────────────────────────

  describe("organizeFiles — extension routing", () => {
    it("routes PDF to papers/", () => {
      const result = organizeFiles([{ name: "research.pdf" }]);
      expect(result[0].organizedPath).toBe("papers/research.pdf");
      expect(result[0].category).toBe("papers");
    });

    it("routes .py to code/", () => {
      const result = organizeFiles([{ name: "model.py" }]);
      expect(result[0].organizedPath).toBe("code/model.py");
      expect(result[0].category).toBe("code");
    });

    it("routes test_foo.py to code/tests/", () => {
      const result = organizeFiles([{ name: "test_foo.py" }]);
      expect(result[0].organizedPath).toBe("code/tests/test_foo.py");
      expect(result[0].category).toBe("tests");
    });

    it("routes foo.test.ts to code/tests/", () => {
      const result = organizeFiles([{ name: "foo.test.ts" }]);
      expect(result[0].organizedPath).toBe("code/tests/foo.test.ts");
      expect(result[0].category).toBe("tests");
    });

    it("routes foo.spec.js to code/tests/", () => {
      const result = organizeFiles([{ name: "foo.spec.js" }]);
      expect(result[0].organizedPath).toBe("code/tests/foo.spec.js");
      expect(result[0].category).toBe("tests");
    });

    it("routes .csv to data/", () => {
      const result = organizeFiles([{ name: "results.csv" }]);
      expect(result[0].organizedPath).toBe("data/results.csv");
      expect(result[0].category).toBe("data");
    });

    it("routes .tex to docs/", () => {
      const result = organizeFiles([{ name: "paper.tex" }]);
      expect(result[0].organizedPath).toBe("docs/paper.tex");
      expect(result[0].category).toBe("docs");
    });

    it("routes .png to figures/", () => {
      const result = organizeFiles([{ name: "chart.png" }]);
      expect(result[0].organizedPath).toBe("figures/chart.png");
      expect(result[0].category).toBe("figures");
    });

    it("routes .yaml to config/", () => {
      const result = organizeFiles([{ name: "settings.yaml" }]);
      expect(result[0].organizedPath).toBe("config/settings.yaml");
      expect(result[0].category).toBe("config");
    });

    it("routes .yml to config/", () => {
      const result = organizeFiles([{ name: "ci.yml" }]);
      expect(result[0].organizedPath).toBe("config/ci.yml");
      expect(result[0].category).toBe("config");
    });

    it("routes unknown extensions to other/", () => {
      const result = organizeFiles([{ name: "readme.xyz" }]);
      expect(result[0].organizedPath).toBe("other/readme.xyz");
      expect(result[0].category).toBe("other");
    });

    it("routes files without extension to other/", () => {
      const result = organizeFiles([{ name: "Makefile" }]);
      expect(result[0].organizedPath).toBe("other/Makefile");
      expect(result[0].category).toBe("other");
    });
  });

  // ── Additional data extensions ─────────────────────────────────

  describe("organizeFiles — additional data extensions", () => {
    it.each(["json", "tsv", "xlsx", "parquet", "h5", "feather"])(
      "routes .%s to data/",
      (ext) => {
        const result = organizeFiles([{ name: `file.${ext}` }]);
        expect(result[0].organizedPath).toBe(`data/file.${ext}`);
      },
    );
  });

  // ── Additional code extensions ─────────────────────────────────

  describe("organizeFiles — additional code extensions", () => {
    it.each(["r", "jl", "ipynb", "go", "rs", "c", "cpp", "java"])(
      "routes .%s to code/",
      (ext) => {
        const result = organizeFiles([{ name: `file.${ext}` }]);
        expect(result[0].organizedPath).toBe(`code/file.${ext}`);
      },
    );
  });

  // ── Additional figure extensions ───────────────────────────────

  describe("organizeFiles — additional figure extensions", () => {
    it.each(["jpg", "jpeg", "svg", "gif", "webp", "eps"])(
      "routes .%s to figures/",
      (ext) => {
        const result = organizeFiles([{ name: `image.${ext}` }]);
        expect(result[0].organizedPath).toBe(`figures/image.${ext}`);
      },
    );
  });

  // ── isAlreadyOrganized ─────────────────────────────────────────

  describe("isAlreadyOrganized", () => {
    it("returns true when majority of paths use known folders", () => {
      const files = [
        { path: "papers/paper.pdf" },
        { path: "code/model.py" },
        { path: "data/results.csv" },
      ];
      expect(isAlreadyOrganized(files)).toBe(true);
    });

    it("returns false for flat files without paths", () => {
      const files = [{ path: undefined }, { path: undefined }];
      expect(isAlreadyOrganized(files)).toBe(false);
    });

    it("returns false when no paths contain a slash", () => {
      const files = [{ path: "paper.pdf" }, { path: "model.py" }];
      expect(isAlreadyOrganized(files)).toBe(false);
    });

    it("returns false when less than half use known folders", () => {
      const files = [
        { path: "random/paper.pdf" },
        { path: "misc/model.py" },
        { path: "papers/a.pdf" },
      ];
      expect(isAlreadyOrganized(files)).toBe(false);
    });

    it("preserves existing paths when already organized", () => {
      const files = [
        { name: "paper.pdf", path: "papers/paper.pdf" },
        { name: "model.py", path: "code/model.py" },
      ];
      const result = organizeFiles(files);
      expect(result[0].organizedPath).toBe("papers/paper.pdf");
      expect(result[1].organizedPath).toBe("code/model.py");
    });
  });

  // ── Academic / Figure PDF detection ────────────────────────────

  describe("PDF classification", () => {
    it("classifies PDF with abstract as academic (papers/)", () => {
      const result = organizeFiles([
        { name: "study.pdf", content: "Abstract: We study the effect..." },
      ]);
      expect(result[0].category).toBe("papers");
    });

    it("classifies PDF with 'theorem' as academic", () => {
      const result = organizeFiles([
        { name: "proof.pdf", content: "Theorem 3.1: For all graphs G..." },
      ]);
      expect(result[0].category).toBe("papers");
    });

    it("classifies PDF without content as papers (default)", () => {
      const result = organizeFiles([{ name: "unknown.pdf" }]);
      expect(result[0].category).toBe("papers");
    });

    it("classifies figure-named PDF as figures/", () => {
      const result = organizeFiles([{ name: "figure-3-results.pdf" }]);
      expect(result[0].category).toBe("figures");
      expect(result[0].organizedPath).toBe("figures/figure-3-results.pdf");
    });

    it("classifies poster PDF as figures/", () => {
      const result = organizeFiles([{ name: "poster-v2.pdf" }]);
      expect(result[0].category).toBe("figures");
    });

    it("classifies slide-content PDF as figures/", () => {
      const result = organizeFiles([
        { name: "talk.pdf", content: "Slide 1: Introduction" },
      ]);
      expect(result[0].category).toBe("figures");
    });

    it("classifies non-academic PDF without indicators as docs/", () => {
      const result = organizeFiles([
        { name: "notes.pdf", content: "Here are some general notes about setup." },
      ]);
      expect(result[0].category).toBe("docs");
    });
  });

  // ── organizeSummary ────────────────────────────────────────────

  describe("organizeSummary", () => {
    it("counts distinct top-level folders", () => {
      const organized = [
        { originalName: "a.py", organizedPath: "code/a.py", category: "code" },
        { originalName: "b.csv", organizedPath: "data/b.csv", category: "data" },
        { originalName: "c.pdf", organizedPath: "papers/c.pdf", category: "papers" },
      ];
      expect(organizeSummary(organized)).toBe("Auto-organized into 3 folders");
    });

    it("uses singular when one folder", () => {
      const organized = [
        { originalName: "a.py", organizedPath: "code/a.py", category: "code" },
      ];
      expect(organizeSummary(organized)).toBe("Auto-organized into 1 folder");
    });
  });

  // ── Multiple files in one call ─────────────────────────────────

  describe("organizeFiles — batch", () => {
    it("organizes a mixed batch correctly", () => {
      const files = [
        { name: "paper.pdf" },
        { name: "model.py" },
        { name: "test_model.py" },
        { name: "results.csv" },
        { name: "draft.tex" },
        { name: "chart.png" },
        { name: "config.yaml" },
      ];
      const result = organizeFiles(files);

      expect(result).toHaveLength(7);
      expect(result.map((r) => r.organizedPath)).toEqual([
        "papers/paper.pdf",
        "code/model.py",
        "code/tests/test_model.py",
        "data/results.csv",
        "docs/draft.tex",
        "figures/chart.png",
        "config/config.yaml",
      ]);
    });
  });
});
