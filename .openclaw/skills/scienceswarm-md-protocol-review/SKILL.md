---
name: scienceswarm-md-protocol-review
description: Review an MD setup before execution and flag blocking assumptions, unsafe defaults, missing controls, reproducibility gaps, and overclaim risks.
owner: scienceswarm
runtime: in-session
tier: molecular-dynamics-pipeline
aliases:
  - md-review
outputs:
  - Protocol Review Note brain asset with asset_kind md_protocol_review_note
  - approved-to-run, approved-with-caveats, or blocked verdict
  - required changes before run
---

# ScienceSwarm MD Protocol Review

Use this skill before execution. It is the quality gate that prevents a coding
agent from turning an under-specified scientific plan into runnable commands.

## Verdicts

- `approved-to-run`: no blocking scientific or reproducibility issues.
- `approved-with-caveats`: execution may proceed, but limitations must be
  carried into interpretation.
- `blocked`: no execution handoff should proceed. The next output is a question
  list or required-fixes list, not runnable commands.

## Review Areas

- Scientific assumptions.
- Parameter Decision Ledger.
- Molecular System Definition.
- Execution Handoff Plan.
- Reproducibility.
- Controls, replicas, sampling adequacy, convergence expectations, and go/no-go
  criteria.
- Overclaim risk.
- Required controls or adjacent methods.

## Output Shape

Produce a `Protocol Review Note`:

```markdown
# MD Protocol Review Note: {Study Title}

## Review Verdict

`approved-to-run | approved-with-caveats | blocked`

## Blocking Issues

| Issue | Severity | Why It Blocks | Required Fix | Owner |
|---|---|---|---|---|

## Non-Blocking Concerns

| Concern | Severity | Risk | Suggested Mitigation |
|---|---|---|---|

## Scientific Assumption Review

| Assumption | Source | Confidence | Risk If Wrong | Needs Expert Review? |
|---|---|---|---|---|

## Parameter Ledger Review

| Parameter | Review Status | Comment |
|---|---|---|

## Overclaim Risk

Claims this setup might tempt the user to make but does not support:
- ...

Safer phrasing:
- ...

## Reproducibility Review

| Item | Status | Notes |
|---|---|---|

## Failure Mode Review

| Failure Mode | Detection Signal | Severity | Rescue Action | Scientist Impact | Covered By Plan? |
|---|---|---|---|---|---|
| Missing or weak parameters |  |  |  |  |  |
| Bad protonation, tautomer, or charge |  |  |  |  |  |
| Unstable minimization or equilibration |  |  |  |  |  |
| LINCS/SHAKE or constraint failures |  |  |  |  |  |
| Barostat, temperature, or pressure instability |  |  |  |  |  |
| Ligand drift or broken binding pose interpretation |  |  |  |  |  |
| Insufficient sampling or inconsistent replicas |  |  |  |  |  |

## Required Changes Before Run

## Optional Improvements

## Confidence Boundary

What this review supports:
- ...

What it does not support:
- ...

What would change this verdict:
- ...
```

Use frontmatter when saving:

```yaml
type: critique
asset_kind: md_protocol_review_note
status: draft
privacy: local-only
tags: [molecular-dynamics, md-pipeline, protocol-review]
```

## Stop Conditions

If the verdict is `blocked`, stop. Do not generate executable instructions until
blocking issues are resolved.
