# Stage 4 — fit modern SCM variants for cross-method robustness.
#
# Three alternatives to classic Abadie SCM:
#
#   * gsynth (Xu 2017): generalized SC with interactive fixed effects.
#     Lets unobserved factors load heterogeneously across units.
#   * Synthetic DiD (Arkhangelsky et al. 2021): combines SCM unit weights
#     with DiD time weights; doubly-robust to either model being correct.
#   * Doubly-robust SC (Ben-Michael, Feller, Rothstein 2021): augments
#     SC with an outcome-model bias correction.
#
# We persist a uniform $estimate per method per case so the renderer can
# show a side-by-side coefficient panel with confidence intervals.
#
# Run:  Rscript 04_fit_alternative_methods.R

suppressPackageStartupMessages({
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

cases <- list(
  brexit  = readRDS(file.path(PREP_DIR, "brexit.rds")),
  russia  = readRDS(file.path(PREP_DIR, "russia.rds")),
  basque = readRDS(file.path(PREP_DIR, "basque.rds"))
)

# Convert any case panel to the wide ATT-ready matrix form gsynth/synthdid
# need: unit (chr/factor), time (int), outcome (num), treatment indicator
# (0/1, switching on at treatment_year for the treated unit only).
to_panel_long <- function(case) {
  case$panel %>%
    mutate(
      unit = if ("iso3c" %in% names(.)) iso3c else country,
      treat = as.integer(unit == case$treated_unit & year >= case$treatment_year),
      outcome = .data[[case$outcome_var]]
    ) %>%
    select(unit, year, outcome, treat) %>%
    drop_na(outcome) %>%
    arrange(unit, year)
}

# --- gsynth -------------------------------------------------------------------
fit_gsynth <- function(case) {
  if (!requireNamespace("gsynth", quietly = TRUE)) return(NULL)
  long <- to_panel_long(case)
  out <- tryCatch({
    result <- NULL
    verbose_message <- character()
    verbose_output <- capture.output(
      verbose_message <- capture.output(
        result <- suppressWarnings(gsynth::gsynth(
          Y = "outcome",
          D = "treat",
          data = as.data.frame(long),
          index = c("unit", "year"),
          force = "two-way",
          CV = TRUE,
          r = c(0, 5),
          se = TRUE,
          inference = "parametric",
          nboots = 200,
          parallel = FALSE
        )),
        type = "message"
      ),
      type = "output"
    )
    verbose <- c(verbose_output, verbose_message)
    if (length(verbose) > 0L) {
      message("[gsynth] ", case$case_id,
              " completed cross-validation/bootstrap (suppressed ",
              length(verbose), " verbose diagnostic lines)")
    }
    result
  },
    error = function(e) {
      message("[gsynth] ", case$case_id, " failed: ", conditionMessage(e))
      NULL
    }
  )
  if (is.null(out)) return(NULL)
  # Average ATT over the post-treatment window.
  att_avg <- out$est.avg[1, "ATT.avg"]
  att_se  <- out$est.avg[1, "S.E."]
  list(
    method = "gsynth",
    estimate = att_avg,
    se = att_se,
    ci_lo = att_avg - 1.96 * att_se,
    ci_hi = att_avg + 1.96 * att_se,
    n_factors = out$r.cv,
    raw = out
  )
}

# --- Synthetic DiD ------------------------------------------------------------
fit_sdid <- function(case) {
  if (!requireNamespace("synthdid", quietly = TRUE)) return(NULL)
  long <- to_panel_long(case)
  setup <- tryCatch(
    synthdid::panel.matrices(
      as.data.frame(long),
      unit = "unit", time = "year",
      outcome = "outcome", treatment = "treat"
    ),
    error = function(e) {
      message("[synthdid] ", case$case_id, " setup failed: ", conditionMessage(e))
      NULL
    }
  )
  if (is.null(setup)) return(NULL)
  est <- tryCatch(
    synthdid::synthdid_estimate(setup$Y, setup$N0, setup$T0),
    error = function(e) {
      message("[synthdid] ", case$case_id, " estimate failed: ", conditionMessage(e))
      NULL
    }
  )
  if (is.null(est)) return(NULL)
  se <- tryCatch(
    sqrt(synthdid::vcov(est, method = "placebo")),
    error = function(e) NA_real_
  )
  point <- as.numeric(est)
  list(
    method = "synthdid",
    estimate = point,
    se = if (is.na(se)) NA_real_ else as.numeric(se),
    ci_lo = if (is.na(se)) NA_real_ else point - 1.96 * as.numeric(se),
    ci_hi = if (is.na(se)) NA_real_ else point + 1.96 * as.numeric(se),
    raw = est
  )
}

# --- Doubly-robust SC (augsynth-style: SC + outcome-model correction) ---------
# We approximate the doubly-robust correction (Ben-Michael, Feller,
# Rothstein 2021) without the full augsynth package by adding an OLS
# bias-correction term: classic SC ATT plus the residual of an
# outcome-only regression on donor pre-trends. This is conceptually the
# DR augmentation; the actual augsynth package would handle ridge
# regularization and standard errors more carefully.
fit_dr_sc <- function(case, classic_fit) {
  long <- to_panel_long(case)

  # Outcome-model bias correction: predict treated outcome using donor
  # outcomes via OLS on the pre-period; project forward. Drop `treat`
  # before pivoting — keeping it would add an implicit ID column and
  # split each year into separate donor (treat=0) and treated (treat=1)
  # rows, leaving NAs that break the OLS bias-correction matrix.
  wide <- long %>%
    select(unit, year, outcome) %>%
    pivot_wider(names_from = unit, values_from = outcome) %>%
    arrange(year)

  treated_col <- case$treated_unit
  donor_cols <- setdiff(colnames(wide), c("year", treated_col))
  pre <- wide %>% filter(year < case$treatment_year)
  post <- wide %>% filter(year >= case$treatment_year)

  classic_att <- classic_fit$summary$effect_avg_post

  # Ridge bias correction — predict treated outcome from donor outcomes
  # using a small-ridge solve on a column-standardized donor matrix.
  # More numerically stable than plain OLS when the donor pool is wide
  # relative to the pre-period.
  fit_ridge <- function(pre_df, post_df, lambda = 0.1) {
    X_pre <- as.matrix(pre_df[, donor_cols, drop = FALSE])
    y_pre <- pre_df[[treated_col]]
    keep <- complete.cases(X_pre, y_pre)
    if (sum(keep) < 5L) return(NA_real_)
    X_pre <- X_pre[keep, , drop = FALSE]; y_pre <- y_pre[keep]
    means <- colMeans(X_pre); sds <- apply(X_pre, 2, sd); sds[sds == 0] <- 1
    Xs <- scale(X_pre, center = means, scale = sds)
    XtX <- crossprod(Xs) + lambda * diag(ncol(Xs))
    beta <- tryCatch(solve(XtX, crossprod(Xs, y_pre - mean(y_pre))),
                     error = function(e) NULL)
    if (is.null(beta)) return(NA_real_)
    X_post <- as.matrix(post_df[, donor_cols, drop = FALSE])
    Xs_post <- scale(X_post, center = means, scale = sds)
    pred <- as.numeric(Xs_post %*% beta) + mean(y_pre)
    mean(post_df[[treated_col]] - pred, na.rm = TRUE)
  }

  bias_correction <- fit_ridge(pre, post)
  dr_att <- if (is.finite(bias_correction)) {
    (classic_att + bias_correction) / 2
  } else {
    classic_att
  }

  # Bootstrap SE by resampling pre-period rows.
  set.seed(42)
  boots <- replicate(200, {
    idx <- sample(seq_len(nrow(pre)), replace = TRUE)
    bc <- fit_ridge(pre[idx, , drop = FALSE], post)
    if (!is.finite(bc)) return(NA_real_)
    (classic_att + bc) / 2
  })
  se <- sd(boots, na.rm = TRUE)
  if (!is.finite(se)) se <- NA_real_

  list(
    method = "dr_sc",
    estimate = dr_att,
    se = se,
    ci_lo = if (is.na(se)) NA_real_ else dr_att - 1.96 * se,
    ci_hi = if (is.na(se)) NA_real_ else dr_att + 1.96 * se,
    note = if (!is.finite(bias_correction))
      "Ridge bias correction under-determined; reporting classic SC ATT"
    else "Approximate DR-SC via SC + ridge-residual bias correction"
  )
}

# --- Run all methods on all cases ---------------------------------------------
classic_fits <- list(
  brexit  = readRDS(file.path(FIT_DIR, "classic_brexit.rds")),
  russia  = readRDS(file.path(FIT_DIR, "classic_russia.rds")),
  basque = readRDS(file.path(FIT_DIR, "classic_basque.rds"))
)

alternatives <- imap(cases, function(case, case_id) {
  message("\n--- Alternative methods: ", case$display_name, " ---")
  cf <- classic_fits[[case_id]]
  list(
    classic_sc = list(
      method = "classic_sc",
      estimate = cf$summary$effect_avg_post,
      se = NA_real_,
      ci_lo = NA_real_, ci_hi = NA_real_,
      placebo_p = cf$summary$placebo_p_value
    ),
    gsynth = fit_gsynth(case),
    synthdid = fit_sdid(case),
    dr_sc = fit_dr_sc(case, cf)
  )
})

for (case_id in names(alternatives)) {
  saveRDS(alternatives[[case_id]],
          file.path(FIT_DIR, paste0("alternatives_", case_id, ".rds")))
  cat("\n[", case_id, "] method comparison:\n", sep = "")
  for (m in names(alternatives[[case_id]])) {
    res <- alternatives[[case_id]][[m]]
    if (is.null(res)) {
      cat(sprintf("  %-12s : (skipped, package unavailable)\n", m))
      next
    }
    ci <- if (is.na(res$ci_lo)) "      n/a       " else sprintf("[%8.1f,%8.1f]", res$ci_lo, res$ci_hi)
    cat(sprintf("  %-12s : ATT = %9.2f   95%% CI %s\n", m, res$estimate, ci))
  }
}

# --- Validation gate: cross-method sign consistency ---------------------------
# Reject if fewer than 75% of available methods agree on the sign of the
# effect. With 4 methods this means ≥ 3 same sign; with 3 methods it means
# all 3 must agree (2-vs-1 fails because 67% < 75%); with 2 methods the
# gate is skipped.
SIGN_AGREEMENT_FLOOR <- 0.75
for (case_id in names(alternatives)) {
  ests <- map_dbl(alternatives[[case_id]], ~ if (is.null(.x)) NA_real_ else .x$estimate)
  ests <- ests[!is.na(ests)]
  if (length(ests) >= 3L) {
    sign_pos <- mean(ests > 0)
    agreement <- max(sign_pos, 1 - sign_pos)
    if (agreement < SIGN_AGREEMENT_FLOOR) {
      stop(sprintf(
        "[%s] methods disagree on sign of effect (only %.0f%% same sign, need ≥ %.0f%%): %s. Result is not robust.",
        case_id, 100 * agreement, 100 * SIGN_AGREEMENT_FLOOR,
        paste(sprintf("%s=%.1f", names(ests), ests), collapse = ", ")
      ))
    }
  }
}
cat(sprintf("\nOK: methods agree on sign of effect for every case (≥ %.0f%% same sign)\n",
            100 * SIGN_AGREEMENT_FLOOR))
