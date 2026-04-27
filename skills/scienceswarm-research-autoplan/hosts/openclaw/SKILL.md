---
name: scienceswarm-research-autoplan
description: Run the full pre-execution research review sequence and consolidate an idea, brief, protocol, or study plan into a saved decision-audited research execution plan with conflict synthesis and a one-page command decision.
owner: scienceswarm
runtime: in-session
tier: research-planning
aliases:
  - research-autoplan
  - autoplan-research
  - full-research-review
outputs:
  - Research Autoplan Dossier brain asset with asset_kind research_autoplan_dossier
  - decision audit trail
  - conflict synthesis
  - one-page command decision
  - execution readiness dashboard
  - staged research plan with gates and handoffs
---

# ScienceSwarm Research Autoplan

Use this skill when the user wants the whole pre-execution research planning
gauntlet run in one pass. The input may be a rough idea, Brown Bag brief,
literature note, protocol, methods sketch, grant sketch, or study plan.

This skill does not run analyses, collect data, prove theorems, write code, or
start fieldwork. It produces the saved research plan that lets execution begin
without hidden assumptions.

## Source Requirement

Start from the best available source artifact:

1. Prefer a `research_brown_bag_brief`, `literature_landscape_map`,
   `execution_ready_research_design`, protocol, study note, or user-provided
   plan.
2. If no artifact exists, ask for the shortest useful research description:
   claim, object of study, method or proof strategy, evidence source, target
   audience, and desired output.
3. If the user only has a topic, run a compact idea clarification pass before
   continuing. Do not pretend a topic is a research design.

The output is incomplete unless it is saved or the save blocker is explicit.

Default save path in ScienceSwarm/OpenClaw:

1. Draft the full dossier in Markdown.
2. Save it with `gbrain_capture` using `asset_kind:
   research_autoplan_dossier`.
3. Report the saved title and artifact/location in the final answer.

If `gbrain_capture` is unavailable but the host can write files, write a
Markdown file only in a user-approved project or study artifact location. If no
durable write path is available, return `BLOCKED_ON_SAVE`, include the complete
Markdown dossier, and ask where to save it.

## Review Posture

Be decisive, but do not hide uncertainty. Make the best research-design
decision available from the evidence. Escalate to the user only when a decision
depends on field taste, risk tolerance, ethical boundary, resource constraint,
or a genuine fork in the scientific claim.

Decision principles:

1. Claim before workflow: the plan exists to support a claim, not a method.
2. Evidence before elegance: prefer the design that can actually decide the
   question.
3. Smallest decisive first: start execution with the step most likely to change
   the plan.
4. Validity before scale: do not scale a study whose core inference is weak.
5. Reproducibility is part of design, not an end-stage cleanup task.
6. Publication fit determines the evidence bar.
7. Synthesis beats aggregation: resolve contradictions across phases instead
   of pasting all phase outputs together.

## Phases

Run the phases in order. If an adjacent ScienceSwarm skill is available, use
its logic for the relevant phase. If not, run the summarized pass here.

Consume prior artifacts rather than redoing them. If a Brown Bag brief,
Literature Landscape Map, Methods Review Report, or Execution-Ready Research
Design already exists, audit its freshness and quality, then reuse or repair
it. Do not repeat the same generic sections unless the prior artifact is stale
or insufficient.

### Phase 0: Intake And Readiness

Produce:

- one-sentence research claim or conjecture
- discipline lens
- available artifacts
- missing artifacts
- target output
- current readiness verdict: `RAW_TOPIC`, `IDEA_READY`, `DESIGN_READY`, or
  `EXECUTION_READY_WITH_GATES`

If the input is too raw, complete only the minimum clarification needed to make
the later phases meaningful.

### Phase 1: Brown Bag Compression

Stress-test the idea:

- Why should the field care?
- What is the narrowest decisive version?
- What is the strongest objection?
- What existing explanation, method, theorem, dataset, or result might already
  cover it?
- What result would make the researcher abandon or radically revise the idea?

If this phase changes the core question, record the decision in the audit
trail.

### Phase 2: Literature Landscape

Map the relevant literature enough to position the plan:

- closest prior art
- canonical anchors
- recent frontier
- live disagreements
- under-explored gap
- claim to avoid because it is already covered or too broad

Use current source search when available and appropriate. For private or
sensitive ideas, ask before sending detailed terms outside the local context;
otherwise use generalized search terms. If live search is unavailable, label
the section `LITERATURE_LANDSCAPE_FROM_SUPPLIED_SOURCES_ONLY`.

### Phase 3: Research Design Review

Convert the idea into a design:

- primary claim
- secondary or exploratory claims
- method fit
- design alternatives considered
- validity threats
- execution pipeline
- evidence and verification checks
- reproducibility artifacts
- publication fit

Use `READY_TO_EXECUTE`, `READY_WITH_GATES`, `NEEDS_REVISION`, or `BLOCKED`.

### Phase 4: Methods Review

Review whether the selected method can support the claim:

- assumptions
- identification or proof burden
- measurement and data quality
- comparators, controls, baselines, or counterexamples
- robustness and sensitivity checks
- diagnostics and stop conditions
- what result would be uninterpretable

If the method is not fit for the claim, revise the claim, recommend a different
method, or mark a blocker.

### Phase 5: Reproducibility And Artifact Plan

Specify the minimum final package:

- data, corpus, proof, protocol, code, or materials inventory
- environment or toolchain
- provenance manifest
- figure and table source files
- decision log
- limitations and release boundaries
- README or methods appendix

### Phase 6: Publication And Execution Plan

Define:

- primary audience
- plausible venue type
- contribution sentence
- minimum evidence package
- likely reviewer objection
- strongest prebuttal
- figure/table spine
- staged work plan
- first assignment
- explicit gates before full execution

### Phase 7: Conflict Synthesis

Reconcile conflicts across phases. Examples:

- Brown Bag says pursue, but literature says crowded.
- Literature says clear gap, but methods review says the design cannot answer
  it.
- Methods review says feasible, but publication fit requires more evidence
  than the project can produce.
- Design review says ready, but execution packet lacks inputs or stop
  conditions.

For each conflict, state the controlling decision. Do not let conflicting
recommendations coexist unresolved.

### Phase 8: One-Page Command Decision

End with the command decision:

- `KILL`: stop this version.
- `PARK`: wait for missing data, access, definitions, or timing.
- `NARROW`: execute only the narrower version named in the dossier.
- `PILOT`: run the smallest decisive test first.
- `EXECUTE`: begin the staged execution plan.

The command decision must fit the weakest serious phase finding, not the most
optimistic one.

## Decision Audit Trail

Every material decision must be recorded:

```markdown
| Decision | Options Considered | Chosen | Rationale | Risk | Revisit Trigger |
|---|---|---|---|---|---|
```

Use this table for decisions made automatically and decisions escalated to the
user. Do not bury unresolved forks in prose.

## Required Output

Produce a `Research Autoplan Dossier`:

````markdown
# Research Autoplan Dossier: {title}

## Source Artifacts

## Executive Verdict

Use one of: `READY_TO_EXECUTE`, `READY_WITH_GATES`, `NEEDS_REVISION`,
`BLOCKED`.

## Readiness Dashboard

| Dimension | Status | Notes |
|---|---|---|
| Claim clarity | |
| Literature position | |
| Method fit | |
| Validity threats | |
| Evidence plan | |
| Reproducibility package | |
| Publication fit | |
| Execution handoff | |

## Research Claim

## Brown Bag Stress Test

## Literature Landscape

## Design Summary

## Methods Review

## Cross-Phase Conflict Synthesis

| Conflict | Evidence From Phases | Controlling Decision | Rationale |
|---|---|---|---|

## One-Page Command Decision

Use one of: `KILL`, `PARK`, `NARROW`, `PILOT`, `EXECUTE`.

## Validity And Failure Register

| Threat Or Failure | Why It Matters | Diagnostic | Mitigation | Stop Condition |
|---|---|---|---|---|

## Evidence And Verification Plan

| Check | Purpose | Pass | Fail | Inconclusive |
|---|---|---|---|---|

## Reproducibility And Artifact Plan

## Publication Fit

| Dimension | Recommendation |
|---|---|
| Primary audience | |
| Venue type | |
| Contribution sentence | |
| Minimum evidence package | |
| Likely objection | |
| Strongest prebuttal | |
| Figure / table spine | |
| Main rejection risk | |

## Staged Execution Plan

| Stage | Work | Output | Gate | Owner |
|---|---|---|---|---|

## First Assignment

## Decision Audit Trail

| Decision | Options Considered | Chosen | Rationale | Risk | Revisit Trigger |
|---|---|---|---|---|---|

## Open Decisions And Blockers

## Next Skill To Run
````

## Quality Checks

Before finalizing, verify:

- The dossier says what is not in scope.
- The method is justified against alternatives.
- The literature landscape distinguishes supplied-source claims from searched
  claims.
- Cross-phase conflicts are resolved rather than merely listed.
- The command decision follows the weakest serious phase finding.
- Every major validity threat has a diagnostic and stop condition.
- The execution plan has gates, not just tasks.
- The first assignment is small, decisive, and useful even if it fails.
- The final dossier is saved, or the save blocker is explicit.

## Saving

When ScienceSwarm MCP tools are available, save the dossier with
`gbrain_capture` before answering. Use frontmatter:

```yaml
type: planning
asset_kind: research_autoplan_dossier
status: draft
privacy: local-only
tags: [research-autoplan, research-design, methods-review]
```

If saving fails, report the exact failure and do not claim the dossier is
durable.
