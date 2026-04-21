#!/usr/bin/env bash
# scripts/install-gbrain.sh — thin wrapper around the TypeScript installer.
#
# The real installer lives in scripts/install-gbrain.ts (see the
# top-of-file docstring there). This shell shim exists for two reasons:
#
#   1. The Phase A spec asks for `scripts/install-gbrain.sh` by name so
#      docs and onboarding instructions can keep using that path.
#   2. Some users expect a .sh entry point and may invoke it via curl
#      pipe or from a different shell where `npx tsx` isn't already on
#      their muscle memory.
#
# Anything you'd add to the installer should go in the .ts file, not
# here — this script is intentionally a one-liner so the two entry
# points stay equivalent.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${REPO_ROOT}"
exec npx tsx "${SCRIPT_DIR}/install-gbrain.ts" "$@"
