const DEFAULT_BRIEFING_SECTIONS = [
  "Today's Top Stories",
  "Why This Matters For The Study",
  "Sources",
  "Suggested Next Actions",
];

const DEFAULT_RESEARCH_SECTIONS = [
  "Papers",
  "Datasets",
  "Methods",
  "Tools",
];

const RESEARCH_SECTION_PATTERNS = [
  { pattern: /\bpapers?\b/i, label: "Papers" },
  { pattern: /\bdatasets?\b/i, label: "Datasets" },
  { pattern: /\bmethods?\b/i, label: "Methods" },
  { pattern: /\btools?\b/i, label: "Tools" },
];

const EXPLICIT_SECTION_PATTERNS = [
  /\bwith\s+sections?\s+(?:for|on|covering)\s+([^.\n;:]+)/i,
  /\b(?:sections?|headings?)\s+(?:for|on|covering)\s+([^.\n;:]+)/i,
  /\borganized\s+(?:into|by)\s+([^.\n;:]+)/i,
];

export interface WatchBriefingStructure {
  sections: string[];
  preserveRequestedStructure: boolean;
}

function uniqPreserveOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];

  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    deduped.push(value);
  }

  return deduped;
}

function titleCase(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function canonicalSectionName(value: string): string | null {
  const normalized = value
    .toLowerCase()
    .replace(/["'`]/g, "")
    .replace(/\b(section|sections|heading|headings)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) return null;
  if (/\btop stories\b/.test(normalized)) return "Today's Top Stories";
  if (/\bwhy (this|it) matters\b/.test(normalized) || /\bproject implications\b/.test(normalized)) {
    return "Why This Matters For The Study";
  }
  if (/\bsources?\b/.test(normalized) || /\bsource links?\b/.test(normalized)) return "Sources";
  if (/\bnext actions?\b/.test(normalized) || /\brecommended actions?\b/.test(normalized)) {
    return "Suggested Next Actions";
  }
  if (normalized === "paper" || normalized === "papers") return "Papers";
  if (normalized === "dataset" || normalized === "datasets") return "Datasets";
  if (normalized === "method" || normalized === "methods") return "Methods";
  if (normalized === "tool" || normalized === "tools") return "Tools";
  return titleCase(normalized);
}

function splitSectionList(value: string): string[] {
  return value
    .split(/\b(?:avoid|without|rather than|instead of)\b/i)[0]
    .replace(/\band\b/gi, ",")
    .replace(/&/g, ",")
    .replace(/\//g, ",")
    .split(",")
    .map((entry) =>
      entry
        .replace(/\b(?:for|on|covering|focused on|first|then|finally)\b/gi, " ")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter(Boolean);
}

function extractExplicitSections(text: string): string[] {
  const matches = EXPLICIT_SECTION_PATTERNS.flatMap((pattern) => {
    const match = pattern.exec(text);
    return match?.[1] ? splitSectionList(match[1]) : [];
  });

  return uniqPreserveOrder(
    matches
      .map(canonicalSectionName)
      .filter((section): section is string => Boolean(section)),
  );
}

function inferResearchSections(text: string): string[] {
  const normalized = text.toLowerCase();
  const researchFirst = /\bresearch[-\s]?first\b/.test(normalized);
  const sections = uniqPreserveOrder(
    RESEARCH_SECTION_PATTERNS
      .filter(({ pattern }) => pattern.test(text))
      .map(({ label }) => label),
  );

  if (researchFirst) {
    return sections.length > 0 ? sections : [...DEFAULT_RESEARCH_SECTIONS];
  }

  return sections.length >= 3 ? sections : [];
}

export function inferWatchBriefingStructure(...texts: Array<string | undefined>): WatchBriefingStructure {
  for (const text of texts) {
    if (!text?.trim()) continue;
    const explicitSections = extractExplicitSections(text);
    if (explicitSections.length >= 2) {
      return {
        sections: explicitSections,
        preserveRequestedStructure: true,
      };
    }
  }

  for (const text of texts) {
    if (!text?.trim()) continue;
    const researchSections = inferResearchSections(text);
    if (researchSections.length >= 2) {
      return {
        sections: researchSections,
        preserveRequestedStructure: true,
      };
    }
  }

  return {
    sections: [...DEFAULT_BRIEFING_SECTIONS],
    preserveRequestedStructure: false,
  };
}

export function buildWatchOutputSectionLines(...texts: Array<string | undefined>): string[] {
  const structure = inferWatchBriefingStructure(...texts);

  if (structure.preserveRequestedStructure) {
    return [
      "Preserve the user's requested briefing structure instead of defaulting to a generic top-stories/news template.",
      "Return a concise Markdown briefing with these sections, in order:",
      ...structure.sections.map((section, index) => `${index + 1}. ${section}`),
      "If a requested section has no material updates, keep the heading and say so briefly.",
    ];
  }

  return [
    "Return a concise Markdown briefing with:",
    ...structure.sections.map((section, index) => `${index + 1}. ${section}`),
  ];
}

export function promptPreservesRequestedStructure(
  prompt: string,
  ...texts: Array<string | undefined>
): boolean {
  if (!prompt.trim()) return false;

  const structure = inferWatchBriefingStructure(...texts);
  if (!structure.preserveRequestedStructure) {
    return true;
  }

  const normalizedPrompt = prompt.toLowerCase();
  if (structure.sections.some((section) => !normalizedPrompt.includes(section.toLowerCase()))) {
    return false;
  }

  const explicitlyRequestedTopStories = structure.sections.some((section) => section.toLowerCase().includes("top stories"));
  if (!explicitlyRequestedTopStories && /\btop stories\b/i.test(prompt)) {
    return false;
  }

  return true;
}

export function buildWatchCompiledPrompt(input: {
  objective: string;
  keywords: string[];
  searchQueries: string[];
  projectLabel?: string;
}): string {
  const projectLabel = input.projectLabel || "this study";
  const structure = inferWatchBriefingStructure(input.objective);
  const queryLines = input.searchQueries.map((query) => `- ${query}`).join("\n");

  const coverageLines = structure.preserveRequestedStructure
    ? [
        "Prioritize the user's requested structure and emphasis instead of forcing a generic headlines brief.",
        "Prefer the artifact types and topic buckets the user explicitly asked for.",
      ]
    : [
        "Cover the following when relevant:",
        "1. Today's top stories and why they matter.",
        "2. New papers, models, releases, benchmarks, datasets, and capability jumps.",
        "3. Startup, funding, lab, policy, leadership, and product announcements.",
        "4. Community discussion or social buzz that could change priorities.",
        "5. Direct implications for this study and recommended next actions.",
      ];

  return [
    `Search for and compile the most important current news and research signals for ${projectLabel}.`,
    "",
    `User request: ${input.objective.trim()}`,
    "",
    ...coverageLines,
    "",
    "Use current web search, include source links, prefer primary sources when available, and ignore duplicate low-signal coverage.",
    "For every substantive item, explain why it matters for the study.",
    ...buildWatchOutputSectionLines(input.objective),
    input.keywords.length > 0 ? `Keywords to prioritize: ${input.keywords.join(", ")}.` : "",
    queryLines ? `Search using queries like:\n${queryLines}` : "",
  ].filter(Boolean).join("\n");
}
