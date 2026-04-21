import { describe, expect, it } from "vitest";
import { generateChartSVG, analyzeData, type ChartSpec } from "@/lib/chart-generator";
import { type DataTable } from "@/lib/data-transform";

function makeTable(columns: string[], rows: (string | number | null)[][]): DataTable {
  return { columns, rows };
}

function makeSpec(overrides: Partial<ChartSpec> & { data: DataTable }): ChartSpec {
  return {
    type: "bar",
    title: "Test Chart",
    xColumn: overrides.data.columns[0] || "x",
    yColumn: overrides.data.columns[1] || "y",
    ...overrides,
  };
}

describe("chart-generator", () => {
  // ── Bar chart ──────────────────────────────────────────────────

  describe("bar chart", () => {
    it("generates SVG with rect elements for each bar", () => {
      const data = makeTable(["cat", "val"], [["A", 10], ["B", 20], ["C", 30]]);
      const svg = generateChartSVG(makeSpec({ type: "bar", data, xColumn: "cat", yColumn: "val" }));

      expect(svg).toContain("<svg");
      expect(svg).toContain("</svg>");
      expect(svg).toContain("<rect");
      expect(svg).toContain("Test Chart");
    });

    it("includes value labels on bars", () => {
      const data = makeTable(["cat", "val"], [["A", 42]]);
      const svg = generateChartSVG(makeSpec({ type: "bar", data, xColumn: "cat", yColumn: "val" }));
      expect(svg).toContain("42");
    });

    it("honors custom axis labels and palette overrides", () => {
      const data = makeTable(["cat", "val"], [["A", 10], ["B", 20]]);
      const svg = generateChartSVG(makeSpec({
        type: "bar",
        data,
        xColumn: "cat",
        yColumn: "val",
        xLabel: "Condition",
        yLabel: "Signal",
        palette: "sunset",
      }));

      expect(svg).toContain("Condition");
      expect(svg).toContain("Signal");
      expect(svg).toContain("#f97316");
    });
  });

  // ── Line chart ─────────────────────────────────────────────────

  describe("line chart", () => {
    it("generates SVG with path and circle elements", () => {
      const data = makeTable(
        ["time", "value"],
        [["Jan", 10], ["Feb", 20], ["Mar", 15]],
      );
      const svg = generateChartSVG(
        makeSpec({ type: "line", data, xColumn: "time", yColumn: "value" }),
      );

      expect(svg).toContain("<svg");
      expect(svg).toContain("<path");
      expect(svg).toContain("<circle");
    });

    it("renders single data point without error", () => {
      const data = makeTable(["x", "y"], [["A", 5]]);
      const svg = generateChartSVG(makeSpec({ type: "line", data, xColumn: "x", yColumn: "y" }));
      expect(svg).toContain("<svg");
      expect(svg).toContain("<circle");
    });
  });

  // ── Scatter plot ───────────────────────────────────────────────

  describe("scatter plot", () => {
    it("generates SVG with circle elements for data points", () => {
      const data = makeTable(
        ["x", "y"],
        [[1, 2], [3, 4], [5, 6], [7, 8]],
      );
      const svg = generateChartSVG(
        makeSpec({ type: "scatter", data, xColumn: "x", yColumn: "y" }),
      );

      expect(svg).toContain("<svg");
      expect(svg).toContain("<circle");
    });

    it("includes a trend line for 2+ points", () => {
      const data = makeTable("xy".split(""), [[1, 2], [3, 4]]);
      const svg = generateChartSVG(
        makeSpec({ type: "scatter", data, xColumn: "x", yColumn: "y" }),
      );
      // Trend line is a dashed line
      expect(svg).toContain("stroke-dasharray");
    });
  });

  // ── Histogram ──────────────────────────────────────────────────

  describe("histogram", () => {
    it("generates binned bars for numeric data", () => {
      const values = Array.from({ length: 50 }, (_, i) => i);
      const data = makeTable(
        ["val"],
        values.map((v) => [v]),
      );
      const svg = generateChartSVG(
        makeSpec({ type: "histogram", data, xColumn: "val", yColumn: "val" }),
      );

      expect(svg).toContain("<svg");
      expect(svg).toContain("<rect");
      expect(svg).toContain("Frequency");
    });
  });

  // ── Box plot ───────────────────────────────────────────────────

  describe("box plot", () => {
    it("renders quartile-based box and whisker elements", () => {
      const data = makeTable(
        ["group", "val"],
        [
          ["A", 1], ["A", 2], ["A", 3], ["A", 4], ["A", 5],
          ["B", 10], ["B", 20], ["B", 30], ["B", 40], ["B", 50],
        ],
      );
      const svg = generateChartSVG(
        makeSpec({ type: "box", data, xColumn: "group", yColumn: "val" }),
      );

      expect(svg).toContain("<svg");
      expect(svg).toContain("<rect"); // box
      expect(svg).toContain("<line"); // whiskers and median
    });
  });

  // ── niceScale edge case ────────────────────────────────────────

  describe("niceScale zero range", () => {
    it("handles data where all values are the same (zero range)", () => {
      const data = makeTable(["x", "y"], [["A", 5], ["B", 5], ["C", 5]]);
      const svg = generateChartSVG(
        makeSpec({ type: "line", data, xColumn: "x", yColumn: "y" }),
      );

      // Should not crash — the niceScale fix guards against min === max
      expect(svg).toContain("<svg");
      expect(svg).not.toContain("NaN");
      expect(svg).not.toContain("Infinity");
    });

    it("handles all-zero values", () => {
      const data = makeTable(["x", "y"], [["A", 0], ["B", 0]]);
      const svg = generateChartSVG(
        makeSpec({ type: "line", data, xColumn: "x", yColumn: "y" }),
      );
      expect(svg).toContain("<svg");
      expect(svg).not.toContain("NaN");
    });
  });

  // ── Empty data ─────────────────────────────────────────────────

  describe("empty data handling", () => {
    it("renders placeholder for empty bar chart", () => {
      const data = makeTable(["x", "y"], []);
      const svg = generateChartSVG(
        makeSpec({ type: "bar", data, xColumn: "x", yColumn: "y" }),
      );
      expect(svg).toContain("No data");
    });

    it("renders placeholder when column not found", () => {
      const data = makeTable(["a"], [[1]]);
      const svg = generateChartSVG(
        makeSpec({ type: "bar", data, xColumn: "missing", yColumn: "also_missing" }),
      );
      expect(svg).toContain("Column not found");
    });

    it("renders placeholder for unsupported chart type", () => {
      const data = makeTable(["x", "y"], [[1, 2]]);
      const svg = generateChartSVG(
        makeSpec({ type: "pie" as ChartSpec["type"], data, xColumn: "x", yColumn: "y" }),
      );
      expect(svg).toContain("Unsupported chart type");
    });
  });

  // ── analyzeData ────────────────────────────────────────────────

  describe("analyzeData", () => {
    it("recommends bar chart for categorical + numeric columns", () => {
      const data = makeTable(
        ["category", "value"],
        [["A", 10], ["B", 20], ["C", 30]],
      );
      const recs = analyzeData(data);
      expect(recs.length).toBeGreaterThan(0);
      expect(recs.some((r) => r.spec.type === "bar")).toBe(true);
    });

    it("recommends scatter for two numeric columns", () => {
      const data = makeTable(
        ["x", "y"],
        [[1, 2], [3, 4], [5, 6]],
      );
      const recs = analyzeData(data);
      expect(recs.some((r) => r.spec.type === "scatter")).toBe(true);
    });

    it("returns at most 5 recommendations", () => {
      const data = makeTable(
        ["cat", "a", "b", "c", "d"],
        Array.from({ length: 20 }, (_, i) => [`cat${i % 5}`, i, i * 2, i * 3, i * 4]),
      );
      const recs = analyzeData(data);
      expect(recs.length).toBeLessThanOrEqual(5);
    });

    it("sorts recommendations by score descending", () => {
      const data = makeTable(
        ["cat", "val1", "val2"],
        Array.from({ length: 20 }, (_, i) => [`cat${i % 3}`, i, i * 2]),
      );
      const recs = analyzeData(data);
      for (let i = 1; i < recs.length; i++) {
        expect(recs[i - 1].score).toBeGreaterThanOrEqual(recs[i].score);
      }
    });
  });
});
