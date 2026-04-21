import { sanitizePdfExtractedText } from "@/lib/pdf-text-extractor";

const XLSX_EXTENSIONS = new Set(["xlsx", "xlsm"]);
const MAX_TEXT_LENGTH = 80_000;
const MAX_ZIP_ENTRY_BYTES = 2_000_000;
const MAX_ZIP_TOTAL_BYTES = 8_000_000;

export interface ParsedFile {
  text: string;
  pages?: number;
  metadata?: Record<string, unknown>;
}

export interface ParseFileOptions {
  zipEntryByteLimit?: number;
  zipTotalByteLimit?: number;
}

/** Parse file content from a Buffer. Supports PDFs, notebooks, spreadsheets, and text files. */
export async function parseFile(
  buffer: Buffer,
  filename: string,
  options: ParseFileOptions = {},
): Promise<ParsedFile> {
  const ext = filename.split(".").pop()?.toLowerCase() || "";

  if (ext === "ipynb") {
    return parseNotebook(buffer, filename);
  }

  if (XLSX_EXTENSIONS.has(ext)) {
    return parseWorkbook(buffer, filename, options);
  }

  if (ext !== "pdf") {
    return { text: truncateText(buffer.toString("utf-8")) };
  }

  // pdf-parse v2: use PDFParse + getText() (v1 callable and old lib/ path removed).
  // Keep CommonJS require (not ESM) so we avoid the package entrypoint debug path under Next bundling.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { PDFParse } = require("pdf-parse") as {
    PDFParse: new (opts: { data: Buffer }) => {
      getText: () => Promise<{ text: string; total: number }>;
      destroy: () => Promise<void>;
    };
  };
  const parser = new PDFParse({ data: buffer });
  let data: { text: string; total: number };
  try {
    data = await parser.getText();
  } finally {
    await parser.destroy();
  }

  let text: string = sanitizePdfExtractedText(data.text || "");
  const pages: number = data.total || 0;

  if (text.trim().length === 0) {
    text =
      "[This PDF is image-based (scanned). No readable text found. Copy-paste the content into the chat.]";
  } else if (text.length > MAX_TEXT_LENGTH) {
    text =
      text.slice(0, MAX_TEXT_LENGTH) +
      "\n\n[... truncated at 80k chars, " +
      pages +
      " pages total ...]";
  }

  return { text, pages };
}

function truncateText(text: string): string {
  return text.length > MAX_TEXT_LENGTH
    ? text.slice(0, MAX_TEXT_LENGTH) + "\n\n[... truncated ...]"
    : text;
}

function parseNotebook(buffer: Buffer, filename: string): ParsedFile {
  try {
    const notebook = JSON.parse(buffer.toString("utf-8")) as {
      cells?: Array<{
        cell_type?: string;
        source?: string[] | string;
      }>;
    };
    const cells = notebook.cells ?? [];
    const lines = [`Notebook: ${filename}`];
    let markdownCells = 0;
    let codeCells = 0;

    for (const [index, cell] of cells.entries()) {
      const kind = cell.cell_type || "unknown";
      if (kind === "markdown") markdownCells += 1;
      if (kind === "code") codeCells += 1;

      const source = Array.isArray(cell.source) ? cell.source.join("") : cell.source || "";
      const trimmed = source.trim();
      if (!trimmed) continue;

      lines.push("", `Cell ${index + 1} [${kind}]`, trimmed);
    }

    return {
      text: truncateText(lines.join("\n")),
      metadata: {
        cells: cells.length,
        markdownCells,
        codeCells,
      },
    };
  } catch {
    return { text: truncateText(buffer.toString("utf-8")) };
  }
}

async function parseWorkbook(
  buffer: Buffer,
  filename: string,
  options: ParseFileOptions,
): Promise<ParsedFile> {
  const files = await readZipTextFiles(buffer, options);
  const workbookXml = files.get("xl/workbook.xml");

  if (!workbookXml) {
    return { text: `[Excel workbook: ${filename}]` };
  }

  const relationships = parseWorkbookRelationships(files.get("xl/_rels/workbook.xml.rels") || "");
  const sharedStrings = parseSharedStrings(files.get("xl/sharedStrings.xml") || "");
  const sheets = parseWorkbookSheets(workbookXml);

  const lines = [`Workbook: ${filename}`];
  let totalRows = 0;
  let maxColumns = 0;

  for (const sheet of sheets.slice(0, 5)) {
    const sheetPath = relationships.get(sheet.relationshipId) || inferWorksheetPath(sheet.relationshipId);
    const sheetXml = sheetPath ? files.get(sheetPath) : undefined;
    if (!sheetXml) continue;

    const allRows = parseWorksheetRows(sheetXml, sharedStrings);
    const rows = allRows.slice(0, 12);
    totalRows += Math.max(0, allRows.length - 1);
    for (const row of allRows) {
      maxColumns = Math.max(maxColumns, row.length);
    }

    lines.push("", `Sheet: ${sheet.name}`);
    for (const row of rows) {
      lines.push(row.join(" | "));
    }
  }

  return {
    text: truncateText(lines.join("\n")),
    metadata: {
      sheets: sheets.map((sheet) => sheet.name),
      rows: totalRows,
      columns: maxColumns,
    },
  };
}

interface WorkbookSheet {
  name: string;
  relationshipId: string;
}

function parseWorkbookSheets(xml: string): WorkbookSheet[] {
  const sheets: WorkbookSheet[] = [];
  const regex = /<sheet\b([^>]+?)\/>/g;

  for (const match of xml.matchAll(regex)) {
    const attrs = match[1] || "";
    const name = getXmlAttribute(attrs, "name");
    const relationshipId = getXmlAttribute(attrs, "r:id");
    if (!name || !relationshipId) continue;
    sheets.push({ name, relationshipId });
  }

  return sheets;
}

function parseWorkbookRelationships(xml: string): Map<string, string> {
  const relationships = new Map<string, string>();
  const regex = /<Relationship\b([^>]+?)\/>/g;

  for (const match of xml.matchAll(regex)) {
    const attrs = match[1] || "";
    const id = getXmlAttribute(attrs, "Id");
    const target = getXmlAttribute(attrs, "Target");
    if (!id || !target) continue;
    relationships.set(id, normalizeWorkbookTarget(target));
  }

  return relationships;
}

function normalizeWorkbookTarget(target: string): string {
  if (target.startsWith("xl/")) return target;
  if (target.startsWith("/")) return target.slice(1);
  return `xl/${target}`;
}

function inferWorksheetPath(relationshipId: string): string | null {
  const match = relationshipId.match(/(\d+)$/);
  return match ? `xl/worksheets/sheet${match[1]}.xml` : null;
}

function parseSharedStrings(xml: string): string[] {
  return Array.from(xml.matchAll(/<si\b[\s\S]*?<\/si>/g)).map((match) => {
    const text = Array.from(match[0].matchAll(/<t(?:\s+[^>]*)?>([\s\S]*?)<\/t>/g))
      .map((part) => decodeXml(part[1] || ""))
      .join("");
    return text;
  });
}

function parseWorksheetRows(xml: string, sharedStrings: string[]): string[][] {
  const rows: string[][] = [];

  for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const rowContent = rowMatch[1] || "";
    const cells: string[] = [];

    for (const cellMatch of rowContent.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = cellMatch[1] || "";
      const content = cellMatch[2] || "";
      const type = getXmlAttribute(attrs, "t");
      const value = extractCellValue(type, content, sharedStrings);
      cells.push(value);
    }

    if (cells.length > 0) {
      rows.push(cells);
    }
  }

  return rows;
}

function extractCellValue(
  type: string | null,
  content: string,
  sharedStrings: string[],
): string {
  if (type === "inlineStr") {
    return Array.from(content.matchAll(/<t(?:\s+[^>]*)?>([\s\S]*?)<\/t>/g))
      .map((match) => decodeXml(match[1] || ""))
      .join("");
  }

  const valueMatch = content.match(/<v>([\s\S]*?)<\/v>/);
  const raw = valueMatch ? decodeXml(valueMatch[1] || "") : "";

  if (type === "s") {
    const index = Number.parseInt(raw, 10);
    return Number.isFinite(index) ? (sharedStrings[index] || "") : "";
  }

  return raw;
}

function getXmlAttribute(attrs: string, name: string): string | null {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = attrs.match(new RegExp(`${escapedName}="([^"]*)"`, "i"));
  return match ? decodeXml(match[1]) : null;
}

function decodeXml(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

async function readZipTextFiles(
  buffer: Buffer,
  options: ParseFileOptions,
): Promise<Map<string, string>> {
  interface YauzlZipFile {
    readEntry: () => void;
    on(
      event: "entry",
      handler: (entry: { fileName: string; uncompressedSize?: number }) => void,
    ): void;
    on(event: "end", handler: () => void): void;
    on(event: "error", handler: (error: Error) => void): void;
    openReadStream: (
      entry: { fileName: string; uncompressedSize?: number },
      callback: (
        error: Error | null,
        stream?: (NodeJS.ReadableStream & { destroy: (error?: Error) => void }) | null,
      ) => void,
    ) => void;
    close: () => void;
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const yauzl = require("yauzl") as {
    fromBuffer: (
      input: Buffer,
      options: { lazyEntries: boolean },
      callback: (
        error: Error | null,
        zipfile: YauzlZipFile,
      ) => void,
    ) => void;
  };

  return await new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (error, zipfile) => {
      if (error || !zipfile) {
        reject(error || new Error("Could not read workbook zip"));
        return;
      }

      const files = new Map<string, string>();
      const entryByteLimit = options.zipEntryByteLimit ?? MAX_ZIP_ENTRY_BYTES;
      const totalByteLimit = options.zipTotalByteLimit ?? MAX_ZIP_TOTAL_BYTES;
      let settled = false;
      let totalBytes = 0;
      const closeZip = () => {
        try {
          zipfile.close();
        } catch {
          // Ignore close errors while unwinding a failed parse.
        }
      };
      const finish = () => {
        if (settled) return;
        settled = true;
        closeZip();
        resolve(files);
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        closeZip();
        reject(error);
      };

      zipfile.on("entry", (entry: { fileName: string; uncompressedSize?: number }) => {
        if (!entry.fileName.endsWith(".xml") && !entry.fileName.endsWith(".rels")) {
          zipfile.readEntry();
          return;
        }

        const advertisedSize = entry.uncompressedSize ?? 0;
        if (advertisedSize > entryByteLimit) {
          fail(new Error(`Zip entry ${entry.fileName} exceeds parser size limit`));
          return;
        }
        if (totalBytes + advertisedSize > totalByteLimit) {
          fail(new Error("Workbook archive exceeds parser size limit"));
          return;
        }

        zipfile.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            fail(streamError || new Error(`Could not read zip entry ${entry.fileName}`));
            return;
          }

          const chunks: Buffer[] = [];
          let entryBytes = 0;
          stream.on("data", (chunk: Buffer | string) => {
            const chunkBuffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            entryBytes += chunkBuffer.length;
            totalBytes += chunkBuffer.length;

            if (entryBytes > entryByteLimit) {
              stream.destroy(new Error(`Zip entry ${entry.fileName} exceeds parser size limit`));
              return;
            }
            if (totalBytes > totalByteLimit) {
              stream.destroy(new Error("Workbook archive exceeds parser size limit"));
              return;
            }

            chunks.push(chunkBuffer);
          });
          stream.on("error", (error) => fail(error instanceof Error ? error : new Error(String(error))));
          stream.on("end", () => {
            if (settled) return;
            files.set(entry.fileName, Buffer.concat(chunks).toString("utf-8"));
            zipfile.readEntry();
          });
        });
      });

      zipfile.on("end", finish);
      zipfile.on("error", fail);
      zipfile.readEntry();
    });
  });
}
