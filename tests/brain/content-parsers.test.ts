import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  rmSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  parseNotebook,
  parseNotebookJSON,
  notebookToExperimentPage,
} from "@/brain/notebook-parser";
import {
  parseCodeRepo,
  parseCodeFile,
  parseCodeContent,
} from "@/brain/code-parser";

const TEST_ROOT = join(tmpdir(), "scienceswarm-content-parsers-test");

beforeEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
  mkdirSync(TEST_ROOT, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

// ── Fixtures ─────────────────────────────────────────

function makeNotebookJSON(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    metadata: {
      kernelspec: {
        display_name: "Python 3",
        language: "python",
        name: "python3",
      },
      language_info: {
        name: "python",
        version: "3.10.0",
      },
    },
    nbformat: 4,
    nbformat_minor: 5,
    cells: [
      {
        cell_type: "markdown",
        source: [
          "# RNA Sequencing Analysis\n",
          "\n",
          "This notebook analyzes differential gene expression from RNA-seq data.\n",
        ],
        metadata: {},
      },
      {
        cell_type: "code",
        source: [
          "import numpy as np\n",
          "import pandas as pd\n",
          "from scipy import stats\n",
          "from sklearn.decomposition import PCA\n",
        ],
        outputs: [],
        metadata: {},
      },
      {
        cell_type: "markdown",
        source: [
          "## Hypothesis\n",
          "Gene X is differentially expressed in treatment vs control groups.\n",
          "\n",
          "## Method\n",
          "We use DESeq2-style normalization followed by Wald tests.\n",
        ],
        metadata: {},
      },
      {
        cell_type: "code",
        source: [
          "def load_counts(path):\n",
          '    """Load raw count matrix from CSV."""\n',
          "    return pd.read_csv(path, index_col=0)\n",
          "\n",
          "def normalize(counts):\n",
          '    """Normalize counts using size factors."""\n',
          "    size_factors = counts.median(axis=0)\n",
          "    return counts / size_factors\n",
        ],
        outputs: [],
        metadata: {},
      },
      {
        cell_type: "code",
        source: [
          "counts = load_counts('data/counts.csv')\n",
          "normalized = normalize(counts)\n",
          "results = stats.ttest_ind(normalized['treatment'], normalized['control'])\n",
          "p_value = results.pvalue\n",
        ],
        outputs: [
          {
            output_type: "execute_result",
            data: {
              "text/plain": ["Ttest_indResult(statistic=2.45, pvalue=0.021)"],
            },
            metadata: {},
          },
        ],
        metadata: {},
      },
      {
        cell_type: "code",
        source: ["import matplotlib.pyplot as plt\nplt.figure()\nplt.plot(results)\nplt.show()"],
        outputs: [
          {
            output_type: "display_data",
            data: {
              "image/png": "iVBORw0KGgoAAAANS...",
              "text/plain": ["<Figure size 640x480 with 1 Axes>"],
            },
            metadata: {},
          },
        ],
        metadata: {},
      },
      {
        cell_type: "markdown",
        source: [
          "## Results\n",
          "Gene X shows significant differential expression (p=0.021).\n",
        ],
        metadata: {},
      },
      {
        cell_type: "raw",
        source: ["Some raw metadata"],
        metadata: {},
      },
    ],
    ...overrides,
  };
}

function writeNotebookFixture(name: string, overrides: Record<string, unknown> = {}): string {
  const path = join(TEST_ROOT, name);
  writeFileSync(path, JSON.stringify(makeNotebookJSON(overrides)));
  return path;
}

function makeCodeRepoFixture(): string {
  const repoDir = join(TEST_ROOT, "my-analysis");
  mkdirSync(repoDir, { recursive: true });
  mkdirSync(join(repoDir, "src"), { recursive: true });
  mkdirSync(join(repoDir, "tests"), { recursive: true });
  mkdirSync(join(repoDir, "scripts"), { recursive: true });

  // README
  writeFileSync(
    join(repoDir, "README.md"),
    [
      "# My Analysis",
      "",
      "A tool for analyzing RNA sequencing data with differential expression.",
      "",
      "## Installation",
      "pip install -e .",
      "",
      "## Usage",
      "python -m my_analysis data/counts.csv",
    ].join("\n"),
  );

  // requirements.txt
  writeFileSync(
    join(repoDir, "requirements.txt"),
    ["numpy>=1.21", "pandas>=1.3", "scipy>=1.7", "# comment line", "scikit-learn"].join("\n"),
  );

  // setup.py
  writeFileSync(
    join(repoDir, "setup.py"),
    [
      "from setuptools import setup",
      "",
      "setup(",
      '    name="my-analysis",',
      "    install_requires=[",
      '        "numpy",',
      '        "pandas",',
      "    ],",
      ")",
    ].join("\n"),
  );

  // Main module with docstrings
  writeFileSync(
    join(repoDir, "src", "analysis.py"),
    [
      '"""',
      "RNA-seq differential expression analysis module.",
      "",
      "Provides functions for normalizing count matrices and running",
      "statistical tests for differential gene expression.",
      '"""',
      "",
      "import numpy as np",
      "import pandas as pd",
      "from scipy import stats",
      "",
      "",
      "def normalize_counts(counts_df):",
      '    """Normalize raw counts using median-of-ratios method."""',
      "    size_factors = counts_df.median(axis=0)",
      "    return counts_df / size_factors",
      "",
      "",
      "class DEAnalysis:",
      '    """Differential expression analysis pipeline."""',
      "",
      "    def __init__(self, counts):",
      "        self.counts = counts",
      "",
      "    def run(self):",
      '        """Run the full DE analysis pipeline."""',
      "        pass",
    ].join("\n"),
  );

  // Utility module
  writeFileSync(
    join(repoDir, "src", "utils.py"),
    [
      '"""Utility functions for data loading."""',
      "",
      "import os",
      "",
      "def load_data(path):",
      '    """Load data from the given path."""',
      "    pass",
    ].join("\n"),
  );

  // Test file
  writeFileSync(
    join(repoDir, "tests", "test_analysis.py"),
    [
      "import pytest",
      "from src.analysis import normalize_counts",
      "",
      "def test_normalize():",
      "    pass",
    ].join("\n"),
  );

  // Script
  writeFileSync(
    join(repoDir, "scripts", "run_pipeline.sh"),
    "#!/bin/bash\npython -m my_analysis $@\n",
  );

  // Makefile
  writeFileSync(
    join(repoDir, "Makefile"),
    [
      "# Run all tests",
      "test:",
      "\tpytest tests/",
      "",
      "# Install dependencies",
      "install:",
      "\tpip install -r requirements.txt",
    ].join("\n"),
  );

  // .git directory (marker)
  mkdirSync(join(repoDir, ".git"), { recursive: true });

  return repoDir;
}

// ── Notebook Parser Tests ────────────────────────────

describe("notebook-parser", () => {
  describe("parseNotebook", () => {
    it("parses a realistic .ipynb file and extracts all metadata", () => {
      const path = writeNotebookFixture("analysis.ipynb");
      const meta = parseNotebook(path);

      expect(meta.title).toBe("RNA Sequencing Analysis");
      expect(meta.description).toBe(
        "This notebook analyzes differential gene expression from RNA-seq data.",
      );
      expect(meta.language).toBe("python");
      expect(meta.cellCount).toEqual({ code: 4, markdown: 3, raw: 1 });
      expect(meta.hasResults).toBe(true);
    });

    it("detects Python imports from notebook code cells", () => {
      const path = writeNotebookFixture("imports.ipynb");
      const meta = parseNotebook(path);

      expect(meta.imports).toContain("numpy");
      expect(meta.imports).toContain("pandas");
      expect(meta.imports).toContain("scipy");
      expect(meta.imports).toContain("sklearn");
      expect(meta.imports).toContain("matplotlib");
      expect(meta.imports.length).toBe(5);
    });

    it("extracts function definitions from code cells", () => {
      const path = writeNotebookFixture("functions.ipynb");
      const meta = parseNotebook(path);

      expect(meta.functions).toContain("load_counts");
      expect(meta.functions).toContain("normalize");
      expect(meta.functions.length).toBe(2);
    });

    it("extracts variable assignments from code cells", () => {
      const path = writeNotebookFixture("vars.ipynb");
      const meta = parseNotebook(path);

      expect(meta.variables).toContain("counts");
      expect(meta.variables).toContain("normalized");
      expect(meta.variables).toContain("results");
      // "p_value" should be included
      expect(meta.variables.some((v) => v === "p_value")).toBe(true);
    });

    it("detects experiment structure from notebook markdown cells", () => {
      const path = writeNotebookFixture("experiment.ipynb");
      const meta = parseNotebook(path);

      expect(meta.experiment).toBeDefined();
      expect(meta.experiment!.hypothesis).toContain("Gene X");
      expect(meta.experiment!.method).toContain("DESeq2");
      expect(meta.experiment!.results).toContain("p=0.021");
    });

    it("extracts output previews including text and image types", () => {
      const path = writeNotebookFixture("outputs.ipynb");
      const meta = parseNotebook(path);

      expect(meta.outputs.length).toBeGreaterThanOrEqual(2);

      const textOutput = meta.outputs.find((o) => o.outputType === "text");
      expect(textOutput).toBeDefined();
      expect(textOutput!.preview).toContain("Ttest_indResult");

      const imageOutput = meta.outputs.find((o) => o.outputType === "image");
      expect(imageOutput).toBeDefined();
      expect(imageOutput!.preview).toBe("[image output]");
    });
  });

  describe("parseNotebookJSON — edge cases", () => {
    it("handles an empty notebook", () => {
      const meta = parseNotebookJSON({
        metadata: { kernelspec: { language: "python", name: "python3" } },
        cells: [],
        nbformat: 4,
      });

      expect(meta.title).toBeNull();
      expect(meta.description).toBeNull();
      expect(meta.language).toBe("python");
      expect(meta.cellCount).toEqual({ code: 0, markdown: 0, raw: 0 });
      expect(meta.imports).toEqual([]);
      expect(meta.functions).toEqual([]);
      expect(meta.outputs).toEqual([]);
      expect(meta.variables).toEqual([]);
      expect(meta.hasResults).toBe(false);
      expect(meta.experiment).toBeUndefined();
    });

    it("handles a notebook with only markdown cells", () => {
      const meta = parseNotebookJSON({
        metadata: { kernelspec: { language: "python", name: "python3" } },
        cells: [
          {
            cell_type: "markdown",
            source: "# Project Notes\n\nThese are my research notes.",
            metadata: {},
          },
          {
            cell_type: "markdown",
            source: "## Background\n\nSome background info.",
            metadata: {},
          },
        ],
        nbformat: 4,
      });

      expect(meta.title).toBe("Project Notes");
      expect(meta.description).toBe("These are my research notes.");
      expect(meta.cellCount).toEqual({ code: 0, markdown: 2, raw: 0 });
      expect(meta.imports).toEqual([]);
      expect(meta.hasResults).toBe(false);
    });

    it("detects R language from kernel info", () => {
      const meta = parseNotebookJSON({
        metadata: { language_info: { name: "R" } },
        cells: [
          {
            cell_type: "code",
            source: 'library(ggplot2)\nrequire("dplyr")\n',
            outputs: [],
            metadata: {},
          },
        ],
        nbformat: 4,
      });

      expect(meta.language).toBe("r");
      expect(meta.imports).toContain("ggplot2");
      expect(meta.imports).toContain("dplyr");
    });

    it("detects Julia language and imports", () => {
      const meta = parseNotebookJSON({
        metadata: {
          kernelspec: { language: "julia", name: "julia-1.8" },
        },
        cells: [
          {
            cell_type: "code",
            source: "using DataFrames\nimport Statistics\n",
            outputs: [],
            metadata: {},
          },
        ],
        nbformat: 4,
      });

      expect(meta.language).toBe("julia");
      expect(meta.imports).toContain("DataFrames");
      expect(meta.imports).toContain("Statistics");
    });

    it("handles error outputs", () => {
      const meta = parseNotebookJSON({
        metadata: { kernelspec: { language: "python", name: "python3" } },
        cells: [
          {
            cell_type: "code",
            source: "1/0",
            outputs: [
              {
                output_type: "error",
                ename: "ZeroDivisionError",
                evalue: "division by zero",
                traceback: ["..."],
              },
            ],
            metadata: {},
          },
        ],
        nbformat: 4,
      });

      expect(meta.outputs.length).toBe(1);
      expect(meta.outputs[0].outputType).toBe("error");
      expect(meta.outputs[0].preview).toContain("ZeroDivisionError");
      expect(meta.outputs[0].preview).toContain("division by zero");
    });

    it("handles source as string instead of array", () => {
      const meta = parseNotebookJSON({
        metadata: { kernelspec: { language: "python", name: "python3" } },
        cells: [
          {
            cell_type: "markdown",
            source: "# Single String Title\n\nDescription here.",
            metadata: {},
          },
          {
            cell_type: "code",
            source: "import os\nx = 42",
            outputs: [],
            metadata: {},
          },
        ],
        nbformat: 4,
      });

      expect(meta.title).toBe("Single String Title");
      expect(meta.imports).toContain("os");
    });

    it("defaults to python when no kernel info is present", () => {
      const meta = parseNotebookJSON({
        cells: [],
        nbformat: 4,
      });

      expect(meta.language).toBe("python");
    });
  });

  describe("notebookToExperimentPage", () => {
    it("generates a wiki page with frontmatter and sections", () => {
      const path = writeNotebookFixture("page-gen.ipynb");
      const meta = parseNotebook(path);
      const page = notebookToExperimentPage(meta, path);

      // Check frontmatter
      expect(page).toContain("title:");
      expect(page).toContain("type: experiment");
      expect(page).toContain("para: projects");
      expect(page).toContain("tags: [notebook, python]");

      // Check sections
      expect(page).toContain("## Purpose");
      expect(page).toContain("## Method");
      expect(page).toContain("## Results");
      expect(page).toContain("## Notebook Stats");
      expect(page).toContain("## Source");

      // Check content
      expect(page).toContain("`numpy`");
      expect(page).toContain("`pandas`");
      expect(page).toContain("`load_counts()`");
    });

    it("uses filename as title when notebook has no heading", () => {
      const nbPath = join(TEST_ROOT, "untitled.ipynb");
      writeFileSync(
        nbPath,
        JSON.stringify({
          metadata: { kernelspec: { language: "python", name: "python3" } },
          cells: [
            { cell_type: "code", source: "x = 1", outputs: [], metadata: {} },
          ],
          nbformat: 4,
        }),
      );

      const meta = parseNotebook(nbPath);
      const page = notebookToExperimentPage(meta, nbPath);

      expect(page).toContain("# untitled");
    });

    it("marks status as planning when notebook has no outputs", () => {
      const nbPath = join(TEST_ROOT, "planning.ipynb");
      writeFileSync(
        nbPath,
        JSON.stringify({
          metadata: { kernelspec: { language: "python", name: "python3" } },
          cells: [
            {
              cell_type: "code",
              source: "import numpy",
              outputs: [],
              metadata: {},
            },
          ],
          nbformat: 4,
        }),
      );

      const meta = parseNotebook(nbPath);
      const page = notebookToExperimentPage(meta, nbPath);

      expect(page).toContain("status: planning");
      expect(page).toContain("No outputs captured");
    });
  });
});

// ── Code Parser Tests ────────────────────────────────

describe("code-parser", () => {
  describe("parseCodeRepo", () => {
    it("parses a realistic code directory with all metadata", () => {
      const repoDir = makeCodeRepoFixture();
      const meta = parseCodeRepo(repoDir);

      expect(meta.name).toBe("my-analysis");
      expect(meta.language).toBe("python");
      expect(meta.readme).toContain("RNA sequencing");
      expect(meta.testCount).toBeGreaterThanOrEqual(1);
    });

    it("extracts dependencies from requirements.txt", () => {
      const repoDir = makeCodeRepoFixture();
      const meta = parseCodeRepo(repoDir);

      expect(meta.dependencies).toContain("numpy");
      expect(meta.dependencies).toContain("pandas");
      expect(meta.dependencies).toContain("scipy");
      expect(meta.dependencies).toContain("scikit-learn");
    });

    it("detects entry points (setup.py, Makefile)", () => {
      const repoDir = makeCodeRepoFixture();
      const meta = parseCodeRepo(repoDir);

      expect(meta.entryPoints).toContain("setup.py");
      // Makefile is in the structure
      expect(meta.entryPoints.some((e) => e.includes("Makefile"))).toBe(true);
    });

    it("extracts docstrings from Python files", () => {
      const repoDir = makeCodeRepoFixture();
      const meta = parseCodeRepo(repoDir);

      // Module docstring
      const moduleDs = meta.docstrings.find((d) => d.name === "analysis");
      expect(moduleDs).toBeDefined();
      expect(moduleDs!.docstring).toContain("RNA-seq differential expression");

      // Function docstring
      const fnDs = meta.docstrings.find((d) => d.name === "normalize_counts");
      expect(fnDs).toBeDefined();
      expect(fnDs!.docstring).toContain("median-of-ratios");

      // Class docstring
      const clsDs = meta.docstrings.find((d) => d.name === "DEAnalysis");
      expect(clsDs).toBeDefined();
      expect(clsDs!.docstring).toContain("Differential expression");
    });

    it("detects scripts from Makefile and scripts/ directory", () => {
      const repoDir = makeCodeRepoFixture();
      const meta = parseCodeRepo(repoDir);

      expect(meta.scripts.some((s) => s.name === "make test")).toBe(true);
      expect(meta.scripts.some((s) => s.name === "run_pipeline.sh")).toBe(true);
    });

    it("includes directory structure without .git, __pycache__, node_modules", () => {
      const repoDir = makeCodeRepoFixture();
      const meta = parseCodeRepo(repoDir);

      const paths = meta.structure.map((s) => s.path);
      // Should include src, tests, scripts
      expect(paths.some((p) => p.startsWith("src"))).toBe(true);
      expect(paths.some((p) => p.startsWith("tests"))).toBe(true);

      // Should NOT include .git
      expect(paths.some((p) => p.includes(".git"))).toBe(false);
    });

    it("handles a directory with no README", () => {
      const emptyRepo = join(TEST_ROOT, "empty-repo");
      mkdirSync(emptyRepo, { recursive: true });
      writeFileSync(join(emptyRepo, "main.py"), "print('hello')");

      const meta = parseCodeRepo(emptyRepo);

      expect(meta.readme).toBeNull();
      expect(meta.name).toBe("empty-repo");
      expect(meta.language).toBe("python");
    });

    it("extracts dependencies from package.json", () => {
      const jsRepo = join(TEST_ROOT, "js-project");
      mkdirSync(jsRepo, { recursive: true });
      writeFileSync(
        join(jsRepo, "package.json"),
        JSON.stringify({
          name: "js-project",
          dependencies: { express: "^4.18.0", lodash: "^4.17.0" },
          devDependencies: { vitest: "^1.0.0" },
        }),
      );
      writeFileSync(join(jsRepo, "index.js"), "const express = require('express')");

      const meta = parseCodeRepo(jsRepo);

      expect(meta.dependencies).toContain("express");
      expect(meta.dependencies).toContain("lodash");
      expect(meta.dependencies).toContain("vitest");
    });
  });

  describe("parseCodeFile", () => {
    it("extracts module docstring, functions, and classes from Python", () => {
      const pyFile = join(TEST_ROOT, "module.py");
      writeFileSync(
        pyFile,
        [
          '"""Module-level docstring for testing."""',
          "",
          "import os",
          "from pathlib import Path",
          "",
          "def helper_func(x):",
          '    """Help with things."""',
          "    return x + 1",
          "",
          "class MyClass:",
          '    """A test class."""',
          "    pass",
        ].join("\n"),
      );

      const meta = parseCodeFile(pyFile);

      expect(meta.language).toBe("python");
      expect(meta.docstring).toBe("Module-level docstring for testing.");
      expect(meta.functions.length).toBe(1);
      expect(meta.functions[0].name).toBe("helper_func");
      expect(meta.functions[0].docstring).toBe("Help with things.");
      expect(meta.classes.length).toBe(1);
      expect(meta.classes[0].name).toBe("MyClass");
      expect(meta.classes[0].docstring).toBe("A test class.");
      expect(meta.imports).toContain("os");
      expect(meta.imports).toContain("pathlib");
    });

    it("handles Python file with no docstrings", () => {
      const pyFile = join(TEST_ROOT, "no_docs.py");
      writeFileSync(
        pyFile,
        ["import sys", "", "def main():", "    pass"].join("\n"),
      );

      const meta = parseCodeFile(pyFile);

      expect(meta.docstring).toBeNull();
      expect(meta.functions[0].name).toBe("main");
      expect(meta.functions[0].docstring).toBeNull();
    });
  });

  describe("parseCodeContent", () => {
    it("extracts R library imports", () => {
      const content = [
        "library(ggplot2)",
        'require("dplyr")',
        "x <- function(a) { a + 1 }",
      ].join("\n");

      const meta = parseCodeContent(content, "script.R", "r");

      expect(meta.imports).toContain("ggplot2");
      expect(meta.imports).toContain("dplyr");
    });

    it("returns empty arrays for unknown language", () => {
      const meta = parseCodeContent("some code", "file.xyz", "unknown");

      expect(meta.functions).toEqual([]);
      expect(meta.classes).toEqual([]);
      expect(meta.imports).toEqual([]);
    });
  });
});

// ── Code-to-Project Linking Tests ────────────────────

describe("code-to-project linking via keyword overlap", () => {
  it("links code repos to projects via shared keywords in README and docstrings", () => {
    // This tests the keyword extraction logic used by coldstart's detectCodeRepos.
    // We verify that parseCodeRepo extracts meaningful keywords from README and docstrings
    // that would overlap with paper/note keywords.
    const repoDir = makeCodeRepoFixture();
    const meta = parseCodeRepo(repoDir);

    // README should contain keywords that would link to RNA research papers
    expect(meta.readme).not.toBeNull();
    const readmeWords = meta.readme!
      .toLowerCase()
      .replace(/[^a-z\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 4);
    expect(readmeWords).toContain("analysis");
    expect(readmeWords).toContain("sequencing");

    // Docstrings contain domain-specific terms
    const allDocstrings = meta.docstrings.map((d) => d.docstring).join(" ").toLowerCase();
    expect(allDocstrings).toContain("differential");
    expect(allDocstrings).toContain("expression");

    // Together, these keywords would link this repo to a project about RNA-seq
    const allKeywords = new Set([
      ...readmeWords,
      ...allDocstrings.split(/\s+/).filter((w) => w.length > 4),
    ]);
    expect(allKeywords.has("analysis")).toBe(true);
    expect(allKeywords.has("expression")).toBe(true);
    expect(allKeywords.has("sequencing")).toBe(true);
  });
});
