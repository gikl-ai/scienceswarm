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
4. Audit each claim against observables, alternative explanations, missing
   controls/replicas, and next evidence needed.
5. Interpret null or negative results and state what would have falsified the
   interpretation.
6. Classify conclusions as `supported`, `suggestive`, `weak`, or `unsupported`.
7. Produce a `Results Interpretation Note` with
   `asset_kind: md_results_interpretation_note`.

When the `scienceswarm` MCP tools are available, save the interpretation note
with `gbrain_capture` before answering. Use a clear title, the asset kind
above, the active project, and links or references to the upstream run log,
analysis packet, and planning assets. If saving fails, report the exact save
failure and do not present the interpretation as durable.

Include a `Confidence Boundary` section in the interpretation note.

Never treat "the run completed" as evidence that the biological claim is true.
