/**
 * POST /api/analyze-folder
 *
 * Receives folder metadata + file contents, returns a structured AI analysis
 * of the research project. Uses the unified chat backend.
 */

import { buildImportPreview } from "@/lib/import/preview-core";
import { isLocalRequest } from "@/lib/local-guard";

interface AnalyzeFolderFileContent {
  path: string;
  type: string;
  content: string;
}

interface AnalyzeFolderPreviewFile extends AnalyzeFolderFileContent {
  size?: number;
  metadata?: Record<string, unknown>;
  hash?: string;
}

export async function POST(request: Request) {
  if (!(await isLocalRequest(request))) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const body = await request.json();
    if (!isAnalyzeFolderBody(body)) {
      return Response.json(
        { error: "Missing or invalid summary or fileContents" },
        { status: 400 }
      );
    }
    const { summary, fileContents, previewFiles } = body;

    // Build the analysis prompt
    const fileDescriptions = fileContents
      .slice(0, 30) // cap at 30 files to stay within context
      .map((f) => {
        const contentPreview = f.content.slice(0, 2000);
        return `--- ${f.path} (${f.type}) ---\n${contentPreview}`;
      })
      .join("\n\n");

    const prompt = `Analyze this research study folder. Here is a structural summary and file contents:

STRUCTURE:
${summary}

FILE CONTENTS:
${fileDescriptions}

Provide a structured analysis with these sections:
1. **Papers**: What papers/documents are here? Key topics and contributions.
2. **Code**: What does the code do? Main scripts, algorithms, dependencies.
3. **Data**: What datasets exist? Row counts, columns, key statistics.
4. **Experiments**: What experiments or results are present?
5. **Gaps**: What is missing? Missing tests, incomplete data, potential improvements.

Format the response as a project overview that a researcher would find useful.
Use emoji prefixes for each section header.`;

    let output: { analysis: string; backend: string } | null = null;

    // Try to send through the unified chat endpoint for AI processing
    try {
      const chatRes = await fetch(new URL("/api/chat/unified", request.url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: prompt }),
      });

      if (chatRes.ok) {
        const chatData = await chatRes.json();
        if (chatData.response) {
          output = {
            analysis: chatData.response,
            backend: chatData.backend || "unknown",
          };
        }
      }
    } catch {
      // Chat backend unavailable — fall through to local analysis
    }

    const finalOutput = output ?? {
      analysis: buildLocalAnalysis(summary, fileContents),
      backend: "local",
    };
    const preview = buildPreview(summary, fileContents, previewFiles, finalOutput);
    return Response.json({
      analysis: finalOutput.analysis,
      backend: finalOutput.backend,
      preview,
      projects: preview.projects,
      duplicateGroups: preview.duplicateGroups,
      warnings: preview.warnings,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Analysis error";
    console.error("Folder analysis error:", message);
    return Response.json({ error: "Failed to analyze folder" }, { status: 500 });
  }
}

function buildPreview(
  summary: string,
  fileContents: AnalyzeFolderFileContent[],
  previewFiles: AnalyzeFolderPreviewFile[] | undefined,
  output: { analysis: string; backend: string },
) {
  return buildImportPreview({
    analysis: output.analysis,
    backend: output.backend,
    summary,
    files:
      previewFiles?.length
        ? previewFiles.map((file) => ({
            path: file.path,
            type: file.type,
            size: file.size ?? estimateTextSize(file.content),
            content: file.content,
            hash: file.hash,
            metadata: file.metadata,
          }))
        : fileContents.map((file) => ({
            path: file.path,
            type: file.type,
            size: estimateTextSize(file.content),
            content: file.content,
          })),
  });
}

function isAnalyzeFolderBody(
  value: unknown,
): value is {
  summary: string;
  fileContents: AnalyzeFolderFileContent[];
  previewFiles?: AnalyzeFolderPreviewFile[];
} {
  if (!value || typeof value !== "object") return false;

  const body = value as {
    summary?: unknown;
    fileContents?: unknown;
    previewFiles?: unknown;
  };

  return (
    typeof body.summary === "string" &&
    Array.isArray(body.fileContents) &&
    body.fileContents.every(isAnalyzeFolderFileContent) &&
    (body.previewFiles === undefined ||
      (Array.isArray(body.previewFiles) && body.previewFiles.every(isAnalyzeFolderPreviewFile)))
  );
}

function isAnalyzeFolderFileContent(value: unknown): value is AnalyzeFolderFileContent {
  if (!value || typeof value !== "object") return false;
  const file = value as Record<string, unknown>;
  return (
    typeof file.path === "string" &&
    typeof file.type === "string" &&
    typeof file.content === "string"
  );
}

function isAnalyzeFolderPreviewFile(value: unknown): value is AnalyzeFolderPreviewFile {
  if (!value || typeof value !== "object") return false;
  if (!isAnalyzeFolderFileContent(value)) return false;
  const file = value as {
    size?: unknown;
    hash?: unknown;
    metadata?: unknown;
  };
  return (
    (file.size === undefined || typeof file.size === "number") &&
    (file.hash === undefined || typeof file.hash === "string") &&
    (file.metadata === undefined ||
      (typeof file.metadata === "object" && file.metadata !== null && !Array.isArray(file.metadata)))
  );
}

function estimateTextSize(content: string): number {
  return new TextEncoder().encode(content).length;
}

// ── Local fallback analysis ──────────────────────────────────

function buildLocalAnalysis(
  summary: string,
  fileContents: AnalyzeFolderFileContent[]
): string {
  const papers = fileContents.filter((f) => f.type === "pdf");
  const code = fileContents.filter((f) =>
    ["py", "js", "ts", "r", "jl", "m", "sh"].includes(f.type)
  );
  const data = fileContents.filter((f) =>
    ["csv", "json", "tsv"].includes(f.type)
  );
  const tex = fileContents.filter((f) =>
    ["tex", "bib"].includes(f.type)
  );

  const sections: string[] = [
    `Study Analysis`,
    "",
    summary,
    "",
  ];

  if (papers.length > 0) {
    sections.push(`Papers (${papers.length} found):`);
    for (const p of papers) {
      sections.push(`  - ${p.path}`);
    }
    sections.push("");
  }

  if (code.length > 0) {
    sections.push(`Code (${code.length} files):`);
    for (const c of code) {
      // Try to extract a doc string or first comment
      const firstLine = c.content.split("\n").find((l) => l.trim().startsWith("#") || l.trim().startsWith("//") || l.trim().startsWith('"""'));
      sections.push(`  - ${c.path}${firstLine ? ` -- ${firstLine.trim().slice(0, 60)}` : ""}`);
    }
    sections.push("");
  }

  if (data.length > 0) {
    sections.push(`Data (${data.length} files):`);
    for (const d of data) {
      if (d.type === "json") {
        try {
          const parsed = JSON.parse(d.content);
          const items = Array.isArray(parsed) ? parsed.length : 1;
          const keys = Array.isArray(parsed) && parsed.length > 0
            ? Object.keys(parsed[0]).length
            : typeof parsed === "object" && parsed !== null
              ? Object.keys(parsed).length
              : 0;
          sections.push(`  - ${d.path} -- ${items} items, ${keys} keys`);
        } catch {
          sections.push(`  - ${d.path} -- JSON (could not parse)`);
        }
      } else {
        const lines = d.content.split("\n");
        const rowCount = lines.length - 1;
        const separator = d.type === "tsv" ? "\t" : ",";
        const cols = lines[0]?.split(separator).length || 0;
        sections.push(`  - ${d.path} -- ${rowCount} rows, ${cols} columns`);
      }
    }
    sections.push("");
  }

  if (tex.length > 0) {
    sections.push(`LaTeX (${tex.length} files):`);
    for (const t of tex) {
      sections.push(`  - ${t.path}`);
    }
    sections.push("");
  }

  sections.push(
    "Gaps identified:",
    "  - Run the AI analysis (requires OpenClaw/OpenHands) for detailed gap detection",
  );

  return sections.join("\n");
}
