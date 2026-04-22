export interface ModelSystemApplicabilitySource {
  workspacePath?: string | null;
  sourceFilename: string;
  title?: string;
  text: string;
}

export interface ModelSystemApplicabilityAssessment {
  title: string;
  markdown: string;
  summary: string;
  systems: string[];
  transferRisks: string[];
  validationLadder: string[];
  missingMetadata: string[];
  comparedSystems: Array<{
    system: string;
    fit: string;
    tradeoff: string;
  }>;
}

type ModelSystemProfile = {
  key: string;
  label: string;
  pattern: RegExp;
  negatedPattern?: RegExp;
  score: number;
  fit: string;
  risks: string[];
  validation: string[];
};

const MODEL_SYSTEM_PROFILES: ModelSystemProfile[] = [
  {
    key: "cell_line",
    label: "2D cancer cell line",
    pattern: /\b(?:2d\s+)?(?:cell line|cell-line|cell culture|monolayer)\b/i,
    negatedPattern: /\b(?:no|without|lacks?|not using)\b[^.\n]{0,80}\b(?:cell line|cell-line|cell culture|monolayer)\b/i,
    score: 2,
    fit:
      "Fast fit for cell-intrinsic mechanism and dose-response triage, but weak as direct translational evidence.",
    risks: [
      "Long-cultured clonal adaptation can exaggerate dependencies that do not survive in patient-like tissue.",
      "A 2D culture lacks stromal, immune, matrix, and pharmacokinetic context.",
    ],
    validation: [
      "Repeat the readout in a patient-derived organoid, spheroid, or matched ex vivo sample.",
      "Add an orthogonal mechanism readout before treating the 2D result as decision-grade.",
    ],
  },
  {
    key: "organoid",
    label: "patient-derived organoid",
    pattern: /\b(?:patient[- ]derived\s+)?organoid(?:s)?\b/i,
    negatedPattern: /\b(?:no|without|lacks?|not using)\b[^.\n]{0,80}\borganoid(?:s)?\b/i,
    score: 3.5,
    fit:
      "Useful fit for tumor-intrinsic biology and perturbation response in a tissue-like architecture.",
    risks: [
      "Organoids can underrepresent immune, stromal, vascular, and drug-exposure context.",
      "Culture conditions and passage can select subclones that are not dominant in the patient sample.",
    ],
    validation: [
      "Add immune or stromal co-culture when the target question depends on microenvironment.",
      "Validate the strongest claim in a PDX, mouse model, or matched patient specimen.",
    ],
  },
  {
    key: "mouse",
    label: "mouse model",
    pattern: /\b(?:mouse|mice|murine|gemm|xenograft|in vivo)\b/i,
    negatedPattern: /\b(?:no|without|lacks?|not using)\b[^.\n]{0,80}\b(?:mouse|mice|murine|gemm|xenograft|in vivo)\b/i,
    score: 4,
    fit:
      "Good fit for organism-level exposure, toxicity, pharmacology, and microenvironment-dependent questions.",
    risks: [
      "Species mismatch can change target biology, immune signaling, and drug handling.",
      "Xenografts and immunodeficient mice can make immune-context conclusions especially fragile.",
    ],
    validation: [
      "Cross-check the result in human-derived organoids or patient specimens.",
      "State which mouse-specific assumptions must hold before using the result for the human question.",
    ],
  },
  {
    key: "pdx",
    label: "patient-derived xenograft",
    pattern: /\b(?:pdx|patient[- ]derived xenograft|xenograft)\b/i,
    negatedPattern: /\b(?:no|without|lacks?|not using)\b[^.\n]{0,80}\b(?:pdx|patient[- ]derived xenograft|xenograft)\b/i,
    score: 4,
    fit:
      "Strong fit for tumor response under in vivo exposure when the question does not require a fully human immune compartment.",
    risks: [
      "Host species and immune deficiency can distort microenvironment and immunology conclusions.",
      "Engraftment and passaging can select non-representative tumor subpopulations.",
    ],
    validation: [
      "Pair the PDX result with matched organoid or patient-sample evidence.",
      "Use an immune-competent or humanized system if the claim depends on immune interaction.",
    ],
  },
  {
    key: "patient_sample",
    label: "patient sample or cohort",
    pattern: /\b(?:patient sample|patient samples|primary sample|primary samples|clinical sample|clinical cohort|biopsy|tumou?r specimen|patient cohort)\b/i,
    negatedPattern: /\b(?:no|without|lacks?|not using)\b[^.\n]{0,80}\b(?:patient sample|primary sample|clinical sample|clinical cohort|biopsy|tumou?r specimen|patient cohort)\b/i,
    score: 5,
    fit:
      "Highest face-validity for patient relevance, especially when metadata, assay, and sampling context are explicit.",
    risks: [
      "Observational patient data can be confounded by sampling, treatment history, and batch effects.",
      "Small or biased cohorts can make a clinically vivid pattern look more general than it is.",
    ],
    validation: [
      "Use a perturbable model to test whether the patient association is causal.",
      "Replicate the marker or phenotype in an independent cohort or matched assay batch.",
    ],
  },
  {
    key: "spheroid",
    label: "3D spheroid",
    pattern: /\b(?:3d\s+)?spheroid(?:s)?\b/i,
    negatedPattern: /\b(?:no|without|lacks?|not using)\b[^.\n]{0,80}\bspheroid(?:s)?\b/i,
    score: 2.8,
    fit:
      "Better than 2D culture for architecture and gradients, but still limited for patient transfer.",
    risks: [
      "Spheroids often lack patient heterogeneity, immune context, and stromal structure.",
      "Diffusion gradients can create assay artifacts if size and timing are not controlled.",
    ],
    validation: [
      "Confirm the pattern in organoids or primary samples.",
      "Add size-matched controls and an orthogonal readout before escalating the claim.",
    ],
  },
];

const REQUEST_ACTION_RE =
  /\b(applicab(?:le|ility)|fit for purpose|fit the question|relevan(?:t|ce)|translate|translation|transfer|generaliz(?:e|ability)|external validity|model risk|validation ladder|which (?:model|system)|compare\b[\s\S]{0,80}\b(?:model|system|organoid|mouse|cell line|pdx|sample))\b/i;

const MODEL_CONTEXT_RE =
  /\b(model system|organoid|cell line|mouse|mice|murine|pdx|xenograft|patient sample|primary sample|clinical cohort|biopsy|spheroid|in vivo|in vitro)\b/i;

const COMPARISON_RE =
  /\b(compare|versus|vs\.?|which (?:model|system)|better suited|choose between|trade[- ]?off)\b/i;

const MISSING_METADATA_CHECKS: Array<{
  label: string;
  pattern: RegExp;
  missingPattern: RegExp;
}> = [
  {
    label: "model identity, tissue, or lineage",
    pattern: /\b(lineage|tissue|colon|lung|breast|pancrea|melanoma|tumou?r|cancer type|model name|line name)\b/i,
    missingPattern: /\b(?:missing|unknown|unspecified|not specified|does not specify|without|no)\b[^.\n]{0,80}\b(lineage|tissue|cancer type|model name|line name)\b/i,
  },
  {
    label: "species or patient origin",
    pattern: /\b(human|patient|mouse|murine|rat|species|donor|biopsy|primary)\b/i,
    missingPattern: /\b(?:missing|unknown|unspecified|not specified|does not specify|without|no)\b[^.\n]{0,80}\b(species|patient origin|donor|biopsy|primary)\b/i,
  },
  {
    label: "genotype or biomarker state",
    pattern: /\b(kras|egfr|tp53|alk|braf|her2|mutation|mutant|wild[- ]?type|genotype|biomarker|driver)\b/i,
    missingPattern: /\b(?:missing|unknown|unspecified|not specified|does not specify|without|no)\b[^.\n]{0,80}\b(genotype|biomarker|mutation|driver)\b/i,
  },
  {
    label: "assay or readout definition",
    pattern: /\b(assay|readout|endpoint|viability|rna[- ]?seq|sequencing|western|immunoblot|flow|elisa|imaging|marker)\b/i,
    missingPattern: /\b(?:missing|unknown|unspecified|not specified|does not specify|without|no)\b[^.\n]{0,80}\b(assay|readout|endpoint|marker)\b/i,
  },
  {
    label: "replication, cohort size, or sampling plan",
    pattern: /\b(n\s*[=:]?\s*\d+|replicate|replicates|cohort|sample size|patients?|wells?|mice|power)\b/i,
    missingPattern: /\b(?:missing|unknown|unspecified|not specified|does not specify|without|no)\b[^.\n]{0,80}\b(replication|replicate|cohort size|sample size|sampling|power)\b/i,
  },
  {
    label: "microenvironment, immune, or stromal context",
    pattern: /\b(immune|t cell|macrophage|stroma|stromal|fibroblast|matrix|vasculature|microenvironment|co[- ]?culture)\b/i,
    missingPattern: /\b(?:missing|unknown|unspecified|not specified|does not specify|without|no)\b[^.\n]{0,80}\b(immune|stroma|stromal|microenvironment|co[- ]?culture)\b/i,
  },
  {
    label: "dose, timing, or exposure schedule",
    pattern: /\b(dose|dosing|exposure|schedule|time[- ]?point|time course|hour|day|week|pharmacokinetic|pk)\b/i,
    missingPattern: /\b(?:missing|unknown|unspecified|not specified|does not specify|without|no)\b[^.\n]{0,80}\b(dose|timing|exposure|schedule|time[- ]?point|time course|pk)\b/i,
  },
  {
    label: "comparator or baseline condition",
    pattern: /\b(control|vehicle|untreated|baseline|comparator|matched|positive control|negative control)\b/i,
    missingPattern: /\b(?:missing|unknown|unspecified|not specified|does not specify|without|no)\b[^.\n]{0,80}\b(comparator|baseline|control|vehicle)\b/i,
  },
];

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function sourceStem(filename: string): string {
  return filename.replace(/\.[a-z0-9]+$/i, "") || filename;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.trim().length > 0)));
}

function combinedText(prompt: string, sources: ModelSystemApplicabilitySource[]): string {
  return [prompt, ...sources.map((source) => source.text)].join("\n\n");
}

function detectSystems(text: string): ModelSystemProfile[] {
  const found = MODEL_SYSTEM_PROFILES.filter((profile) =>
    profile.pattern.test(text) && !profile.negatedPattern?.test(text)
  );
  return found.length > 0 ? found : [];
}

function inferMissingMetadata(text: string): string[] {
  return MISSING_METADATA_CHECKS
    .filter((check) => check.missingPattern.test(text) || !check.pattern.test(text))
    .map((check) => check.label);
}

function buildTransferRisks(
  profiles: ModelSystemProfile[],
  missingMetadata: string[],
): string[] {
  const systemRisks = profiles.flatMap((profile) => profile.risks);
  const honestyRisks = missingMetadata.length > 0
    ? [
        `Applicability is provisional because the visible context is missing ${missingMetadata.slice(0, 3).join(", ")}.`,
      ]
    : [];
  if (systemRisks.length === 0) {
    systemRisks.push(
      "ScienceSwarm cannot safely infer transfer risk until the model system, source, assay, and comparison target are visible.",
    );
  }
  return unique([...systemRisks, ...honestyRisks]).slice(0, 7);
}

function buildValidationLadder(
  profiles: ModelSystemProfile[],
  missingMetadata: string[],
): string[] {
  const steps: string[] = [];
  if (missingMetadata.length > 0) {
    steps.push(
      `First capture the missing metadata: ${missingMetadata.slice(0, 4).join(", ")}.`,
    );
  }
  steps.push(
    "Define what result would upgrade, downgrade, or invalidate the current model's relevance before committing resources.",
  );
  steps.push(...profiles.flatMap((profile) => profile.validation));
  if (steps.length === 0) {
    steps.push(
      "Start by naming the model system and assay, then validate the claim in a more patient-proximal or orthogonal system.",
    );
  }
  return unique(steps).slice(0, 6);
}

function rankProfilesForQuestion(
  profiles: ModelSystemProfile[],
  prompt: string,
): ModelSystemProfile[] {
  const loweredPrompt = prompt.toLowerCase();
  return [...profiles].sort((left, right) => {
    const leftBoost = scoreQuestionFit(left, loweredPrompt);
    const rightBoost = scoreQuestionFit(right, loweredPrompt);
    return right.score + rightBoost - (left.score + leftBoost);
  });
}

function scoreQuestionFit(profile: ModelSystemProfile, prompt: string): number {
  if (/\b(immune|microenvironment|stromal|toxicity|pk|pharmacokinetic|in vivo)\b/.test(prompt)) {
    if (profile.key === "mouse" || profile.key === "pdx") return 1.2;
    if (profile.key === "patient_sample") return 0.8;
  }
  if (/\b(mechanism|pathway|target|cell[- ]?intrinsic|drug response|dose)\b/.test(prompt)) {
    if (profile.key === "organoid") return 1;
    if (profile.key === "cell_line") return 0.5;
  }
  if (/\b(clinical|patient|translat|biomarker)\b/.test(prompt)) {
    if (profile.key === "patient_sample") return 1.2;
    if (profile.key === "pdx" || profile.key === "organoid") return 0.6;
  }
  return 0;
}

function buildComparison(
  profiles: ModelSystemProfile[],
  prompt: string,
): ModelSystemApplicabilityAssessment["comparedSystems"] {
  if (profiles.length < 2 && !COMPARISON_RE.test(prompt)) return [];
  return rankProfilesForQuestion(profiles, prompt).map((profile, index) => ({
    system: profile.label,
    fit: index === 0 ? "best visible fit" : "secondary fit",
    tradeoff: profile.fit,
  }));
}

function buildSummary(
  profiles: ModelSystemProfile[],
  missingMetadata: string[],
): string {
  if (profiles.length === 0) {
    return "ScienceSwarm cannot make a strong applicability call yet because the visible context does not name the model system.";
  }
  const systemLabels = profiles.map((profile) => profile.label).join(", ");
  if (missingMetadata.length >= 4) {
    return `The visible ${systemLabels} evidence is usable only as a provisional signal until the missing model and assay metadata are filled in.`;
  }
  if (profiles.some((profile) => profile.key === "patient_sample")) {
    return `The visible ${systemLabels} evidence is relatively patient-proximal, but ScienceSwarm still separates clinical relevance from causal proof.`;
  }
  if (profiles.some((profile) => profile.key === "organoid" || profile.key === "pdx")) {
    return `The visible ${systemLabels} evidence is a moderate fit for translation, with transfer risk concentrated in microenvironment, immune, and sampling assumptions.`;
  }
  return `The visible ${systemLabels} evidence is useful for triage, but it should not be treated as decision-grade translation without validation in a more patient-proximal system.`;
}

function renderSourceList(sources: ModelSystemApplicabilitySource[]): string[] {
  if (sources.length === 0) return ["- Current user request only"];
  return sources.map((source) => {
    const label = source.workspacePath || source.sourceFilename;
    return `- \`${label}\``;
  });
}

function renderBulletList(items: string[], fallback: string): string[] {
  return items.length > 0 ? items.map((item) => `- ${item}`) : [`- ${fallback}`];
}

export function isModelSystemApplicabilityRequest(message: string): boolean {
  return REQUEST_ACTION_RE.test(message) && MODEL_CONTEXT_RE.test(message);
}

export function looksLikeModelSystemArtifact(pathOrName: string): boolean {
  const normalized = pathOrName.replace(/[_-]+/g, " ");
  return MODEL_CONTEXT_RE.test(normalized)
    || /\b(model|applicability|translation|validation|organoid|mouse|pdx|xenograft|patient|cell line)\b/i.test(normalized);
}

export function buildModelSystemApplicabilityAssessment(input: {
  prompt: string;
  projectTitle?: string;
  sources: ModelSystemApplicabilitySource[];
}): ModelSystemApplicabilityAssessment {
  const prompt = compactWhitespace(input.prompt);
  const text = combinedText(input.prompt, input.sources);
  const profiles = detectSystems(text);
  const missingMetadata = inferMissingMetadata(text);
  const transferRisks = buildTransferRisks(profiles, missingMetadata);
  const validationLadder = buildValidationLadder(profiles, missingMetadata);
  const comparedSystems = buildComparison(profiles, prompt);
  const systems = profiles.map((profile) => profile.label);
  const sourceTitle =
    input.sources[0]?.title || sourceStem(input.sources[0]?.sourceFilename ?? "visible context");
  const title = `Model-system applicability assessment: ${sourceTitle}`;
  const summary = buildSummary(profiles, missingMetadata);
  const comparisonLines = comparedSystems.flatMap((comparison) => [
    `- **${comparison.system}** (${comparison.fit}): ${comparison.tradeoff}`,
  ]);
  const markdown = [
    `# ${title}`,
    "",
    "## Question Being Judged",
    "",
    prompt || "Assess whether the visible model system evidence fits the target biological question.",
    "",
    "## Visible Sources",
    "",
    ...renderSourceList(input.sources),
    "",
    "## Relevance Judgment",
    "",
    summary,
    "",
    "## Model Systems Detected",
    "",
    ...renderBulletList(systems, "No explicit model system was visible."),
    "",
    "## Transfer Risks",
    "",
    ...renderBulletList(
      transferRisks,
      "No transfer risk can be assessed until the model system is specified.",
    ),
    "",
    "## Validation Ladder",
    "",
    ...validationLadder.map((step, index) => `${index + 1}. ${step}`),
    "",
    "## Candidate-System Comparison",
    "",
    ...(comparisonLines.length > 0
      ? comparisonLines
      : ["- No two candidate systems were visible enough for a direct comparison."]),
    "",
    "## Missing Metadata ScienceSwarm Will Not Assume",
    "",
    ...renderBulletList(
      missingMetadata,
      "The visible context names the core model, assay, and transfer assumptions.",
    ),
    "",
    "## Decision-Ready Next Step",
    "",
    validationLadder[0] ?? "Name the model system and target question, then rerun this applicability check.",
    "",
  ].join("\n");

  return {
    title,
    markdown,
    summary,
    systems,
    transferRisks,
    validationLadder,
    missingMetadata,
    comparedSystems,
  };
}
