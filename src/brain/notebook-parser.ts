/**
 * Second Brain — Jupyter Notebook Parser
 *
 * Parses .ipynb JSON files to extract metadata for wiki page generation.
 * Extracts imports, function definitions, outputs, and experiment structure
 * from notebook cells without loading actual image data.
 */

import { readFileSync } from "fs";
import { basename } from "path";

// ── Types ────────────────────────────────────────────

export interface NotebookMetadata {
  title: string | null;
  description: string | null;
  language: string;
  cellCount: { code: number; markdown: number; raw: number };
  imports: string[];
  functions: string[];
  outputs: Array<{
    cellIndex: number;
    outputType: "text" | "image" | "table" | "error";
    preview: string;
  }>;
  variables: string[];
  hasResults: boolean;
  experiment?: {
    hypothesis: string | null;
    method: string | null;
    results: string | null;
  };
}

// ── Notebook cell types (subset of nbformat v4) ─────

interface NotebookCell {
  cell_type: "code" | "markdown" | "raw";
  source: string | string[];
  outputs?: NotebookOutput[];
  metadata?: Record<string, unknown>;
}

interface NotebookOutput {
  output_type: string;
  text?: string | string[];
  data?: Record<string, unknown>;
  ename?: string;
  evalue?: string;
  traceback?: string[];
}

interface NotebookJSON {
  metadata?: {
    kernelspec?: { language?: string; display_name?: string; name?: string };
    language_info?: { name?: string };
  };
  cells?: NotebookCell[];
  nbformat?: number;
}

// ── Public API ───────────────────────────────────────

/**
 * Parse a .ipynb file and extract structured metadata.
 */
export function parseNotebook(filePath: string): NotebookMetadata {
  const raw = readFileSync(filePath, "utf-8");
  const nb: NotebookJSON = JSON.parse(raw);
  return parseNotebookJSON(nb);
}

/**
 * Parse notebook JSON directly (useful for testing without files).
 */
export function parseNotebookJSON(nb: NotebookJSON): NotebookMetadata {
  const cells = nb.cells ?? [];

  // Detect language from kernel info
  const language = detectLanguage(nb);

  // Count cells by type
  const cellCount = { code: 0, markdown: 0, raw: 0 };
  for (const cell of cells) {
    if (cell.cell_type === "code") cellCount.code++;
    else if (cell.cell_type === "markdown") cellCount.markdown++;
    else if (cell.cell_type === "raw") cellCount.raw++;
  }

  // Extract title and description from first markdown cell
  const { title, description } = extractTitleAndDescription(cells);

  // Extract imports from code cells
  const imports = extractImports(cells, language);

  // Extract function definitions from code cells
  const functions = extractFunctions(cells, language);

  // Extract variable assignments from code cells
  const variables = extractVariables(cells, language);

  // Extract output previews
  const outputs = extractOutputs(cells);

  // Check if any code cells have output
  const hasResults = outputs.length > 0;

  // Detect experiment structure from markdown cells
  const experiment = detectExperimentStructure(cells);

  return {
    title,
    description,
    language,
    cellCount,
    imports,
    functions,
    outputs,
    variables,
    hasResults,
    ...(experiment ? { experiment } : {}),
  };
}

/**
 * Generate a wiki experiment page from notebook metadata.
 */
export function notebookToExperimentPage(
  metadata: NotebookMetadata,
  sourcePath: string,
): string {
  const date = new Date().toISOString().slice(0, 10);
  const title = metadata.title ?? basename(sourcePath, ".ipynb").replace(/[-_]/g, " ");

  const lines: string[] = [
    "---",
    `title: "${escapeYaml(title)}"`,
    `date: ${date}`,
    "type: experiment",
    "para: projects",
    `status: ${metadata.hasResults ? "completed" : "planning"}`,
    "hypotheses: []",
    `tags: [notebook, ${metadata.language}]`,
    `source: "${sourcePath}"`,
    "---",
    "",
    `# ${title}`,
    "",
  ];

  // Purpose section
  lines.push("## Purpose");
  if (metadata.experiment?.hypothesis) {
    lines.push(metadata.experiment.hypothesis);
  } else if (metadata.description) {
    lines.push(metadata.description);
  } else {
    lines.push(`Notebook analysis in ${metadata.language}.`);
  }
  lines.push("");

  // Method section
  lines.push("## Method");
  if (metadata.experiment?.method) {
    lines.push(metadata.experiment.method);
    lines.push("");
  }
  if (metadata.imports.length > 0) {
    lines.push("### Dependencies");
    for (const imp of metadata.imports) {
      lines.push(`- \`${imp}\``);
    }
    lines.push("");
  }
  if (metadata.functions.length > 0) {
    lines.push("### Key Functions");
    for (const fn of metadata.functions) {
      lines.push(`- \`${fn}()\``);
    }
    lines.push("");
  }

  // Results section
  lines.push("## Results");
  if (metadata.experiment?.results) {
    lines.push(metadata.experiment.results);
  } else if (metadata.outputs.length > 0) {
    for (const out of metadata.outputs.slice(0, 10)) {
      if (out.outputType === "image") {
        lines.push(`- Cell ${out.cellIndex}: ${out.preview}`);
      } else if (out.outputType === "error") {
        lines.push(`- Cell ${out.cellIndex} (error): ${out.preview}`);
      } else {
        lines.push(`- Cell ${out.cellIndex}: \`${out.preview}\``);
      }
    }
  } else {
    lines.push("*No outputs captured — notebook may need re-execution.*");
  }
  lines.push("");

  // Stats section
  lines.push("## Notebook Stats");
  lines.push(`- **Language**: ${metadata.language}`);
  lines.push(
    `- **Cells**: ${metadata.cellCount.code} code, ${metadata.cellCount.markdown} markdown, ${metadata.cellCount.raw} raw`,
  );
  if (metadata.variables.length > 0) {
    lines.push(`- **Variables**: ${metadata.variables.slice(0, 20).join(", ")}`);
  }
  lines.push("");

  // Source link
  lines.push("## Source");
  lines.push(`- [[raw/experiments/${basename(sourcePath)}]]`);

  return lines.join("\n") + "\n";
}

// ── Internal Helpers ─────────────────────────────────

function detectLanguage(nb: NotebookJSON): string {
  const langInfo = nb.metadata?.language_info?.name;
  if (langInfo) return langInfo.toLowerCase();

  const kernelLang = nb.metadata?.kernelspec?.language;
  if (kernelLang) return kernelLang.toLowerCase();

  const kernelName = nb.metadata?.kernelspec?.name ?? "";
  if (/python/i.test(kernelName)) return "python";
  if (/^ir$/i.test(kernelName) || /^r$/i.test(kernelName)) return "r";
  if (/julia/i.test(kernelName)) return "julia";

  return "python"; // default
}

function cellSource(cell: NotebookCell): string {
  return Array.isArray(cell.source) ? cell.source.join("") : cell.source;
}

function extractTitleAndDescription(
  cells: NotebookCell[],
): { title: string | null; description: string | null } {
  for (const cell of cells) {
    if (cell.cell_type !== "markdown") continue;
    const src = cellSource(cell).trim();
    if (!src) continue;

    const headingMatch = src.match(/^#\s+(.+)$/m);
    const title = headingMatch ? headingMatch[1].trim() : null;

    // Description is the first paragraph after the heading, or the whole cell if no heading
    let description: string | null = null;
    if (headingMatch) {
      const afterHeading = src.slice(headingMatch.index! + headingMatch[0].length).trim();
      const firstParagraph = afterHeading.split(/\n\s*\n/)[0]?.trim();
      description = firstParagraph || null;
    } else {
      const firstParagraph = src.split(/\n\s*\n/)[0]?.trim();
      description = firstParagraph || null;
    }

    return { title, description };
  }
  return { title: null, description: null };
}

function extractImports(cells: NotebookCell[], language: string): string[] {
  const imports = new Set<string>();

  for (const cell of cells) {
    if (cell.cell_type !== "code") continue;
    const src = cellSource(cell);

    if (language === "python") {
      // import X, import X as Y, import X.Y
      for (const match of src.matchAll(/^\s*import\s+([\w.]+)/gm)) {
        imports.add(match[1].split(".")[0]);
      }
      // from X import Y, from X.Y import Z
      for (const match of src.matchAll(/^\s*from\s+([\w.]+)\s+import/gm)) {
        imports.add(match[1].split(".")[0]);
      }
    } else if (language === "r") {
      // library(X), require(X)
      for (const match of src.matchAll(/(?:library|require)\s*\(\s*["']?(\w+)["']?\s*\)/gm)) {
        imports.add(match[1]);
      }
    } else if (language === "julia") {
      // using X, import X
      for (const match of src.matchAll(/^\s*(?:using|import)\s+([\w.]+)/gm)) {
        imports.add(match[1].split(".")[0]);
      }
    }
  }

  return [...imports].sort();
}

function extractFunctions(cells: NotebookCell[], language: string): string[] {
  const functions: string[] = [];

  for (const cell of cells) {
    if (cell.cell_type !== "code") continue;
    const src = cellSource(cell);

    if (language === "python") {
      // def func_name( and class ClassName(
      for (const match of src.matchAll(/^\s*def\s+(\w+)\s*\(/gm)) {
        functions.push(match[1]);
      }
      for (const match of src.matchAll(/^\s*class\s+(\w+)/gm)) {
        functions.push(match[1]);
      }
    } else if (language === "r") {
      // func_name <- function(
      for (const match of src.matchAll(/^\s*(\w+)\s*<-\s*function\s*\(/gm)) {
        functions.push(match[1]);
      }
    } else if (language === "julia") {
      // function func_name(
      for (const match of src.matchAll(/^\s*function\s+(\w+)/gm)) {
        functions.push(match[1]);
      }
    }
  }

  return functions;
}

function extractVariables(cells: NotebookCell[], language: string): string[] {
  const variables = new Set<string>();

  for (const cell of cells) {
    if (cell.cell_type !== "code") continue;
    const src = cellSource(cell);

    if (language === "python") {
      // Simple assignment: var = ...
      for (const match of src.matchAll(/^\s*([a-zA-Z_]\w*)\s*=/gm)) {
        const name = match[1];
        // Skip dunders, private, common loop vars, and keywords
        if (
          !name.startsWith("__") &&
          !name.startsWith("_") &&
          !PYTHON_SKIP_VARS.has(name)
        ) {
          variables.add(name);
        }
      }
    } else if (language === "r") {
      // var <- ... or var = ...
      for (const match of src.matchAll(/^\s*(\w+)\s*(?:<-|=)\s/gm)) {
        variables.add(match[1]);
      }
    }
  }

  return [...variables];
}

const PYTHON_SKIP_VARS = new Set([
  "i", "j", "k", "x", "y", "self", "cls", "args", "kwargs",
  "True", "False", "None",
]);

function extractOutputs(
  cells: NotebookCell[],
): NotebookMetadata["outputs"] {
  const results: NotebookMetadata["outputs"] = [];

  for (let idx = 0; idx < cells.length; idx++) {
    const cell = cells[idx];
    if (cell.cell_type !== "code" || !cell.outputs) continue;

    for (const output of cell.outputs) {
      if (output.output_type === "error") {
        results.push({
          cellIndex: idx,
          outputType: "error",
          preview: `${output.ename ?? "Error"}: ${(output.evalue ?? "").slice(0, 200)}`,
        });
        continue;
      }

      // Check for image data first (don't load it) — images take priority
      // over text/plain fallback representations
      if (output.data) {
        const dataKeys = Object.keys(output.data);
        if (dataKeys.some((k) => k.startsWith("image/"))) {
          results.push({
            cellIndex: idx,
            outputType: "image",
            preview: "[image output]",
          });
          continue;
        }
      }

      // Stream or execute_result text
      const text = extractOutputText(output);
      if (text) {
        // Detect table-like output
        const isTable =
          text.includes("|") ||
          text.includes("\\t") ||
          /^\s*\w+\s+\w+\s+\w+/m.test(text);
        results.push({
          cellIndex: idx,
          outputType: isTable ? "table" : "text",
          preview: text.slice(0, 200),
        });
      }
    }
  }

  return results;
}

function extractOutputText(output: NotebookOutput): string | null {
  // Stream output
  if (output.text) {
    const text = Array.isArray(output.text)
      ? output.text.join("")
      : output.text;
    return text.trim() || null;
  }

  // execute_result or display_data with text/plain
  if (output.data) {
    const plain = output.data["text/plain"];
    if (plain) {
      const text = Array.isArray(plain)
        ? (plain as string[]).join("")
        : String(plain);
      return text.trim() || null;
    }
  }

  return null;
}

function detectExperimentStructure(
  cells: NotebookCell[],
): NotebookMetadata["experiment"] | null {
  let hypothesis: string | null = null;
  let method: string | null = null;
  let results: string | null = null;

  for (const cell of cells) {
    if (cell.cell_type !== "markdown") continue;
    const src = cellSource(cell).trim();
    const lower = src.toLowerCase();

    // Detect hypothesis section
    if (!hypothesis && /(?:^|\n)#{1,3}\s*hypothesis/i.test(src)) {
      hypothesis = extractSectionContent(src, /#{1,3}\s*hypothesis/i);
    } else if (!hypothesis && lower.includes("hypothesis:")) {
      const match = src.match(/hypothesis:\s*(.+)/i);
      if (match) hypothesis = match[1].trim();
    }

    // Detect method section
    if (
      !method &&
      /(?:^|\n)#{1,3}\s*(?:method|methodology|approach|procedure)/i.test(src)
    ) {
      method = extractSectionContent(
        src,
        /#{1,3}\s*(?:method|methodology|approach|procedure)/i,
      );
    }

    // Detect results section
    if (
      !results &&
      /(?:^|\n)#{1,3}\s*(?:results?|findings?|conclusion)/i.test(src)
    ) {
      results = extractSectionContent(
        src,
        /#{1,3}\s*(?:results?|findings?|conclusion)/i,
      );
    }
  }

  if (!hypothesis && !method && !results) return null;

  return { hypothesis, method, results };
}

function extractSectionContent(src: string, headerPattern: RegExp): string {
  const match = src.match(headerPattern);
  if (!match) return "";

  const afterHeader = src.slice(match.index! + match[0].length).trim();
  // Take content until the next heading or end
  const nextHeading = afterHeader.search(/\n#{1,3}\s/);
  const content =
    nextHeading === -1 ? afterHeader : afterHeader.slice(0, nextHeading);
  return content.trim().slice(0, 500);
}

function escapeYaml(s: string): string {
  return s.replace(/"/g, '\\"');
}
