---
name: scienceswarm-scm-scratch-inference-placebos
description: "Author placebo and sensitivity code for from-scratch SCM fits, including in-space, in-time, and leave-one-out checks."
owner: scienceswarm
runtime: in-session
tier: synthetic-control-from-scratch
aliases:
  - scm-scratch-inference
outputs:
  - SCM From-Scratch Inference Note brain asset with asset_kind scm_scratch_inference_note
  - approved placebo and sensitivity R code for selected checks
  - placebo distribution and sensitivity outputs
  - Confidence Boundary
---

# ScienceSwarm SCM From-Scratch Inference and Placebos

Use this skill after classic SCM fits and method-comparison notes exist and the user has approved inference or falsification checks.

## Stage Contract

Generate or modify only the inference code for the selected placebo or sensitivity family. Do not render the final report unless the user explicitly approves the reporting stage.

## Dependency Policy

Do not write `install.packages(...)`, `remotes::install_*`, `pak::pkg_install(...)`, or other package-install commands into generated R files. Generated code may check dependencies with `requireNamespace()` and must stop with a clear missing-dependency message that the user can approve separately. If a required package is absent, propose the install location and action as a next step instead of installing automatically.

## Refit Validation Policy

Before each placebo, in-time, or leave-one-out refit, generated code must validate treated and donor identifiers, non-empty pre/post windows, donor-pool size, and outcome-matrix dimensions. A failed refit for one donor, time window, or fragile case should be recorded in `placebo-summary.csv`, `in-time-placebo.csv`, or `leave-one-out.csv` with `status = "error"` and a reason; it should not prevent other selected checks from writing their outputs.

## Workflow

1. Read the latest from-scratch study brief, data plan, fit note, and method choice note.
2. Propose the inference plan before authoring code. The normal file is analysis/scm-from-scratch/code/05_placebos_and_sensitivity.R.
3. Support three families of checks where feasible:
   - in-space donor placebos with placebo rank and RMSPE-ratio filtering,
   - in-time placebo treatment years to detect anticipation or timing artifacts,
   - leave-one-out refits for influential donors.
4. Label any fast tutorial approximation separately from full refitting.
5. Write outputs to:
   - analysis/scm-from-scratch/output/tables/placebo-summary.csv
   - analysis/scm-from-scratch/output/tables/in-time-placebo.csv
   - analysis/scm-from-scratch/output/tables/leave-one-out.csv
   - analysis/scm-from-scratch/output/figures/placebo-distribution.*
   - analysis/scm-from-scratch/output/notes/inference.md
6. Stop if placebo evidence contradicts the claimed effect or if sensitivity checks show that one donor drives the result.
7. Produce an SCM From-Scratch Inference Note with asset_kind: scm_scratch_inference_note.

## Execution Gate

Before generating 05_placebos_and_sensitivity.R, identify the selected inference family, compute budget, approximation status, expected outputs, and stop criteria. Ask for user approval for that selected check.

## Artifact Capture

When the scienceswarm MCP tools are available, save the inference note with gbrain_capture. Link to the generated tables, figures, and notes by project-relative path.

## Confidence Boundary

A single ATT estimate is never enough. State what the placebo distribution and sensitivity checks support, what they fail to rule out, and whether the result remains tutorial-grade or publication-grade.
