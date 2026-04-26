# Stage 5 - summarize placebo inference diagnostics for the UI walkthrough.
#
# Reads the classic SCM fit objects and writes compact, assistant-readable
# artifacts. The chat UI should cite these files instead of pasting raw R
# tibbles into the conversation.
#
# Run:  Rscript 05_summarize_inference.R

suppressPackageStartupMessages({
  library(dplyr)
  library(jsonlite)
  library(purrr)
})

args <- commandArgs(trailingOnly = FALSE)
script_arg <- args[grep("^--file=", args)]
HERE <- if (length(script_arg) == 1L) {
  normalizePath(dirname(sub("^--file=", "", script_arg[1])))
} else {
  getwd()
}
ROOT <- normalizePath(file.path(HERE, ".."))
FIT_DIR <- file.path(ROOT, "output", "fits")
OUT_DIR <- file.path(ROOT, "output")
JSON_PATH <- file.path(OUT_DIR, "inference_summary.json")
MD_PATH <- file.path(OUT_DIR, "inference_summary.md")

required <- file.path(FIT_DIR, paste0("classic_", c("brexit", "russia", "basque"), ".rds"))
missing <- required[!file.exists(required)]
if (length(missing) > 0L) {
  stop(
    "Missing classic fit files. Run scripts/03_fit_classic_scm.R first: ",
    paste(missing, collapse = ", ")
  )
}

dir.create(OUT_DIR, recursive = TRUE, showWarnings = FALSE)

fit_paths <- setNames(required, c("brexit", "russia", "basque"))
fits <- map(fit_paths, readRDS)

fmt_num <- function(x, digits = 2L) {
  ifelse(is.na(x), "n/a", format(round(x, digits), nsmall = digits, trim = TRUE))
}

top_placebos <- function(fit, n = 5L) {
  fit$significance %>%
    filter(type != "Treated") %>%
    mutate(ratio = ifelse(!is.finite(pre_mspe) | pre_mspe <= 0, NA_real_, post_mspe / pre_mspe)) %>%
    arrange(desc(ratio)) %>%
    head(n) %>%
    transmute(
      unit = unit,
      ratio = round(ratio, 3),
      pre_mspe = round(pre_mspe, 3),
      post_mspe = round(post_mspe, 3)
    )
}

interpret_case <- function(case_id, fit) {
  ratio <- fit$summary$post_pre_rmspe_ratio
  p_value <- fit$summary$placebo_p_value
  metric_phrase <- sprintf(" (ratio %.2f, placebo p-value %.3f)", ratio, p_value)
  if (case_id == "brexit") {
    return(paste0("Treated ratio is well into the placebo right tail; supports a detectable post-2016 deviation, with top-donor sensitivity still worth checking.", metric_phrase))
  }
  if (case_id == "russia") {
    return(paste0("Treated ratio is inside the donor placebo cloud; do not interpret the two-year post-window as a sanctions effect.", metric_phrase))
  }
  if (case_id == "basque") {
    return(paste0("Large treated gap, but several small-region placebos have larger ratios because their pre-MSPE is tiny; present the trajectory and rank plot, not the p-value alone.", metric_phrase))
  }
  sprintf("Post/pre ratio %.2f and placebo p-value %.3f.", ratio, p_value)
}

summary_rows <- imap(fits, function(fit, case_id) {
  s <- fit$summary
  placebos <- top_placebos(fit)
  list(
    case_id = case_id,
    display_name = fit$case$display_name,
    treated_unit = s$unit_name,
    treatment_year = s$treatment_year,
    post_pre_rmspe_ratio = round(s$post_pre_rmspe_ratio, 3),
    placebo_p_value = round(s$placebo_p_value, 3),
    average_post_treatment_gap = round(s$effect_avg_post, 3),
    closest_donor_placebos = placebos,
    interpretation = interpret_case(case_id, fit)
  )
})

jsonlite::write_json(
  summary_rows,
  JSON_PATH,
  pretty = TRUE,
  auto_unbox = TRUE,
  null = "null"
)

table_rows <- imap_chr(summary_rows, function(row, case_id) {
  donors <- paste(
    sprintf("%s %.2f", row$closest_donor_placebos$unit, row$closest_donor_placebos$ratio),
    collapse = "; "
  )
  paste(
    "|",
    row$display_name,
    "|",
    row$treated_unit,
    "|",
    row$treatment_year,
    "|",
    fmt_num(row$post_pre_rmspe_ratio),
    "|",
    fmt_num(row$placebo_p_value, 3L),
    "|",
    donors,
    "|"
  )
})

md <- c(
  "# SCM inference summary",
  "",
  "Generated from `output/fits/classic_{brexit,russia,basque}.rds`.",
  "",
  "| Case | Treated unit | T0 | post/pre RMSPE | placebo p-value | closest donor placebos |",
  "|---|---:|---:|---:|---:|---|",
  table_rows,
  "",
  "## Interpretation",
  "",
  imap_chr(summary_rows, function(row, case_id) {
    paste0("- **", row$display_name, "**: ", row$interpretation)
  }),
  "",
  "## Confidence boundary",
  "",
  "- Fully run here: in-space placebo p-values from the classic SCM donor-refit permutation.",
  "- Approximated in the report renderer: in-time treatment-year falsification chart.",
  "- Deferred in this tutorial runtime: full leave-one-out refits for top-weighted donors.",
  "- Do not report a single ATT without the placebo distribution and the caveats above."
)

writeLines(md, MD_PATH, useBytes = TRUE)

cat("OK: wrote ", JSON_PATH, "\n", sep = "")
cat("OK: wrote ", MD_PATH, "\n", sep = "")
cat("OK: summarized inference diagnostics for cases: ", paste(names(fits), collapse = ", "), "\n", sep = "")
