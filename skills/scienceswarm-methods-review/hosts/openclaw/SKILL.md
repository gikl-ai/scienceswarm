---
name: scienceswarm-methods-review
description: Review whether a proposed research method can support the claim, with assumptions, validity threats, alternatives, diagnostics, robustness checks, and stop conditions.
owner: scienceswarm
runtime: in-session
tier: research-planning
aliases:
  - methods-review
  - research-methods-review
  - validity-review
outputs:
  - Methods Review Report brain asset with asset_kind research_methods_review
  - assumption ledger
  - method alternatives table
  - robustness and diagnostic plan
---

# ScienceSwarm Methods Review

Use this skill when the user has a proposed research method, study design,
analysis plan, proof strategy, benchmark, simulation protocol, qualitative
design, or engineering evaluation and wants to know whether it can support the
claim.

This skill reviews method fit. It does not execute the method.

## Source Requirement

Start from a source artifact or user description that includes:

- research claim or conjecture
- proposed method
- evidence object: data, model system, proof object, corpus, benchmark,
  apparatus, field site, or materials
- intended audience or venue type, if known
- constraints such as time, access, compute, ethics, sample, or equipment

If the claim or method is missing, ask one concise clarification question.
If both are missing, recommend `scienceswarm-brown-bag` first.

Default save path in ScienceSwarm/OpenClaw:

1. Draft the full report in Markdown.
2. Save it with `gbrain_capture` using `asset_kind:
   research_methods_review`.
3. Report the saved title and artifact/location in the final answer.

If `gbrain_capture` is unavailable but the host can write files, write a
Markdown file only in a user-approved project or study artifact location. If no
durable write path is available, return `BLOCKED_ON_SAVE`, include the complete
Markdown report, and ask where to save it.

## Review Posture

Be strict. A method is acceptable only if it can make the claimed inference,
derivation, measurement, comparison, or capability credible to a skeptical
expert.

Core instincts:

1. Separate claim, estimand or target, and method.
2. Name assumptions before evaluating results.
3. Compare against plausible alternatives, not straw alternatives.
4. Require diagnostics that can reveal failure.
5. Define pass, fail, and inconclusive outcomes before execution.
6. Prefer narrower claims over overextended methods.

## Choose The Method Lens

Pick the lens that fits the plan:

- Experimental or empirical science: controls, randomization or assignment,
  measurement reliability, sample size, confounds, mechanism, and replicability.
- Causal or quasi-experimental social science: estimand, treatment timing,
  comparison set, parallel trends or counterfactual assumptions, spillovers,
  anticipation, placebo logic, and external validity.
- Computational, simulation, or machine-learning research: benchmark validity,
  leakage, baselines, ablations, seeds, nondeterminism, resource reporting,
  and failure envelope.
- Mathematics or theory: definitions, assumptions, edge cases, dependency
  lemmas, proof strategy, counterexample search, and generality.
- Qualitative or interpretive research: case logic, sampling, positionality,
  construct validity, coding reliability, rival explanations, and transfer.
- Engineering or systems research: capability claim, instrumentation,
  operating envelope, stress tests, failure modes, maintainability, and
  reproducibility.
- Methods research: user of the method, assumptions, comparison methods,
  stress tests, adoption barriers, and known failure cases.

## Review Flow

### Step 1: Claim-Method Alignment

State:

- what the method can establish
- what it cannot establish
- whether the claim must be narrowed
- the exact target: estimand, theorem, mechanism, parameter, capability,
  construct, or design requirement

### Step 2: Assumption Ledger

Create an assumption table:

```markdown
| Assumption | Why Needed | How To Check | Consequence If False |
|---|---|---|---|
```

Do not allow hidden assumptions to remain in prose.

### Step 3: Alternatives And Negative Comparisons

Compare the proposed method against at least two plausible alternatives when
possible. Alternatives may include a simpler descriptive analysis, different
model, different control group, different proof route, different benchmark,
different measurement strategy, or a narrower pilot.

```markdown
| Method | What It Buys | What It Cannot Answer | Cost / Risk | Verdict |
|---|---|---|---|---|
```

### Step 4: Validity Threats

Identify threats that could invalidate the method:

- construct mismatch
- confounding or omitted causes
- selection or missingness
- timing or anticipation
- measurement error
- leakage or contamination
- low power or weak signal
- multiple comparisons
- model misspecification
- unstable computation
- hidden proof assumption
- nonrepresentative cases
- irreproducible setup

For each, require mitigation, diagnostic, and stop condition.

### Step 5: Robustness And Diagnostics

Design checks before execution:

- negative controls, placebos, counterexamples, or falsification checks
- sensitivity analysis
- baseline or comparator analysis
- ablations or stress tests
- replication target
- subgroup or boundary analysis only when justified
- result interpretation table

### Step 6: Verdict

Use one of:

- `METHOD_FIT`: method can support the claim with ordinary execution risk.
- `METHOD_FIT_WITH_GATES`: method can support the claim only if listed
  diagnostics pass before full-scale execution.
- `NARROW_CLAIM`: method is useful, but only for a narrower claim.
- `CHANGE_METHOD`: proposed method cannot support the claim; use a different
  design.
- `BLOCKED`: missing data, missing definition, ethical/compliance issue,
  impossible comparison, or no durable save path.

## Required Output

Produce a `Methods Review Report`:

````markdown
# Methods Review Report: {title}

## Source Artifact

## Verdict

## Claim And Target

## Method Summary

## What The Method Can And Cannot Establish

## Assumption Ledger

| Assumption | Why Needed | How To Check | Consequence If False |
|---|---|---|---|

## Method Alternatives

| Method | What It Buys | What It Cannot Answer | Cost / Risk | Verdict |
|---|---|---|---|---|

## Validity Threat Register

| Threat | Why It Matters | Mitigation | Diagnostic | Stop Condition |
|---|---|---|---|---|

## Robustness And Diagnostics Plan

| Check | Purpose | Pass | Fail | Inconclusive |
|---|---|---|---|---|

## Recommended Claim Revision

## Execution Gates

## Reviewer Objection Prebuttals

## Open Decisions
````

## Quality Checks

Before finalizing, verify:

- The report separates the claim from the method.
- The target of inference, proof, measurement, or evaluation is explicit.
- Assumptions are tabled and checkable.
- At least two method alternatives are considered when plausible.
- Validity threats have diagnostics and stop conditions.
- The verdict says whether to proceed, gate, narrow, change method, or block.
- The final report is saved, or the save blocker is explicit.

## Saving

When ScienceSwarm MCP tools are available, save the report with
`gbrain_capture` before answering. Use frontmatter:

```yaml
type: review
asset_kind: research_methods_review
status: draft
privacy: local-only
tags: [methods-review, validity, research-design]
```

If saving fails, report the exact failure and do not claim the report is
durable.
