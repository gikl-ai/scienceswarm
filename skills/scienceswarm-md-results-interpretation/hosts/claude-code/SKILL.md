---
name: scienceswarm-md-results-interpretation
description: Interpret MD outputs, separate run completion from scientific support, and classify conclusions as supported, suggestive, weak, or unsupported.
---

# ScienceSwarm MD Results Interpretation

Use this skill after an MD run, log, trajectory summary, plot, or analysis
packet exists.

## Workflow

1. Tie the run back to the original simulation question and parameter ledger.
2. Assess run quality before interpreting metrics.
3. Explain RMSD, RMSF, contacts, hydrogen bonds, radius of gyration, ligand pose
   stability, membrane interaction, or other observed metrics.
4. Classify conclusions as `supported`, `suggestive`, `weak`, or `unsupported`.
5. Produce a `Results Interpretation Note` with
   `asset_kind: md_results_interpretation_note`.

Include a `Confidence Boundary` section in the interpretation note.

Never treat "the run completed" as evidence that the biological claim is true.
