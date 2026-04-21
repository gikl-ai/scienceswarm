import { describe, expect, it } from "vitest";
import {
  parseCSV,
  parseJSON,
  filterRows,
  aggregateBy,
  sortBy,
  pivotTable,
  convertFormat,
  cleanData,
  deriveColumn,
  detectColumnTypes,
  type DataTable,
} from "@/lib/data-transform";

// ── Helper ───────────────────────────────────────────────────────

function makeTable(columns: string[], rows: (string | number | null)[][]): DataTable {
  return { columns, rows };
}

// ── parseCSV ─────────────────────────────────────────────────────

describe("parseCSV", () => {
  it("parses basic CSV", () => {
    const table = parseCSV("name,age\nAlice,30\nBob,25");
    expect(table.columns).toEqual(["name", "age"]);
    expect(table.rows).toEqual([
      ["Alice", 30],
      ["Bob", 25],
    ]);
    expect(table.metadata?.rowCount).toBe(2);
  });

  it("parses quoted fields with commas", () => {
    const table = parseCSV('city,desc\n"New York","Big, bold city"');
    expect(table.rows[0]).toEqual(["New York", "Big, bold city"]);
  });

  it("handles escaped quotes inside quoted fields", () => {
    const table = parseCSV('val\n"He said ""hi"""');
    expect(table.rows[0][0]).toBe('He said "hi"');
  });

  it("skips empty rows", () => {
    const table = parseCSV("a,b\n1,2\n\n3,4");
    expect(table.rows).toHaveLength(2);
  });

  it("returns empty table for empty input", () => {
    const table = parseCSV("");
    expect(table.columns).toEqual([]);
    expect(table.rows).toEqual([]);
    expect(table.metadata?.rowCount).toBe(0);
  });

  it("handles unicode values", () => {
    const table = parseCSV("name,city\nMüller,Zürich");
    expect(table.rows[0]).toEqual(["Müller", "Zürich"]);
  });

  it("converts numeric strings to numbers", () => {
    const table = parseCSV("val\n42\n3.14");
    expect(table.rows[0][0]).toBe(42);
    expect(table.rows[1][0]).toBe(3.14);
  });

  it("keeps non-numeric strings as strings", () => {
    const table = parseCSV("val\nhello");
    expect(table.rows[0][0]).toBe("hello");
  });

  it("treats empty cells as null", () => {
    const table = parseCSV("a,b\n1,");
    expect(table.rows[0]).toEqual([1, null]);
  });
});

// ── parseJSON ────────────────────────────────────────────────────

describe("parseJSON", () => {
  it("parses a JSON array of objects", () => {
    const table = parseJSON('[{"x":1,"y":2},{"x":3,"y":4}]');
    expect(table.columns).toEqual(["x", "y"]);
    expect(table.rows).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it("parses a JSON object with an array property", () => {
    const table = parseJSON('{"data":[{"a":"hello"}]}');
    expect(table.columns).toEqual(["a"]);
    expect(table.rows).toEqual([["hello"]]);
  });

  it("wraps a single object into one row", () => {
    const table = parseJSON('{"name":"Alice","age":30}');
    expect(table.columns).toContain("name");
    expect(table.columns).toContain("age");
    expect(table.rows).toHaveLength(1);
  });

  it("handles nested values by stringifying", () => {
    const table = parseJSON('[{"info":{"nested":true}}]');
    // nested objects are stringified
    expect(table.rows[0][0]).toBe("[object Object]");
  });

  it("returns empty table for empty array", () => {
    const table = parseJSON("[]");
    expect(table.columns).toEqual([]);
    expect(table.rows).toEqual([]);
  });

  it("handles null values", () => {
    const table = parseJSON('[{"a":null}]');
    expect(table.rows[0][0]).toBe(null);
  });
});

// ── filterRows ───────────────────────────────────────────────────

describe("filterRows", () => {
  const table = makeTable(
    ["name", "score"],
    [
      ["Alice", 90],
      ["Bob", 75],
      ["Carol", 85],
    ],
  );

  it("filters with eq operator", () => {
    const result = filterRows(table, "name", "eq", "Alice");
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0][0]).toBe("Alice");
  });

  it("filters with gt operator", () => {
    const result = filterRows(table, "score", "gt", 80);
    expect(result.rows).toHaveLength(2);
  });

  it("filters with contains operator (case insensitive)", () => {
    const result = filterRows(table, "name", "contains", "bo");
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0][0]).toBe("Bob");
  });

  it("filters with lt operator", () => {
    const result = filterRows(table, "score", "lt", 80);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0][0]).toBe("Bob");
  });

  it("returns empty rows when no match", () => {
    const result = filterRows(table, "score", "gt", 100);
    expect(result.rows).toHaveLength(0);
  });

  it("throws on unknown column", () => {
    expect(() => filterRows(table, "missing", "eq", 1)).toThrow("Column \"missing\" not found");
  });

  it("handles notNull operator", () => {
    const withNull = makeTable(["a"], [[1], [null], [3]]);
    const result = filterRows(withNull, "a", "notNull", null);
    expect(result.rows).toHaveLength(2);
  });

  it("handles isNull operator", () => {
    const withNull = makeTable(["a"], [[1], [null], [3]]);
    const result = filterRows(withNull, "a", "isNull", null);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0][0]).toBe(null);
  });
});

// ── aggregateBy ──────────────────────────────────────────────────

describe("aggregateBy", () => {
  const table = makeTable(
    ["dept", "salary"],
    [
      ["eng", 100],
      ["eng", 120],
      ["sales", 80],
      ["sales", 90],
    ],
  );

  it("computes sum", () => {
    const result = aggregateBy(table, "dept", "salary", "sum");
    const eng = result.rows.find((r) => r[0] === "eng");
    expect(eng![1]).toBe(220);
  });

  it("computes avg", () => {
    const result = aggregateBy(table, "dept", "salary", "avg");
    const eng = result.rows.find((r) => r[0] === "eng");
    expect(eng![1]).toBe(110);
  });

  it("computes count", () => {
    const result = aggregateBy(table, "dept", "salary", "count");
    const eng = result.rows.find((r) => r[0] === "eng");
    expect(eng![1]).toBe(2);
  });

  it("computes min", () => {
    const result = aggregateBy(table, "dept", "salary", "min");
    const sales = result.rows.find((r) => r[0] === "sales");
    expect(sales![1]).toBe(80);
  });

  it("computes max", () => {
    const result = aggregateBy(table, "dept", "salary", "max");
    const sales = result.rows.find((r) => r[0] === "sales");
    expect(sales![1]).toBe(90);
  });

  it("produces columns named [groupBy, op(column)]", () => {
    const result = aggregateBy(table, "dept", "salary", "sum");
    expect(result.columns).toEqual(["dept", "sum(salary)"]);
  });
});

// ── sortBy ───────────────────────────────────────────────────────

describe("sortBy", () => {
  const table = makeTable(
    ["name", "val"],
    [
      ["B", 2],
      ["A", 3],
      ["C", 1],
    ],
  );

  it("sorts ascending by number", () => {
    const result = sortBy(table, "val", "asc");
    expect(result.rows.map((r) => r[1])).toEqual([1, 2, 3]);
  });

  it("sorts descending by number", () => {
    const result = sortBy(table, "val", "desc");
    expect(result.rows.map((r) => r[1])).toEqual([3, 2, 1]);
  });

  it("sorts ascending by string", () => {
    const result = sortBy(table, "name", "asc");
    expect(result.rows.map((r) => r[0])).toEqual(["A", "B", "C"]);
  });

  it("sorts descending by string", () => {
    const result = sortBy(table, "name", "desc");
    expect(result.rows.map((r) => r[0])).toEqual(["C", "B", "A"]);
  });

  it("pushes nulls to the end regardless of direction", () => {
    const withNull = makeTable(["a"], [[3], [null], [1]]);
    const result = sortBy(withNull, "a", "asc");
    expect(result.rows.map((r) => r[0])).toEqual([1, 3, null]);
  });
});

// ── pivotTable ───────────────────────────────────────────────────

describe("pivotTable", () => {
  it("pivots a basic table", () => {
    const table = makeTable(
      ["region", "quarter", "revenue"],
      [
        ["East", "Q1", 100],
        ["East", "Q2", 150],
        ["West", "Q1", 200],
        ["West", "Q2", 250],
      ],
    );
    const result = pivotTable(table, "region", "quarter", "revenue");
    expect(result.columns).toEqual(["region", "Q1", "Q2"]);
    const east = result.rows.find((r) => r[0] === "East");
    expect(east).toEqual(["East", 100, 150]);
    const west = result.rows.find((r) => r[0] === "West");
    expect(west).toEqual(["West", 200, 250]);
  });
});

// ── convertFormat ────────────────────────────────────────────────

describe("convertFormat", () => {
  const table = makeTable(
    ["name", "score"],
    [
      ["Alice", 90],
      ["Bob", 80],
    ],
  );

  it("converts to CSV", () => {
    const csv = convertFormat(table, "csv");
    expect(csv).toContain("name,score");
    expect(csv).toContain("Alice,90");
  });

  it("converts to JSON", () => {
    const json = convertFormat(table, "json");
    const parsed = JSON.parse(json);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].name).toBe("Alice");
  });

  it("converts to markdown", () => {
    const md = convertFormat(table, "markdown");
    expect(md).toContain("| name | score |");
    expect(md).toContain("| --- | --- |");
    expect(md).toContain("| Alice | 90 |");
  });

  it("converts to latex", () => {
    const latex = convertFormat(table, "latex");
    expect(latex).toContain("\\begin{tabular}");
    expect(latex).toContain("\\toprule");
    expect(latex).toContain("\\bottomrule");
    expect(latex).toContain("Alice");
  });

  it("escapes commas in CSV output", () => {
    const t = makeTable(["val"], [["a,b"]]);
    const csv = convertFormat(t, "csv");
    expect(csv).toContain('"a,b"');
  });
});

// ── cleanData ────────────────────────────────────────────────────

describe("cleanData", () => {
  it("removes rows with nulls (column-specific)", () => {
    const table = makeTable(
      ["a", "b"],
      [
        [1, "x"],
        [null, "y"],
        [3, "z"],
      ],
    );
    const result = cleanData(table, [{ type: "removeNulls", column: "a" }]);
    expect(result.rows).toHaveLength(2);
  });

  it("removes all-null rows when no column specified", () => {
    const table = makeTable(
      ["a", "b"],
      [
        [1, "x"],
        [null, null],
        [3, "z"],
      ],
    );
    const result = cleanData(table, [{ type: "removeNulls" }]);
    expect(result.rows).toHaveLength(2);
  });

  it("trims whitespace from strings", () => {
    const table = makeTable(["a"], [["  hello  "], ["world "]]);
    const result = cleanData(table, [{ type: "trim" }]);
    expect(result.rows[0][0]).toBe("hello");
    expect(result.rows[1][0]).toBe("world");
  });

  it("deduplicates rows", () => {
    const table = makeTable(
      ["a"],
      [[1], [2], [1], [2]],
    );
    const result = cleanData(table, [{ type: "dedup" }]);
    expect(result.rows).toHaveLength(2);
  });

  it("fills default values for nulls", () => {
    const table = makeTable(["a"], [[null], [5]]);
    const result = cleanData(table, [
      { type: "fillDefault", column: "a", defaultValue: 0 },
    ]);
    expect(result.rows[0][0]).toBe(0);
    expect(result.rows[1][0]).toBe(5);
  });

  it("coerces column to number", () => {
    const table = makeTable(["a"], [["42"], ["abc"]]);
    const result = cleanData(table, [
      { type: "coerce", column: "a", targetType: "number" },
    ]);
    expect(result.rows[0][0]).toBe(42);
    expect(result.rows[1][0]).toBe(0); // NaN coerced to 0
  });
});

// ── deriveColumn ─────────────────────────────────────────────────

describe("deriveColumn", () => {
  it("derives a new column from an expression", () => {
    const table = makeTable(["x"], [[2], [3], [4]]);
    const result = deriveColumn(table, "doubled", "row.x * 2");
    expect(result.columns).toEqual(["x", "doubled"]);
    expect(result.rows[0][1]).toBe(4);
    expect(result.rows[1][1]).toBe(6);
    expect(result.rows[2][1]).toBe(8);
  });

  it("returns null for invalid expressions", () => {
    const table = makeTable(["x"], [[1]]);
    const result = deriveColumn(table, "bad", "import('fs')");
    expect(result.rows[0][1]).toBe(null);
  });
});

// ── detectColumnTypes ────────────────────────────────────────────

describe("detectColumnTypes", () => {
  it("detects number, string, and mixed columns", () => {
    const table = makeTable(
      ["num", "str", "mix"],
      [
        [1, "a", 1],
        [2, "b", "x"],
      ],
    );
    const types = detectColumnTypes(table);
    expect(types).toEqual(["number", "string", "mixed"]);
  });

  it("detects empty columns (all null)", () => {
    const table = makeTable(["a"], [[null], [null]]);
    const types = detectColumnTypes(table);
    expect(types).toEqual(["empty"]);
  });
});

// ── Edge cases ───────────────────────────────────────────────────

describe("edge cases", () => {
  it("handles single-row table in all transforms", () => {
    const table = makeTable(["a", "b"], [[1, 2]]);

    const filtered = filterRows(table, "a", "eq", 1);
    expect(filtered.rows).toHaveLength(1);

    const sorted = sortBy(table, "a", "asc");
    expect(sorted.rows).toHaveLength(1);

    const aggregated = aggregateBy(table, "a", "b", "sum");
    expect(aggregated.rows).toHaveLength(1);
  });

  it("returns empty CSV for whitespace-only input", () => {
    const table = parseCSV("   \n  ");
    expect(table.columns).toEqual([]);
    expect(table.rows).toEqual([]);
  });
});
