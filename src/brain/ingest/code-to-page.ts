/**
 * Source-code ingest — wraps a file body in a fenced markdown code block
 * with the language derived from the extension. No syntax validation, no
 * parsing, no import rewriting; the goal is to get the content into gbrain
 * verbatim so a downstream job can read it back.
 */

import { createReadStream } from "node:fs";
import { StringDecoder } from "node:string_decoder";

export interface CodeIngestResult {
  language: string;
  lineCount: number;
  markdown: string;
}

export interface CodeIngestFileOptions {
  /** Maximum UTF-8 bytes to embed in the markdown page preview. */
  maxMarkdownBytes?: number;
}

const DEFAULT_MAX_MARKDOWN_BYTES = 1024 * 1024;

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  py: "python",
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  r: "r",
  R: "r",
  sh: "bash",
  bash: "bash",
  zsh: "zsh",
  rb: "ruby",
  go: "go",
  rs: "rust",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  jl: "julia",
  m: "matlab",
  lua: "lua",
  sql: "sql",
};

export function resolveLanguageFromFileName(fileName: string): string {
  const lower = fileName.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot === -1 || dot === lower.length - 1) return "text";
  const ext = lower.slice(dot + 1);
  return LANGUAGE_BY_EXTENSION[ext] ?? "text";
}

export function ingestCodeContent(
  content: string,
  fileName: string,
): CodeIngestResult {
  const language = resolveLanguageFromFileName(fileName);
  const lineCount = content.split(/\r\n|\r|\n/).length;
  const markdown = `\`\`\`${language}\n${content.replace(/\r\n?/g, "\n")}\n\`\`\``;
  return { language, lineCount, markdown };
}

export async function ingestCodeFile(
  filePath: string,
  fileName: string,
  options: CodeIngestFileOptions = {},
): Promise<CodeIngestResult> {
  const language = resolveLanguageFromFileName(fileName);
  const maxMarkdownBytes = options.maxMarkdownBytes ?? DEFAULT_MAX_MARKDOWN_BYTES;
  const decoder = new StringDecoder("utf8");
  const stream = createReadStream(filePath);

  let preview = "";
  let previewBytes = 0;
  let truncated = false;
  let sawAnyData = false;
  let pendingCr = false;
  let separatorCount = 0;

  const appendPreview = (text: string) => {
    if (truncated || text.length === 0) return;
    const bytes = Buffer.byteLength(text, "utf8");
    if (previewBytes + bytes <= maxMarkdownBytes) {
      preview += text;
      previewBytes += bytes;
      return;
    }

    let allowed = maxMarkdownBytes - previewBytes;
    for (const ch of text) {
      const chBytes = Buffer.byteLength(ch, "utf8");
      if (chBytes > allowed) break;
      preview += ch;
      previewBytes += chBytes;
      allowed -= chBytes;
    }
    truncated = true;
  };

  const consumeDecoded = (text: string) => {
    if (text.length === 0) return;
    sawAnyData = true;
    let normalized = "";

    for (const ch of text) {
      if (pendingCr) {
        separatorCount += 1;
        normalized += "\n";
        pendingCr = false;
        if (ch === "\n") {
          continue;
        }
      }

      if (ch === "\r") {
        pendingCr = true;
      } else if (ch === "\n") {
        separatorCount += 1;
        normalized += "\n";
      } else {
        normalized += ch;
      }
    }

    appendPreview(normalized);
  };

  for await (const chunk of stream) {
    consumeDecoded(decoder.write(chunk as Buffer));
  }
  consumeDecoded(decoder.end());
  if (pendingCr) {
    separatorCount += 1;
    appendPreview("\n");
  }

  const lineCount = sawAnyData ? separatorCount + 1 : 1;
  const truncationNote = truncated
    ? "\n\n/* Source preview truncated; the complete file is stored as the source file object. */"
    : "";
  const markdown = `\`\`\`${language}\n${preview}${truncationNote}\n\`\`\``;

  return { language, lineCount, markdown };
}
