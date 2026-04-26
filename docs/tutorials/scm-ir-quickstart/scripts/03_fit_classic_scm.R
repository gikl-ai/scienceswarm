# Stage 3 — fit classic Abadie synthetic control for each case.
#
# Uses tidysynth, which exposes a chainable interface around the original
# Abadie/Diamond/Hainmueller solver. For each case:
#
#   1. Build the synth pipeline (treated + donors + predictors)
#   2. Generate the synthetic control via the constrained quadratic program
#   3. Run leave-one-out placebo permutation across donors
#   4. Compute pre-period RMSPE and post/pre RMSPE ratio
#   5. Compute the placebo p-value (share of donor placebos with ratio ≥ treated)
#
# Saves a per-case fit list with everything the renderer needs.
#
# Run:  Rscript 03_fit_classic_scm.R

suppressPackageStartupMessages({
  library(tidysynth)
  library(dplyr)
  library(tidyr)
  library(purrr)
  library(tibble)
})

args <- commandArgs(trailingOnly = FALSE); script_arg <- args[grep("^--file=", args)]; HERE <- if (length(script_arg) == 1L) normalizePath(dirname(sub("^--file=", "", script_arg[1]))) else getwd()
ROOT <- normalizePath(file.path(HERE, ".."))
PREP_DIR <- file.path(ROOT, "data", "prepared")
FIT_DIR <- file.path(ROOT, "output", "fits")
dir.create(FIT_DIR, recursive = TRUE, showWarnings = FALSE)

# Validation gate: pre-period RMSPE / outcome SD should be ≤ 0.25 for the
# fit to be interpretable as a counterfactual (Abadie 2021, JEL).
PRE_RMSPE_SD_RATIO_MAX <- 0.25

fit_one_case <- function(case) {
  message("\n--- Fitting classic SCM: ", case$display_name, " ---")
  panel <- case$panel
  outcome_sym <- as.name(case$outcome_var)

  # Build the synth pipeline. tidysynth's API: declare units → pre-treatment
  # predictors → outcome → solve.
  pipeline <- panel %>%
    synthetic_control(
      outcome = !!outcome_sym,
      unit = iso3c,
      time = year,
      i_unit = case$treated_unit,
      i_time = case$treatment_year,
      generate_placebos = TRUE
    )

  # Pre-treatment predictor averages over a window inside the pre-period.
  # We use the back half of the pre-period to capture the trajectory close
  # to treatment (a standard tidysynth convention).
  pre_lo <- case$pre_window[1]
  pre_hi <- case$pre_window[2]
  pred_window_lo <- floor(pre_lo + (pre_hi - pre_lo) / 2)

  for (pv in case$predictor_vars) {
    pv_sym <- as.name(pv)
    pipeline <- pipeline %>%
      generate_predictor(
        time_window = pred_window_lo:pre_hi,
        !!pv := mean(!!pv_sym, na.rm = TRUE)
      )
  }

  # Lagged outcome predictors at three pre-treatment snapshots — a
  # standard SCM ingredient that pulls the donor weights toward
  # economies that match the *trajectory* of the outcome, not just its
  # average.
  lag_years <- unique(c(
    pre_lo,
    floor((pre_lo + pre_hi) / 2),
    pre_hi
  ))
  for (ly in lag_years) {
    pipeline <- pipeline %>%
      generate_predictor(
        time_window = ly,
        !!paste0("lag_", ly) := mean(!!outcome_sym, na.rm = TRUE)
      )
  }

  # Solve.
  fit <- pipeline %>%
    generate_weights(
      optimization_window = pre_lo:pre_hi,
      margin_ipop = 0.02, sigf_ipop = 7, bound_ipop = 6
    ) %>%
    generate_control()

  # Extract trajectory: actual vs. synthetic for the treated unit.
  traj <- grab_synthetic_control(fit) %>%
    rename(year = time_unit,
           actual = real_y,
           synthetic = synth_y) %>%
    mutate(gap = actual - synthetic)

  # Donor weights.
  weights <- grab_unit_weights(fit) %>%
    rename(donor = unit, weight = weight) %>%
    arrange(desc(weight))

  # Predictor balance table.
  balance <- grab_balance_table(fit)

  # Placebo trajectories (one per donor as if it were treated).
  placebos <- grab_synthetic_control(fit, placebo = TRUE) %>%
    rename(year = time_unit,
           actual = real_y,
           synthetic = synth_y,
           unit = .placebo) %>%
    mutate(gap = actual - synthetic)

  # Significance: post/pre RMSPE ratio (Abadie/Diamond/Hainmueller 2010).
  signif_tbl <- grab_significance(fit) %>%
    rename(unit = unit_name) %>%
    arrange(desc(post_mspe / pre_mspe))

  treated_row <- signif_tbl %>% filter(type == "Treated")
  if (nrow(treated_row) != 1L) stop("Could not isolate treated row in significance table")

  # Pre-period RMSPE in original outcome units.
  pre_rmspe <- sqrt(treated_row$pre_mspe[1])
  ratio <- treated_row$post_mspe[1] / treated_row$pre_mspe[1]
  # Permutation p-value: share of donor placebos with ratio ≥ treated.
  donor_ratios <- signif_tbl %>%
    filter(type != "Treated") %>%
    mutate(ratio = post_mspe / pre_mspe) %>%
    pull(ratio)
  p_perm <- mean(c(ratio, donor_ratios) >= ratio)

  # Average post-treatment gap.
  post_gap <- traj %>%
    filter(year >= case$post_window[1], year <= case$post_window[2]) %>%
    pull(gap) %>%
    mean(na.rm = TRUE)

  outcome_sd <- sd(panel[[case$outcome_var]], na.rm = TRUE)

  summary_list <- list(
    unit_name = case$treated_unit_name,
    outcome = case$outcome_label,
    treatment_year = case$treatment_year,
    n_donors_with_weight = sum(weights$weight > 1e-3),
    pre_rmspe = pre_rmspe,
    pre_rmspe_over_sd = pre_rmspe / outcome_sd,
    post_pre_rmspe_ratio = ratio,
    effect_avg_post = post_gap,
    placebo_p_value = p_perm
  )

  list(
    case = case,
    trajectory = traj,
    placebos = placebos,
    weights = weights,
    balance = balance,
    significance = signif_tbl,
    summary = summary_list
  )
}

cases <- list(
  brexit  = readRDS(file.path(PREP_DIR, "brexit.rds")),
  russia  = readRDS(file.path(PREP_DIR, "russia.rds")),
  basque = readRDS(file.path(PREP_DIR, "basque.rds"))
)

fits <- map(cases, fit_one_case)

# Save and print summaries.
for (case_id in names(fits)) {
  path <- file.path(FIT_DIR, paste0("classic_", case_id, ".rds"))
  saveRDS(fits[[case_id]], path)
  s <- fits[[case_id]]$summary
  cat(sprintf(
    "\n[%s] %s\n  pre-RMSPE = %.2f (=%.2f × outcome SD)\n  post/pre RMSPE ratio = %.2f\n  avg post-treatment gap = %.2f\n  placebo p-value = %.3f\n",
    case_id, s$unit_name, s$pre_rmspe, s$pre_rmspe_over_sd,
    s$post_pre_rmspe_ratio, s$effect_avg_post, s$placebo_p_value
  ))
}

# --- Validation gates ---------------------------------------------------------
bad <- keep(fits, ~ .x$summary$pre_rmspe_over_sd > PRE_RMSPE_SD_RATIO_MAX)
if (length(bad) > 0L) {
  ids <- paste(names(bad), collapse = ", ")
  stop(sprintf(
    "Pre-period RMSPE / outcome-SD ratio exceeds %.2f for: %s. The synthetic control is not tracking the pre-period closely enough to be interpreted as a counterfactual. Widen the donor pool or revisit predictors in 02_prepare_panels.R.",
    PRE_RMSPE_SD_RATIO_MAX, ids
  ))
}
cat("\nOK: all classic SCM fits have pre-period RMSPE ≤",
    PRE_RMSPE_SD_RATIO_MAX, "× outcome SD\n")
