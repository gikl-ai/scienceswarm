# SCM-IR quickstart — install required CRAN packages.
#
# Idempotent: skips packages that are already installed.
# Run with:  Rscript setup.R

required <- c(
  # Core synthetic control
  "tidysynth",   # tidy interface to Abadie classic SCM (Lindner 2021)
  "Synth",       # canonical Abadie/Diamond/Hainmueller implementation; ships german reunification data
  "gsynth",      # generalized SCM with interactive fixed effects (Xu 2017)
  "synthdid",    # synthetic difference-in-differences (Arkhangelsky et al. 2021)
  # Data
  "WDI",         # World Bank development indicators
  # Tidy + plotting
  "dplyr",
  "tidyr",
  "purrr",
  "readr",
  "tibble",
  "ggplot2",
  "scales",
  # Interactive HTML output
  "plotly",
  "htmlwidgets",
  "htmltools",
  "jsonlite"
)

repos <- c(CRAN = "https://cloud.r-project.org")
installed <- rownames(installed.packages())
to_install <- setdiff(required, installed)

if (length(to_install) == 0L) {
  message("All required packages already installed.")
} else {
  message("Installing: ", paste(to_install, collapse = ", "))
  install.packages(to_install, repos = repos)
}

# synthdid is GitHub-only on some systems; warn but do not fail if missing.
if (!requireNamespace("synthdid", quietly = TRUE)) {
  message(
    "Note: 'synthdid' is not on CRAN as of 2024 and may need installation via:\n",
    "    remotes::install_github('synth-inference/synthdid')\n",
    "The pipeline will skip the SDID method if synthdid is unavailable."
  )
}

# Verify all critical packages load.
critical <- c("tidysynth", "Synth", "gsynth", "WDI", "plotly", "htmlwidgets")
for (p in critical) {
  ok <- suppressMessages(requireNamespace(p, quietly = TRUE))
  if (!ok) stop("Critical package failed to install: ", p)
}
message("OK: critical packages installed and loadable.")
