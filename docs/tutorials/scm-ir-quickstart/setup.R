# SCM-IR quickstart — install required CRAN packages.
#
# Idempotent: skips packages that are already installed.
# Run by ScienceSwarm/Claude Code as part of the UI-driven tutorial.

managed_r_library <- function() {
  scienceswarm_dir <- Sys.getenv(
    "SCIENCESWARM_DIR",
    unset = file.path(Sys.getenv("HOME", unset = "~"), ".scienceswarm")
  )
  minor <- strsplit(R.version$minor, ".", fixed = TRUE)[[1]][1]
  file.path(
    scienceswarm_dir,
    "runtimes",
    "r",
    paste0("R-", R.version$major, ".", minor),
    R.version$platform,
    "library"
  )
}

use_default_library <- identical(Sys.getenv("SCIENCESWARM_USE_DEFAULT_R_LIBS"), "1")
if (!use_default_library) {
  science_lib <- managed_r_library()
  dir.create(science_lib, recursive = TRUE, showWarnings = FALSE)
  .libPaths(unique(c(science_lib, .libPaths())))
  Sys.setenv(R_LIBS_USER = science_lib)
  message("Using ScienceSwarm-managed R package library: ", science_lib)
} else {
  message("Using the default R library path because SCIENCESWARM_USE_DEFAULT_R_LIBS=1.")
}

required <- c(
  # Core synthetic control
  "tidysynth",   # tidy interface to Abadie classic SCM (Lindner 2021)
  "Synth",       # canonical Abadie/Diamond/Hainmueller implementation; ships the Basque dataset
  "gsynth",      # generalized SCM with interactive fixed effects (Xu 2017)
  # Data
  "jsonlite",    # direct World Bank API parsing
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
  "htmltools"
)

optional <- c(
  "synthdid"     # synthetic difference-in-differences (Arkhangelsky et al. 2021)
)

repos <- c(CRAN = "https://cloud.r-project.org")

install_missing <- function(packages, required = TRUE) {
  installed <- rownames(installed.packages())
  to_install <- setdiff(packages, installed)

  if (length(to_install) == 0L) {
    message("Already installed: ", paste(packages, collapse = ", "))
    return(invisible(TRUE))
  }

  message("Installing: ", paste(to_install, collapse = ", "))
  ok <- tryCatch({
    install.packages(to_install, repos = repos, lib = .libPaths()[1])
    TRUE
  }, error = function(e) {
    if (required) {
      stop("Package installation failed: ", conditionMessage(e))
    }
    message("Optional package installation failed: ", conditionMessage(e))
    FALSE
  })

  if (required) {
    missing <- to_install[!vapply(to_install, requireNamespace, logical(1), quietly = TRUE)]
    if (length(missing) > 0L) {
      stop("Required packages failed to install or load: ", paste(missing, collapse = ", "))
    }
  }

  invisible(ok)
}

install_missing(required, required = TRUE)
install_missing(optional, required = FALSE)

# synthdid is optional; warn but do not fail if missing.
if (!requireNamespace("synthdid", quietly = TRUE)) {
  message(
    "Note: 'synthdid' is unavailable in this R library. ",
    "The pipeline will skip the SDID method and still run the remaining SCM checks."
  )
}

# Verify all critical packages load.
critical <- c("tidysynth", "Synth", "gsynth", "jsonlite", "plotly", "htmlwidgets")
for (p in critical) {
  ok <- suppressMessages(requireNamespace(p, quietly = TRUE))
  if (!ok) stop("Critical package failed to install: ", p)
}
message("OK: critical packages installed and loadable.")
