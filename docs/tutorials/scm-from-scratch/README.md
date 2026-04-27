# SCM from scratch - a conversation-first research demo

This tutorial shows how to use ScienceSwarm the way a researcher usually starts:
with a half-formed scientific question, not with a prebuilt pipeline or a
collection of custom skills.

The example stays close to the existing
[SCM-IR quickstart](../scm-ir-quickstart/README.md) so the final artifacts are
easy to compare:

- Brexit referendum, treated unit United Kingdom, treatment year 2016.
- Russia 2022 sanctions, treated unit Russian Federation, treatment year 2022.
- Basque Country / ETA terrorism, treated unit Basque Country, treatment year
  1975.

The method target is still synthetic control: classic Abadie synthetic control
as the primary estimator, method comparison as robustness, in-space and in-time
placebo checks for inference, sensitivity checks, and a final report with
figures, tables, and caveated interpretation.

The point of this path is different from the quickstart. Here, the user and the
assistant discover the workflow together. The assistant should help refine the
research question, find data, choose libraries, write code, debug failures,
revise the study design, and decide how strong the final claim can be.

No terminal is required for the human user. All planning, code authoring,
execution, and artifact review happens through the ScienceSwarm study UI and
the selected assistant runtime.

## What you do not need

You do not need to create custom skills before starting your own research
exploration.

You do not need to know the final file paths before the assistant has designed
the analysis.

You do not need to paste a long staged script for every step. Long, precise
prompts are useful for replaying a finished workflow, but they are not the
normal starting point for exploratory science.

Use this tutorial as a model for the conversation. The reproducibility appendix
at the end gives a stable artifact layout and optional skillized replay path
after the research shape is clear.

## Expected final state

By the end, the study should contain:

- durable study notes for the research question, data choices, method choices,
  fit diagnostics, inference checks, and final interpretation,
- generated analysis code,
- raw or cached source data plus prepared panels,
- tables, figures, fit objects, execution notes, and a final HTML report,
- a run log that explains what changed during the conversation, and
- a confidence boundary that distinguishes tutorial parity from a new
  political-science finding.

The assistant may propose its own folder names. If you want a consistent shape,
ask it to use `analysis/scm-from-scratch/` as the analysis root.

## 0. Create the study

1. Start ScienceSwarm and complete setup if the app asks.
2. Open the dashboard and create a study named something like
   `SCM from scratch`.
3. Open the study chat composer.
4. Choose a runtime that can author and execute study files, such as
   `Claude Code`.
5. Keep the existing SCM quickstart scripts out of the project for this path.
   Do not copy or require existing quickstart scripts. The goal is to let the
   assistant build the analysis from an empty study.

Generated R should check for required packages and stop with a clear missing
dependency message if the runtime is not ready. It should not install packages
automatically; any package installation remains a separate user-approved step.

## 1. Start with one research prompt

Paste this into the study chat:

```text
I want to explore whether synthetic control can estimate how three
international-relations shocks changed real GDP per capita:

- Brexit for the United Kingdom in 2016.
- Russia 2022 sanctions for the Russian Federation in 2022.
- ETA terrorism for the Basque Country beginning in 1975.

I am starting from an empty ScienceSwarm study. Please act as a research
collaborator, not as a script runner.

First, do not write code. Help me turn this into an executable research design.
If there are blocking ambiguities, ask at most three questions. Otherwise make
reasonable assumptions and produce a study plan that covers:

- the estimand and outcome,
- treated units and treatment dates,
- donor-pool rules and exclusions,
- likely public data sources,
- the primary SCM estimator,
- robustness checks,
- placebo and sensitivity checks,
- the minimum artifact set we need to trust the result,
- stop criteria for weak data or poor pre-treatment fit, and
- the next action you recommend.

Keep the main donor pools comparable to the SCM-IR quickstart. For the Basque
case, exclude the Spain national aggregate in the main specification and leave
Madrid, Catalonia, and Navarre for sensitivity checks unless you explain why
they must be handled differently.

Save durable study notes in ScienceSwarm/gbrain if that capability is available
in this study. After the plan, wait for my approval before writing analysis
code.
```

Continue only after the assistant has explained the study design and proposed a
next action. If it starts writing code immediately, interrupt it and say:

```text
Pause. I want the research design and data plan reviewed before code exists.
Summarize the assumptions, risks, and proposed first code step, then wait.
```

## 2. Steer the conversation

The rest of the workflow should feel like a research collaboration. Use short
steering prompts when the assistant needs direction.

### Tighten the design

```text
Before writing code, critique this design. What would make synthetic control
invalid or weak for each case? Which assumptions are doing the most work?
```

### Scout data and tools

```text
Find plausible public data sources and R or Python libraries for this study.
Rank them by suitability. Separate must-have data from nice-to-have predictors.
Do not write code yet.
```

### Ask for a minimal runnable version

```text
Write the smallest runnable analysis for one case first. Use clear file names
under an analysis folder you propose. After it runs, inspect the outputs and
tell me whether the design still looks viable.
```

### Keep file organization from becoming messy

```text
Before creating more files, propose the artifact tree you will use for code,
data, outputs, figures, notes, and the final report. Keep paths simple and
study-scoped.
```

### Debug without changing the science silently

```text
The run failed. Diagnose the error, distinguish environment problems from
scientific design problems, and propose the smallest fix. Do not change donor
pools, outcomes, treatment years, or estimators without approval.
```

### Add robustness checks

```text
Now add robustness checks one family at a time. Start with method comparison,
then in-space placebos, then in-time placebo years, then leave-one-out donor
sensitivity. Stop if a check undermines the main interpretation.
```

### Calibrate the final claim

```text
Write the final interpretation as if it will be read by a skeptical methods
reviewer. Separate strong claims, weak claims, failed checks, and tutorial-only
shortcuts.
```

## 3. Natural milestones

You do not need to micromanage every file path. Watch for these milestones
instead:

1. Study design exists before code.
2. Data sources are named and suitability is justified.
3. A minimal one-case run works before expanding to all cases.
4. Prepared panels pass coverage, donor-count, and pre-period checks.
5. Classic Abadie synthetic control fits are gated on pre-treatment RMSPE.
6. Method comparison either supports the sign of the result or marks it
   fragile.
7. In-space and in-time placebo checks are reported, not hand-waved.
8. Leave-one-out donor sensitivity is inspected for donor-weight fragility.
9. The report explains failures and caveats instead of forcing a success.
10. Every final claim points back to a visible artifact.

If a panel has weak coverage, the right next step is to revise data choices or
donor rules, not to fit a model. If available methods disagree on sign or
interpretation, the tutorial should carry forward a fragile-result narrative
rather than a strong headline claim.

## 4. When to ask for exact paths

Exact paths become useful once the analysis has a shape. They are not the entry
fee for doing the research.

When the assistant is ready to organize the study, ask for a simple tree like:

```text
Use this study-scoped layout unless you see a concrete reason to change it:

analysis/scm-from-scratch/code/
analysis/scm-from-scratch/data/raw/
analysis/scm-from-scratch/data/prepared/
analysis/scm-from-scratch/output/tables/
analysis/scm-from-scratch/output/figures/
analysis/scm-from-scratch/output/fits/
analysis/scm-from-scratch/output/notes/
analysis/scm-from-scratch/output/scm-from-scratch-report.html
analysis/scm-from-scratch/output/run-log.md

Explain any deviation before creating files.
```

For parity with the existing SCM demo, useful generated files include:

- `analysis/scm-from-scratch/code/01_acquire_data.R`
- `analysis/scm-from-scratch/code/02_build_panels.R`
- `analysis/scm-from-scratch/code/03_fit_classic_scm.R`
- `analysis/scm-from-scratch/code/04_compare_methods.R`
- `analysis/scm-from-scratch/code/05_placebos_and_sensitivity.R`
- `analysis/scm-from-scratch/code/06_render_report.R`
- `analysis/scm-from-scratch/data/prepared/brexit.rds`
- `analysis/scm-from-scratch/data/prepared/russia.rds`
- `analysis/scm-from-scratch/data/prepared/basque.rds`
- `analysis/scm-from-scratch/output/tables/data-audit.csv`
- `analysis/scm-from-scratch/output/tables/classic-fit-summary.csv`
- `analysis/scm-from-scratch/output/scm-from-scratch-report.html`

The assistant may choose a different language or layout for a different
research problem. The durable requirement is not these exact paths; it is that
the study has visible code, data provenance, diagnostics, outputs, and a final
claim boundary.

## 5. Scientific gates to preserve

For this SCM example, ask the assistant to preserve these gates even if it
changes implementation details:

- Pull World Bank Development Indicators for the United Kingdom and Russia
  cases, and use a documented public source for the Basque Country case such as
  `Synth::basque`.
- Build balanced unit-time panels for classic SCM.
- Treat outcome coverage, donor count, and pre-period length as hard gates.
- Treat sparse auxiliary predictors such as schooling or human-capital proxies
  as optional drops that must be recorded in the data audit.
- Keep classic Abadie synthetic control as the primary estimator.
- Compare feasible modern variants such as generalized synthetic control,
  synthetic DiD when available, and an augmented or doubly robust approximation.
- Gate each classic fit on pre-treatment RMSPE relative to outcome variability.
  By default, pre-RMSPE divided by outcome standard deviation should be at most 0.25
  unless a stricter threshold was explicitly approved.
- Report in-space and in-time placebo checks, plus leave-one-out donor
  sensitivity where feasible.
- Label fast tutorial approximations clearly.

The inference note should not report only a single ATT. It should describe the
placebo distribution, closest placebo donors, timing falsification, donor
sensitivity, and limits of the tutorial-scale checks.

## 6. What counts as parity with the current SCM demo

The numbers may differ because this path authors code interactively and may
pull newer source data. Parity means the final artifacts have the same research
shape:

- the same three case studies,
- the same primary SCM estimator,
- comparable diagnostics for pre-treatment fit,
- donor-weight and trajectory outputs,
- placebo and sensitivity summaries,
- method robustness checks,
- a single study-visible report with interpretation and limitations.

If the newly generated analysis cannot support one of the quickstart-style
claims, the correct final output is a high-quality failed or caveated SCM report
with visible diagnostics, not a forced success.

## Appendix: what belongs in skills

Skills are useful after a workflow has repeated structure. They should encode
stable process, quality bars, stop conditions, and expected artifacts. They
should not be required before a scientist can ask a research question.

For example:

- A reusable research-design skill can ask whether the estimand, outcome,
  comparison set, and threats to validity are clear.
- A data-scouting skill can force source provenance, coverage checks, and
  license notes.
- A results-skeptic skill can challenge overclaiming, robustness failures, and
  missing falsification tests.
- A reproducibility-audit skill can verify that files exist, outputs open, and
  claims trace back to artifacts.

The prompt still carries the study-specific substance: the question, cases,
known constraints, preferred data, and current uncertainty.

## Appendix: optional skillized replay

ScienceSwarm includes SCM from-scratch skills for replaying this exact demo in a
more constrained way. Use them only after you understand the conversation-first
path, or when you want a guided regression test for the same workflow.

| Step | Command | Skill | Main asset |
|---|---|---|---|
| 1 | `/scm-scratch-question` | `scienceswarm-scm-scratch-question-design` | `scm_scratch_study_brief` |
| 2 | `/scm-scratch-data` | `scienceswarm-scm-scratch-data-authoring` | `scm_scratch_data_plan` |
| 3 | `/scm-scratch-fit` | `scienceswarm-scm-scratch-pretreatment-fit` | `scm_scratch_fit_note` |
| 4 | `/scm-scratch-methods` | `scienceswarm-scm-scratch-method-choice` | `scm_scratch_method_choice_note` |
| 5 | `/scm-scratch-inference` | `scienceswarm-scm-scratch-inference-placebos` | `scm_scratch_inference_note` |
| 6 | `/scm-scratch-report` | `scienceswarm-scm-scratch-results-report` | `scm_scratch_results_report` |

The skillized path is not the model for starting your own project. It is a
replay harness for a known tutorial shape.
