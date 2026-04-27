---
name: scienceswarm-scm-scratch-method-choice
description: "Author method-comparison code for from-scratch SCM results and decide whether classic SCM is robust enough to carry forward."
owner: scienceswarm
runtime: in-session
tier: synthetic-control-from-scratch
aliases:
  - scm-scratch-methods
outputs:
  - SCM From-Scratch Method Choice Note brain asset with asset_kind scm_scratch_method_choice_note
  - approved method-comparison R code for selected cases
  - robustness table and sign-consistency verdict
  - Confidence Boundary
---

# ScienceSwarm SCM From-Scratch Method Choice

Use this skill after classic from-scratch SCM fits exist and the user has approved robustness checks across related SCM estimators.

## Stage Contract

Generate or modify only the method comparison code for the selected cases. Do not run placebo inference or final report rendering unless the user explicitly approves those later stages.

## Dependency Policy

Do not write `install.packages(...)`, `remotes::install_*`, `pak::pkg_install(...)`, or other package-install commands into generated R files. Generated code may check dependencies with `requireNamespace()` and must stop with a clear missing-dependency message that the user can approve separately. If a required package is absent, propose the install location and action as a next step instead of installing automatically.

## Shape Validation Policy

Before fitting any method, generated code must validate each case's outcome matrix: the treated and donor columns must be present, pre/post indices must be non-empty, and row/column dimensions must align with the panel years and units. If validation fails, or if an optional estimator fails for one case, record a case-specific row with `status = "error"` and the reason in `method-comparison.csv`; do not let raw indexing errors such as `subscript out of bounds` stop the whole stage.

## Workflow

1. Read the latest study brief, data plan, and pretreatment fit note.
2. Identify which modern variants are feasible in the current R environment: generalized synthetic control, synthetic DiD, and a doubly robust or augmented synthetic-control approximation.
3. Propose the method-comparison plan before authoring code. The normal file is analysis/scm-from-scratch/code/04_compare_methods.R.
4. Preserve classic Abadie SCM as the primary estimator, then compare signs, magnitudes, standard errors or uncertainty summaries when available, and package availability.
5. Write outputs to:
   - analysis/scm-from-scratch/output/tables/method-comparison.csv
   - analysis/scm-from-scratch/output/figures/method-comparison.*
   - analysis/scm-from-scratch/output/notes/method-choice.md
6. Apply a sign-consistency and fragility gate. If available methods disagree in direction or imply a qualitatively different conclusion, recommend reporting fragility rather than proceeding to a headline result.
7. Produce an SCM From-Scratch Method Choice Note with asset_kind: scm_scratch_method_choice_note.

## Execution Gate

Before generating 04_compare_methods.R, list the methods, required packages, fallback behavior for unavailable optional methods, and the robustness gate. Ask for approval for that exact file or case subset.

## Artifact Capture

When the scienceswarm MCP tools are available, save the method choice note with gbrain_capture. Report included and skipped methods with reasons.

## Confidence Boundary

Make clear whether agreement across methods strengthens the tutorial result or whether the evidence is still only a scaffold-level robustness check.
