#!/usr/bin/env bash
# Builds the scienceswarm/sandbox:latest image used by the audit-revise
# run_job flow (revise_paper, rerun_stats_and_regenerate_figure). The image
# bakes in pdflatex + PyMC/matplotlib and ships a thin Python gbrain
# wrapper that calls back into the host Next.js server over HTTP.
#
# Usage:
#   ./scripts/build-sandbox.sh
#
# Exit codes: 0 success, 1 docker build failure, 2 docker daemon not running.
set -euo pipefail

if ! docker info >/dev/null 2>&1; then
  echo "error: docker daemon is not running (or not reachable)." >&2
  echo "       start Docker Desktop and retry." >&2
  exit 2
fi

REPO_ROOT="$(git rev-parse --show-toplevel)"

if ! docker build \
  -f "$REPO_ROOT/sandbox/Dockerfile" \
  -t scienceswarm/sandbox:latest \
  "$REPO_ROOT"; then
  echo "error: docker build failed for scienceswarm/sandbox:latest." >&2
  exit 1
fi

echo
echo "built scienceswarm/sandbox:latest"
echo "next: docker compose up -d openhands"
echo "      then set SCIENCESWARM_SANDBOX_TOKEN in .env"
