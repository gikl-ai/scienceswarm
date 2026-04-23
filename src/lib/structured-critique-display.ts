import type { StructuredCritiqueResult } from "@/lib/structured-critique-schema";

export type CritiqueDisplayItem = {
  title: string;
  bodyMarkdown: string;
  findingIds?: string[];
};

export type CritiqueDisplayModel = {
  title?: string;
  summaryMarkdown?: string;
  atAGlance?: string;
  topIssues: CritiqueDisplayItem[];
  sectionFeedback: CritiqueDisplayItem[];
  questionsForAuthors: CritiqueDisplayItem[];
  referencesFeedbackMarkdown?: string;
  appendixOverviewMarkdown?: string;
  fullReportMarkdown: string;
  unclassifiedSections: MarkdownSection[];
};

export type MarkdownSection = {
  title: string;
  depth: number;
  bodyMarkdown: string;
  children: MarkdownSection[];
};

type DisplaySectionRole =
  | "summary"
  | "top_issues"
  | "section_feedback"
  | "questions_for_authors"
  | "references_feedback"
  | "appendix";

const SECTION_ROLE_ALIASES: Record<DisplaySectionRole, string[]> = {
  summary: ["overall summary", "summary", "executive summary", "brief"],
  top_issues: ["top issues", "priority issues", "main issues", "main findings"],
  section_feedback: [
    "section-by-section feedback",
    "section by section feedback",
    "section feedback",
    "manuscript sections",
  ],
  questions_for_authors: [
    "questions for authors",
    "author questions",
    "questions",
  ],
  references_feedback: [
    "relevant methods references",
    "references feedback",
    "reference feedback",
    "references",
  ],
  appendix: ["detailed appendix", "appendix"],
};

export function buildCritiqueDisplayModel(
  result: StructuredCritiqueResult,
): CritiqueDisplayModel {
  const fullReportMarkdown = result.report_markdown.trim();
  const markdownSections = parseMarkdownSections(fullReportMarkdown);
  const consumedMarkdownSections = new Set<MarkdownSection>();
  const displayContract = readDisplayContract(result);
  const authorFeedback = readRecord(result.author_feedback);

  const summarySection = findMarkdownSection(
    markdownSections,
    SECTION_ROLE_ALIASES.summary,
  );
  if (summarySection) consumedMarkdownSections.add(summarySection);

  const topIssuesSection = findMarkdownSection(
    markdownSections,
    SECTION_ROLE_ALIASES.top_issues,
  );
  if (topIssuesSection) consumedMarkdownSections.add(topIssuesSection);

  const sectionFeedbackSection = findMarkdownSection(
    markdownSections,
    SECTION_ROLE_ALIASES.section_feedback,
  );
  if (sectionFeedbackSection) consumedMarkdownSections.add(sectionFeedbackSection);

  const questionsSection = findMarkdownSection(
    markdownSections,
    SECTION_ROLE_ALIASES.questions_for_authors,
  );
  if (questionsSection) consumedMarkdownSections.add(questionsSection);

  const referencesSection = findMarkdownSection(
    markdownSections,
    SECTION_ROLE_ALIASES.references_feedback,
  );
  if (referencesSection) consumedMarkdownSections.add(referencesSection);

  const appendixSection = findMarkdownSection(
    markdownSections,
    SECTION_ROLE_ALIASES.appendix,
  );
  if (appendixSection) consumedMarkdownSections.add(appendixSection);

  const summaryMarkdown =
    displayContract.summaryMarkdown ??
    readNonEmptyString(authorFeedback?.overall_summary) ??
    cleanMarkdownBody(summarySection?.bodyMarkdown) ??
    firstMeaningfulParagraph(fullReportMarkdown);

  const atAGlance =
    displayContract.atAGlance ??
    extractAtAGlance(summarySection?.bodyMarkdown ?? fullReportMarkdown);

  return {
    title: result.title,
    summaryMarkdown,
    atAGlance,
    topIssues: firstNonEmpty(
      displayContract.topIssues,
      readAuthorFeedbackItems(authorFeedback?.top_issues, {
        titleKeys: ["title"],
        bodyKeys: ["body_markdown", "bodyMarkdown", "summary"],
        fallbackTitle: "Issue",
      }),
      readItemsFromMarkdownSection(topIssuesSection, { fallbackTitle: "Issue" }),
    ),
    sectionFeedback: firstNonEmpty(
      displayContract.sectionFeedback,
      readAuthorFeedbackItems(authorFeedback?.section_feedback, {
        titleKeys: ["section", "title"],
        bodyKeys: ["body_markdown", "bodyMarkdown", "summary"],
        fallbackTitle: "Section",
      }),
      readItemsFromMarkdownSection(sectionFeedbackSection, {
        fallbackTitle: "Section",
      }),
    ),
    questionsForAuthors: firstNonEmpty(
      displayContract.questionsForAuthors,
      readAuthorFeedbackItems(authorFeedback?.questions_for_authors, {
        titleKeys: ["question", "title"],
        bodyKeys: ["body_markdown", "bodyMarkdown", "rationale", "summary"],
        fallbackTitle: "Question",
      }),
      readItemsFromMarkdownSection(questionsSection, {
        fallbackTitle: "Question",
      }),
    ),
    referencesFeedbackMarkdown:
      displayContract.referencesFeedbackMarkdown ??
      readNonEmptyString(authorFeedback?.references_feedback) ??
      cleanMarkdownBody(referencesSection?.bodyMarkdown),
    appendixOverviewMarkdown:
      displayContract.appendixOverviewMarkdown ??
      readNonEmptyString(authorFeedback?.appendix_overview) ??
      cleanMarkdownBody(appendixSection?.bodyMarkdown),
    fullReportMarkdown,
    unclassifiedSections: markdownSections.filter(
      (section) => !consumedMarkdownSections.has(section),
    ),
  };
}

export function parseMarkdownSections(markdown: string): MarkdownSection[] {
  const root: MarkdownSection = {
    title: "",
    depth: 0,
    bodyMarkdown: "",
    children: [],
  };
  const stack: MarkdownSection[] = [root];
  let inFence = false;
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      appendBodyLine(stack.at(-1) ?? root, line);
      continue;
    }

    const heading = inFence ? null : parseHeading(line);
    if (!heading) {
      appendBodyLine(stack.at(-1) ?? root, line);
      continue;
    }

    const section: MarkdownSection = {
      title: heading.title,
      depth: heading.depth,
      bodyMarkdown: "",
      children: [],
    };
    while (stack.length > 1 && (stack.at(-1)?.depth ?? 0) >= heading.depth) {
      stack.pop();
    }
    (stack.at(-1) ?? root).children.push(section);
    stack.push(section);
  }

  return root.children.map(trimSectionBodies);
}

function readDisplayContract(result: StructuredCritiqueResult): {
  summaryMarkdown?: string;
  atAGlance?: string;
  topIssues: CritiqueDisplayItem[];
  sectionFeedback: CritiqueDisplayItem[];
  questionsForAuthors: CritiqueDisplayItem[];
  referencesFeedbackMarkdown?: string;
  appendixOverviewMarkdown?: string;
} {
  const display = readRecord((result as Record<string, unknown>).display);
  const sections = Array.isArray(display?.sections) ? display.sections : [];
  return {
    summaryMarkdown: readMarkdownLike(display?.summary),
    atAGlance: readNonEmptyString(display?.at_a_glance ?? display?.atAGlance),
    topIssues: readDisplayItemsForRole(sections, "top_issues"),
    sectionFeedback: readDisplayItemsForRole(sections, "section_feedback"),
    questionsForAuthors: readDisplayItemsForRole(
      sections,
      "questions_for_authors",
    ),
    referencesFeedbackMarkdown: readDisplayBodyForRole(
      sections,
      "references_feedback",
    ),
    appendixOverviewMarkdown: readDisplayBodyForRole(sections, "appendix"),
  };
}

function readDisplayItemsForRole(
  sections: unknown[],
  role: DisplaySectionRole,
): CritiqueDisplayItem[] {
  const section = sections
    .map(readRecord)
    .find((entry) => normalizeRole(entry?.role) === role);
  if (!section) return [];
  const sectionBody = readBodyMarkdown(section);
  const items = readAuthorFeedbackItems(section.items, {
    titleKeys: ["title", "section", "question"],
    bodyKeys: ["body_markdown", "bodyMarkdown", "summary", "rationale"],
    fallbackTitle: readNonEmptyString(section.title) ?? titleFromRole(role),
  });
  if (items.length > 0) return items;
  return sectionBody
    ? [
        {
          title: readNonEmptyString(section.title) ?? titleFromRole(role),
          bodyMarkdown: sectionBody,
        },
      ]
    : [];
}

function readDisplayBodyForRole(
  sections: unknown[],
  role: DisplaySectionRole,
): string | undefined {
  const section = sections
    .map(readRecord)
    .find((entry) => normalizeRole(entry?.role) === role);
  return section ? readBodyMarkdown(section) : undefined;
}

function readAuthorFeedbackItems(
  value: unknown,
  options: {
    titleKeys: string[];
    bodyKeys: string[];
    fallbackTitle: string;
  },
): CritiqueDisplayItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry, index): CritiqueDisplayItem[] => {
    const record = readRecord(entry);
    if (!record) return [];
    const title =
      readFirstString(record, options.titleKeys) ??
      `${options.fallbackTitle} ${index + 1}`;
    const bodyMarkdown = readFirstString(record, options.bodyKeys);
    if (!bodyMarkdown) return [];
    const findingIds = readStringArray(record.finding_ids ?? record.findingIds);
    return [
      {
        title,
        bodyMarkdown,
        ...(findingIds.length > 0 ? { findingIds } : {}),
      },
    ];
  });
}

function readItemsFromMarkdownSection(
  section: MarkdownSection | null | undefined,
  options: { fallbackTitle: string },
): CritiqueDisplayItem[] {
  if (!section) return [];
  if (section.children.length > 0) {
    return section.children.flatMap((child, index): CritiqueDisplayItem[] => {
      const bodyMarkdown = cleanMarkdownBody(child.bodyMarkdown);
      if (!bodyMarkdown) return [];
      return [
        {
          title: child.title || `${options.fallbackTitle} ${index + 1}`,
          bodyMarkdown,
        },
      ];
    });
  }

  const bodyMarkdown = cleanMarkdownBody(section.bodyMarkdown);
  if (!bodyMarkdown) return [];
  return [
    {
      title: section.title || options.fallbackTitle,
      bodyMarkdown,
    },
  ];
}

function findMarkdownSection(
  sections: MarkdownSection[],
  aliases: string[],
): MarkdownSection | null {
  for (const section of sections) {
    if (aliases.includes(normalizeHeading(section.title))) return section;
    const child = findMarkdownSection(section.children, aliases);
    if (child) return child;
  }
  return null;
}

function parseHeading(line: string): { depth: number; title: string } | null {
  const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
  if (!match) return null;
  return {
    depth: match[1].length,
    title: match[2].trim(),
  };
}

function appendBodyLine(section: MarkdownSection, line: string): void {
  section.bodyMarkdown += section.bodyMarkdown.length > 0 ? `\n${line}` : line;
}

function trimSectionBodies(section: MarkdownSection): MarkdownSection {
  return {
    ...section,
    bodyMarkdown: section.bodyMarkdown.trim(),
    children: section.children.map(trimSectionBodies),
  };
}

function extractAtAGlance(markdown: string): string | undefined {
  const match = /\*\*At a glance:\*\*\s*([^\n]+)/i.exec(markdown);
  return readNonEmptyString(match?.[1]);
}

function firstMeaningfulParagraph(markdown: string): string | undefined {
  const bodyWithoutTitle = markdown
    .replace(/\r\n/g, "\n")
    .replace(/^#\s+.+?(?:\n+|$)/, "")
    .trim();
  return readNonEmptyString(
    bodyWithoutTitle
      .split(/\n{2,}/)
      .find((paragraph) => !/^#{1,6}\s/.test(paragraph.trim())),
  );
}

function cleanMarkdownBody(markdown: string | undefined): string | undefined {
  if (!markdown) return undefined;
  const withoutAtAGlance = markdown
    .replace(/\*\*At a glance:\*\*\s*[^\n]+/i, "")
    .trim();
  return readNonEmptyString(withoutAtAGlance);
}

function readMarkdownLike(value: unknown): string | undefined {
  if (typeof value === "string") return readNonEmptyString(value);
  const record = readRecord(value);
  return record ? readBodyMarkdown(record) : undefined;
}

function readBodyMarkdown(record: Record<string, unknown>): string | undefined {
  return readFirstString(record, [
    "body_markdown",
    "bodyMarkdown",
    "summary",
    "text",
  ]);
}

function firstNonEmpty<T>(...arrays: T[][]): T[] {
  return arrays.find((array) => array.length > 0) ?? [];
}

function readFirstString(
  record: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = readNonEmptyString(record[key]);
    if (value) return value;
  }
  return undefined;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): string[] => {
    const text = readNonEmptyString(entry);
    return text ? [text] : [];
  });
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeRole(value: unknown): string | undefined {
  return readNonEmptyString(value)?.toLowerCase().replace(/-/g, "_");
}

function normalizeHeading(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/[-\s]+/g, " ");
}

function titleFromRole(role: DisplaySectionRole): string {
  return role
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}
