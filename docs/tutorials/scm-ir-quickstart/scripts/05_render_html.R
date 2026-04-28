# Compatibility wrapper for the previous report-rendering entry point.
#
# New UI-first walkthroughs run scripts/05_summarize_inference.R before
# rendering the report with scripts/06_render_html.R. This wrapper preserves
# older references to scripts/05_render_html.R.

args <- commandArgs(trailingOnly = FALSE)
script_arg <- args[grep("^--file=", args)]
HERE <- if (length(script_arg) == 1L) {
  normalizePath(dirname(sub("^--file=", "", script_arg[1])))
} else {
  getwd()
}

message("scripts/05_render_html.R is kept for compatibility; running scripts/06_render_html.R.")
source(file.path(HERE, "06_render_html.R"), chdir = FALSE)
