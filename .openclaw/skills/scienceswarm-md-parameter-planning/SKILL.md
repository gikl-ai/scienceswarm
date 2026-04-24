---
name: scienceswarm-md-parameter-planning
description: Recommend MD parameters with rationale, confidence, assumptions, alternatives, expert-sensitivity labels, and risks if chosen incorrectly.
owner: scienceswarm
runtime: in-session
tier: molecular-dynamics-pipeline
aliases:
  - md-parameters
outputs:
  - Parameter Decision Ledger brain asset with asset_kind md_parameter_decision_ledger
  - standard defaults list
  - expert-sensitive choices list
  - do-not-default choices list
---

# ScienceSwarm MD Parameter Planning

Use this skill after the molecular system is defined. This is the core judgment
step for users who do not know how to choose MD parameters.

Do not simply list defaults. For every recommendation, explain why it fits this
system, what evidence supports it, what assumptions it makes, and what risk it
creates if wrong.

## Parameter Areas

- Force field.
- Ligand or nonstandard residue parameterization.
- Water model.
- Ion conditions.
- Box and boundary conditions.
- Energy minimization.
- Equilibration protocol.
- Production runtime.
- Timestep.
- Thermostat and barostat.
- Restraints.
- Sampling strategy.
- Replicates, random seeds, and restart policy.
- Controls, comparators, or baseline systems required by the claim.
- Convergence and stopping criteria.
- Analysis metrics.

## Sensitivity Labels

- `standard-default`: unlikely to dominate the conclusion if the system is
  otherwise well-defined.
- `expert-sensitive`: can materially change the conclusion and needs evidence
  or expert review.
- `do-not-default`: ScienceSwarm refuses to choose without more information.

## Output Shape

Produce a `Parameter Decision Ledger`:

```markdown
# Parameter Decision Ledger: {Study Title}

## Recommendation Summary

| Area | Recommendation | Confidence | Evidence Class | Expert Sensitivity |
|---|---|---:|---|---|

## Detailed Decisions

### {Parameter Name}

**Recommendation:**

**Why this recommendation:**

**Evidence class:**
`project-literature | external-literature | common-heuristic | tool-default | speculative`

**Confidence:**
`low | medium | high`

**Expert sensitivity:**
`standard-default | expert-sensitive | do-not-default`

**Assumptions:**
- ...

**Risks if wrong:**
- ...

**Validation signal:**
What result, warning, plot, or diagnostic would show this choice is behaving as
expected.

**Failure indicators:**
What would suggest this choice is wrong, unstable, or insufficient for the
claim.

**Alternatives considered:**

| Alternative | When it would be better | Tradeoff |
|---|---|---|

**What would change this decision:**
- ...

**Source refs:**
- ...

**Teach me version:**
Plain-English explanation for a non-MD expert.

**Expert note:**
Technical caveats for a reviewer or collaborator.

## Standard Defaults vs Expert-Sensitive Choices

## Simulation Design Completeness

| Item | Plan | Why It Is Enough | Failure Signal | Blocking? |
|---|---|---|---|---|
| Replicates / Seeds |  |  |  |  |
| Controls / Comparators |  |  |  |  |
| Sampling Adequacy |  |  |  |  |
| Convergence Criteria |  |  |  |  |
| Sensitivity Checks |  |  |  |  |

## Missing Inputs Blocking Confidence

| Missing Input | Affected Parameter | Why It Matters | How To Resolve |
|---|---|---|---|

## Confidence Boundary

What this ledger supports:
- ...

What it does not support:
- ...

What would change these recommendations:
- ...
```

Use frontmatter when saving:

```yaml
type: decision
asset_kind: md_parameter_decision_ledger
status: draft
privacy: local-only
tags: [molecular-dynamics, md-pipeline, parameters]
```

## Stop Conditions

Stop if a `do-not-default` choice is unresolved, evidence is insufficient for a
high-impact parameter, or the desired conclusion requires stronger methods than
the planned MD can support.
