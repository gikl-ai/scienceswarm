---
name: scienceswarm-md-results-interpretation
description: Interpret MD outputs, separate run completion from scientific support, and classify conclusions as supported, suggestive, weak, or unsupported.
owner: scienceswarm
runtime: in-session
tier: molecular-dynamics-pipeline
aliases:
  - md-results
outputs:
  - Results Interpretation Note brain asset with asset_kind md_results_interpretation_note
  - supported conclusions table
  - overclaim warnings
---

# ScienceSwarm MD Results Interpretation

Use this skill after a run or analysis summary exists. The central rule is:
successful MD execution is not successful science.

Interpret the result against the original simulation question and the Parameter
Decision Ledger. Do not let completed trajectories imply binding affinity,
mechanism, delivery efficacy, or cancer biology claims without sufficient
evidence.

## Common Metrics To Explain

- RMSD.
- RMSF.
- Hydrogen bonds.
- Contacts.
- Radius of gyration.
- Ligand pose stability.
- Membrane interaction.
- Energy or pressure warnings.
- Analysis reproducibility.

## Conclusion Classes

- `supported`: the run directly supports this bounded statement.
- `suggestive`: the run is consistent with the statement, but not decisive.
- `weak`: the run provides weak or fragile support.
- `unsupported`: the run does not support the statement.

## Output Shape

Produce a `Results Interpretation Note`:

```markdown
# MD Results Interpretation Note: {Study Title}

## Linked Run

## Question Being Interpreted

## Run Quality Summary

| Check | Result | Interpretation Impact |
|---|---|---|

## Metrics Observed

| Metric | Observation | What It May Suggest | What It Does Not Prove |
|---|---|---|---|

## Visual / Artifact References

## Supported Conclusions

| Conclusion | Support Level | Evidence | Caveat |
|---|---|---|---|

## Overclaims To Avoid

Do not claim:
- ...

Safer phrasing:
- ...

## Alternative Explanations

## Recommended Next Step

`accept-result | rerun | extend-simulation | adjust-parameters | switch-method | seek-expert-review | seek-experimental-validation`

## Confidence Boundary

What this interpretation supports:
- ...

What it does not support:
- ...

What would change this interpretation:
- ...
```

Use frontmatter when saving:

```yaml
type: observation
asset_kind: md_results_interpretation_note
status: draft
privacy: local-only
tags: [molecular-dynamics, md-pipeline, results]
```

## Stop Conditions

Stop if run quality failed, the metric does not answer the original question,
or the user is trying to infer a biological or binding claim from insufficient
evidence.
