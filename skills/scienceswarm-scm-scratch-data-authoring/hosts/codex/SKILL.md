---
name: scienceswarm-scm-scratch-data-authoring
description: "Author and review the data acquisition and munging code for a from-scratch synthetic-control panel after the study design is approved."
owner: scienceswarm
runtime: in-session
tier: synthetic-control-from-scratch
aliases:
  - scm-scratch-data
outputs:
  - SCM From-Scratch Data Plan brain asset with asset_kind scm_scratch_data_plan
  - approved R code for selected data step
  - data provenance and balance checks
  - Confidence Boundary
---

# ScienceSwarm SCM From-Scratch Data Authoring

Use this skill after an SCM From-Scratch Study Brief exists and the user has approved authoring the data acquisition or panel construction step.

## Stage Contract

Generate or modify only the R code needed for the selected data step. Do not fit SCM models, render final figures, or create later-stage files unless the user explicitly approves that later stage.

## Dependency Policy

Do not write `install.packages(...)`, `remotes::install_*`, `pak::pkg_install(...)`, or other package-install commands into generated R files. Generated code may check dependencies with `requireNamespace()` and must stop with a clear missing-dependency message that the user can approve separately. If a required package is absent, propose the install location and action as a next step instead of installing automatically.

## Workflow

1. Read the latest scm_scratch_study_brief for treated units, treatment dates, outcomes, donor rules, and required diagnostics.
2. Propose a compact data plan before writing code. Include source APIs or package data, expected variables, cache paths, transformations, and validation checks.
3. Ask for approval to generate one selected file at a time, normally:
   - analysis/scm-from-scratch/code/01_acquire_data.R
   - analysis/scm-from-scratch/code/02_build_panels.R
4. For the SCM-IR from-scratch tutorial, pull World Bank Development Indicators for Brexit and Russia cases, use the public Synth::basque data for the Basque case, and build the same unit-time case structure as the quickstart without copying its scripts. Preserve quickstart-comparable main donor pools unless the user approves a redesign: do not exclude Madrid, Catalonia, or Navarre from the Basque main specification by default; record them as sensitivity exclusions instead.
5. Treat outcome coverage, minimum donor count, and minimum pre-treatment length as hard gates. Treat sparse auxiliary predictors, including human-capital or schooling proxies, as optional: drop them with an audit note when coverage is weak instead of failing an otherwise usable panel.
5. Validate raw and prepared outputs:
   - analysis/scm-from-scratch/data/raw/
   - analysis/scm-from-scratch/data/prepared/brexit.rds
   - analysis/scm-from-scratch/data/prepared/russia.rds
   - analysis/scm-from-scratch/data/prepared/basque.rds
   - analysis/scm-from-scratch/output/tables/data-audit.csv
6. Stop if any case has too few pre-treatment observations, too few donors, missing outcome coverage, or undocumented exclusions. Do not stop only because an optional predictor is sparse; revise the predictor set and record the decision in the data audit.
7. Produce an SCM From-Scratch Data Plan with asset_kind: scm_scratch_data_plan.

## Execution Gate

Before writing or changing R code, show the exact file path, purpose, inputs, outputs, and validation checks. Ask the user to approve that specific file. After execution, propose the next 2 or 3 actions instead of continuing automatically.

## Artifact Capture

When the scienceswarm MCP tools are available, save the data plan and validation summary with gbrain_capture. If generated R is created through a runtime, report the project-relative path and the validation output path.

## Confidence Boundary

Separate verified panel facts from intended modeling assumptions. If a source revision, package dependency, or coverage gap changes comparability, say so before recommending model fitting.
