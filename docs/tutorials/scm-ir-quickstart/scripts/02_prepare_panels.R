# Stage 2 — assemble three balanced country-year panels.
#
# Reads the cached World Bank panel and bundled Basque dataset from stage 1, then
# carves three case-specific tibbles ready for SCM:
#
#   * brexit:  GBR + 24 OECD donors, 1995–2023, treatment 2016
#   * russia:  RUS + 19 upper-middle-income donors, 2000–2023, treatment 2022
#   * basque: Basque Country + 16 Spanish regions, 1960–1997, treatment 1975
#
# Each output is a list with $panel (long tibble), $treated_unit,
# $donor_units, $treatment_year, $outcome_var, $predictor_vars.
#
# Run:  Rscript 02_prepare_panels.R

suppressPackageStartupMessages({
  library(dplyr)
  library(tidyr)
  library(tibble)
})

args <- commandArgs(trailingOnly = FALSE); script_arg <- args[grep("^--file=", args)]; HERE <- if (length(script_arg) == 1L) normalizePath(dirname(sub("^--file=", "", script_arg[1]))) else getwd()
ROOT <- normalizePath(file.path(HERE, ".."))
RAW_DIR <- file.path(ROOT, "data", "raw")
PREP_DIR <- file.path(ROOT, "data", "prepared")
dir.create(PREP_DIR, recursive = TRUE, showWarnings = FALSE)

panel <- readRDS(file.path(RAW_DIR, "wdi_panel.rds"))
basque <- readRDS(file.path(RAW_DIR, "basque_bundled.rds"))

# Validation: balanced-panel check helper.
require_balanced <- function(p, units, year_range, var, label) {
  expected_n <- length(units) * (diff(year_range) + 1L)
  obs <- p %>%
    filter(iso3c %in% units, year >= year_range[1], year <= year_range[2]) %>%
    select(iso3c, year, all_of(var)) %>%
    drop_na()
  if (nrow(obs) < 0.85 * expected_n) {
    stop(sprintf(
      "[%s] only %d/%d cells non-missing for outcome '%s'; widen donor pool or shorten window",
      label, nrow(obs), expected_n, var
    ))
  }
  obs
}

# --- Case A: Brexit -----------------------------------------------------------
brexit_units <- c(
  "GBR", "AUS", "AUT", "BEL", "CAN", "CHE", "CZE", "DEU", "DNK", "ESP",
  "FIN", "FRA", "GRC", "IRL", "ISR", "ITA", "JPN", "KOR", "NLD", "NOR",
  "NZL", "POL", "PRT", "SWE", "USA"
)
brexit_years <- c(1995L, 2023L)
brexit_outcome <- "gdp_pc"
# Predictors averaged over the pre-period inside tidysynth at fit time.
brexit_predictors <- c("trade_openness", "investment_pct")

invisible(require_balanced(panel, brexit_units, brexit_years, brexit_outcome, "brexit"))

brexit_panel <- panel %>%
  filter(iso3c %in% brexit_units,
         year >= brexit_years[1], year <= brexit_years[2]) %>%
  select(iso3c, country, year, all_of(c(brexit_outcome, brexit_predictors))) %>%
  arrange(iso3c, year)

brexit_case <- list(
  case_id = "brexit",
  display_name = "Brexit referendum (2016)",
  panel = brexit_panel,
  treated_unit = "GBR",
  treated_unit_name = "United Kingdom",
  donor_units = setdiff(brexit_units, "GBR"),
  treatment_year = 2016L,
  outcome_var = brexit_outcome,
  outcome_label = "GDP per capita (constant 2015 USD)",
  predictor_vars = brexit_predictors,
  pre_window = c(1995L, 2015L),
  post_window = c(2016L, 2023L),
  citation = "Born, Müller, Schularick, Sedláček (2019, EJ); replication-style fit"
)
saveRDS(brexit_case, file.path(PREP_DIR, "brexit.rds"))
message("Wrote brexit.rds: ", length(brexit_case$donor_units), " donors, ",
        diff(brexit_case$pre_window) + 1L, " pre-treatment years")

# --- Case B: Russia 2022 sanctions --------------------------------------------
russia_units <- c(
  "RUS", "ARG", "BRA", "BGR", "CHL", "CHN", "COL", "HRV", "HUN", "IDN",
  "IND", "KAZ", "MEX", "MYS", "POL", "ROU", "SAU", "THA", "TUR", "ZAF"
)
russia_years <- c(2000L, 2023L)
russia_outcome <- "gdp_pc"
russia_predictors <- c("trade_openness", "investment_pct", "fx_lcu_per_usd")

invisible(require_balanced(panel, russia_units, russia_years, russia_outcome, "russia"))

russia_panel <- panel %>%
  filter(iso3c %in% russia_units,
         year >= russia_years[1], year <= russia_years[2]) %>%
  select(iso3c, country, year, all_of(c(russia_outcome, russia_predictors))) %>%
  arrange(iso3c, year)

russia_case <- list(
  case_id = "russia",
  display_name = "Russia 2022 sanctions",
  panel = russia_panel,
  treated_unit = "RUS",
  treated_unit_name = "Russian Federation",
  donor_units = setdiff(russia_units, "RUS"),
  treatment_year = 2022L,
  outcome_var = russia_outcome,
  outcome_label = "GDP per capita (constant 2015 USD)",
  predictor_vars = russia_predictors,
  pre_window = c(2000L, 2021L),
  post_window = c(2022L, 2023L),
  citation = "Post-invasion sanctions onset; donor pool of upper-middle-income economies"
)
saveRDS(russia_case, file.path(PREP_DIR, "russia.rds"))
message("Wrote russia.rds: ", length(russia_case$donor_units), " donors, ",
        diff(russia_case$pre_window) + 1L, " pre-treatment years")

# --- Case C: Basque Country / ETA terrorism (Abadie & Gardeazabal 2003) ------
# The original synthetic control paper. 17 Spanish regions + Spain,
# 1955–1997, treatment year 1975 (intensification of ETA terrorism).
# We exclude Spain itself from the donor pool to keep the comparison
# at the regional level. Predictors with material pre-1975 coverage:
# investment share (invest), sector composition, schooling.
basque_panel <- basque %>%
  as_tibble() %>%
  filter(regionname != "Spain (Espana)",
         year >= 1960L, year <= 1997L) %>%
  mutate(
    iso3c = regionname,
    country = regionname,
    gdp_pc = gdpcap
  ) %>%
  select(iso3c, country, year, gdp_pc,
         invest, sec.industry, school.high)

basque_units <- unique(basque_panel$iso3c)
treated <- "Basque Country (Pais Vasco)"

basque_case <- list(
  case_id = "basque",
  display_name = "Basque Country / ETA terrorism (1975)",
  panel = basque_panel,
  treated_unit = treated,
  treated_unit_name = "Basque Country",
  donor_units = setdiff(basque_units, treated),
  treatment_year = 1975L,
  outcome_var = "gdp_pc",
  outcome_label = "Real GDP per capita (1986 USD, thousands)",
  predictor_vars = c("invest", "sec.industry", "school.high"),
  pre_window = c(1960L, 1974L),
  post_window = c(1975L, 1997L),
  citation = "Abadie & Gardeazabal (2003, AER); canonical replication"
)
saveRDS(basque_case, file.path(PREP_DIR, "basque.rds"))
message("Wrote basque.rds: ", length(basque_case$donor_units), " donors, ",
        diff(basque_case$pre_window) + 1L, " pre-treatment years")

# --- Validation gate: every case meets minimums --------------------------------
for (case in list(brexit_case, russia_case, basque_case)) {
  pre_years <- diff(case$pre_window) + 1L
  n_donors <- length(case$donor_units)
  if (pre_years < 10L) stop(case$case_id, ": only ", pre_years, " pre-treatment years (need ≥ 10)")
  if (n_donors < 15L) stop(case$case_id, ": only ", n_donors, " donors (need ≥ 15)")
}
cat("OK: all 3 cases have ≥ 10 pre-treatment years and ≥ 15 donor candidates\n")
