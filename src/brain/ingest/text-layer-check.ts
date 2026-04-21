/**
 * Text-layer sanity check for PDF ingest.
 *
 * P0 measurement found that a Google Books scan of Mendel 1866 silently
 * produced ~1,300 words of bilingual boilerplate from a 69-page PDF — zero
 * paper body. Every downstream consumer (critique, plan, execution) trusted
 * the output and produced garbage. Ingest MUST fail loud when extracted text
 * per page is below a floor, so the user discovers the problem at drop time
 * instead of an hour into a critique run.
 *
 * The v1 threshold is 200 words/page. A real paper runs 300-600 words/page;
 * 200 is a comfortable floor that image-only scans never approach.
 */

export const MIN_WORDS_PER_PAGE = 200;

export interface TextLayerCheckInput {
  wordCount: number;
  pageCount: number;
  fileName: string;
}

export interface TextLayerCheckResult {
  ok: boolean;
  wordsPerPage: number;
  message?: string;
}

/**
 * Classify a PDF text-extraction result as adequate or not. A zero or
 * negative `pageCount` is treated as a failure and routed through the same
 * message so the upstream route surface stays simple.
 */
export function checkPdfTextLayer(
  input: TextLayerCheckInput,
): TextLayerCheckResult {
  const { wordCount, pageCount, fileName } = input;

  if (pageCount <= 0) {
    return {
      ok: false,
      wordsPerPage: 0,
      message: buildMessage(fileName, 0, 0),
    };
  }

  const wordsPerPage = wordCount / pageCount;
  if (wordsPerPage < MIN_WORDS_PER_PAGE) {
    return {
      ok: false,
      wordsPerPage,
      message: buildMessage(fileName, wordsPerPage, pageCount),
    };
  }

  return { ok: true, wordsPerPage };
}

function buildMessage(
  fileName: string,
  wordsPerPage: number,
  pageCount: number,
): string {
  const rounded = Math.round(wordsPerPage * 10) / 10;
  if (pageCount <= 0) {
    return (
      `${fileName}: could not extract any page count from the PDF. ` +
      `The file may be image-only or corrupt. Upload a text-bearing ` +
      `replacement, run OCR, or supply a sidecar .txt file.`
    );
  }
  return (
    `${fileName}: only ${rounded} words/page (minimum ${MIN_WORDS_PER_PAGE}). ` +
    `The PDF looks image-only, so every downstream critique or revision ` +
    `step would get garbage. Upload a text-bearing replacement, run OCR ` +
    `on this file, or supply a sidecar .txt file.`
  );
}
