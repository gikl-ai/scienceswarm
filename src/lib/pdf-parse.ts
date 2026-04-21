export const PDF_PARSE_TIMEOUT_MS = 3_000;

type PdfParseCtor<TParser> = new (opts: { data: Buffer }) => TParser;

export function loadPdfParseCtor<TParser>(): PdfParseCtor<TParser> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { PDFParse } = require("pdf-parse") as { PDFParse: PdfParseCtor<TParser> };
  return PDFParse;
}

export async function withPdfParseTimeout<T>(
  operation: Promise<T>,
  label: string,
  timeoutMs = PDF_PARSE_TIMEOUT_MS,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    return await new Promise<T>((resolve, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(`pdf-parse ${label} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      operation.then(resolve, reject);
    });
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}
