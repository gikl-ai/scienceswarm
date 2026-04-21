import { isStrictLocalOnlyEnabled } from "@/lib/env-flags";
import { completeLocal, isLocalProviderConfigured } from "@/lib/local-llm";
import { getOpenAIClient, getOpenAIModel, hasOpenAIKey } from "@/lib/openai-client";
import type {
  LiteratureReviewGroup,
  PaperMetadata,
  Summarizer,
} from "@/lib/lit-review";

const PAPER_CONTEXT_LIMIT = 40;
const ABSTRACT_CHAR_LIMIT = 600;

export class LiteratureReviewSummarizerUnavailableError extends Error {
  readonly status = 503;

  constructor(message: string) {
    super(message);
    this.name = "LiteratureReviewSummarizerUnavailableError";
  }
}

function truncateAbstract(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (trimmed.length <= ABSTRACT_CHAR_LIMIT) return trimmed;
  return `${trimmed.slice(0, ABSTRACT_CHAR_LIMIT - 1).trimEnd()}...`;
}

function formatPaper(paper: PaperMetadata, index: number): string {
  const parts = [`${index + 1}. ${paper.title}`];
  if (paper.year !== undefined) parts.push(`year=${paper.year}`);
  if (paper.authors?.length) parts.push(`authors=${paper.authors.slice(0, 6).join(", ")}`);
  if (paper.tags?.length) parts.push(`tags=${paper.tags.slice(0, 8).join(", ")}`);
  if (paper.doi) parts.push(`doi=${paper.doi}`);
  parts.push(`file=${paper.file}`);
  const abstract = truncateAbstract(paper.abstract);
  if (abstract) parts.push(`abstract=${abstract}`);
  return parts.join(" | ");
}

function buildGroupSummary(groups: LiteratureReviewGroup[]): string {
  if (groups.length === 0) return "No groups.";
  return groups
    .map((group) => `${group.heading} (${group.papers.length})`)
    .join(", ");
}

function buildPrompt(papers: PaperMetadata[], groups: LiteratureReviewGroup[]): string {
  const paperLines = papers
    .slice(0, PAPER_CONTEXT_LIMIT)
    .map((paper, index) => formatPaper(paper, index));

  return [
    `Total papers: ${papers.length}`,
    `Groups: ${buildGroupSummary(groups)}`,
    "",
    "Paper metadata:",
    ...paperLines,
    "",
    papers.length > PAPER_CONTEXT_LIMIT
      ? `Only the first ${PAPER_CONTEXT_LIMIT} papers are listed here. Be explicit about any uncertainty caused by truncation.`
      : "All paper metadata available to the route is listed here.",
  ].join("\n");
}

function buildMessages(papers: PaperMetadata[], groups: LiteratureReviewGroup[]) {
  return [
    {
      role: "system" as const,
      content: [
        "You are summarizing a research workspace literature review.",
        "Use only the supplied metadata and abstracts.",
        "Do not invent methods, findings, or citations.",
        "Write 2 short paragraphs followed by 3-5 bullet points covering themes, clusters, and obvious gaps.",
        "If the evidence is sparse or incomplete, say so plainly.",
      ].join(" "),
    },
    {
      role: "user" as const,
      content: buildPrompt(papers, groups),
    },
  ];
}

function normalizeSummary(summary: string): string {
  const trimmed = summary.trim();
  if (!trimmed) {
    throw new Error("Literature review summarizer returned empty output.");
  }
  return trimmed;
}

export const summarizeLiteratureReview: Summarizer = async ({ papers, groups }) => {
  if (papers.length === 0) return "";

  const messages = buildMessages(papers, groups);

  if (isLocalProviderConfigured()) {
    return normalizeSummary(await completeLocal(messages));
  }

  if (isStrictLocalOnlyEnabled()) {
    throw new LiteratureReviewSummarizerUnavailableError(
      "Strict local-only mode is enabled. Configure local chat before generating a literature review.",
    );
  }

  if (!hasOpenAIKey()) {
    throw new LiteratureReviewSummarizerUnavailableError(
      "Literature review requires a configured LLM backend. Set LLM_PROVIDER=local or OPENAI_API_KEY.",
    );
  }

  const response = await getOpenAIClient().chat.completions.create({
    model: getOpenAIModel(),
    messages,
    stream: false,
    temperature: 0.2,
    max_completion_tokens: 900,
  });

  return normalizeSummary(response.choices[0]?.message?.content ?? "");
};
