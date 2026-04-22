export interface TargetPrioritizationSource {
  workspacePath?: string | null;
  sourceFilename: string;
  title?: string;
  text: string;
}

export interface CandidatePriority {
  name: string;
  score: number;
  evidenceStrength: number;
  mechanismFit: number;
  resistanceRisk: number;
  assayability: number;
  tractability: number;
  timelineFit: number;
  evidence: string[];
  rationale: string;
  caveats: string[];
}

export interface TargetPrioritizationAssessment {
  title: string;
  markdown: string;
  summary: string;
  candidates: CandidatePriority[];
  criteria: string[];
  constraintNotes: string[];
  thinEvidenceWarnings: string[];
}

const PRIORITIZATION_REQUEST_RE =
  /\b(?:re)?prioriti[sz]e|\b(rank|ranking|score|choose|shortlist|which (?:target|biomarker|combination)|best (?:target|biomarker|combination)|next wave|validation wave)\b/i;

const CANDIDATE_CONTEXT_RE =
  /\b(candidates?|targets?|biomarkers?|markers?|combinations?|therap(?:y|ies)|drugs?|inhibitors?|pathways?|resistance|validation)\b/i;

const KNOWN_CANDIDATE_RE =
  /\b(?:EGFR|MEK|ERK|KRAS|NRAS|BRAF|MET|AXL|ERBB2|ERBB3|HER2|PI3K|AKT|MTOR|YAP1|TEAD|CDK4\/6|PD[- ]?1|PD[- ]?L1|CTLA4|VEGF|VEGFA|MYC|TP53|BRCA1|BRCA2|PARP|ALK|ROS1|RET|NTRK|FGFR[1-4]?|IDH[12]?)\b/g;

const COMBINATION_CANDIDATE_RE =
  /\b[A-Z0-9][A-Z0-9/-]{1,}(?:\s*\+\s*[A-Z0-9][A-Z0-9/-]{1,})+\b/g;

const GENERIC_CANDIDATE_LINE_RE =
  /(?:^|\n)\s*(?:[-*]|\d+[.)])\s*(?:candidate|target|biomarker|combo|combination)?\s*:?\s*([A-Za-z0-9+/\- ]{2,80})(?=$|[:\-–—]|\n)/g;

const CRITERIA = [
  "evidence strength",
  "mechanism fit",
  "resistance risk",
  "assayability",
  "tractability",
  "timeline fit",
];

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function sourceStem(filename: string): string {
  return filename.replace(/\.[a-z0-9]+$/i, "") || filename;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function normalizeCandidateName(value: string): string {
  return compactWhitespace(value)
    .replace(/\b(?:candidate|target|biomarker|combo|combination)\b\s*:?\s*/ig, "")
    .replace(/\s*\([^)]*\)\s*$/g, "")
    .trim();
}

function combinedText(prompt: string, sources: TargetPrioritizationSource[]): string {
  return [prompt, ...sources.map((source) => source.text)].join("\n\n");
}

function candidateWindow(text: string, candidate: string): string {
  const lineWindow = text
    .split(/\n+/)
    .map((line) => compactWhitespace(line))
    .find((line) => new RegExp(`\\b${candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(line));
  if (lineWindow) return lineWindow.slice(0, 420);

  const normalizedCandidate = candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(new RegExp(`[^.\\n]{0,180}\\b${normalizedCandidate}\\b[^.\\n]{0,220}`, "i"));
  return compactWhitespace(match?.[0] ?? "");
}

function extractCandidates(text: string): string[] {
  const candidates = new Set<string>();
  const candidateLabelText = text
    .split(/\n+/)
    .map((line) => {
      const bulletLabel = line.match(/^\s*(?:[-*]|\d+[.)])\s*([^:]{2,120}):/);
      return bulletLabel?.[1] ?? line;
    })
    .join("\n");

  for (const match of candidateLabelText.matchAll(COMBINATION_CANDIDATE_RE)) {
    candidates.add(normalizeCandidateName(match[0]));
  }
  for (const match of candidateLabelText.matchAll(KNOWN_CANDIDATE_RE)) {
    candidates.add(normalizeCandidateName(match[0]));
  }
  for (const match of text.matchAll(GENERIC_CANDIDATE_LINE_RE)) {
    const candidate = normalizeCandidateName(match[1] ?? "");
    if (
      candidate.length >= 2
      && candidate.length <= 60
      && !/\b(evidence|notes?|rationale|criteria|timeline|assay|readout)\b/i.test(candidate)
    ) {
      candidates.add(candidate);
    }
  }
  const allCandidates = Array.from(candidates);
  const combinations = allCandidates.filter((candidate) => candidate.includes("+"));
  return allCandidates
    .filter((candidate) => {
      if (candidate.includes("+")) return true;
      return !combinations.some((combination) =>
        combination
          .split("+")
          .map((part) => part.trim())
          .includes(candidate)
      );
    })
    .slice(0, 12);
}

function scorePattern(window: string, patterns: RegExp[], base = 1): number {
  const hits = patterns.filter((pattern) => pattern.test(window)).length;
  return Math.min(5, base + hits);
}

function constraintWeights(prompt: string): {
  evidence: number;
  mechanism: number;
  resistance: number;
  assayability: number;
  tractability: number;
  timeline: number;
} {
  const lowered = prompt.toLowerCase();
  const fast = /\b(short|fast|quick|two[- ]?week|limited window|near[- ]?term|timeline)\b/.test(lowered);
  const assayLimited = /\b(limited assay|assay support|existing assay|available readout|cheap|low budget)\b/.test(lowered);
  const resistance = /\b(resistance|escape|rebound|durable)\b/.test(lowered);
  const mechanism = /\b(mechanism|causal|pathway|biology|fit)\b/.test(lowered);
  return {
    evidence: 1.4,
    mechanism: mechanism ? 1.5 : 1.2,
    resistance: resistance ? 1.4 : 1,
    assayability: fast || assayLimited ? 1.5 : 1,
    tractability: assayLimited ? 1.4 : 1,
    timeline: fast ? 1.7 : 1,
  };
}

function buildConstraintNotes(prompt: string): string[] {
  const notes: string[] = [];
  if (/\b(short|fast|quick|two[- ]?week|limited window|near[- ]?term|timeline)\b/i.test(prompt)) {
    notes.push("Short-window constraint boosts candidates with existing assays, clear readouts, and low setup cost.");
  }
  if (/\b(limited assay|assay support|existing assay|available readout|cheap|low budget)\b/i.test(prompt)) {
    notes.push("Limited assay support boosts candidates that can be tested with available reagents or standard readouts.");
  }
  if (/\b(resistance|escape|rebound|durable)\b/i.test(prompt)) {
    notes.push("Resistance-focused constraint boosts candidates tied to escape biology or durable-response risk.");
  }
  if (notes.length === 0) {
    notes.push("No special constraint was visible, so the default ranking balances evidence, mechanism, risk, assayability, tractability, and timeline.");
  }
  return notes;
}

function scoreCandidate(
  candidate: string,
  text: string,
  prompt: string,
): CandidatePriority {
  const window = candidateWindow(text, candidate);
  const evidenceStrength = scorePattern(window, [
    /\b(strong|validated|replicated|patient|clinical|significant|multiple|orthogonal|response|enriched)\b/i,
    /\b(n\s*[=:]?\s*\d+|cohort|samples?|organoid|pdx|mouse|assay)\b/i,
  ]);
  const mechanismFit = scorePattern(window, [
    /\b(mechanism|pathway|driver|causal|dependency|synthetic lethal|phospho|signaling)\b/i,
    /\b(kras|egfr|mek|erk|resistance|feedback|rebound)\b/i,
  ]);
  const resistanceRisk = scorePattern(window, [
    /\b(resistance|escape|rebound|relapse|bypass|adaptive|feedback)\b/i,
  ]);
  const assayability = scorePattern(window, [
    /\b(assay|readout|viability|western|immunoblot|flow|qpcr|elisa|imaging|available|existing)\b/i,
  ]);
  const tractability = scorePattern(window, [
    /\b(inhibitor|drug|antibody|crispr|sirna|probe|reagent|clinically available|tool compound)\b/i,
  ]);
  const timelineFit = scorePattern(window, [
    /\b(fast|short|ready|available|existing|standard|two[- ]?week|low setup)\b/i,
  ]);
  const weights = constraintWeights(prompt);
  const score =
    evidenceStrength * weights.evidence
    + mechanismFit * weights.mechanism
    + resistanceRisk * weights.resistance
    + assayability * weights.assayability
    + tractability * weights.tractability
    + timelineFit * weights.timeline;
  const evidence = window ? [window] : [];
  const caveats = buildCaveats(window);
  return {
    name: candidate,
    score: Number(score.toFixed(1)),
    evidenceStrength,
    mechanismFit,
    resistanceRisk,
    assayability,
    tractability,
    timelineFit,
    evidence,
    rationale: buildRationale(candidate, {
      evidenceStrength,
      mechanismFit,
      resistanceRisk,
      assayability,
      tractability,
      timelineFit,
    }),
    caveats,
  };
}

function buildCaveats(window: string): string[] {
  const caveats: string[] = [];
  if (!/\b(n\s*[=:]?\s*\d+|cohort|samples?|replicate|patient|organoid|pdx|mouse)\b/i.test(window)) {
    caveats.push("Evidence depth is thin or sample context is not visible.");
  }
  if (!/\b(assay|readout|viability|western|flow|qpcr|elisa|imaging)\b/i.test(window)) {
    caveats.push("Assay or readout support is not explicit.");
  }
  if (!/\b(inhibitor|drug|antibody|crispr|sirna|probe|reagent)\b/i.test(window)) {
    caveats.push("Tractability is not explicit from the visible evidence.");
  }
  return caveats;
}

function buildRationale(
  candidate: string,
  scores: Pick<
    CandidatePriority,
    | "evidenceStrength"
    | "mechanismFit"
    | "resistanceRisk"
    | "assayability"
    | "tractability"
    | "timelineFit"
  >,
): string {
  const strongest = Object.entries(scores)
    .sort(([, left], [, right]) => right - left)
    .slice(0, 2)
    .map(([key]) => key.replace(/[A-Z]/g, (char) => ` ${char.toLowerCase()}`));
  return `${candidate} ranks here because its strongest visible dimensions are ${strongest.join(" and ")}.`;
}

function buildThinEvidenceWarnings(candidates: CandidatePriority[]): string[] {
  const warnings = candidates.flatMap((candidate) =>
    candidate.caveats.map((caveat) => `${candidate.name}: ${caveat}`)
  );
  if (candidates.length === 0) {
    warnings.push("No candidates were visible enough to rank; add candidate names plus supporting evidence before trusting a priority order.");
  }
  if (candidates.length > 0 && candidates.every((candidate) => candidate.evidence.length === 0)) {
    warnings.push("All candidates are prompt-only; the ranking is unstable until source evidence is attached.");
  }
  return unique(warnings).slice(0, 8);
}

function renderSourceList(sources: TargetPrioritizationSource[]): string[] {
  if (sources.length === 0) return ["- Current user request only"];
  return sources.map((source) => `- \`${source.workspacePath || source.sourceFilename}\``);
}

function renderRanking(candidates: CandidatePriority[]): string[] {
  if (candidates.length === 0) {
    return ["No rankable candidates were visible."];
  }
  return candidates.flatMap((candidate, index) => [
    `${index + 1}. **${candidate.name}** — score ${candidate.score}`,
    `   Rationale: ${candidate.rationale}`,
    candidate.evidence[0] ? `   Evidence: ${candidate.evidence[0]}` : "   Evidence: no source-backed evidence snippet was visible.",
    `   Criteria: evidence ${candidate.evidenceStrength}/5, mechanism ${candidate.mechanismFit}/5, resistance ${candidate.resistanceRisk}/5, assayability ${candidate.assayability}/5, tractability ${candidate.tractability}/5, timeline ${candidate.timelineFit}/5.`,
  ]);
}

export function isTargetPrioritizationRequest(message: string): boolean {
  return PRIORITIZATION_REQUEST_RE.test(message) && CANDIDATE_CONTEXT_RE.test(message);
}

export function looksLikeTargetPrioritizationArtifact(pathOrName: string): boolean {
  const normalized = pathOrName.replace(/[_-]+/g, " ");
  return CANDIDATE_CONTEXT_RE.test(normalized)
    || /\b(priority|prioritization|ranking|candidate|biomarker|combo|combination)\b/i.test(normalized);
}

export function buildTargetPrioritizationAssessment(input: {
  prompt: string;
  sources: TargetPrioritizationSource[];
}): TargetPrioritizationAssessment {
  const text = combinedText(input.prompt, input.sources);
  const candidates = extractCandidates(text)
    .map((candidate) => scoreCandidate(candidate, text, input.prompt))
    .sort((left, right) => right.score - left.score);
  const title = `Target and biomarker prioritization: ${
    input.sources[0]?.title || sourceStem(input.sources[0]?.sourceFilename ?? "visible context")
  }`;
  const thinEvidenceWarnings = buildThinEvidenceWarnings(candidates);
  const summary =
    candidates.length > 0
      ? `${candidates[0].name} is the current top visible priority, but the ranking should be read with the evidence and constraint notes below.`
      : "ScienceSwarm could not rank candidates because the visible context does not name enough targets, biomarkers, or combinations.";
  const constraintNotes = buildConstraintNotes(input.prompt);
  const markdown = [
    `# ${title}`,
    "",
    "## Project Goal",
    "",
    compactWhitespace(input.prompt),
    "",
    "## Visible Sources",
    "",
    ...renderSourceList(input.sources),
    "",
    "## Priority Ranking",
    "",
    ...renderRanking(candidates),
    "",
    "## Ranking Criteria",
    "",
    ...CRITERIA.map((criterion) => `- ${criterion}`),
    "",
    "## Constraint Sensitivity",
    "",
    ...constraintNotes.map((note) => `- ${note}`),
    "",
    "## Thin Evidence and Missing Information",
    "",
    ...(thinEvidenceWarnings.length > 0
      ? thinEvidenceWarnings.map((warning) => `- ${warning}`)
      : ["- No major evidence-depth warning was visible for the ranked candidates."]),
    "",
  ].join("\n");

  return {
    title,
    markdown,
    summary,
    candidates,
    criteria: CRITERIA,
    constraintNotes,
    thinEvidenceWarnings,
  };
}
