# Stage 1 — fetch raw panel data for the three IR cases.
#
# Pulls World Bank development indicators directly from the World Bank API
# for Brexit (UK + OECD donors) and Russia 2022 (RU + upper-middle-income
# donors); loads the bundled Abadie & Gardeazabal Basque dataset from the
# Synth package. Caches API pulls to data/raw/ so re-runs are offline-safe.
#
# Run:  Rscript 01_fetch_data.R

suppressPackageStartupMessages({
  library(dplyr)
  library(tidyr)
  library(purrr)
  library(readr)
  library(jsonlite)
})

options(timeout = max(120, getOption("timeout")))

args <- commandArgs(trailingOnly = FALSE); script_arg <- args[grep("^--file=", args)]; HERE <- if (length(script_arg) == 1L) normalizePath(dirname(sub("^--file=", "", script_arg[1]))) else getwd()
ROOT <- normalizePath(file.path(HERE, ".."))
RAW_DIR <- file.path(ROOT, "data", "raw")
dir.create(RAW_DIR, recursive = TRUE, showWarnings = FALSE)

# --- World Bank indicator codes ------------------------------------------------
# Picked for substantive relevance to IR-shock outcomes:
#   NY.GDP.PCAP.KD   real GDP per capita (constant 2015 USD)
#   NE.TRD.GNFS.ZS   trade openness (% of GDP)
#   NE.GDI.TOTL.ZS   gross capital formation (% of GDP) — investment proxy
#   PA.NUS.FCRF      official exchange rate (LCU per USD, period average) — FX proxy
INDICATORS <- c(
  gdp_pc        = "NY.GDP.PCAP.KD",
  trade_openness = "NE.TRD.GNFS.ZS",
  investment_pct = "NE.GDI.TOTL.ZS",
  fx_lcu_per_usd = "PA.NUS.FCRF"
)

# --- Donor pools ---------------------------------------------------------------
# Brexit donors: 24 high-income OECD economies excluding the UK and the
# eurozone-core economies that had their own simultaneous shocks (the
# 2015 refugee crisis was concentrated in DEU/AUT/SWE; we keep them but
# this is a defensible alternative). These match brexit_units in
# 02_prepare_panels.R exactly so nothing is fetched and silently unused.
BREXIT_DONORS <- c(
  "AUS", "AUT", "BEL", "CAN", "CHE", "CZE", "DEU", "DNK", "ESP",
  "FIN", "FRA", "GRC", "IRL", "ISR", "ITA", "JPN", "KOR", "NLD", "NOR",
  "NZL", "POL", "PRT", "SWE", "USA"
)

# Russia 2022 donors: upper-middle-income economies with comparable
# pre-2022 GDP-per-capita level and growth profile. Excludes obvious
# co-shocked countries (Ukraine, Belarus).
RUSSIA_DONORS <- c(
  "ARG", "BRA", "BGR", "CHL", "CHN", "COL", "HRV", "HUN", "IDN", "IND",
  "KAZ", "MEX", "MYS", "POL", "ROU", "SAU", "THA", "TUR", "ZAF"
)

ALL_ISO3 <- unique(c("GBR", BREXIT_DONORS, "RUS", RUSSIA_DONORS))

CACHE_PATH <- file.path(RAW_DIR, "wdi_panel.rds")

fetch_world_bank_indicator <- function(iso3_codes, indicator_code, value_name,
                                       start_year = 1990L, end_year = 2023L) {
  country_path <- paste(iso3_codes, collapse = ";")
  url <- sprintf(
    "https://api.worldbank.org/v2/country/%s/indicator/%s?format=json&date=%d:%d&per_page=20000",
    country_path,
    indicator_code,
    start_year,
    end_year
  )

  message("  - ", value_name, " (", indicator_code, ")")
  payload <- tryCatch(
    jsonlite::fromJSON(url, flatten = TRUE),
    error = function(e) {
      stop("World Bank API request failed for ", indicator_code, ": ",
           conditionMessage(e))
    }
  )

  if (!is.list(payload) || length(payload) < 2L || is.null(payload[[2]])) {
    stop("World Bank API returned an unexpected payload for ", indicator_code)
  }

  rows <- as_tibble(payload[[2]])
  if (nrow(rows) == 0L) {
    stop("World Bank API returned 0 rows for ", indicator_code)
  }

  out <- tibble(
    iso3c = rows$countryiso3code,
    country = rows[["country.value"]],
    year = as.integer(rows$date),
    value = as.numeric(rows$value)
  )
  names(out)[names(out) == "value"] <- value_name
  out
}

fetch_wdi_panel <- function() {
  message("Fetching World Bank panel for ", length(ALL_ISO3), " countries x ",
          length(INDICATORS), " indicators (1990-2023)...")
  imap(INDICATORS, ~ fetch_world_bank_indicator(
    ALL_ISO3,
    indicator_code = .x,
    value_name = .y
  )) %>%
    reduce(full_join, by = c("iso3c", "country", "year")) %>%
    select(iso3c, country, year, all_of(names(INDICATORS))) %>%
    arrange(iso3c, year) %>%
    as_tibble()
}

if (file.exists(CACHE_PATH)) {
  message("Using cached World Bank panel: ", CACHE_PATH)
  panel <- readRDS(CACHE_PATH)
} else {
  panel <- tryCatch(
    fetch_wdi_panel(),
    error = function(e) {
      stop(
        "World Bank panel fetch failed: ", conditionMessage(e), "\n",
        "Check internet connectivity, then re-run."
      )
    }
  )
  saveRDS(panel, CACHE_PATH)
  message("Wrote ", CACHE_PATH)
}

# --- Quick coverage diagnostics -----------------------------------------------
coverage <- panel %>%
  group_by(iso3c) %>%
  summarise(
    n_years = n(),
    gdp_nonmiss = sum(!is.na(gdp_pc)),
    .groups = "drop"
  )

stopifnot(
  "Coverage panel is empty - World Bank API fetch returned no rows" = nrow(coverage) > 0,
  "Some donor countries returned 0 GDP observations" =
    all(coverage$gdp_nonmiss > 0)
)

# --- Bundled Basque Country / ETA terrorism dataset ---------------------------
# Abadie & Gardeazabal (2003, AER) — the *original* synthetic control
# paper. Ships with the Synth package as `basque`. 17 Spanish regions +
# Spain over 1955–1997, treatment 1975 (ETA terrorism intensification).
# Outcome: real GDP per capita (gdpcap).
#
# Note: the German reunification dataset (Abadie/Diamond/Hainmueller 2015,
# AJPS) has been removed from recent CRAN versions of Synth. Basque is
# the canonical alternative — same author, same method, original paper.
suppressPackageStartupMessages(library(Synth))
basque_env <- new.env()
data("basque", package = "Synth", envir = basque_env)
basque <- basque_env$basque
basque_path <- file.path(RAW_DIR, "basque_bundled.rds")
saveRDS(basque, basque_path)
message("Wrote ", basque_path, " (n=", nrow(basque), " region-years)")

cat(sprintf(
  "OK: World Bank panel %d countries x %d years = %d rows; %d indicators\n",
  length(unique(panel$iso3c)),
  length(unique(panel$year)),
  nrow(panel),
  length(INDICATORS)
))
