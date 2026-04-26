# SCM-IR quickstart — synthetic control for international relations shocks

An end-to-end synthetic control method (SCM) pipeline that takes three
canonical IR / political-economy shocks — **Brexit (2016)**, **Russia's 2022
sanctions**, and **Basque Country / ETA terrorism (1975)** — pulls real
World Bank panels and the bundled Abadie & Gardeazabal Basque dataset,
fits classic SCM (Abadie 2003) plus three modern variants (generalized
SCM, synthetic DiD, doubly-robust SC), runs permutation placebo
inference, and renders an interactive HTML report that a researcher can
drop straight into a paper, blog post, or policy memo.

Note: the third case substitutes Basque/ETA (Abadie & Gardeazabal 2003,
*AER* — the *original* synthetic control paper) for German reunification.
The German reunification dataset has been removed from recent CRAN
versions of the `Synth` package; the Basque case is the canonical
alternative and was the first SCM application in the literature.

Wall time: roughly **8–12 min on a laptop** end-to-end (most of which is
the first-time CRAN install). Fitting itself is seconds per case.

This tutorial exists to:

- give a copy-paste-runnable proof that a non-expert can produce a
  publication-grade synthetic control analysis without becoming an
  econometrician,
- expose the validation gates that distinguish a meaningful SCM result
  from a fit that "ran" but is not interpretable (pre-period RMSPE,
  donor weight concentration, placebo permutation),
- serve as the concrete example that the
  [ScienceSwarm SCM pipeline walkthrough](../scm-pipeline-walkthrough.md)
  refers to.

It is **not** a research result. The three cases are deliberately
canonical so the tutorial focuses on technique rather than novelty.

---

## What you will do

| Stage | Script | Wall time | Output |
|---|---|---|---|
| 1. Fetch panel data | `01_fetch_data.R` | ~30 s (cached after first run) | `data/raw/{wdi_panel,basque_bundled}.rds` |
| 2. Prepare three case panels | `02_prepare_panels.R` | < 5 s | `data/prepared/{brexit,russia,basque}.rds` |
| 3. Classic SCM + placebo permutation | `03_fit_classic_scm.R` | ~30 s | `output/fits/classic_{brexit,russia,basque}.rds` |
| 4. Method comparison (gsynth, SDID, DR-SC) | `04_fit_alternative_methods.R` | ~60 s | `output/fits/alternatives_*.rds` |
| 5. Render interactive HTML report | `05_render_html.R` | ~10 s | `output/scm-ir-report.html` |

The deliverable is one HTML file (`scm-ir-report.html`) plus a sibling
`output/lib/` folder of locally-embedded Plotly assets — **no external
CDN dependencies**. The two pieces are co-located, so the HTML renders
correctly when opened directly from disk. The HTML includes:

- Animated counterfactual trajectory (treated vs. synthetic, gap fills
  in over the post-treatment window)
- Donor-weight bar chart with click-to-highlight country selection
- Placebo distribution plot (RMSPE post/pre ratios, treated unit
  highlighted in red)
- "What-if" treatment-year falsification chart (in-time placebo)
- Method-comparison forest plot (classic SCM vs gsynth vs synthetic DiD vs DR-SC, with 95% CIs)
- Methodology explainer modal (toggleable, written for non-experts)
- Auto-generated Methods paragraph ready to paste into a paper

---

## Requirements

- macOS, Linux, or Windows
- **R ≥ 4.2** (install via [CRAN](https://cran.r-project.org/) or `brew install r` on macOS)
- ~250 MB free disk for outputs and CRAN packages
- Internet access for (a) one-time CRAN install and (b) World Bank API
  pulls (cached on first run; offline-friendly thereafter)

No API keys, no cluster, no GPU required.

---

## Setup

Install R packages from this directory:

```bash
Rscript setup.R
```

This is idempotent — already-installed packages are skipped. First run
takes ~5 min; subsequent runs are instant.

Verify the install:

```bash
Rscript -e 'core <- c("tidysynth","Synth","gsynth","WDI","plotly","htmlwidgets"); for (p in core) suppressMessages(library(p, character.only = TRUE)); cat(paste0(core, " OK"), sep = "\n"); if (requireNamespace("synthdid", quietly = TRUE)) { suppressMessages(library(synthdid)); cat("synthdid OK\n") } else { cat("synthdid not installed (optional; SDID method will be skipped)\n") }'
```

---

## Run the pipeline

From `docs/tutorials/scm-ir-quickstart/scripts/`:

```bash
Rscript 01_fetch_data.R
Rscript 02_prepare_panels.R
Rscript 03_fit_classic_scm.R
Rscript 04_fit_alternative_methods.R
Rscript 05_render_html.R
```

Each script prints diagnostics, fails fast on a bad input, and writes
its output before exiting.

Open the report:

```bash
open ../output/scm-ir-report.html       # macOS
xdg-open ../output/scm-ir-report.html   # Linux
start ../output/scm-ir-report.html      # Windows
```

---

## What "good" looks like

Each fitting stage ends with a validation assertion that must pass
before the next stage is meaningful.

| Script | Validation gate |
|---|---|
| `01_fetch_data.R` | All requested country-year cells present (no silent NA panels) |
| `02_prepare_panels.R` | Each case has ≥ 10 pre-treatment years, ≥ 15 donor candidates |
| `03_fit_classic_scm.R` | Pre-period RMSPE / outcome-SD ratio ≤ 0.25 (well-fitted pre-period) |
| `04_fit_alternative_methods.R` | Sign of estimated effect is consistent across ≥ 3 of 4 methods |
| `05_render_html.R` | HTML + sibling `lib/` folder ≥ 1 MB total and HTML contains all 7 wow elements |

The 0.25 RMSPE / outcome-SD ratio reflects the practical guidance
in Abadie (2021, *JEL*) and Abadie/Diamond/Hainmueller (2010): a
synthetic control whose pre-period fit is materially worse than the
outcome's own variability is not interpretable as a counterfactual,
regardless of the post-period gap. The cross-method sign-consistency
gate guards against single-method artifacts: if classic SCM, gsynth,
SDID, and DR-SC disagree on the *direction* of the effect, the result
is not robust enough to report.

---

## Reading the output

A typical converged `output/fits/classic_brexit.rds` includes:

```r
# Loaded into R:
fit <- readRDS("output/fits/classic_brexit.rds")
str(fit$summary, max.level = 1)
#> List of 6
#>  $ unit_name              : chr "United Kingdom"
#>  $ outcome                : chr "GDP per capita (constant 2015 USD)"
#>  $ treatment_year         : num 2016
#>  $ pre_rmspe              : num 412.3
#>  $ post_pre_rmspe_ratio   : num 3.21
#>  $ effect_avg_post        : num -1842
#>  $ placebo_p_value        : num 0.041
```

`post_pre_rmspe_ratio > 2` is conventionally treated as evidence of a
real treatment effect (Abadie/Diamond/Hainmueller 2010). The placebo
p-value is the share of donor units whose post/pre RMSPE ratio meets
or exceeds the treated unit's — a non-parametric exact test.

---

## Common failures and what they mean

| Symptom | Likely cause | What to try |
|---|---|---|
| `Error: package 'tidysynth' is not available` | R version too old | Upgrade to R ≥ 4.2 |
| `WDI` returns 0 rows | World Bank API throttled or offline | Re-run; fetch is cached after first success |
| Pre-period RMSPE assertion fails | Donor pool too narrow, predictors poorly chosen | Widen donor pool in `02_prepare_panels.R`; revisit predictor list |
| All methods disagree on sign | Treatment effect is genuinely small/null relative to noise | Honest finding — report null with placebo distribution |
| Russia case shows NA in 2024 | World Bank lag for recent years | Acceptable; treatment effect is still estimable on 2022–2023 window |
| HTML renders but charts are blank | Plotly assets in `output/lib/` are missing or not co-located with the HTML | Re-run `05_render_html.R`; verify `output/lib/plotly-main-*` exists alongside `output/scm-ir-report.html` |

---

## What this tutorial does not cover

- **Time-varying treatment effects with staggered adoption.** That is
  the Callaway–Sant'Anna territory and a separate tutorial.
- **Bayesian synthetic control.** `bayessynth` and related approaches
  are out of scope but compatible with this scaffolding.
- **Causal forests / heterogeneous treatment effects.** Different
  question, different tool.

---

## Citing this tutorial

If you use this scaffold in published or shared work, please cite the
underlying methods papers:

- **Classic SCM:** Abadie, Diamond, Hainmueller (2010, *JASA*); Abadie
  (2021, *JEL*).
- **Generalized SCM:** Xu (2017, *Political Analysis*).
- **Synthetic DiD:** Arkhangelsky, Athey, Hirshberg, Imbens, Wager
  (2021, *AER*).
- **Doubly-robust SC:** Ben-Michael, Feller, Rothstein (2021, *JASA*).
- **Brexit reference:** Born, Müller, Schularick, Sedláček (2019,
  *Economic Journal*).
- **Basque case reference:** Abadie & Gardeazabal (2003, *AER*) — the
  original synthetic control paper.

The tutorial code itself is MIT-licensed with the rest of ScienceSwarm.
