---
name: scienceswarm-md-refinement-planning
description: Decide whether an MD study should stop, rerun, extend, adjust parameters, change system definition, switch methods, seek expert review, or seek experimental validation.
owner: scienceswarm
runtime: in-session
tier: molecular-dynamics-pipeline
aliases:
  - md-refine
outputs:
  - Refinement Decision Update brain asset with asset_kind md_refinement_decision_update
  - rerun, extend, adjust, switch-method, or stop recommendation
  - next handoff requirements
---

# ScienceSwarm MD Refinement Planning

Use this skill after results interpretation or failed execution. It decides
whether another MD run is justified, what must change, and when the right move
is to switch methods or stop.

Do not silently change the scientific question. A refinement decision must say
what changed and why.

## Decision Values

- `stop`
- `rerun-same-protocol`
- `extend-run`
- `adjust-parameters`
- `change-system-definition`
- `switch-method`
- `seek-expert-review`
- `seek-experimental-validation`

## Diagnose Common Problems

- Unstable trajectory.
- Ligand drift.
- No convergence.
- Conflicting metrics.
- Failed equilibration.
- Unsupported parameter choice.
- Analysis artifact.
- Method mismatch.

## Output Shape

Produce a `Refinement Decision Update`:

```markdown
# MD Refinement Decision Update: {Study Title}

## Decision

`stop | rerun-same-protocol | extend-run | adjust-parameters | change-system-definition | switch-method | seek-expert-review | seek-experimental-validation`

## Why This Decision

## Evidence Considered

| Evidence | Source | Supports Decision? | Notes |
|---|---|---|---|

## Problem Diagnosis

| Problem | Likely Cause | Confidence | How To Check |
|---|---|---|---|

## Proposed Changes

| Change | Reason | Risk | Expected Effect | Expected New Information |
|---|---|---|---|---|

## Rerun Justification

Before recommending another MD run, state what the next run is expected to teach
that the prior run could not. Repeating a weak setup without a new diagnostic,
control, parameter change, sampling plan, or method change is not refinement.

| Proposed Run | New Information Expected | Why Prior Evidence Is Insufficient | Stop Condition |
|---|---|---|---|

## Rejected Decision Values

| Decision Not Chosen | Why Not | What Would Make It Better |
|---|---|---|

## What Must Not Change Silently

- Molecular identity.
- Protonation states.
- Force field family.
- Membrane composition.
- Ion/pH assumptions.
- Scientific question being tested.

## Next Handoff

If the decision requires execution, create or update:
- Molecular System Definition.
- Parameter Decision Ledger.
- Execution Handoff Plan.
- Protocol Review Note.

## Confidence Boundary

What this refinement decision supports:
- ...

What it does not support:
- ...

What would change this decision:
- ...
```

Use frontmatter when saving:

```yaml
type: decision
asset_kind: md_refinement_decision_update
status: draft
privacy: local-only
tags: [molecular-dynamics, md-pipeline, refinement]
```

## Stop Conditions

Stop if the refinement would silently change the scientific question, parameter
changes lack rationale, or the question needs a different method rather than
another MD run.

If repeated failures remain unresolved after two refinement attempts, stop and
recommend expert review, a method switch, or experimental validation rather than
continuing low-value reruns.
