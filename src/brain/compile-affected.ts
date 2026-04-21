import { compilePage, type CompileContradiction } from "./compile-page";
import { ensureBrainStoreReady, getBrainStore, type BrainPage } from "./store";
import type { GbrainEngineAdapter } from "./stores/gbrain-engine-adapter";
import type { BrainConfig } from "./types";
import type { LLMClient } from "./llm";
import { getCurrentUserHandle } from "@/lib/setup/gbrain-installer";

export interface CompileAffectedTopic {
  slug: string;
  title: string;
  score: number;
  contradictions: CompileContradiction[];
  backlinksAdded: number;
  compiledTruthPreview: string;
}

export interface CompileAffectedResult {
  sourceSlug: string;
  sourceTitle: string;
  sourceType: string;
  conceptsConsidered: number;
  pagesCompiled: number;
  contradictionsFound: number;
  backlinksAdded: number;
  compiledTopics: CompileAffectedTopic[];
}

export interface CompileAffectedInput {
  sourceSlug: string;
  sourceTitle?: string;
  sourceType?: string;
  content?: string;
  config: BrainConfig;
  llm: LLMClient;
  maxConcepts?: number;
  skipConceptSlugs?: string[];
}

const DEFAULT_MAX_CONCEPTS = 4;
const MAX_CONCEPT_SCAN = 1000;
const MIN_TOKEN_LENGTH = 4;
const FALLBACK_COMPILE_TYPES = new Set([
  "paper",
  "chat",
  "note",
  "observation",
  "hypothesis",
  "experiment",
  "task",
  "dataset",
  "data",
  "lab_data",
]);
const STOP_WORDS = new Set([
  "about",
  "after",
  "against",
  "also",
  "because",
  "between",
  "could",
  "current",
  "evidence",
  "from",
  "have",
  "improve",
  "improved",
  "improves",
  "into",
  "paper",
  "research",
  "results",
  "study",
  "that",
  "their",
  "there",
  "these",
  "this",
  "using",
  "with",
]);

export async function compileAffectedConceptsForSource(
  input: CompileAffectedInput,
): Promise<CompileAffectedResult> {
  await ensureBrainStoreReady();
  const store = getBrainStore();
  const sourceSlug = normalizeSlug(input.sourceSlug);
  const sourcePage = await store.getPage(sourceSlug).catch(() => null);
  const sourceTitle = input.sourceTitle ?? sourcePage?.title ?? titleFromSlug(sourceSlug);
  const sourceType = input.sourceType ?? sourcePage?.type ?? inferSourceType(sourceSlug);
  const sourceContent = (input.content ?? sourcePage?.content ?? "").trim();
  const empty: CompileAffectedResult = {
    sourceSlug,
    sourceTitle,
    sourceType,
    conceptsConsidered: 0,
    pagesCompiled: 0,
    contradictionsFound: 0,
    backlinksAdded: 0,
    compiledTopics: [],
  };

  if (!sourceContent) return empty;

  const concepts = await store.listPages({ type: "concept", limit: MAX_CONCEPT_SCAN });
  const skipConceptSlugs = new Set((input.skipConceptSlugs ?? []).map(normalizeSlug));

  const linkedConceptSlugs = new Set(
    (await store.getLinks(sourceSlug).catch(() => []))
      .filter((link) => link.slug.includes("/concepts/") || link.kind === "concept")
      .map((link) => normalizeSlug(link.slug)),
  );
  const explicitTopicTitle = sourcePage
    ? deriveExplicitConceptTitle(sourcePage, sourceContent)
    : null;
  const explicitTopicTargets = explicitTopicTitle
    ? await buildFallbackCompileTargets({
        store,
        sourceSlug,
        sourceTitle,
        sourceType,
        sourcePage,
        sourceContent,
        skipConceptSlugs,
        titleOverride: explicitTopicTitle,
        score: 100,
      })
    : [];
  const sourceTokens = tokenize(`${sourceTitle}\n${sourceContent}`);
  const scoredCandidates = concepts
    .map((concept) => ({
      concept,
      score: scoreConcept(concept, sourceTokens, linkedConceptSlugs),
    }))
    .filter(({ concept, score }) => {
      const conceptSlug = normalizeSlug(concept.path);
      return score > 0 && conceptSlug !== sourceSlug;
    })
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return left.concept.title.localeCompare(right.concept.title);
    });
  const skippedScoredCandidates = scoredCandidates.some(({ concept }) =>
    skipConceptSlugs.has(normalizeSlug(concept.path)),
  );
  const scored = scoredCandidates
    .filter(({ concept }) => !skipConceptSlugs.has(normalizeSlug(concept.path)))
    .slice(0, input.maxConcepts ?? DEFAULT_MAX_CONCEPTS);

  let compileTargets: Array<{ concept: BrainPage; score: number }>;
  if (explicitTopicTargets.length > 0) {
    compileTargets = explicitTopicTargets;
  } else if (scored.length > 0) {
    compileTargets = scored;
  } else if (skippedScoredCandidates) {
    compileTargets = [];
  } else {
    compileTargets = await buildFallbackCompileTargets({
      store,
      sourceSlug,
      sourceTitle,
      sourceType,
      sourcePage,
      sourceContent,
      skipConceptSlugs,
    });
  }

  if (compileTargets.length === 0) return { ...empty, conceptsConsidered: concepts.length };

  const result: CompileAffectedResult = {
    ...empty,
    conceptsConsidered: concepts.length,
  };

  for (const { concept, score } of compileTargets) {
    const compileResult = await compilePage(
      normalizeSlug(concept.path),
      {
        content: sourceContent,
        sourceSlug,
        sourceTitle,
        sourceType,
      },
      input.config,
      input.llm,
    );
    result.pagesCompiled += 1;
    result.contradictionsFound += compileResult.contradictions.length;
    result.backlinksAdded += compileResult.backlinksAdded;
    result.compiledTopics.push({
      slug: normalizeSlug(concept.path),
      title: concept.title,
      score,
      contradictions: compileResult.contradictions,
      backlinksAdded: compileResult.backlinksAdded,
      compiledTruthPreview: compileResult.compiledTruth.slice(0, 320),
    });
  }

  return result;
}

async function buildFallbackCompileTargets(input: {
  store: ReturnType<typeof getBrainStore>;
  sourceSlug: string;
  sourceTitle: string;
  sourceType: string;
  sourcePage: BrainPage | null;
  sourceContent: string;
  skipConceptSlugs: Set<string>;
  titleOverride?: string;
  score?: number;
}): Promise<Array<{ concept: BrainPage; score: number }>> {
  if (!input.sourcePage) return [];
  if (!FALLBACK_COMPILE_TYPES.has(input.sourceType)) return [];

  const title = input.titleOverride
    ? cleanConceptTitle(input.titleOverride)
    : deriveFallbackConceptTitle(input.sourcePage, input.sourceTitle, input.sourceContent);
  const slug = normalizeSlug(`wiki/concepts/${slugifyConceptTitle(title)}`);
  if (!slug || slug === input.sourceSlug || input.skipConceptSlugs.has(slug)) return [];

  const existing = await input.store.getPage(slug).catch(() => null);
  if (existing) return [{ concept: existing, score: input.score ?? 1 }];

  const adapter = input.store as Partial<GbrainEngineAdapter>;
  if (!adapter.engine) return [];

  const now = new Date().toISOString();
  const createdBy = getCurrentUserHandle();
  const frontmatter = {
    project: input.sourcePage.frontmatter.project,
    type: "concept",
    created_from_source: input.sourceSlug,
    created_at: now,
    created_by: createdBy,
  };

  await adapter.engine.putPage(slug, {
    type: "concept",
    title,
    compiled_truth: [
      `${title} is a current-view topic created from new project evidence.`,
      "Dream Cycle will refine this page as sources, notes, and contradictions accumulate.",
    ].join("\n\n"),
    timeline: "",
    frontmatter: Object.fromEntries(
      Object.entries(frontmatter).filter(([, value]) => value !== undefined),
    ),
  });

  const created = await input.store.getPage(slug).catch(() => null);
  return created ? [{ concept: created, score: input.score ?? 1 }] : [];
}

function deriveExplicitConceptTitle(
  sourcePage: BrainPage,
  sourceContent: string,
): string | null {
  const frontmatterTopic = sourcePage.frontmatter.topic;
  if (typeof frontmatterTopic === "string" && frontmatterTopic.trim()) {
    return cleanConceptTitle(frontmatterTopic);
  }

  const topicLine = sourceContent.match(
    /(?:^|\n)\s*(?:topic|research\s+thread)\s*:\s*([^\n.;]+)/i,
  )?.[1];
  return topicLine?.trim() ? cleanConceptTitle(topicLine) : null;
}

function deriveFallbackConceptTitle(
  sourcePage: BrainPage,
  sourceTitle: string,
  sourceContent: string,
): string {
  const explicitTitle = deriveExplicitConceptTitle(sourcePage, sourceContent);
  if (explicitTitle) return explicitTitle;

  const topicLine = sourceContent.match(
    /(?:^|\n)\s*(?:current\s+view|claim)\s*:\s*([^\n.;]+)/i,
  )?.[1];
  if (topicLine?.trim()) return cleanConceptTitle(topicLine);

  const heading = sourceContent.match(/^#\s+(.+)$/m)?.[1];
  if (heading?.trim()) return cleanConceptTitle(heading);

  return cleanConceptTitle(sourceTitle);
}

function cleanConceptTitle(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(/[.。]+$/, "")
    .trim()
    .slice(0, 120) || "Untitled topic";
}

function slugifyConceptTitle(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s-]+/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80) || "untitled-topic";
}

export function normalizeSlug(value: string): string {
  return value
    .replace(/\\/g, "/")
    .replace(/^gbrain:/, "")
    .replace(/^\.?\//, "")
    .replace(/\.mdx?$/i, "")
    .split("/")
    .filter(Boolean)
    .join("/")
    .toLowerCase();
}

function scoreConcept(
  concept: BrainPage,
  sourceTokens: Set<string>,
  linkedConceptSlugs: Set<string>,
): number {
  const conceptSlug = normalizeSlug(concept.path);
  let score = linkedConceptSlugs.has(conceptSlug) ? 8 : 0;
  const conceptTokens = tokenize(`${concept.title}\n${concept.path}\n${concept.content}`);
  for (const token of conceptTokens) {
    if (sourceTokens.has(token)) score += token.length >= 8 ? 2 : 1;
  }
  return score;
}

function tokenize(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/\s+/)
      .map((token) => token.trim())
      .filter(
        (token) =>
          token.length >= MIN_TOKEN_LENGTH &&
          !STOP_WORDS.has(token) &&
          !/^\d+$/.test(token),
      ),
  );
}

function titleFromSlug(slug: string): string {
  return slug
    .split("/")
    .pop()!
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function inferSourceType(slug: string): string {
  const segments = normalizeSlug(slug).split("/").filter(Boolean);
  const lastSegment = segments.at(-1) ?? "";
  if (hasPathSegment(segments, "papers", "paper")) return "paper";
  if (hasPathSegment(segments, "experiments", "experiment")) return "experiment";
  if (hasPathSegment(segments, "data", "datasets", "dataset") || lastSegment.endsWith("-dataset")) return "data";
  if (hasPathSegment(segments, "meetings", "meeting")) return "meeting";
  return "note";
}

function hasPathSegment(segments: string[], ...candidates: string[]): boolean {
  return segments.some((segment) => candidates.includes(segment));
}
