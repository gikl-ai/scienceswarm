---
name: scienceswarm-md-results-interpretation
description: Interpret MD outputs, separate run completion from scientific support, and classify conclusions as supported, suggestive, weak, or unsupported.
---

# ScienceSwarm MD Results Interpretation

Use this skill when MD outputs need a bounded scientific interpretation.

## Workflow

1. Verify the run quality and linked planning assets.
2. Explain each metric in terms of what it may suggest and what it does not
   prove.
3. Audit each claim against observables, alternative explanations, missing
   controls/replicas, and next evidence needed.
4. Interpret null or negative results and state what would have falsified the
   interpretation.
5. List supported conclusions and overclaims to avoid.
6. Recommend accepting, rerunning, extending, adjusting parameters, switching
   methods, seeking expert review, or seeking experimental validation.
7. Produce a `Results Interpretation Note` with
   `asset_kind: md_results_interpretation_note` and a `Confidence Boundary`.

Separate operational success from scientific support.
