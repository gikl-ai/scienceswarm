import { createHash } from "node:crypto";

import type {
  StructuredCritiqueFinding,
  StructuredCritiqueJob,
  StructuredCritiqueResult,
} from "@/lib/structured-critique-schema";

type FindingSeed = {
  severity: "high" | "medium" | "low";
  title: string;
  flawType: string;
  description: string;
  suggestedFix: string;
  impact: string;
  evidenceQuote?: string;
  confidence?: number;
};

export interface ExperimentDesignCritiqueSource {
  workspacePath?: string | null;
  sourceFilename: string;
  title?: string;
  text: string;
}

const DESIGN_CRITIQUE_INTENT_RE =
  /\b(critique|review|audit|red[- ]?team|stress[- ]?test|weak(?:ness|nesses)?|confound(?:er|ers)?|controls?|comparators?|study design|experimental design|experiment plan|protocol)\b/i;

const DESIGN_ARTIFACT_HINT_RE =
  /\b(plan|protocol|design|study|experiment|assay|memo)\b/i;

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function sourceStem(filename: string): string {
  return filename.replace(/\.[a-z0-9]+$/i, "") || filename;
}

function excerptNear(text: string, patterns: RegExp[]): string | undefined {
  const lines = text
    .split(/\n+/)
    .map((line) => compactWhitespace(line))
    .filter((line) => line.length > 0);
  for (const pattern of patterns) {
    const line = lines.find((entry) => pattern.test(entry));
    if (line) {
      return line.slice(0, 220);
    }
  }
  return undefined;
}

function countMatches(text: string, pattern: RegExp): number {
  return Array.from(text.matchAll(pattern)).length;
}

function hasAny(text: string, pattern: RegExp): boolean {
  return pattern.test(text);
}

function hasPresentFeature(
  text: string,
  presentPattern: RegExp,
  missingPattern?: RegExp,
): boolean {
  if (missingPattern && missingPattern.test(text)) {
    return false;
  }
  return presentPattern.test(text);
}

function buildFinding(
  index: number,
  seed: FindingSeed,
): StructuredCritiqueFinding {
  return {
    finding_id: `design-${index + 1}`,
    severity: seed.severity,
    description: `${seed.title}: ${seed.description}`,
    evidence_quote: seed.evidenceQuote,
    suggested_fix: seed.suggestedFix,
    flaw_type: seed.flawType,
    impact: seed.impact,
    confidence: seed.confidence ?? 0.78,
    finding_kind: "experimental_design",
  };
}

function inferFindings(text: string): FindingSeed[] {
  const normalized = text.toLowerCase();
  const findings: FindingSeed[] = [];

  const sampleEvidence = excerptNear(text, [
    /\bn\s*[=:]?\s*\d+\b/i,
    /\breplicates?\b/i,
    /\bwells?\/group\b/i,
    /\bcohort\b/i,
    /\bsamples?\b/i,
  ]);
  const lowReplication =
    /\bn\s*[=:]?\s*(?:1|2)\b/i.test(text)
    || /\b(?:one|single|two)\s+(?:well|wells|replicate|replicates|mouse|mice|sample|samples)\b/i.test(text)
    || /\bn=2\b/i.test(normalized);
  const missingSamplingContext = !hasAny(
    normalized,
    /\b(n\s*[=:]?\s*\d+|replicates?|replicate|wells?\/group|patients?|samples?|cohort|power)\b/i,
  );
  if (lowReplication || missingSamplingContext) {
    findings.push({
      severity: "high",
      title: "Sampling plan is too weak or unspecified",
      flawType: "sampling_plan",
      description: lowReplication
        ? "The plan signals very low replication, which makes the readout fragile against noise and batch drift."
        : "The plan never states replicate count, cohort size, or any power logic, so the result would be hard to interpret even if the assay runs cleanly.",
      suggestedFix:
        "State the unit of replication, minimum replicate count, and what effect size or decision threshold would count as meaningful before running the experiment.",
      impact:
        "Weak replication can make false positives and false negatives look equally convincing.",
      evidenceQuote: sampleEvidence,
      confidence: lowReplication ? 0.93 : 0.85,
    });
  }

  const hasComparatorLanguage = hasAny(
    normalized,
    /\b(control|vehicle|untreated|baseline|comparator|compare|matched|negative control|positive control)\b/i,
  );
  if (!hasComparatorLanguage) {
    findings.push({
      severity: "high",
      title: "Controls or comparators are not explicit",
      flawType: "controls",
      description:
        "The design does not clearly state the baseline or comparison conditions needed to tell whether any observed effect is specific.",
      suggestedFix:
        "Name the required negative, positive, and baseline comparators explicitly, and tie each readout to the control it is meant to rule out.",
      impact:
        "Without clear controls, an apparently strong result can still be a measurement artifact or handling effect.",
      evidenceQuote: excerptNear(text, [/\bexperiment\b/i, /\bplan\b/i]),
      confidence: 0.82,
    });
  }

  const modelMentions = countMatches(
    normalized,
    /\b(cell line|organoid|pdx|mouse model|patient sample|cohort|model system)\b/g,
  );
  const singleModelLanguage = hasAny(
    normalized,
    /\b(single|one)\s+(cell line|organoid|pdx|mouse model|model system|cohort)\b/i,
  );
  const validationLanguage = hasPresentFeature(
    normalized,
    /\b(independent|second|additional|orthogonal|validation cohort|replicate model|multiple models)\b/i,
    /\b(no|not|without)\b[^.\n]{0,60}\b(second|additional|orthogonal|validation cohort|replicate model|multiple models)\b/i,
  );
  if ((modelMentions > 0 || singleModelLanguage) && !validationLanguage) {
    findings.push({
      severity: "medium",
      title: "Transfer across models is not established",
      flawType: "model_generalizability",
      description:
        "The design appears to lean on a single model system without a stated validation plan, which makes it hard to separate a real effect from model-specific behavior.",
      suggestedFix:
        "Add an orthogonal validation model or a clearly staged follow-up that tests whether the finding survives outside the first system.",
      impact:
        "Single-model readouts often overstate how durable or general a result really is.",
      evidenceQuote: excerptNear(text, [/\b(single|one)\s+(cell line|organoid|model)\b/i, /\bcell line\b/i, /\borganoid\b/i]),
      confidence: 0.8,
    });
  }

  const mentionsRandomization = hasPresentFeature(
    normalized,
    /\b(randomi[sz]e|blinded?|batch|plate|block|allocation|balanced across)\b/i,
    /\b(no|not|without)\b[^.\n]{0,80}\b(randomi[sz]e|blinded?|batch|plate|block|allocation|balanced across)\b/i,
  );
  if (!mentionsRandomization) {
    findings.push({
      severity: "medium",
      title: "Bias-control and batch-handling details are missing",
      flawType: "confounding",
      description:
        "The plan does not explain how samples are randomized, blocked, or protected against batch effects and operator bias.",
      suggestedFix:
        "Document randomization or plate layout, identify the likely batch axes, and state how they will be balanced or modeled.",
      impact:
        "Unmanaged batch structure can masquerade as a biological effect.",
      evidenceQuote: excerptNear(text, [/\bplate\b/i, /\bbatch\b/i, /\brandom/i]),
      confidence: 0.79,
    });
  }

  const endpointOnly =
    hasAny(normalized, /\bviability|endpoint|immunoblot|western blot|single assay\b/i)
    && !hasPresentFeature(
      normalized,
      /\borthogonal|second assay|time course|dose[- ]response|kinetic|imaging|rescue\b/i,
      /\b(no|not|without)\b[^.\n]{0,80}\b(orthogonal|second assay|time course|dose[- ]response|kinetic|imaging|rescue)\b/i,
    );
  if (endpointOnly) {
    findings.push({
      severity: "medium",
      title: "Readout strategy is too narrow for the claim",
      flawType: "endpoint_fragility",
      description:
        "The plan relies on a narrow endpoint without a second readout that could discriminate mechanism from assay-specific noise.",
      suggestedFix:
        "Pair the primary endpoint with at least one orthogonal assay that would fail differently if the first readout were misleading.",
      impact:
        "A single assay can make a mechanistic claim look firmer than the evidence supports.",
      evidenceQuote: excerptNear(text, [/\bviability\b/i, /\bimmunoblot\b/i, /\bwestern blot\b/i, /\bendpoint\b/i]),
      confidence: 0.84,
    });
  }

  const missingTiming = !hasPresentFeature(
    normalized,
    /\b(time course|timepoint|time point|hour|hours|day|days|week|weeks|dose[- ]response|kinetic|kinetics)\b/i,
    /\b(no|not|without)\b[^.\n]{0,80}\b(time course|timepoint|time point|dose[- ]response|kinetic|kinetics)\b/i,
  );
  if (missingTiming) {
    findings.push({
      severity: "medium",
      title: "Timing and response context are underspecified",
      flawType: "timing_context",
      description:
        "The design does not say when measurements happen or how timing will distinguish transient adaptation from durable change.",
      suggestedFix:
        "State the measurement schedule, key perturbation windows, and what temporal pattern would count as a meaningful effect.",
      impact:
        "Without timing context, the same endpoint can support incompatible stories.",
      evidenceQuote: excerptNear(text, [/\btime\b/i, /\bday\b/i, /\bhour\b/i]),
      confidence: 0.76,
    });
  }

  const strongClaimLanguage = hasAny(
    normalized,
    /\b(mechanism|causal|drives|driven by|proves|confirm|resistance|rebound|durable)\b/i,
  );
  const discriminatingFollowup = hasPresentFeature(
    normalized,
    /\b(washout|rechallenge|rescue|epistasis|falsif|alternative explanation|orthogonal validation)\b/i,
    /\b(no|not|without)\b[^.\n]{0,80}\b(washout|rechallenge|rescue|epistasis|falsif|alternative explanation|orthogonal validation)\b/i,
  );
  if (strongClaimLanguage && !discriminatingFollowup) {
    findings.push({
      severity: "high",
      title: "Mechanistic or durability claims are ahead of the design",
      flawType: "claim_strength",
      description:
        "The memo makes a strong interpretation, but the design does not include the discriminating checks that would rule out simpler explanations.",
      suggestedFix:
        "Add a falsification step such as washout/rechallenge, rescue, or an explicitly competing hypothesis test before making a mechanistic claim.",
      impact:
        "Overclaiming early can push the lab toward the wrong next experiment.",
      evidenceQuote: excerptNear(text, [/\bmechanism\b/i, /\bresistance\b/i, /\brebound\b/i, /\bdurable\b/i]),
      confidence: 0.9,
    });
  }

  const missingDecisionRule = !hasPresentFeature(
    normalized,
    /\bthreshold|decision rule|success criterion|meaningful|fold change|effect size|accept|reject\b/i,
    /\b(no|not|without)\b[^.\n]{0,80}\b(threshold|decision rule|success criterion|meaningful|fold change|effect size|accept|reject)\b/i,
  );
  if (missingDecisionRule) {
    findings.push({
      severity: "low",
      title: "Decision thresholds are not stated",
      flawType: "decision_rule",
      description:
        "The plan does not say what result would count as convincing, so post hoc interpretation would be too easy.",
      suggestedFix:
        "Write down the effect threshold or decision rule now, before the experiment starts.",
      impact:
        "Missing decision rules increase hindsight bias.",
      evidenceQuote: excerptNear(text, [/\bthreshold\b/i, /\bmeaningful\b/i, /\bsuccess\b/i]),
      confidence: 0.72,
    });
  }

  if (findings.length === 0) {
    findings.push({
      severity: "low",
      title: "Design looks plausible but still needs explicit assumptions",
      flawType: "assumptions",
      description:
        "The memo covers the basics, but the critical assumptions are still implicit rather than written as falsifiable checks.",
      suggestedFix:
        "List the assumptions that could break the interpretation and pair each with a visible control or fallback decision.",
      impact:
        "Even well-written designs become brittle when assumptions stay implicit.",
      evidenceQuote: excerptNear(text, [/\bplan\b/i, /\bdesign\b/i]),
      confidence: 0.64,
    });
  }

  return findings;
}

function buildOverallSummary(findings: StructuredCritiqueFinding[]): string {
  const high = findings.filter((finding) => finding.severity === "high");
  const medium = findings.filter((finding) => finding.severity === "medium");
  if (high.length > 0) {
    return `The current design is not yet strong enough to justify a high-confidence lab run. The biggest gaps are ${high
      .slice(0, 2)
      .map((finding) => finding.flaw_type?.replaceAll("_", " "))
      .filter(Boolean)
      .join(" and ")}, which would make a positive result difficult to trust.`;
  }
  if (medium.length > 0) {
    return `The design has a workable core idea, but it still needs tighter controls and decision logic before the readout will be easy to interpret.`;
  }
  return "The plan is directionally sound, but it still benefits from making its assumptions and decision thresholds explicit.";
}

function buildReportMarkdown(
  source: ExperimentDesignCritiqueSource,
  findings: StructuredCritiqueFinding[],
): string {
  const topFixes = findings.slice(0, 3).map((finding) => `- ${finding.suggested_fix}`);
  const honestyChecks = findings
    .filter((finding) =>
      finding.flaw_type === "sampling_plan"
      || finding.flaw_type === "timing_context"
      || finding.flaw_type === "decision_rule",
    )
    .map((finding) => `- ${finding.description}`);

  return [
    `# Experimental design critique: ${source.title || sourceStem(source.sourceFilename)}`,
    "",
    "## What looks fragile",
    "",
    ...findings.map((finding, index) => [
      `${index + 1}. **${finding.description}**`,
      finding.evidence_quote ? `   Evidence: "${finding.evidence_quote}"` : null,
      finding.suggested_fix ? `   Fix: ${finding.suggested_fix}` : null,
      finding.impact ? `   Why it matters: ${finding.impact}` : null,
    ].filter(Boolean).join("\n")),
    "",
    "## Highest-leverage fixes",
    "",
    ...(topFixes.length > 0 ? topFixes : ["- Add explicit controls, replication, and a falsification check."]),
    "",
    "## Missing details the system cannot safely assume",
    "",
    ...(honestyChecks.length > 0
      ? honestyChecks
      : ["- The design memo still needs explicit sample, timing, and decision-threshold details."]),
    "",
  ].join("\n");
}

function normalizeFlawKey(
  finding: Pick<StructuredCritiqueFinding, "flaw_type" | "description">,
): string {
  const flawType =
    typeof finding.flaw_type === "string" ? finding.flaw_type.trim() : "";
  if (flawType.length > 0) return flawType;
  return finding.description.trim().toLowerCase();
}

export function summarizeExperimentDesignIteration(
  previousFindings: StructuredCritiqueFinding[],
  currentFindings: StructuredCritiqueFinding[],
): {
  improved: string[];
  stillWeak: string[];
  newRisks: string[];
} {
  const previousByKey = new Map(
    previousFindings.map((finding) => [normalizeFlawKey(finding), finding]),
  );
  const currentByKey = new Map(
    currentFindings.map((finding) => [normalizeFlawKey(finding), finding]),
  );

  const improved = Array.from(previousByKey.entries())
    .filter(([key]) => !currentByKey.has(key))
    .map(([, finding]) => finding.description);
  const stillWeak = Array.from(currentByKey.entries())
    .filter(([key]) => previousByKey.has(key))
    .map(([, finding]) => finding.description);
  const newRisks = Array.from(currentByKey.entries())
    .filter(([key]) => !previousByKey.has(key))
    .map(([, finding]) => finding.description);

  return { improved, stillWeak, newRisks };
}

export function isExperimentDesignCritiqueRequest(message: string): boolean {
  return DESIGN_CRITIQUE_INTENT_RE.test(message);
}

export function looksLikeExperimentDesignArtifact(pathOrName: string): boolean {
  return DESIGN_ARTIFACT_HINT_RE.test(pathOrName);
}

export function buildExperimentDesignCritiqueJob(
  source: ExperimentDesignCritiqueSource,
): StructuredCritiqueJob {
  const findings = inferFindings(source.text).map((seed, index) =>
    buildFinding(index, seed)
  );
  const result: StructuredCritiqueResult = {
    title: `Experimental design critique: ${source.title || sourceStem(source.sourceFilename)}`,
    report_markdown: buildReportMarkdown(source, findings),
    findings,
    author_feedback: {
      overall_summary: buildOverallSummary(findings),
      top_issues: findings.slice(0, 3).map((finding) => ({
        title: finding.flaw_type?.replaceAll("_", " ") || "design issue",
        summary: finding.description,
      })),
    },
  };

  const digest = createHash("sha1")
    .update(source.sourceFilename)
    .update("\n")
    .update(source.text)
    .digest("hex")
    .slice(0, 12);

  return {
    id: `local-design-critique-${digest}`,
    status: "COMPLETED",
    pdf_filename: source.sourceFilename,
    style_profile: "internal_red_team",
    result,
  };
}
