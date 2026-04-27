---
name: scienceswarm-scm-scratch-pretreatment-fit
description: "Author the classic Abadie synthetic-control fit code for prepared from-scratch panels and gate the result on pre-treatment diagnostics."
owner: scienceswarm
runtime: in-session
tier: synthetic-control-from-scratch
aliases:
  - scm-scratch-fit
outputs:
  - SCM From-Scratch Pretreatment Fit Note brain asset with asset_kind scm_scratch_fit_note
  - approved classic SCM fit code for selected cases
  - fit diagnostics and donor weights
  - Confidence Boundary
---

# ScienceSwarm SCM From-Scratch Pretreatment Fit

Use this skill after the from-scratch data stage has produced validated prepared panels and the user has approved fitting classic synthetic controls.

## Stage Contract

Generate or modify only the classic SCM fitting code for the selected case set. Do not run method comparison, placebo inference, or report rendering unless the user approves those later stages.

## Dependency Policy

Do not write `install.packages(...)`, `remotes::install_*`, `pak::pkg_install(...)`, or other package-install commands into generated R files. Generated code may check dependencies with `requireNamespace()` and must stop with a clear missing-dependency message that the user can approve separately. If a required package is absent, propose the install location and action as a next step instead of installing automatically.

## Workflow

1. Read the latest scm_scratch_study_brief and scm_scratch_data_plan.
2. Confirm the prepared panel paths, treated unit, treatment year, donor pool, predictors, and pre/post windows for each case.
3. Propose a fit-code plan before authoring code. The normal file is analysis/scm-from-scratch/code/03_fit_classic_scm.R.
4. Implement classic Abadie synthetic control with explicit predictor selection, constrained donor weights, treated versus synthetic trajectories, and serialized fit outputs under analysis/scm-from-scratch/output/fits/.
5. Write machine-readable fit summaries under analysis/scm-from-scratch/output/tables/classic-fit-summary.csv and human-readable notes under analysis/scm-from-scratch/output/notes/pretreatment-fit.md.
6. Gate every case on pre-treatment RMSPE relative to outcome variability. Use the SCM-IR quickstart-compatible gate by default: pre-treatment RMSPE divided by outcome standard deviation should be at most 0.25 unless the user explicitly selects a stricter threshold. If the fit fails, stop and recommend revising predictors, donor exclusions, pre-period windows, or data quality before any report claim.
7. Produce an SCM From-Scratch Pretreatment Fit Note with asset_kind: scm_scratch_fit_note.

## Execution Gate

Before creating or changing 03_fit_classic_scm.R, present the exact model inputs, diagnostics, and stop criteria. Ask for approval. After the selected fit step, offer next actions such as revise predictors, inspect donor weights, or move to method comparison.

## Artifact Capture

When the scienceswarm MCP tools are available, save the fit note with gbrain_capture. Include project-relative paths for generated code, fit objects, tables, and diagnostics.

## Confidence Boundary

Do not interpret a post-treatment gap as causal unless the pre-treatment fit gate passes and donor weights are substantively defensible. Label tutorial-scale shortcuts separately from publication-ready inference.
