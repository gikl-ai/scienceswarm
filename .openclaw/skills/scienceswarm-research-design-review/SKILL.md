---
name: scienceswarm-research-design-review
description: Review and upgrade a research idea, protocol, brown-bag brief, or study plan into an execution-ready research design document with validity checks, analysis plan, reproducibility package, and handoff tasks.
owner: scienceswarm
runtime: in-session
tier: research-planning
aliases:
  - research-design-review
  - study-design-review
  - design-review-research
outputs:
  - Execution-Ready Research Design brain asset with asset_kind execution_ready_research_design
  - research readiness dashboard
  - validity threat register
  - execution workstream plan
  - reproducibility and publication package checklist
---

# ScienceSwarm Research Design Review

Use this skill when the user has a research idea, Brown Bag brief, protocol,
study plan, grant sketch, methods plan, or rough execution plan and wants to
lock it into an execution-ready research design before work begins.

This is the research analog of a rigorous engineering plan review. It does not
run experiments, write code, fit models, prove theorems, or collect data. It
produces the design document that primes execution.

## Hard Boundary

Do not begin execution. The output is a saved `Execution-Ready Research Design`
and a list of decisions or blockers. Downstream execution can start only after
the design states what will be done, why it is valid, what would falsify it, and
what artifacts must be produced.

Do not include business, commercialization, or promotional framing unless the
research topic itself studies those phenomena.

## Source Artifact Requirement

Start by finding or asking for the source artifact:

1. Prefer an existing `research_brown_bag_brief`, protocol, study note, paper
   packet, prior design, or user-provided plan.
2. If none exists, ask the user for the shortest useful plan: research claim,
   method, evidence/data/proof object, target audience, and desired output.
3. If the idea is still too raw to review, recommend running
   `scienceswarm-brown-bag` first, then return to this skill.

The review is incomplete unless it saves or returns a complete written design.

Default save path in ScienceSwarm/OpenClaw:

1. Draft the complete design in Markdown.
2. Save it with `gbrain_capture` using `asset_kind:
   execution_ready_research_design`.
3. Report the saved title and artifact/location in the final answer.

If `gbrain_capture` is unavailable but the host can write files, write a
Markdown file only in a user-approved project or study artifact location. If no
durable write path is available, return `BLOCKED_ON_SAVE`, include the full
Markdown design, and ask where to save it.

## Review Posture

Be direct. The goal is not to admire the idea; it is to make the research hard
to fool, easy to execute, and credible to a skeptical expert.

Review instincts to apply throughout:

1. Claim before method: a method is not a research question.
2. Validity before speed: an easy study that cannot answer the claim is not a
   study.
3. Smallest decisive first: execution should start with a step that can change
   the researcher's mind.
4. Negative results count: specify what failure would teach.
5. Reproducibility is design, not cleanup.
6. Publication fit shapes evidence: the venue and audience determine the bar.
7. Scope discipline: defer work that does not change the core inference,
   proof, benchmark, mechanism, or artifact.

## Discipline Lens

Choose the lens that fits the design. If uncertain, ask one clarifying question.

- Empirical science: hypothesis, model system, assay, controls, confounds,
  sample size, measurement reliability, and mechanism.
- Mathematics or theory: definitions, conjecture, boundary cases, proof
  strategy, counterexample search, toy cases, and dependency lemmas.
- Causal social science: estimand, identification, treatment timing,
  comparison set, threats to inference, mechanisms, ethics, and external
  validity.
- Engineering or computational research: capability claim, baselines,
  benchmark, ablations, instrumentation, reliability, failure envelope, and
  reproducibility.
- Methods research: user of the method, assumptions, comparison methods, stress
  tests, adoption barrier, and failure cases.

## Review Flow

Work section by section. If a section surfaces a major unresolved decision,
pause and ask the user before finalizing that part of the design. Do not batch
unrelated decisions.

## Finding And Decision Protocol

For every material design issue, record:

- severity: `critical`, `major`, `minor`, or `note`
- confidence: 1 to 10
- affected claim, method, dataset, proof step, benchmark, artifact, or audience
- recommended fix
- tradeoff if left unresolved

Ask the user before changing the design when alternatives differ in kind or
when the fix narrows the research claim. Do not ask when the issue is a plain
correction, such as adding a missing stop condition or separating pass/fail/
inconclusive outcomes.

Suppress low-confidence speculative findings unless the possible consequence
would invalidate the study.

### Step 0: Readiness And Scope Challenge

Before detailed review, answer:

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

Evaluate:

- Is the main claim specific enough to criticize?
- Is the contribution new relative to closest prior art?
- Does the design separate primary claim, secondary claims, and exploratory
  observations?
- What would count as success, failure, and inconclusive result?
- What field, venue, or expert audience will care?

### Section 2: Method Fit And Design Logic

Evaluate:

- Does the chosen method actually answer the claim?
- What assumptions does the method require?
- What alternative methods should be considered or rejected?
- What data, corpus, model system, benchmark, proof object, or apparatus is
  required?
- What is the execution pipeline from inputs to final claim?

Require a simple ASCII diagram for non-trivial designs:

```text
Inputs / prior work
  -> design choice / method
  -> measurement / derivation / computation
  -> primary result
  -> robustness / counterexample / negative control
  -> claim boundary
```

### Section 3: Validity Threat Register

Create a threat register. Tailor labels to the discipline.

Common threats:

- construct validity: are we measuring the thing we claim?
- internal validity: could another cause explain the result?
- external validity: where does the result generalize?
- statistical validity: power, uncertainty, multiplicity, model choice
- computational validity: benchmark leakage, brittle evaluation, nondeterminism
- proof validity: hidden assumptions, undefined terms, missing edge cases
- measurement validity: noisy instruments, annotation bias, data quality
- ethical or compliance risk: human subjects, privacy, dual use, safety

For each threat, state mitigation, diagnostic, and stop condition.

### Section 4: Analysis, Proof, Or Execution Plan

Specify the execution plan at the level an execution agent or researcher can
start without guessing.

Include:

- ordered workstreams
- inputs and dependencies
- decision gates
- expected outputs
- failure modes
- recovery paths
- what to log as provenance

If workstreams can run in parallel, produce a lane plan:

```markdown
| Lane | Workstream | Inputs | Output | Depends On |
|---|---|---|---|---|
```

### Section 5: Evidence And Verification Plan

Define the tests of the research design:

- pilot or smallest decisive test
- negative controls, counterexamples, placebo tests, or ablations
- robustness and sensitivity checks
- baseline comparisons
- replication or reproduction target
- quality thresholds
- result interpretation table

Use this shape:

```markdown
| Check | Purpose | Pass | Fail | Inconclusive |
|---|---|---|---|---|
```

### Section 6: Reproducibility And Artifact Plan

Specify what must exist at the end:

- data/code/proof/protocol/materials package
- environment or toolchain notes
- provenance manifest
- figure and table source files
- decision log
- README or method appendix
- privacy/compliance limitations
- what can and cannot be released publicly

### Section 7: Publication Fit

Name the audience and evidence bar:

- primary audience
- plausible venue type
- minimum evidence package
- likely reviewer or reader objection
- strongest prebuttal
- figure/table spine
- reproducibility expectation
- strongest reason to desk-reject or reject

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

## Review Verdict

Use one of:

- `READY_TO_EXECUTE`: no blocking design gaps remain.
- `READY_WITH_GATES`: execution can begin, but listed gates must be checked
  before full-scale work.
- `NEEDS_REVISION`: core claim, method, validity, evidence, or execution plan is
  not ready.
- `BLOCKED`: missing source artifact, unavailable data, ethical/compliance
  blocker, or no durable save path.

If the verdict is not `READY_TO_EXECUTE`, list the exact blockers and the first
action needed to clear each one.

## Quality Checks

Before finalizing, verify:

- The design names the research claim and what would falsify or weaken it.
- The method is justified against at least one plausible alternative.
- Validity threats have diagnostics and stop conditions.
- Execution steps are concrete enough for a researcher or agent to begin.
- Verification checks distinguish pass, fail, and inconclusive outcomes.
- Reproducibility artifacts are specified before execution starts.
- Publication fit names the audience, venue type, evidence bar, reviewer
  objection, prebuttal, figure/table spine, and rejection risk.
- The final design is saved, or the save blocker is explicit.

## Saving

When ScienceSwarm MCP tools are available, save the design with
`gbrain_capture` before answering. Use frontmatter:

```yaml
type: planning
asset_kind: execution_ready_research_design
status: draft
privacy: local-only
tags: [research-design, execution-ready]
```

If saving fails, report the exact failure and do not claim the design is
durable.
