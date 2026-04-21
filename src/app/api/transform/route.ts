import {
  parseCSV,
  parseTSV,
  parseJSON,
  applyTransforms,
  convertFormat,
  type DataTable,
  type TransformStep,
} from "@/lib/data-transform";
import { generateChartSVG, analyzeData, type ChartSpec } from "@/lib/chart-generator";
import { isLocalRequest } from "@/lib/local-guard";

interface TransformRequest {
  action: "parse" | "transform" | "chart" | "export" | "auto-analyze";
  data?: string;
  format?: "csv" | "tsv" | "json" | "markdown" | "latex";
  table?: DataTable;
  steps?: TransformStep[];
  spec?: ChartSpec;
}

export async function POST(request: Request) {
  if (!(await isLocalRequest(request))) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const body = (await request.json()) as TransformRequest;

    switch (body.action) {
      case "parse": {
        if (!body.data || typeof body.data !== "string" || !body.format) {
          return Response.json({ error: "Missing data or format" }, { status: 400 });
        }
        if (body.format !== "csv" && body.format !== "tsv" && body.format !== "json") {
          return Response.json(
            { error: `Unsupported parse format: ${body.format}. Supported: csv, tsv, json` },
            { status: 400 }
          );
        }
        const table =
          body.format === "json" ? parseJSON(body.data) : body.format === "tsv" ? parseTSV(body.data) : parseCSV(body.data);
        return Response.json({ table });
      }

      case "transform": {
        if (!body.table || !body.steps) {
          return Response.json({ error: "Missing table or steps" }, { status: 400 });
        }
        const result = applyTransforms(body.table, body.steps);
        return Response.json({ table: result });
      }

      case "chart": {
        if (!body.table || !body.spec) {
          return Response.json({ error: "Missing table or spec" }, { status: 400 });
        }
        // Attach table data to spec
        const spec: ChartSpec = { ...body.spec, data: body.table };
        const svg = generateChartSVG(spec);
        return Response.json({ svg });
      }

      case "export": {
        if (!body.table || !body.format) {
          return Response.json({ error: "Missing table or format" }, { status: 400 });
        }
        if (
          body.format !== "csv" &&
          body.format !== "json" &&
          body.format !== "markdown" &&
          body.format !== "latex"
        ) {
          return Response.json({ error: "Invalid format" }, { status: 400 });
        }
        const output = convertFormat(body.table, body.format);
        return Response.json({ output });
      }

      case "auto-analyze": {
        if (!body.data || typeof body.data !== "string") {
          return Response.json({ error: "Missing data" }, { status: 400 });
        }

        // Detect format: if data looks like JSON (starts with [ or {), try JSON first
        let table: DataTable;
        const trimmed = body.data.trim();
        const looksLikeJSON = trimmed.startsWith("[") || trimmed.startsWith("{");

        if (looksLikeJSON) {
          try {
            table = parseJSON(body.data);
          } catch {
            try {
              table = parseCSV(body.data);
              if (table.columns.length === 0) throw new Error("empty");
            } catch {
              return Response.json({ error: "Could not parse data as JSON or CSV" }, { status: 400 });
            }
          }
        } else {
          try {
            table = parseCSV(body.data);
            if (table.columns.length === 0) throw new Error("empty");
          } catch {
            try {
              table = parseJSON(body.data);
            } catch {
              return Response.json({ error: "Could not parse data as CSV or JSON" }, { status: 400 });
            }
          }
        }

        const recommendations = analyzeData(table);
        const charts = recommendations.map((r) => r.spec);

        // Build a text summary
        const insights = buildInsights(table, recommendations);

        return Response.json({ table, charts, insights });
      }

      default:
        return Response.json({ error: `Unknown action: ${body.action}` }, { status: 400 });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    return Response.json({ error: message }, { status: 500 });
  }
}

function buildInsights(
  table: DataTable,
  recommendations: { reason: string }[]
): string {
  const lines: string[] = [];
  lines.push(`**Dataset**: ${table.rows.length} rows, ${table.columns.length} columns`);
  lines.push(`**Columns**: ${table.columns.join(", ")}`);

  // Basic stats for numeric columns
  for (let ci = 0; ci < table.columns.length; ci++) {
    const values = table.rows
      .map((r) => r[ci])
      .filter((v): v is number => typeof v === "number");
    if (values.length > 0) {
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      const min = Math.min(...values);
      const max = Math.max(...values);
      lines.push(
        `**${table.columns[ci]}**: min=${min}, max=${max}, mean=${mean.toFixed(2)}, n=${values.length}`
      );
    }
  }

  if (recommendations.length > 0) {
    lines.push("");
    lines.push("**Recommended visualizations:**");
    for (const rec of recommendations) {
      lines.push(`- ${rec.reason}`);
    }
  }

  return lines.join("\n");
}
