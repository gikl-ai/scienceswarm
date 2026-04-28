import { createHash } from "node:crypto";

import {
  DomUtils,
  parseDocument,
} from "htmlparser2";

import { parseBbl, type BblEntry } from "@/lib/bbl-parser";
import { parseBibtex, type BibtexEntry } from "@/lib/bibtex-parser";

import type { PaperIdentifier } from "../contracts";
import {
  BibliographyEntryArtifactSchema,
  PaperSectionMapSchema,
  PaperSourceArtifactSchema,
  paperCorpusBibliographySlug,
  paperCorpusSourceSlugForPaperSlug,
  type BibliographyEntryArtifact,
  type BibliographyExtractionSource,
  type CorpusArtifactStatus,
  type CorpusExtractor,
  type PaperCorpusWarning,
  type PaperCorpusWarningCode,
  type PaperSectionAnchor,
  type PaperSectionMap,
  type PaperSourceArtifact,
  type PaperSourceCandidate,
  type SourceQuality,
} from "./contracts";

export type PdfParserAdapterName = "marker" | "mineru" | "pdf-parse";

export interface PdfParserAdapterProbe {
  name: PdfParserAdapterName;
  installed: boolean;
  version?: string;
}

export interface PdfParserDecisionInput {
  wordCount?: number;
  hasTextLayer?: boolean;
  hasTables?: boolean;
  hasEquations?: boolean;
  scanned?: boolean;
  requiresAdvancedParser?: boolean;
  minimumTextLayerWords?: number;
  adapters?: Partial<Record<PdfParserAdapterName, PdfParserAdapterProbe>>;
}

export type PdfParserDecisionStatus = "available" | "unavailable" | "blocked";

export interface PdfParserDecision {
  status: PdfParserDecisionStatus;
  extractor: CorpusExtractor;
  quality: SourceQuality;
  warnings: PaperCorpusWarning[];
  unavailableReason?: string;
}

export interface BaseCorpusExtractionInput {
  candidate: PaperSourceCandidate;
  extractedAt: string;
  paperSlug?: string;
  title?: string;
}

export interface ExtractLatexCorpusSourceInput extends BaseCorpusExtractionInput {
  latex: string;
  bibtex?: string;
  bbl?: string;
}

export interface ExtractHtmlCorpusSourceInput extends BaseCorpusExtractionInput {
  html: string;
}

export interface ExtractPdfTextCorpusSourceInput extends BaseCorpusExtractionInput {
  text: string;
  wordCount?: number;
  pageCount?: number;
  hasTextLayer?: boolean;
  hasTables?: boolean;
  hasEquations?: boolean;
  scanned?: boolean;
  requiresAdvancedParser?: boolean;
  minimumTextLayerWords?: number;
  adapters?: Partial<Record<PdfParserAdapterName, PdfParserAdapterProbe>>;
}

export interface CorpusSourceExtractionResult {
  sourceArtifact: PaperSourceArtifact;
  sectionMap?: PaperSectionMap;
  bibliography: BibliographyEntryArtifact[];
  warnings: PaperCorpusWarning[];
  parserDecision?: PdfParserDecision;
}

type HtmlNode = ReturnType<typeof parseDocument>["children"][number];

interface BuildCurrentArtifactInput extends BaseCorpusExtractionInput {
  sourceType: PaperSourceCandidate["sourceType"];
  origin: PaperSourceCandidate["origin"];
  normalizedMarkdown: string;
  extractor: CorpusExtractor;
  warnings?: PaperCorpusWarning[];
  quality?: Partial<SourceQuality>;
}

interface BuildBlockedArtifactInput extends BaseCorpusExtractionInput {
  sourceType: PaperSourceCandidate["sourceType"];
  origin: PaperSourceCandidate["origin"];
  extractor: CorpusExtractor;
  warnings: PaperCorpusWarning[];
  quality: SourceQuality;
  status?: Extract<CorpusArtifactStatus, "blocked" | "failed" | "skipped">;
}

interface BibliographyArtifactInput {
  paperSlug: string;
  createdAt: string;
  source: BibliographyExtractionSource;
  bibtex?: string;
  bbl?: string;
  referencesText?: string;
}

interface ReferenceLikeEntry {
  key?: string;
  title?: string;
  authors?: string[];
  year?: number;
  venue?: string;
  identifiers: PaperIdentifier;
  confidence: number;
}

const DEFAULT_MINIMUM_TEXT_LAYER_WORDS = 120;
const HASH_ALGORITHM = "sha256";

const KNOWN_SECTION_HEADINGS = new Set([
  "abstract",
  "introduction",
  "background",
  "related work",
  "methods",
  "method",
  "materials and methods",
  "results",
  "discussion",
  "conclusion",
  "conclusions",
  "references",
  "bibliography",
  "acknowledgments",
  "acknowledgements",
]);

const DOI_RE = /\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+/gi;
const ARXIV_RE =
  /\b(?:arXiv\s*:\s*)?(\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?)\b/gi;
const PMID_RE = /\b(?:PMID\s*:?\s*)(\d{6,9})\b/gi;
const YEAR_RE = /\b(19\d{2}|20\d{2})\b/g;

const SKIPPED_HTML_TAGS = new Set([
  "head",
  "title",
  "script",
  "style",
  "template",
  "noscript",
  "svg",
  "math",
]);

const BLOCK_HTML_TAGS = new Set([
  "article",
  "aside",
  "blockquote",
  "body",
  "div",
  "figure",
  "footer",
  "header",
  "main",
  "nav",
  "ol",
  "section",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
]);

function sha256(value: string): string {
  return createHash(HASH_ALGORITHM).update(value).digest("hex");
}

function warning(
  code: PaperCorpusWarningCode,
  message: string,
  severity: PaperCorpusWarning["severity"] = "warning",
): PaperCorpusWarning {
  return { code, message, severity };
}

function uniqueWarnings(warnings: readonly PaperCorpusWarning[]): PaperCorpusWarning[] {
  const seen = new Set<string>();
  const result: PaperCorpusWarning[] = [];
  for (const item of warnings) {
    const key = `${item.code}\0${item.message}\0${item.artifactSlug ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function normalizeWhitespace(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function wordCount(value: string): number {
  return value.match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu)?.length ?? 0;
}

function slugSegment(value: string): string {
  const slug = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "section";
  if (slug.length <= 80) return slug;
  return `${slug.slice(0, 71)}-${sha256(slug).slice(0, 8)}`;
}

function ensurePaperSlug(input: BaseCorpusExtractionInput): string {
  const paperSlug = input.paperSlug ?? input.candidate.paperSlug;
  if (!paperSlug) {
    throw new Error("corpus extraction requires paperSlug on the input or source candidate.");
  }
  return paperSlug;
}

function extractor(name: string, adapter: string, installed = true, version?: string): CorpusExtractor {
  return { name, adapter, installed, ...(version ? { version } : {}) };
}

function defaultPdfAdapters(): Record<PdfParserAdapterName, PdfParserAdapterProbe> {
  return {
    marker: { name: "marker", installed: false },
    mineru: { name: "mineru", installed: false },
    "pdf-parse": { name: "pdf-parse", installed: true },
  };
}

export function selectPdfParserAdapter(input: PdfParserDecisionInput): PdfParserDecision {
  const adapters = { ...defaultPdfAdapters(), ...input.adapters };
  const minimumTextLayerWords = input.minimumTextLayerWords ?? DEFAULT_MINIMUM_TEXT_LAYER_WORDS;
  const words = input.wordCount ?? 0;
  const hasTextLayer = input.hasTextLayer ?? words > 0;

  if (input.scanned || !hasTextLayer) {
    const warnings = uniqueWarnings([
      warning("no_text_layer", "PDF text layer is absent or unusable."),
      warning("low_text_layer", "PDF text layer is too sparse for reliable corpus extraction."),
      warning("ocr_required", "OCR is required before this PDF can be used as corpus evidence."),
    ]);
    return {
      status: "blocked",
      extractor: extractor("pdf-parse", "text-layer", adapters["pdf-parse"]?.installed ?? true),
      quality: {
        score: 0.05,
        wordCount: words,
        hasTextLayer: false,
        hasTables: input.hasTables,
        hasEquations: input.hasEquations,
        warnings,
      },
      warnings,
      unavailableReason: "PDF has no usable text layer.",
    };
  }

  if (words < minimumTextLayerWords) {
    const warnings = uniqueWarnings([
      warning("low_text_layer", "PDF text layer is too short for reliable corpus extraction."),
      warning("short_body", "Extracted PDF body is suspiciously short."),
      warning("ocr_required", "OCR or a higher-quality parser is required before summarization."),
    ]);
    return {
      status: "blocked",
      extractor: extractor("pdf-parse", "text-layer", adapters["pdf-parse"]?.installed ?? true),
      quality: {
        score: 0.15,
        wordCount: words,
        hasTextLayer: true,
        hasTables: input.hasTables,
        hasEquations: input.hasEquations,
        warnings,
      },
      warnings,
      unavailableReason: "PDF text layer is below the minimum extraction threshold.",
    };
  }

  if (input.requiresAdvancedParser || input.hasEquations || input.hasTables) {
    const advanced = [adapters.marker, adapters.mineru].find((adapter) => adapter?.installed);
    if (advanced) {
      return {
        status: "available",
        extractor: extractor(
          advanced.name,
          advanced.name === "mineru" ? "math-table-pdf" : "document-pdf",
          true,
          advanced.version,
        ),
        quality: {
          score: 0.86,
          wordCount: words,
          hasTextLayer: true,
          hasTables: input.hasTables,
          hasEquations: input.hasEquations,
          warnings: [],
        },
        warnings: [],
      };
    }

    const warnings = uniqueWarnings([
      warning("parser_unavailable", "Marker/MinerU-class PDF parser is unavailable."),
      input.hasEquations || input.requiresAdvancedParser
        ? warning("equations_degraded", "Math-heavy PDF requires an advanced parser before use as trusted evidence.")
        : undefined,
      input.hasTables
        ? warning("low_table_fidelity", "Table-heavy PDF requires an advanced parser before use as trusted evidence.")
        : undefined,
    ].filter((item): item is PaperCorpusWarning => Boolean(item)));
    return {
      status: "unavailable",
      extractor: extractor("marker-or-mineru", "advanced-pdf", false),
      quality: {
        score: 0.4,
        wordCount: words,
        hasTextLayer: true,
        hasTables: input.hasTables,
        hasEquations: input.hasEquations,
        warnings,
      },
      warnings,
      unavailableReason: "Advanced PDF parser unavailable for math-heavy or table-heavy source.",
    };
  }

  return {
    status: "available",
    extractor: extractor("pdf-parse", "text-layer", adapters["pdf-parse"]?.installed ?? true),
    quality: {
      score: words >= 1000 ? 0.76 : 0.62,
      wordCount: words,
      hasTextLayer: true,
      hasTables: input.hasTables,
      hasEquations: input.hasEquations,
      warnings: [],
    },
    warnings: [],
  };
}

function sectionTitle(raw: string): string {
  return raw
    .replace(/\s+#*$/g, "")
    .replace(/^\d+(?:\.\d+)*\.?\s+/, "")
    .trim();
}

function markdownHeadings(markdown: string): Array<{ level: number; title: string; index: number }> {
  return Array.from(markdown.matchAll(/^(#{1,6})\s+(.+?)\s*$/gm), (match) => ({
    level: match[1].length,
    title: sectionTitle(match[2]),
    index: match.index ?? 0,
  })).filter((heading) => heading.title.length > 0);
}

function sectionMapHashForSections(sections: readonly PaperSectionAnchor[]): string {
  return sha256(JSON.stringify(sections.map((section) => ({
    sectionId: section.sectionId,
    title: section.title,
    level: section.level,
    ordinal: section.ordinal,
    anchor: section.anchor,
    startOffset: section.startOffset,
    endOffset: section.endOffset,
    chunkHandles: section.chunkHandles,
  }))));
}

export function buildPaperSectionMap(input: {
  paperSlug: string;
  sourceSlug: string;
  sourceHash: string;
  normalizedMarkdown: string;
  createdAt: string;
  warnings?: PaperCorpusWarning[];
}): PaperSectionMap {
  const headings = markdownHeadings(input.normalizedMarkdown);
  const sectionHeadings = headings.filter((heading, index) => {
    const isDocumentTitle = index === 0 && heading.level === 1 && heading.index === 0 && headings.length > 1;
    return !isDocumentTitle;
  });
  const usableHeadings = sectionHeadings.length > 0
    ? sectionHeadings
    : [{ level: 1, title: "Source", index: 0 }];
  const seen = new Map<string, number>();
  const sections = usableHeadings.map((heading, ordinal): PaperSectionAnchor => {
    const base = slugSegment(heading.title);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    const sectionId = count === 0 ? base : `${base}-${count + 1}`;
    const next = usableHeadings[ordinal + 1];
    return {
      sectionId,
      title: heading.title,
      level: heading.level,
      ordinal,
      anchor: sectionId,
      startOffset: heading.index,
      endOffset: next?.index ?? input.normalizedMarkdown.length,
      chunkHandles: [
        {
          sourceSlug: input.sourceSlug,
          chunkId: `section-${sectionId}`,
          chunkIndex: ordinal,
          sectionId,
        },
      ],
    };
  });
  const sectionMapHash = sectionMapHashForSections(sections);

  return PaperSectionMapSchema.parse({
    paperSlug: input.paperSlug,
    sourceSlug: input.sourceSlug,
    sourceHash: input.sourceHash,
    sectionMapHash,
    status: "current",
    sections,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    warnings: uniqueWarnings(input.warnings ?? []),
  });
}

function buildQuality(
  sourceType: PaperSourceCandidate["sourceType"],
  markdown: string,
  warnings: readonly PaperCorpusWarning[],
  quality?: Partial<SourceQuality>,
): SourceQuality {
  const words = quality?.wordCount ?? wordCount(markdown);
  const baseScore = sourceType === "latex" ? 0.94 : sourceType === "html" ? 0.88 : 0.76;
  const penalty = warnings.reduce((score, item) => {
    if (item.severity === "error") return score + 0.3;
    if (item.severity === "warning") return score + 0.08;
    return score;
  }, words < DEFAULT_MINIMUM_TEXT_LAYER_WORDS ? 0.18 : 0);
  return {
    score: Math.max(0, Math.min(1, quality?.score ?? baseScore - penalty)),
    wordCount: words,
    hasTextLayer: quality?.hasTextLayer,
    hasTables: quality?.hasTables,
    hasEquations: quality?.hasEquations,
    hasFigures: quality?.hasFigures,
    warnings: uniqueWarnings([...(quality?.warnings ?? []), ...warnings]),
  };
}

function buildCurrentArtifacts(input: BuildCurrentArtifactInput): {
  sourceArtifact: PaperSourceArtifact;
  sectionMap: PaperSectionMap;
} {
  const paperSlug = ensurePaperSlug(input);
  const sourceSlug = paperCorpusSourceSlugForPaperSlug(paperSlug);
  const normalizedMarkdown = normalizeWhitespace(input.normalizedMarkdown);
  const sourceHash = sha256(normalizedMarkdown);
  const warnings = uniqueWarnings([...(input.candidate.warnings ?? []), ...(input.warnings ?? [])]);
  const sectionMap = buildPaperSectionMap({
    paperSlug,
    sourceSlug,
    sourceHash,
    normalizedMarkdown,
    createdAt: input.extractedAt,
    warnings,
  });
  const sourceArtifact = PaperSourceArtifactSchema.parse({
    paperId: input.candidate.paperId,
    paperSlug,
    sourceSlug,
    selectedCandidateId: input.candidate.id,
    sourceType: input.sourceType,
    origin: input.origin,
    status: "current",
    extractor: input.extractor,
    sourceHash,
    sectionMapHash: sectionMap.sectionMapHash,
    normalizedMarkdown,
    quality: buildQuality(input.sourceType, normalizedMarkdown, warnings, input.quality),
    createdAt: input.extractedAt,
    updatedAt: input.extractedAt,
    warnings,
  });

  return { sourceArtifact, sectionMap };
}

function buildBlockedArtifact(input: BuildBlockedArtifactInput): PaperSourceArtifact {
  const paperSlug = ensurePaperSlug(input);
  const sourceSlug = paperCorpusSourceSlugForPaperSlug(paperSlug);
  const warnings = uniqueWarnings([...(input.candidate.warnings ?? []), ...input.warnings]);

  return PaperSourceArtifactSchema.parse({
    paperId: input.candidate.paperId,
    paperSlug,
    sourceSlug,
    selectedCandidateId: input.candidate.id,
    sourceType: input.sourceType,
    origin: input.origin,
    status: input.status ?? "blocked",
    extractor: input.extractor,
    normalizedMarkdown: "",
    quality: {
      ...input.quality,
      warnings: uniqueWarnings([...(input.quality.warnings ?? []), ...warnings]),
    },
    createdAt: input.extractedAt,
    updatedAt: input.extractedAt,
    warnings,
  });
}

function stripLatexComments(input: string): string {
  return input
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|[^\\])%.*/, "$1"))
    .join("\n");
}

function latexCommandBody(input: string, command: string): string | undefined {
  const match = new RegExp(`\\\\${command}\\s*\\{([^{}]*(?:\\{[^{}]*\\}[^{}]*)*)\\}`, "s").exec(input);
  return match?.[1];
}

function latexEnvironmentBody(input: string, environment: string): string | undefined {
  const pattern = new RegExp(`\\\\begin\\{${environment}\\}([\\s\\S]*?)\\\\end\\{${environment}\\}`, "i");
  return pattern.exec(input)?.[1];
}

function stripLatexInline(value: string): string {
  let result = value;
  for (let index = 0; index < 4; index += 1) {
    result = result
      .replace(/\\(?:emph|textit|textbf|textsc|texttt|mathrm)\{([^{}]*)\}/g, "$1")
      .replace(/\\href\{[^{}]*\}\{([^{}]*)\}/g, "$1")
      .replace(/\\url\{([^{}]*)\}/g, "$1");
  }
  return result
    .replace(/\\(?:cite|citet|citep|citealp|citeauthor|citeyear)(?:\[[^\]]*\])*\{([^{}]*)\}/g, "[citation: $1]")
    .replace(/\\(?:ref|label)\{[^{}]*\}/g, "")
    .replace(/\\(?:begin|end)\{[^{}]*\}/g, "")
    .replace(/\\[a-zA-Z]+\*?(?:\[[^\]]*\])?/g, "")
    .replace(/\\([#$%&_{}])/g, "$1")
    .replace(/[{}]/g, "")
    .replace(/~/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function readLatexBraceBody(source: string, openBraceIndex: number): { body: string; endIndex: number } | undefined {
  if (source[openBraceIndex] !== "{") return undefined;
  let depth = 0;
  for (let index = openBraceIndex; index < source.length; index += 1) {
    const char = source[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char !== "}") continue;
    depth -= 1;
    if (depth === 0) {
      return {
        body: source.slice(openBraceIndex + 1, index),
        endIndex: index + 1,
      };
    }
  }
  return undefined;
}

function latexHeadingPrefix(command: string): string {
  if (command === "section") return "##";
  if (command === "subsection") return "###";
  if (command === "subsubsection") return "####";
  return "#####";
}

function replaceLatexSectionCommands(source: string): string {
  const commandPattern = /\\(section|subsection|subsubsection|paragraph)\*?\s*\{/g;
  let result = "";
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = commandPattern.exec(source)) !== null) {
    const openBraceIndex = commandPattern.lastIndex - 1;
    const body = readLatexBraceBody(source, openBraceIndex);
    if (!body) continue;
    result += source.slice(lastIndex, match.index);
    result += `\n\n${latexHeadingPrefix(match[1])} ${stripLatexInline(body.body)}\n\n`;
    lastIndex = body.endIndex;
    commandPattern.lastIndex = body.endIndex;
  }

  return result + source.slice(lastIndex);
}

function latexToMarkdown(input: { latex: string; title?: string }): string {
  let source = stripLatexComments(input.latex);
  const title = stripLatexInline(input.title ?? latexCommandBody(source, "title") ?? "");
  const abstract = latexEnvironmentBody(source, "abstract");
  const bibliography = latexEnvironmentBody(source, "thebibliography");

  source = source
    .replace(/\\begin\{abstract\}[\s\S]*?\\end\{abstract\}/gi, "")
    .replace(/\\begin\{thebibliography\}[\s\S]*?\\end\{thebibliography\}/gi, "")
    .replace(/\\title\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g, "")
    .replace(/\\author\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g, "")
    .replace(/\\date\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g, "")
    .replace(/\\(?:documentclass|usepackage)(?:\[[^\]]*\])?\{[^{}]*\}/g, "")
    .replace(/\\maketitle/g, "")
    .replace(/\\begin\{document\}|\\end\{document\}/g, "");

  source = replaceLatexSectionCommands(source)
    .replace(/\\begin\{(?:equation|align|alignat|gather|multline)\*?\}([\s\S]*?)\\end\{(?:equation|align|alignat|gather|multline)\*?\}/g, "\n\n$$\n$1\n$$\n\n");

  const cleanedBody = source
    .split("\n")
    .map((line) => {
      if (/^\s*#+\s/.test(line)) return line.trim();
      return stripLatexInline(line);
    })
    .filter((line) => line.length > 0)
    .join("\n\n");

  return normalizeWhitespace([
    title ? `# ${title}` : undefined,
    abstract ? `## Abstract\n\n${stripLatexInline(abstract)}` : undefined,
    cleanedBody,
    bibliography ? "## References" : undefined,
  ].filter((part): part is string => Boolean(part && part.trim())).join("\n\n"));
}

function htmlToMarkdown(input: { html: string; title?: string }): string {
  const document = parseDocument(input.html, { decodeEntities: true });
  const title = input.title
    ?? firstHtmlTagText(document.children, "title")
    ?? firstHtmlTagText(document.children, "h1");
  const lines: string[] = [];
  appendHtmlNodesAsMarkdown(document.children, lines);

  const body = normalizeWhitespace(lines.join("\n"));
  const hasTopHeading = /^#\s+/m.test(body);
  return normalizeWhitespace([
    title && !hasTopHeading ? `# ${title}` : undefined,
    body,
  ].filter((part): part is string => Boolean(part && part.trim())).join("\n\n"));
}

function normalizeHtmlText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function htmlNodeText(node: HtmlNode): string {
  return normalizeHtmlText(DomUtils.textContent(node));
}

function appendMarkdownLine(lines: string[], line: string): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  lines.push(trimmed);
  lines.push("");
}

function htmlTagName(node: HtmlNode): string | undefined {
  return DomUtils.isTag(node) ? DomUtils.getName(node).toLowerCase() : undefined;
}

function firstHtmlTagText(nodes: readonly HtmlNode[], tagName: string): string | undefined {
  const element = DomUtils.findOne(
    (node) => DomUtils.getName(node).toLowerCase() === tagName,
    [...nodes],
    true,
  );
  const text = element ? htmlNodeText(element) : undefined;
  return text || undefined;
}

function appendHtmlNodesAsMarkdown(nodes: readonly HtmlNode[], lines: string[]): void {
  for (const node of nodes) {
    appendHtmlNodeAsMarkdown(node, lines);
  }
}

function appendHtmlNodeAsMarkdown(node: HtmlNode, lines: string[]): void {
  const tagName = htmlTagName(node);
  if (tagName && SKIPPED_HTML_TAGS.has(tagName)) return;

  if (tagName && /^h[1-6]$/.test(tagName)) {
    const level = Number(tagName.slice(1));
    appendMarkdownLine(lines, `${"#".repeat(level)} ${htmlNodeText(node)}`);
    return;
  }

  if (tagName === "p" || tagName === "blockquote") {
    appendMarkdownLine(lines, htmlNodeText(node));
    return;
  }

  if (tagName === "li") {
    appendMarkdownLine(lines, `- ${htmlNodeText(node)}`);
    return;
  }

  if (tagName === "br") {
    lines.push("");
    return;
  }

  if (DomUtils.isTag(node) || DomUtils.hasChildren(node)) {
    appendHtmlNodesAsMarkdown(DomUtils.getChildren(node), lines);
    if (tagName && BLOCK_HTML_TAGS.has(tagName)) {
      lines.push("");
    }
    return;
  }

  const text = htmlNodeText(node);
  if (text) {
    appendMarkdownLine(lines, text);
  }
}

function normalizePdfHeading(value: string): string | undefined {
  const trimmed = value.trim().replace(/[:.]$/g, "");
  if (KNOWN_SECTION_HEADINGS.has(trimmed.toLowerCase())) {
    return trimmed.replace(/\b\w/g, (letter) => letter.toUpperCase());
  }
  const numbered = /^(\d+(?:\.\d+)*\.?)\s+([A-Z][A-Za-z0-9 ,:;/'()-]{2,90})$/.exec(trimmed);
  if (!numbered) return undefined;
  const title = numbered[2].replace(/[:.]$/g, "").trim();
  if (title.split(/\s+/).length > 12) return undefined;
  return title;
}

function pdfTextToMarkdown(input: { text: string; title?: string }): string {
  const lines = normalizeWhitespace(input.text)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const firstLine = lines[0];
  const title = input.title ?? (firstLine && !normalizePdfHeading(firstLine) ? firstLine : undefined);
  const bodyLines = title === firstLine ? lines.slice(1) : lines;
  const markdownLines: string[] = [];

  for (const line of bodyLines) {
    const heading = normalizePdfHeading(line);
    markdownLines.push(heading ? `## ${heading}` : line);
  }

  if (!markdownLines.some((line) => /^##\s+/i.test(line))) {
    markdownLines.unshift("## Extracted Text");
  }

  return normalizeWhitespace([
    title ? `# ${title}` : undefined,
    markdownLines.join("\n\n"),
  ].filter((part): part is string => Boolean(part && part.trim())).join("\n\n"));
}

function extractMarkdownSection(markdown: string, titles: readonly string[]): string | undefined {
  const titlePattern = titles.map((title) => title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const pattern = new RegExp(`^#{1,6}\\s+(?:${titlePattern})\\s*$`, "gim");
  const match = pattern.exec(markdown);
  if (!match || match.index === undefined) return undefined;
  const bodyStart = match.index + match[0].length;
  const headingLevel = match[0].match(/^#+/)?.[0].length ?? 1;
  const next = new RegExp(`^#{1,${headingLevel}}\\s+.+$`, "gim");
  next.lastIndex = bodyStart;
  const nextMatch = next.exec(markdown);
  return markdown.slice(bodyStart, nextMatch?.index ?? markdown.length).trim();
}

function normalizeDoi(value: string | undefined): string | undefined {
  const normalized = value
    ?.trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "")
    .replace(/[)\].,;:\s]+$/g, "")
    .toLowerCase();
  return normalized || undefined;
}

function normalizeArxiv(value: string | undefined): string | undefined {
  const normalized = value
    ?.trim()
    .replace(/^arxiv\s*:\s*/i, "")
    .replace(/[)\].,;:\s]+$/g, "")
    .replace(/v\d+$/i, "");
  return normalized || undefined;
}

function normalizePmid(value: string | undefined): string | undefined {
  const normalized = value
    ?.trim()
    .replace(/^pmid\s*:?\s*/i, "")
    .replace(/[)\].,;:\s]+$/g, "");
  return normalized || undefined;
}

function firstMatch(regex: RegExp, value: string): string | undefined {
  regex.lastIndex = 0;
  const match = regex.exec(value);
  return match?.[1] ?? match?.[0];
}

function firstYear(value: string): number | undefined {
  YEAR_RE.lastIndex = 0;
  const years = Array.from(value.matchAll(YEAR_RE), (match) => Number(match[1]))
    .filter((year) => Number.isInteger(year) && year >= 1000 && year <= 3000);
  return years[0];
}

function publicationYear(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = /\b(1[5-9]\d{2}|20\d{2}|2[1-9]\d{2})\b/.exec(value);
  if (!match) return undefined;
  const year = Number(match[1]);
  return Number.isInteger(year) && year >= 1000 && year <= 3000 ? year : undefined;
}

function splitReferenceEntries(section: string): string[] {
  const markerized = section
    .replace(/\r\n?/g, "\n")
    .replace(/\s+(?=(?:\[\d{1,4}\]|\d{1,3}\.|\[[A-Za-z][A-Za-z0-9+.-]{1,16}\])\s+)/g, "\n");
  const markerEntries = markerized
    .split(/\n+/)
    .map((entry) => entry.replace(/^(?:\[\d{1,4}\]|\d{1,3}\.|\[[A-Za-z][A-Za-z0-9+.-]{1,16}\])\s*/, "").trim())
    .filter((entry) => entry.length >= 30);
  if (markerEntries.length > 0) return markerEntries;

  return section
    .split(/\n\s*\n|;\s+(?=[A-Z])/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length >= 30);
}

function titleFromReference(value: string): string | undefined {
  const quoted = /["“]([^"”]{8,220})["”]/.exec(value)?.[1];
  if (quoted) return quoted.trim();

  const sentences = value
    .replace(/\b(et al)\./gi, "$1")
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"“])/)
    .map((sentence) => sentence.replace(/\b(et al)\b/gi, "$1.").trim())
    .filter(Boolean);
  const candidate = sentences.find((sentence, index) => {
    if (index === 0 && /\b(19\d{2}|20\d{2})\b/.test(sentence) && /[,;]/.test(sentence)) return false;
    return /[A-Za-z]{4}/.test(sentence) && !/^(doi|url|arxiv|available at)\b/i.test(sentence);
  });
  return candidate
    ?.replace(/\b(?:doi|arxiv|url)\b.*$/i, "")
    .replace(/[.,;:\s]+$/g, "")
    .trim()
    .slice(0, 220);
}

function referenceLikeFromText(value: string, index: number): ReferenceLikeEntry | undefined {
  const identifiers: PaperIdentifier = {
    doi: normalizeDoi(firstMatch(DOI_RE, value)),
    arxivId: normalizeArxiv(firstMatch(ARXIV_RE, value)),
    pmid: normalizePmid(firstMatch(PMID_RE, value)),
  };
  const title = titleFromReference(value);
  if (!title && !identifiers.doi && !identifiers.arxivId && !identifiers.pmid) return undefined;
  return {
    key: `ref-${index + 1}`,
    title,
    authors: [],
    year: firstYear(value),
    identifiers,
    confidence: identifiers.doi || identifiers.arxivId || identifiers.pmid ? 0.72 : 0.55,
  };
}

function bibtexToReference(entry: BibtexEntry): ReferenceLikeEntry {
  const identifiers: PaperIdentifier = {
    doi: normalizeDoi(entry.doi),
    arxivId: normalizeArxiv(entry.fields.eprint ?? entry.fields.arxiv),
    pmid: normalizePmid(entry.fields.pmid),
  };
  return {
    key: entry.key,
    title: entry.title,
    authors: entry.authors ?? [],
    year: publicationYear(entry.year),
    venue: entry.journal ?? entry.booktitle ?? entry.publisher,
    identifiers,
    confidence: 0.9,
  };
}

function bblToReference(entry: BblEntry): ReferenceLikeEntry {
  return {
    key: entry.key,
    title: entry.title,
    authors: entry.authors,
    year: entry.year,
    venue: entry.venue,
    identifiers: {
      doi: normalizeDoi(entry.doi),
      arxivId: normalizeArxiv(entry.arxiv),
      pmid: normalizePmid(entry.pmid),
    },
    confidence: 0.86,
  };
}

function bibliographyEntryFromReference(input: {
  paperSlug: string;
  createdAt: string;
  source: BibliographyExtractionSource;
  reference: ReferenceLikeEntry;
}): BibliographyEntryArtifact {
  const fallback = input.reference.title ?? input.reference.key ?? "untitled reference";
  return BibliographyEntryArtifactSchema.parse({
    bibliographySlug: paperCorpusBibliographySlug(input.reference.identifiers, fallback),
    identifiers: input.reference.identifiers,
    title: input.reference.title,
    authors: input.reference.authors ?? [],
    year: input.reference.year,
    venue: input.reference.venue,
    status: "current",
    localStatus: "metadata_only",
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    seenIn: [
      {
        paperSlug: input.paperSlug,
        bibKey: input.reference.key,
        extractionSource: input.source,
        confidence: input.reference.confidence,
      },
    ],
  });
}

function mergeBibliographyEntries(entries: readonly BibliographyEntryArtifact[]): BibliographyEntryArtifact[] {
  const bySlug = new Map<string, BibliographyEntryArtifact>();
  for (const entry of entries) {
    const existing = bySlug.get(entry.bibliographySlug);
    if (!existing) {
      bySlug.set(entry.bibliographySlug, entry);
      continue;
    }
    bySlug.set(entry.bibliographySlug, BibliographyEntryArtifactSchema.parse({
      ...existing,
      title: existing.title ?? entry.title,
      authors: existing.authors.length > 0 ? existing.authors : entry.authors,
      year: existing.year ?? entry.year,
      venue: existing.venue ?? entry.venue,
      seenIn: [...existing.seenIn, ...entry.seenIn],
      warnings: uniqueWarnings([...existing.warnings, ...entry.warnings]),
    }));
  }
  return [...bySlug.values()].sort((left, right) => left.bibliographySlug.localeCompare(right.bibliographySlug));
}

function extractBibliographyArtifacts(input: BibliographyArtifactInput): BibliographyEntryArtifact[] {
  const references: ReferenceLikeEntry[] = [];
  if (input.bbl?.trim()) {
    references.push(...parseBbl(input.bbl).entries.map(bblToReference));
  }
  if (input.bibtex?.trim()) {
    references.push(...parseBibtex(input.bibtex).entries.map(bibtexToReference));
  }
  if (input.referencesText?.trim()) {
    references.push(...splitReferenceEntries(input.referencesText)
      .map(referenceLikeFromText)
      .filter((entry): entry is ReferenceLikeEntry => Boolean(entry)));
  }

  return mergeBibliographyEntries(references.map((reference) => bibliographyEntryFromReference({
    paperSlug: input.paperSlug,
    createdAt: input.createdAt,
    source: input.source,
    reference,
  })));
}

function missingReferenceWarning(sourceType: PaperSourceCandidate["sourceType"]): PaperCorpusWarning {
  return warning(
    "references_not_found",
    `${sourceType.toUpperCase()} extraction did not find a usable references section.`,
    "info",
  );
}

export function extractLatexCorpusSource(input: ExtractLatexCorpusSourceInput): CorpusSourceExtractionResult {
  const paperSlug = ensurePaperSlug(input);
  const markdown = latexToMarkdown({ latex: input.latex, title: input.title ?? input.candidate.title });
  const bbl = input.bbl ?? latexEnvironmentBody(input.latex, "thebibliography");
  const bibliography = extractBibliographyArtifacts({
    paperSlug,
    createdAt: input.extractedAt,
    source: bbl ? "bbl" : "latex_bib",
    bbl,
    bibtex: input.bibtex,
  });
  const warnings = bibliography.length === 0 ? [missingReferenceWarning("latex")] : [];
  const { sourceArtifact, sectionMap } = buildCurrentArtifacts({
    ...input,
    sourceType: "latex",
    origin: input.candidate.origin,
    normalizedMarkdown: markdown,
    extractor: extractor("latex-source", "latex-to-markdown"),
    warnings,
    quality: {
      hasEquations: /\\begin\{(?:equation|align|gather|multline)\*?\}|\$[^$]+\$/.test(input.latex),
    },
  });

  return {
    sourceArtifact,
    sectionMap,
    bibliography,
    warnings: uniqueWarnings([...warnings, ...sourceArtifact.warnings]),
  };
}

export function extractHtmlCorpusSource(input: ExtractHtmlCorpusSourceInput): CorpusSourceExtractionResult {
  const paperSlug = ensurePaperSlug(input);
  const markdown = htmlToMarkdown({ html: input.html, title: input.title ?? input.candidate.title });
  const referencesText = extractMarkdownSection(markdown, ["References", "Bibliography", "Works Cited"]);
  const bibliography = extractBibliographyArtifacts({
    paperSlug,
    createdAt: input.extractedAt,
    source: "html_references",
    referencesText,
  });
  const warnings = bibliography.length === 0 ? [missingReferenceWarning("html")] : [];
  const { sourceArtifact, sectionMap } = buildCurrentArtifacts({
    ...input,
    sourceType: "html",
    origin: input.candidate.origin,
    normalizedMarkdown: markdown,
    extractor: extractor("html-sidecar", "html-to-markdown"),
    warnings,
  });

  return {
    sourceArtifact,
    sectionMap,
    bibliography,
    warnings: uniqueWarnings([...warnings, ...sourceArtifact.warnings]),
  };
}

export function extractPdfTextCorpusSource(input: ExtractPdfTextCorpusSourceInput): CorpusSourceExtractionResult {
  const paperSlug = ensurePaperSlug(input);
  const decision = selectPdfParserAdapter({
    wordCount: input.wordCount ?? wordCount(input.text),
    hasTextLayer: input.hasTextLayer,
    hasTables: input.hasTables,
    hasEquations: input.hasEquations,
    scanned: input.scanned,
    requiresAdvancedParser: input.requiresAdvancedParser,
    minimumTextLayerWords: input.minimumTextLayerWords,
    adapters: input.adapters,
  });

  if (decision.status !== "available") {
    const sourceArtifact = buildBlockedArtifact({
      ...input,
      sourceType: "pdf",
      origin: input.candidate.origin,
      extractor: decision.extractor,
      warnings: decision.warnings,
      quality: decision.quality,
    });
    return {
      sourceArtifact,
      bibliography: [],
      warnings: uniqueWarnings(sourceArtifact.warnings),
      parserDecision: decision,
    };
  }

  const markdown = pdfTextToMarkdown({ text: input.text, title: input.title ?? input.candidate.title });
  const referencesText = extractMarkdownSection(markdown, ["References", "Bibliography", "Works Cited"]);
  const bibliography = extractBibliographyArtifacts({
    paperSlug,
    createdAt: input.extractedAt,
    source: "pdf_references",
    referencesText,
  });
  const referenceWarnings = bibliography.length === 0 ? [missingReferenceWarning("pdf")] : [];
  const warnings = uniqueWarnings([...decision.warnings, ...referenceWarnings]);
  const { sourceArtifact, sectionMap } = buildCurrentArtifacts({
    ...input,
    sourceType: "pdf",
    origin: input.candidate.origin,
    normalizedMarkdown: markdown,
    extractor: decision.extractor,
    warnings,
    quality: {
      ...decision.quality,
      wordCount: input.wordCount ?? decision.quality.wordCount,
    },
  });

  return {
    sourceArtifact,
    sectionMap,
    bibliography,
    warnings: uniqueWarnings([...warnings, ...sourceArtifact.warnings]),
    parserDecision: decision,
  };
}
