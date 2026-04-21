import { describe, expect, it } from "vitest";
import { POST } from "@/app/api/transform/route";

function makeRequest(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/transform", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/transform", () => {
  // ── Parse CSV ──────────────────────────────────────────────────

  describe("action: parse", () => {
    it("parses CSV data and returns a table", async () => {
      const response = await POST(
        makeRequest({
          action: "parse",
          data: "name,score\nAlice,90\nBob,80",
          format: "csv",
        }),
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.table.columns).toEqual(["name", "score"]);
      expect(body.table.rows).toHaveLength(2);
    });

    it("parses JSON data and returns a table", async () => {
      const response = await POST(
        makeRequest({
          action: "parse",
          data: '[{"a":1,"b":2}]',
          format: "json",
        }),
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.table.columns).toEqual(["a", "b"]);
    });

    it("returns 400 when data or format is missing", async () => {
      const response = await POST(makeRequest({ action: "parse" }));
      expect(response.status).toBe(400);
    });

    it("returns 400 for unsupported parse format", async () => {
      const response = await POST(
        makeRequest({ action: "parse", data: "test", format: "yaml" }),
      );
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain("Unsupported parse format");
    });
  });

  // ── Transform with filter ──────────────────────────────────────

  describe("action: transform", () => {
    it("applies filter steps to a table", async () => {
      const table = {
        columns: ["name", "score"],
        rows: [
          ["Alice", 90],
          ["Bob", 75],
          ["Carol", 85],
        ],
      };

      const response = await POST(
        makeRequest({
          action: "transform",
          table,
          steps: [{ type: "filter", config: { column: "score", op: "gt", value: 80 } }],
        }),
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.table.rows).toHaveLength(2);
    });

    it("returns 400 when table or steps are missing", async () => {
      const response = await POST(makeRequest({ action: "transform" }));
      expect(response.status).toBe(400);
    });
  });

  // ── Export as markdown ─────────────────────────────────────────

  describe("action: export", () => {
    it("exports table as markdown", async () => {
      const table = {
        columns: ["a", "b"],
        rows: [[1, 2]],
      };

      const response = await POST(
        makeRequest({ action: "export", table, format: "markdown" }),
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.output).toContain("| a | b |");
      expect(body.output).toContain("| --- | --- |");
    });

    it("returns 400 for missing table or format", async () => {
      const response = await POST(makeRequest({ action: "export" }));
      expect(response.status).toBe(400);
    });

    it("returns 400 for invalid export format", async () => {
      const table = { columns: ["a"], rows: [[1]] };
      const response = await POST(
        makeRequest({ action: "export", table, format: "xml" }),
      );
      expect(response.status).toBe(400);
    });
  });

  // ── Auto-analyze ───────────────────────────────────────────────

  describe("action: auto-analyze", () => {
    it("parses CSV data, produces table, charts, and insights", async () => {
      const csvData = "category,value\nA,10\nB,20\nC,30";

      const response = await POST(
        makeRequest({ action: "auto-analyze", data: csvData }),
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.table).toBeDefined();
      expect(body.table.columns).toEqual(["category", "value"]);
      expect(body.charts).toBeDefined();
      expect(body.insights).toBeDefined();
      expect(body.insights).toContain("3 rows");
    });

    it("auto-detects JSON data", async () => {
      const jsonData = '[{"x":1,"y":2},{"x":3,"y":4}]';

      const response = await POST(
        makeRequest({ action: "auto-analyze", data: jsonData }),
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.table.columns).toContain("x");
    });

    it("returns 400 when data is missing", async () => {
      const response = await POST(makeRequest({ action: "auto-analyze" }));
      expect(response.status).toBe(400);
    });
  });

  // ── Chart generation ───────────────────────────────────────────

  describe("action: chart", () => {
    it("generates an SVG chart", async () => {
      const table = {
        columns: ["name", "val"],
        rows: [["A", 10], ["B", 20]],
      };

      const response = await POST(
        makeRequest({
          action: "chart",
          table,
          spec: {
            type: "bar",
            title: "Test",
            xColumn: "name",
            yColumn: "val",
          },
        }),
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.svg).toContain("<svg");
    });

    it("returns 400 when table or spec is missing", async () => {
      const response = await POST(makeRequest({ action: "chart" }));
      expect(response.status).toBe(400);
    });
  });

  // ── Unknown action ─────────────────────────────────────────────

  describe("unknown action", () => {
    it("returns 400 for unknown action", async () => {
      const response = await POST(makeRequest({ action: "invalid" }));
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain("Unknown action");
    });
  });
});
