# SCM-IR quickstart - synthetic control for international relations shocks

An end-to-end synthetic control method (SCM) pipeline for three canonical
international-relations and political-economy shocks:

- **Brexit (2016)**
- **Russia's 2022 sanctions**
- **Basque Country / ETA terrorism (1975)**

ScienceSwarm drives the workflow from the study UI with Claude Code. You
should not need to open a terminal or type Linux commands. The R scripts in
this folder are the deterministic execution contract that the assistant runs
for you: pull real World Bank panels, load the bundled Abadie & Gardeazabal
Basque dataset, fit classic SCM plus modern variants, run placebo inference,
and render an interactive HTML report.

This tutorial exists to:

- show that a non-expert can produce a publication-grade synthetic control
  scaffold from the ScienceSwarm UI,
- expose the validation gates that distinguish an interpretable SCM result
  from a fit that merely ran, and
- provide the concrete example used by the
  [ScienceSwarm SCM pipeline walkthrough](../scm-pipeline-walkthrough.md).

It is **not** a research result. The cases are canonical so the tutorial can
focus on method and workflow rather than novelty.

Note: the third case uses Basque Country / ETA terrorism from Abadie &
Gardeazabal (2003, *AER*), the original synthetic control paper. Recent CRAN
versions of `Synth` no longer ship the German reunification dataset that older
SCM tutorials used.

Typical wall time is **8-12 min on a laptop** after R is available. The first
run can take longer because CRAN packages are installed into a managed
ScienceSwarm runtime library.

---

## What ScienceSwarm Runs

| Stage | Script | Wall time | Output |
|---|---|---|---|
| 0. Prepare R dependencies | `setup.R` | ~5 min first run | managed R library under `$SCIENCESWARM_DIR/runtimes/` |
| 1. Fetch panel data | `01_fetch_data.R` | ~30 s, cached | `data/raw/{wdi_panel,basque_bundled}.rds` |
| 2. Prepare case panels | `02_prepare_panels.R` | < 5 s | `data/prepared/{brexit,russia,basque}.rds` |
| 3. Classic SCM + placebo permutation | `03_fit_classic_scm.R` | ~30 s | `output/fits/classic_{brexit,russia,basque}.rds` |
| 4. Method comparison | `04_fit_alternative_methods.R` | ~60 s | `output/fits/alternatives_*.rds` |
| 5. Summarize placebo inference | `05_summarize_inference.R` | < 5 s | `output/inference_summary.{json,md}` |
| 6. Render interactive HTML report | `06_render_html.R` | ~10 s | `output/scm-ir-report.html` |

The deliverable is `output/scm-ir-report.html` plus a sibling `output/lib/`
folder of locally embedded Plotly assets. Keep those pieces together when
sharing or importing the report.

The report includes:

- animated counterfactual trajectories,
- hover-readable donor-weight charts,
- placebo distributions with treated units highlighted,
- in-time treatment-year falsification charts,
- method-comparison forest plots,
- a methodology explainer modal, and
- auto-generated Methods paragraphs ready to adapt for a paper or memo.

---

## Requirements

- ScienceSwarm with study chat enabled
- Claude Code available as an assistant destination
- R 4.2 or newer available locally, or permission for the execution assistant
  to help install a local R runtime
- Internet access for one-time CRAN installs and World Bank API pulls
- About 250 MB free for outputs and R packages

No API keys, cluster, or GPU are required.

ScienceSwarm's platform convention is:

- persistent tools and language runtimes live under
  `$SCIENCESWARM_DIR/runtimes/` (default `~/.scienceswarm/runtimes/`),
- this tutorial's R packages are installed by `setup.R` into
  `$SCIENCESWARM_DIR/runtimes/r/R-<major.minor>/<platform>/library/`, and
- generated tutorial outputs stay inside the imported study tutorial folder
  so the assistant can import, summarize, and save them as study artifacts.

Do not install CRAN packages into the app checkout or commit generated outputs
to the repository.

---

## 0. Create the Study

1. Start ScienceSwarm and complete setup if the app asks.
2. Open the dashboard and create a study. A name like
   `SCM IR quickstart` is fine.
3. Open the study. You should see the study chat composer at the bottom of
   the page.
4. Import this checkout, or just `docs/tutorials/scm-ir-quickstart/`, into the
   study so Claude Code can see `setup.R` and `scripts/`.
5. In the study chat composer, open the assistant selector and choose
   `Claude Code`.
6. If ScienceSwarm shows a send-review sheet for Claude Code, confirm the
   destination is `Claude Code`, the study is the SCM project, and the
   included data is the prompt plus study context.

Use Claude Code for the steps below.

---

## 1. Prepare the Runtime

Paste this into the study chat:

```text
Prepare the SCM-IR quickstart for execution.

If the full ScienceSwarm checkout is imported, use
docs/tutorials/scm-ir-quickstart/. If only this tutorial folder is imported,
use the current study folder.

Use setup.R as the dependency contract. First check whether Rscript is
available and report the R version. Then run setup.R from the tutorial root.
Do not install R packages into the repository or the imported study folder.
Use the ScienceSwarm-managed R library under
$SCIENCESWARM_DIR/runtimes/r/R-<major.minor>/<platform>/library/ unless the
project explicitly sets a different runtime path.

When setup finishes, verify that tidysynth, Synth, gsynth, plotly,
htmlwidgets, htmltools, dplyr, tidyr, purrr, readr, tibble, ggplot2, scales,
and jsonlite load. synthdid is optional; report whether it is available.
Stop with a clear recovery note if R itself is missing.
```

Continue only after Claude Code reports the R version, the managed library
path, and whether `synthdid` is available.

---

## 2. Run the Pipeline

Paste:

```text
Run the SCM-IR quickstart end to end using this ScienceSwarm project
workspace.

Use the tutorial root prepared in the previous step. Run the stages in order:
setup.R, scripts/01_fetch_data.R, scripts/02_prepare_panels.R,
scripts/03_fit_classic_scm.R, scripts/04_fit_alternative_methods.R, and
scripts/05_summarize_inference.R, then scripts/06_render_html.R.

Stop immediately if any validation gate fails. Keep generated files inside the
tutorial folder. When finished, summarize the classic SCM fit diagnostics, the
method-comparison sign-consistency gate, the placebo p-values, and the final
HTML report path. Do not make the user run shell commands to view or manage
artifacts; reference the ScienceSwarm study artifact path instead. Save a
durable study-scoped SCM Run Log with gbrain_capture before answering.
```

If the run succeeds, Claude Code should list:

| Artifact | Meaning |
|---|---|
| `data/raw/wdi_panel.rds` | cached World Bank indicators |
| `data/raw/basque_bundled.rds` | bundled Basque dataset from `Synth` |
| `data/prepared/{brexit,russia,basque}.rds` | validated case panels |
| `output/fits/classic_*.rds` | classic SCM fits and placebo ratios |
| `output/fits/alternatives_*.rds` | gsynth, synthetic DiD when available, and DR-SC comparisons |
| `output/inference_summary.{json,md}` | compact placebo-inference summary for the assistant to cite |
| `output/scm-ir-report.html` | interactive report |
| `output/lib/` | local Plotly/htmlwidget assets required by the report |

---

## What "Good" Looks Like

Each stage has a validation gate. A failed gate means the assistant should stop
and explain what needs to change; it should not continue to a polished report.

| Script | Validation gate |
|---|---|
| `01_fetch_data.R` | requested country-year cells are present; no silent empty panels |
| `02_prepare_panels.R` | each case has at least 10 pre-treatment years and 15 donor candidates |
| `03_fit_classic_scm.R` | pre-period RMSPE / outcome SD is at most 0.25 |
| `04_fit_alternative_methods.R` | at least 75% of available methods agree on ATT sign |
| `05_summarize_inference.R` | compact JSON and Markdown inference summaries are written without raw console tables |
| `06_render_html.R` | HTML plus sibling `lib/` assets total at least 1 MB and required report markers are present |

The 0.25 RMSPE / outcome-SD ratio follows the practical guidance in Abadie
(2021, *JEL*) and Abadie/Diamond/Hainmueller (2010). If the pre-period fit is
materially worse than the outcome's own variability, the counterfactual is not
interpretable no matter how large the post-period gap looks.

The cross-method sign-consistency gate guards against single-method artifacts.
If classic SCM, gsynth, synthetic DiD, and DR-SC disagree on the direction of
the effect, the tutorial should report fragility rather than a headline claim.

---

## Reading the Output

A typical `output/fits/classic_brexit.rds` summary contains:

```r
fit <- readRDS("output/fits/classic_brexit.rds")
str(fit$summary, max.level = 1)
```

Expected fields include:

- `unit_name`
- `outcome`
- `treatment_year`
- `pre_rmspe`
- `pre_rmspe_over_sd`
- `post_pre_rmspe_ratio`
- `effect_avg_post`
- `placebo_p_value`

`post_pre_rmspe_ratio > 2` is often treated as evidence of a treatment signal
in classic SCM applications. The placebo p-value is the share of donor placebo
units whose post/pre RMSPE ratio is at least as large as the treated unit's
ratio.

---

## Common Failures

| Symptom | Likely cause | What ScienceSwarm should do |
|---|---|---|
| `Rscript` is missing | R is not installed or not on PATH | Ask for permission to install or point to a local R runtime; do not continue |
| CRAN package install fails | network issue, compiler issue, or stale lockfile | Preserve the managed library path and report the exact package/log |
| World Bank fetch returns 0 rows | World Bank API throttled or offline | Re-run once; cache is used after first success |
| pre-period RMSPE gate fails | donor pool too narrow or predictors poor | stop and revisit donor/predictor choices |
| methods disagree on sign | fragile or small effect relative to noise | report fragility; do not claim a robust effect |
| HTML opens with blank charts | `output/lib/` is missing or moved away from the HTML | re-run rendering and keep `scm-ir-report.html` next to `output/lib/` |

---

## Done Checklist

You are done when the study has:

- a saved SCM Run Log in gbrain,
- `data/prepared/brexit.rds`,
- `data/prepared/russia.rds`,
- `data/prepared/basque.rds`,
- `output/fits/classic_brexit.rds`,
- `output/fits/classic_russia.rds`,
- `output/fits/classic_basque.rds`,
- `output/fits/alternatives_brexit.rds`,
- `output/fits/alternatives_russia.rds`,
- `output/fits/alternatives_basque.rds`,
- `output/scm-ir-report.html`, and
- `output/lib/` next to the report.

For the fuller skill-by-skill research workflow, continue with
[ScienceSwarm SCM pipeline walkthrough](../scm-pipeline-walkthrough.md).

---

## What This Tutorial Does Not Cover

- **Time-varying treatment effects with staggered adoption.** Use
  Callaway-Sant'Anna or Sun-Abraham style staggered DiD instead.
- **Bayesian synthetic control.** Compatible with the scaffold, but not wired
  into this quickstart.
- **Causal forests / heterogeneous treatment effects.** Different question,
  different tool.

---

## Citing This Tutorial

If you use this scaffold in published or shared work, cite the methods papers:

- **Classic SCM:** Abadie, Diamond, Hainmueller (2010, *JASA*); Abadie (2021,
  *JEL*).
- **Generalized SCM:** Xu (2017, *Political Analysis*).
- **Synthetic DiD:** Arkhangelsky, Athey, Hirshberg, Imbens, Wager (2021,
  *AER*).
- **Doubly-robust SC:** Ben-Michael, Feller, Rothstein (2021, *JASA*).
- **Brexit reference:** Born, Müller, Schularick, Sedláček (2019,
  *Economic Journal*).
- **Basque case reference:** Abadie & Gardeazabal (2003, *AER*).

The tutorial code itself is MIT-licensed with the rest of ScienceSwarm.
