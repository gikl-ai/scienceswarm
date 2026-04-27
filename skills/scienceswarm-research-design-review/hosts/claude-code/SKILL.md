---
name: scienceswarm-research-design-review
description: Review and upgrade a research idea, protocol, brown-bag brief, or study plan into an execution-ready research design document with validity checks, analysis plan, reproducibility package, and handoff tasks.
---

# ScienceSwarm Research Design Review

Use this skill when the user has a research idea, Brown Bag brief, protocol,
study plan, grant sketch, methods plan, or rough execution plan and wants to
lock it into an execution-ready research design before work begins.

This is a research plan review. Do not begin execution. The output is a saved
`Execution-Ready Research Design` and a list of decisions or blockers.

## Source Artifact Requirement

Start by finding or asking for the source artifact:

1. Prefer an existing `research_brown_bag_brief`, protocol, study note, paper
   packet, prior design, or user-provided plan.
2. If none exists, ask for the shortest useful plan: research claim, method,
   evidence/data/proof object, target audience, and desired output.
3. If the idea is still too raw to review, recommend running
   `scienceswarm-brown-bag` first.

The review is incomplete unless it saves or returns a complete written design.

## Review Flow

Work section by section. If a section surfaces a major unresolved decision,
pause and ask the user before finalizing that part of the design.

## Finding And Decision Protocol

For every material issue, record severity, confidence from 1 to 10, affected
claim/method/artifact/audience, recommended fix, and tradeoff if unresolved.
Ask the user before changing the design when alternatives differ in kind or
when the fix narrows the research claim.

### Step 0: Readiness And Scope Challenge

Answer:

1. What exactly is the research claim, conjecture, mechanism, method, or
   capability?
2. What existing evidence, paper, dataset, theorem, benchmark, protocol, or
   artifact already partially supports the plan?
3. What is the smallest design that can answer the claim?
4. What is explicitly not in scope?
5. What would make the result uninterpretable?
6. What execution work can happen in parallel, and what must be sequential?

If the plan is trying to do too much, recommend a scope reduction and explain
what evidence would be lost.

### Section 1: Contribution And Claim Review

Evaluate claim specificity, novelty, primary vs secondary claims, success /
failure / inconclusive outcomes, and target audience.

### Section 2: Method Fit And Design Logic

Evaluate whether the method answers the claim, required assumptions, alternative
methods, required inputs, and the pipeline from inputs to final claim. Require a
simple ASCII pipeline for non-trivial designs.

### Section 3: Validity Threat Register

Create a threat register. Include discipline-relevant threats such as construct
validity, internal validity, external validity, statistical validity,
computational validity, proof validity, measurement validity, and ethics or
compliance risk. For each, state mitigation, diagnostic, and stop condition.

### Section 4: Analysis, Proof, Or Execution Plan

Specify ordered workstreams, inputs, dependencies, decision gates, expected
outputs, failure modes, recovery paths, and provenance logs. If work can run in
parallel, produce a lane plan.

### Section 5: Evidence And Verification Plan

Define pilot / smallest decisive test, negative controls, counterexamples,
placebo tests, ablations, robustness checks, baselines, replication target,
quality thresholds, and a pass/fail/inconclusive interpretation table.

### Section 6: Reproducibility And Artifact Plan

Specify data/code/proof/protocol/materials package, environment notes,
provenance manifest, figure/table source files, decision log, README or method
appendix, privacy/compliance limits, and what can be released publicly.

### Section 7: Publication Fit

Name primary audience, venue type, minimum evidence package, likely reviewer
objection, strongest prebuttal, figure/table spine, reproducibility expectation,
and main rejection risk.

## Required Output

Produce an `Execution-Ready Research Design`:

````markdown
# Execution-Ready Research Design: {title}

## Source Artifact

## Research Readiness Dashboard

| Dimension | Status | Notes |
|---|---|---|
| Claim clarity | |
| Method fit | |
| Validity threats | |
| Evidence / verification plan | |
| Execution handoff | |
| Reproducibility package | |
| Publication fit | |
| Open blockers | |

## Research Claim

## Contribution And Audience

## What Is Not In Scope

## Prior Art / Existing Evidence

## Design Summary

## Method Fit

## Research Pipeline

```text
{ASCII pipeline}
```

## Validity Threat Register

| Threat | Why It Matters | Mitigation | Diagnostic | Stop Condition |
|---|---|---|---|---|

## Analysis / Proof / Execution Plan

## Evidence And Verification Plan

| Check | Purpose | Pass | Fail | Inconclusive |
|---|---|---|---|---|

## Workstream Plan

| Lane | Workstream | Inputs | Output | Depends On |
|---|---|---|---|---|

## Reproducibility And Artifact Plan

## Publication Fit

| Dimension | Recommendation |
|---|---|
| Primary audience | |
| Likely venue type | |
| Minimum evidence package | |
| Likely reviewer objection | |
| Strongest prebuttal | |
| Figure / table spine | |
| Reproducibility expectation | |
| Main rejection risk | |

## Execution Handoff

## Open Decisions

## Review Verdict
````

Verdicts:

- `READY_TO_EXECUTE`
- `READY_WITH_GATES`
- `NEEDS_REVISION`
- `BLOCKED`

If the verdict is not `READY_TO_EXECUTE`, list blockers and the first action
needed to clear each one.

## Saving

When ScienceSwarm MCP tools are available, save the design with
`gbrain_capture` before answering using `asset_kind:
execution_ready_research_design`. If saving fails, report the exact failure and
do not claim the design is durable.
