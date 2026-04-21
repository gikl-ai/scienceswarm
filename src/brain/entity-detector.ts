/**
 * Second Brain — Science Entity Detector
 *
 * Fires on EVERY chat message. Two-tier detection:
 * 1. Fast path (regex/heuristic) — <10ms, always runs
 * 2. LLM path (optional) — classifies entities, detects original thinking
 *
 * Captures two things with equal priority:
 * - Original Thinking (PRIMARY): scientist's own ideas, EXACT phrasing
 * - Entity Mentions (SECONDARY): papers, authors, methods, datasets
 *
 * Iron Law: back-link FROM entity pages TO the source that mentions them.
 */

import type { Confidence } from "./types";
import type { LLMClient } from "./llm";

// ── Public Types ─────────────────────────────────────

export type ScienceEntityType =
  | "paper"
  | "author"
  | "method"
  | "dataset"
  | "concept"
  | "original_idea";

export interface DetectedEntity {
  type: ScienceEntityType;
  name: string;
  /** Extracted identifiers: DOI, arXiv ID, etc. */
  identifiers: Record<string, string>;
  /** Confidence of detection */
  confidence: Confidence;
  /** The exact text span that triggered detection */
  span: string;
  /** Suggested brain path */
  suggestedPath: string;
}

export interface DetectedOriginal {
  /** The user's exact words — NEVER paraphrase */
  verbatim: string;
  /** What kind of original thinking */
  kind:
    | "observation"
    | "hypothesis"
    | "framework"
    | "hot_take"
    | "connection"
    | "question";
  /** Suggested slug using the user's own language */
  suggestedSlug: string;
  /** Related entities mentioned in the same thought */
  relatedEntities: string[];
}

export interface EntityDetectionResult {
  entities: DetectedEntity[];
  originals: DetectedOriginal[];
  /** Whether the message is purely operational (skip entity detection) */
  isOperational: boolean;
}

// ── Regex Patterns ───────────────────────────────────

/** arXiv IDs: 2301.12345 or arXiv:2301.12345v2 */
const ARXIV_PATTERN = /(?:arXiv:\s*)?(\d{4}\.\d{4,5}(?:v\d+)?)/gi;

/** DOIs: 10.1234/anything */
const DOI_PATTERN = /\b(10\.\d{4,}\/[^\s,;)]+)/g;

/** Author et al. references: "the Smith et al. paper", "Smith et al. (2023)", "LeCun et al." */
const AUTHOR_ET_AL_PATTERN =
  /\b([A-Z][a-zA-Z]+(?:\s+(?:and|&)\s+[A-Z][a-zA-Z]+)?)\s+et\s+al\.?\s*(?:\((\d{4})\))?/g;

/** Author (Year) references: "Smith (2023)", "Zhang & Lee (2024)", "LeCun (1998)" */
const AUTHOR_YEAR_PATTERN =
  /\b([A-Z][a-zA-Z]+(?:\s+(?:and|&)\s+[A-Z][a-zA-Z]+)?)\s*\((\d{4})\)/g;

/** "the {Title} paper" pattern */
const THE_PAPER_PATTERN =
  /\bthe\s+(?:([A-Z][A-Za-z0-9-]+(?:\s+[A-Za-z0-9-]+){0,4})\s+)?paper\b/gi;

// ── Known Entity Dictionaries ────────────────────────

/** Common ML/AI methods */
const ML_METHODS = new Set([
  "transformer",
  "attention mechanism",
  "self-attention",
  "multi-head attention",
  "gradient descent",
  "stochastic gradient descent",
  "sgd",
  "adam optimizer",
  "backpropagation",
  "dropout",
  "batch normalization",
  "layer normalization",
  "convolution",
  "convolutional neural network",
  "cnn",
  "recurrent neural network",
  "rnn",
  "lstm",
  "gru",
  "generative adversarial network",
  "gan",
  "variational autoencoder",
  "vae",
  "diffusion model",
  "reinforcement learning",
  "q-learning",
  "policy gradient",
  "ppo",
  "rlhf",
  "dpo",
  "fine-tuning",
  "lora",
  "qlora",
  "retrieval augmented generation",
  "rag",
  "chain of thought",
  "cot",
  "in-context learning",
  "few-shot learning",
  "zero-shot learning",
  "transfer learning",
  "knowledge distillation",
  "mixture of experts",
  "moe",
  "flash attention",
  "sparse attention",
  "beam search",
  "nucleus sampling",
  "top-k sampling",
  "temperature scaling",
  "contrastive learning",
  "clip",
  "siamese network",
  "graph neural network",
  "gnn",
  "message passing",
  "word2vec",
  "bert",
  "gpt",
  "t5",
  "mamba",
  "state space model",
  "ssm",
  "tokenization",
  "bpe",
  "sentencepiece",
  "embedding",
  "positional encoding",
  "rotary embedding",
  "rope",
]);

/** Common biotech/wet lab methods */
const BIO_METHODS = new Set([
  "pcr",
  "qpcr",
  "rt-pcr",
  "western blot",
  "southern blot",
  "northern blot",
  "elisa",
  "facs",
  "flow cytometry",
  "mass spectrometry",
  "cryo-em",
  "x-ray crystallography",
  "nmr spectroscopy",
  "gel electrophoresis",
  "sds-page",
  "immunoprecipitation",
  "chip-seq",
  "rna-seq",
  "single-cell rna-seq",
  "scRNA-seq",
  "atac-seq",
  "crispr",
  "crispr-cas9",
  "prime editing",
  "base editing",
  "gene knockout",
  "gene knockin",
  "transfection",
  "transformation",
  "cloning",
  "gibson assembly",
  "golden gate",
  "site-directed mutagenesis",
  "protein purification",
  "affinity chromatography",
  "size exclusion chromatography",
  "hplc",
  "microscopy",
  "confocal microscopy",
  "fluorescence microscopy",
  "electron microscopy",
  "alphafold",
  "rosetta",
  "molecular dynamics",
  "docking",
  "phage display",
  "yeast two-hybrid",
  "co-immunoprecipitation",
]);

/** Common benchmark datasets */
const DATASETS = new Set([
  "imagenet",
  "cifar-10",
  "cifar-100",
  "mnist",
  "fashion-mnist",
  "coco",
  "pascal voc",
  "mmlu",
  "hellaswag",
  "arc",
  "winogrande",
  "truthfulqa",
  "gsm8k",
  "math",
  "humaneval",
  "mbpp",
  "squad",
  "glue",
  "superglue",
  "wmt",
  "common crawl",
  "the pile",
  "redpajama",
  "openwebtext",
  "c4",
  "laion",
  "ms marco",
  "natural questions",
  "triviaqa",
  "hotpotqa",
  "drop",
  "race",
  "boolq",
  "piqa",
  "openbookqa",
  "bigbench",
  "lmsys",
  "alpaca",
  "sharegpt",
  "mtbench",
  "chatbot arena",
  "spider",
  "wikisql",
  "genbank",
  "uniprot",
  "pdb",
  "chembl",
  "pubmed",
  "geo",
  "arrayexpress",
  "tcga",
  "gtex",
  "encode",
]);

// ── Operational Message Detection ────────────────────

/** Patterns that indicate a purely operational message (no science content) */
const OPERATIONAL_PATTERNS = [
  /^(hi|hello|hey|thanks|thank you|ok|okay|yes|no|sure|got it|do it|done|sounds good|agreed|perfect|great|fine|yep|nope|nah)/i,
  /^(can you|could you|please|help me)\s+(format|fix|debug|deploy|push|commit|merge)/i,
  /^(show me|list|display|open|close|run|start|stop|restart)/i,
  /^(git |npm |docker |kubectl )/i,
  /^\/\w+/, // slash commands
];

// ── Core Detection Functions ─────────────────────────

/**
 * Detect science entities and original thinking in a message.
 * Fast path (regex) runs first, always. LLM path is optional.
 */
export async function detectEntities(
  message: string,
  options?: { fast?: boolean; llm?: LLMClient; model?: string }
): Promise<EntityDetectionResult> {
  // Check if operational message first
  if (isOperationalMessage(message)) {
    return { entities: [], originals: [], isOperational: true };
  }

  // Fast path: regex/heuristic detection
  const entities = fastDetect(message);

  // If fast-only mode or no LLM provided, return fast results
  if (options?.fast || !options?.llm) {
    return { entities, originals: [], isOperational: false };
  }

  // LLM path: classify entities + detect original thinking
  const llmResult = await llmDetect(
    options.llm,
    message,
    entities,
    options.model
  );

  return {
    entities: mergeEntities(entities, llmResult.entities),
    originals: llmResult.originals,
    isOperational: false,
  };
}

/**
 * Check if a message is purely operational (no science content).
 */
function isOperationalMessage(message: string): boolean {
  const trimmed = message.trim();
  if (trimmed.length < 5) return true;
  return OPERATIONAL_PATTERNS.some((p) => p.test(trimmed));
}

/**
 * Fast regex/heuristic entity detection. Should complete in <10ms.
 */
export function fastDetect(message: string): DetectedEntity[] {
  const entities: DetectedEntity[] = [];
  const seen = new Set<string>();

  // Detect arXiv IDs
  for (const match of message.matchAll(ARXIV_PATTERN)) {
    const arxivId = match[1];
    const key = `paper:arxiv:${arxivId}`;
    if (seen.has(key)) continue;
    seen.add(key);

    entities.push({
      type: "paper",
      name: `arXiv:${arxivId}`,
      identifiers: { arxiv: arxivId },
      confidence: "high",
      span: match[0],
      suggestedPath: `wiki/entities/papers/arxiv-${arxivId.replace(/\./g, "-")}.md`,
    });
  }

  // Detect DOIs
  for (const match of message.matchAll(DOI_PATTERN)) {
    const doi = match[1].replace(/[.,;)]+$/, ""); // trim trailing punctuation
    const key = `paper:doi:${doi}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const slug = doi
      .replace(/[^a-z0-9]+/gi, "-")
      .toLowerCase()
      .slice(0, 60);
    entities.push({
      type: "paper",
      name: `DOI:${doi}`,
      identifiers: { doi },
      confidence: "high",
      span: match[0],
      suggestedPath: `wiki/entities/papers/doi-${slug}.md`,
    });
  }

  // Detect Author et al. references
  for (const match of message.matchAll(AUTHOR_ET_AL_PATTERN)) {
    const author = match[1];
    const year = match[2] ?? "";
    const key = `author:${author.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const slug = author.toLowerCase().replace(/\s+/g, "-");
    entities.push({
      type: "author",
      name: author,
      identifiers: year ? { year } : {},
      confidence: "medium",
      span: match[0],
      suggestedPath: `wiki/entities/people/${slug}.md`,
    });

    // Also register the paper reference
    const paperKey = `paper:${author.toLowerCase()}-${year}`;
    if (!seen.has(paperKey)) {
      seen.add(paperKey);
      const paperSlug = `${slug}-${year || "unknown"}-et-al`;
      entities.push({
        type: "paper",
        name: `${author} et al.${year ? ` (${year})` : ""}`,
        identifiers: year ? { year } : {},
        confidence: "medium",
        span: match[0],
        suggestedPath: `wiki/entities/papers/${paperSlug}.md`,
      });
    }
  }

  // Detect Author (Year) references
  for (const match of message.matchAll(AUTHOR_YEAR_PATTERN)) {
    const author = match[1];
    const year = match[2];
    const authorKey = `author:${author.toLowerCase()}`;
    const paperKey = `paper:${author.toLowerCase()}-${year}`;

    if (!seen.has(authorKey)) {
      seen.add(authorKey);
      const slug = author.toLowerCase().replace(/\s+/g, "-");
      entities.push({
        type: "author",
        name: author,
        identifiers: { year },
        confidence: "medium",
        span: match[0],
        suggestedPath: `wiki/entities/people/${slug}.md`,
      });
    }

    if (!seen.has(paperKey)) {
      seen.add(paperKey);
      const slug = author.toLowerCase().replace(/\s+/g, "-");
      entities.push({
        type: "paper",
        name: `${author} (${year})`,
        identifiers: { year },
        confidence: "medium",
        span: match[0],
        suggestedPath: `wiki/entities/papers/${slug}-${year}.md`,
      });
    }
  }

  // Detect "the X paper" references
  for (const match of message.matchAll(THE_PAPER_PATTERN)) {
    const title = match[1];
    if (!title) continue;
    const key = `paper:${title.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, 60);
    entities.push({
      type: "paper",
      name: title,
      identifiers: {},
      confidence: "low",
      span: match[0],
      suggestedPath: `wiki/entities/papers/${slug}.md`,
    });
  }

  // Detect methods (ML + bio)
  detectDictionaryEntities(
    message,
    ML_METHODS,
    "method",
    "wiki/concepts",
    entities,
    seen
  );
  detectDictionaryEntities(
    message,
    BIO_METHODS,
    "method",
    "wiki/concepts",
    entities,
    seen
  );

  // Detect datasets
  detectDictionaryEntities(
    message,
    DATASETS,
    "dataset",
    "wiki/resources/data",
    entities,
    seen
  );

  return entities;
}

/**
 * Detect entities from a known dictionary in the message text.
 */
function detectDictionaryEntities(
  message: string,
  dictionary: Set<string>,
  type: ScienceEntityType,
  pathPrefix: string,
  entities: DetectedEntity[],
  seen: Set<string>
): void {
  const messageLower = message.toLowerCase();

  for (const term of dictionary) {
    const key = `${type}:${term}`;
    if (seen.has(key)) continue;

    // Word-boundary-aware search — scan ALL occurrences, not just the first
    const termLower = term.toLowerCase();
    let idx = messageLower.indexOf(termLower);
    let matched = false;
    let matchIdx = -1;

    while (idx !== -1) {
      // Check word boundaries (allow trailing 's' for plurals, e.g. "transformers" matches "transformer")
      const before = idx > 0 ? messageLower[idx - 1] : " ";
      const afterIdx = idx + termLower.length;
      const after =
        afterIdx < messageLower.length ? messageLower[afterIdx] : " ";
      const isWordBoundary = /[\s,.;:!?()\-/]/.test(before) || idx === 0;
      const isEndBoundary =
        /[\s,.;:!?()\-/]/.test(after) ||
        afterIdx === messageLower.length ||
        // Allow plural 's' followed by a word boundary
        (after === "s" &&
          (afterIdx + 1 >= messageLower.length ||
            /[\s,.;:!?()\-/]/.test(messageLower[afterIdx + 1])));

      if (isWordBoundary && isEndBoundary) {
        matched = true;
        matchIdx = idx;
        break;
      }

      // Try next occurrence
      idx = messageLower.indexOf(termLower, idx + 1);
    }

    if (!matched) continue;

    seen.add(key);
    const slug = term.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    entities.push({
      type,
      name: term,
      identifiers: {},
      confidence: "medium",
      span: message.slice(matchIdx, matchIdx + term.length),
      suggestedPath: `${pathPrefix}/${slug}.md`,
    });
  }
}

// ── LLM Detection ────────────────────────────────────

const ENTITY_DETECTION_PROMPT = `You are a science entity detector for a researcher's second brain.
Analyze the message and extract:

1. ENTITIES: Papers, authors, methods, datasets, concepts mentioned.
   For each: type, name, identifiers, confidence.

2. ORIGINALS (PRIMARY — most valuable): The researcher's OWN ideas, observations, hypotheses, hot takes, frameworks, connections, questions.
   - Capture EXACT phrasing. Never paraphrase.
   - Use their language for the slug.
   - Example: "retrieval beats reasoning because knowledge lives in weights" → slug: "retrieval-beats-reasoning-because-knowledge-in-weights"

Output valid JSON:
{
  "entities": [
    { "type": "paper|author|method|dataset|concept", "name": "...", "identifiers": {}, "confidence": "low|medium|high", "span": "exact text" }
  ],
  "originals": [
    { "verbatim": "exact quote from message", "kind": "observation|hypothesis|framework|hot_take|connection|question", "suggestedSlug": "slug-from-their-words", "relatedEntities": ["entity names"] }
  ]
}

If no entities or originals, return empty arrays.`;

interface LLMDetectionResult {
  entities: DetectedEntity[];
  originals: DetectedOriginal[];
}

async function llmDetect(
  llm: LLMClient,
  message: string,
  fastEntities: DetectedEntity[],
  model?: string
): Promise<LLMDetectionResult> {
  try {
    const fastContext =
      fastEntities.length > 0
        ? `\n\nAlready detected by regex: ${fastEntities.map((e) => `${e.type}:${e.name}`).join(", ")}`
        : "";

    const response = await llm.complete({
      system: ENTITY_DETECTION_PROMPT,
      user: `${message}${fastContext}`,
      model: model ?? "gpt-4.1-mini",
    });

    const jsonMatch = response.content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { entities: [], originals: [] };

    const parsed = JSON.parse(jsonMatch[0]) as {
      entities?: Array<{
        type: string;
        name: string;
        identifiers?: Record<string, string>;
        confidence?: string;
        span?: string;
      }>;
      originals?: Array<{
        verbatim: string;
        kind: string;
        suggestedSlug: string;
        relatedEntities?: string[];
      }>;
    };

    const entities: DetectedEntity[] = (parsed.entities ?? []).map((e) => ({
      type: validateEntityType(e.type),
      name: e.name,
      identifiers: e.identifiers ?? {},
      confidence: validateConfidence(e.confidence),
      span: e.span ?? e.name,
      suggestedPath: suggestPath(validateEntityType(e.type), e.name),
    }));

    const originals: DetectedOriginal[] = (parsed.originals ?? []).map((o) => ({
      verbatim: o.verbatim,
      kind: validateOriginalKind(o.kind),
      suggestedSlug: o.suggestedSlug || slugify(o.verbatim),
      relatedEntities: o.relatedEntities ?? [],
    }));

    return { entities, originals };
  } catch {
    // LLM detection is optional — failures are silent
    return { entities: [], originals: [] };
  }
}

// ── Helpers ──────────────────────────────────────────

function validateEntityType(type: string): ScienceEntityType {
  const valid: ScienceEntityType[] = [
    "paper",
    "author",
    "method",
    "dataset",
    "concept",
    "original_idea",
  ];
  return valid.includes(type as ScienceEntityType)
    ? (type as ScienceEntityType)
    : "concept";
}

function validateConfidence(c?: string): Confidence {
  if (c === "low" || c === "medium" || c === "high") return c;
  return "medium";
}

function validateOriginalKind(
  kind: string
): DetectedOriginal["kind"] {
  const valid: DetectedOriginal["kind"][] = [
    "observation",
    "hypothesis",
    "framework",
    "hot_take",
    "connection",
    "question",
  ];
  return valid.includes(kind as DetectedOriginal["kind"])
    ? (kind as DetectedOriginal["kind"])
    : "observation";
}

function suggestPath(type: ScienceEntityType, name: string): string {
  const slug = slugify(name);
  switch (type) {
    case "paper":
      return `wiki/entities/papers/${slug}.md`;
    case "author":
      return `wiki/entities/people/${slug}.md`;
    case "method":
      return `wiki/concepts/${slug}.md`;
    case "dataset":
      return `wiki/resources/data/${slug}.md`;
    case "concept":
      return `wiki/concepts/${slug}.md`;
    case "original_idea":
      return `wiki/originals/${slug}.md`;
  }
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

/**
 * Merge fast-path and LLM-path entities, deduplicating by name.
 */
function mergeEntities(
  fast: DetectedEntity[],
  llm: DetectedEntity[]
): DetectedEntity[] {
  const seen = new Set<string>();
  const merged: DetectedEntity[] = [];

  // Fast-path entities take priority (they have exact regex spans)
  for (const entity of fast) {
    const key = `${entity.type}:${entity.name.toLowerCase()}`;
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(entity);
    }
  }

  // Add LLM entities that weren't already found
  for (const entity of llm) {
    const key = `${entity.type}:${entity.name.toLowerCase()}`;
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(entity);
    }
  }

  return merged;
}
